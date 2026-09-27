/** @file-guide
 * 목적: weekly-bundle.ts — weekOfMonday, loadWeeklyBundles, weeklyPlainText, assertWeeklyBundleSendable (util)
 * 책임/재사용: N-54 주간 묶음의 판정 한 곳 — 그 주 쓴 리포트를 읽을 때 모으고(저장하지 않는다) 총평 · 보내기 가능 여부 · 보낼 본문을 만든다.
 *   리포트 목록(§47)·보호자 발송(guardians.service)이 같은 함수를 부른다(D-R22 · D-R39).
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { addDays, isIsoDate } from '../../lib/kst';
import {
  REP_STATE_LABEL_DB, effectiveRepStateFromEnded, isWrittenDbState, reportDeliveryIssue, reportPlainText,
  type RepStateDb, type ReportBody,
} from '../../lib/rules';
import { END_MIN, kstAt, START_MIN } from '../../lib/sql';
import { REPORT_CANCELED_SQL, REPORT_DATE_SQL } from './report-sql';

/**
 * N-54 채택(W11 · 2026-09-26) — S23 검수 권고 ①+②:
 *  ① 묶음 **본문은 그 주(월~일 · KST) 그 학생에게 이미 쓴 리포트를 읽을 때 모은다** — 저장하지 않는다(학부모에게 나갈 글을 시스템이 짓지 않는다).
 *  ② `wrep.body` 에는 **매니저가 직접 쓴 총평만** `{summary, by, at}` 로 둔다.
 *  보내기는 DQ3 보호자 선택 발송(`guardian_send.wrep_id`)으로 기록한다 — `autorep` 은 쓰지 않는다.
 *
 * 보내기의 문은 하루 발송(§49)과 **같은 규칙**이다(`reportDeliveryIssue` — 안 쓴 것 · 승인 안 된 것이 있으면 막는다) + 총평이 있어야 한다.
 * 한 번 실제로 나간 뒤에는 총평을 고치지 않는다 — 원장(`guardian_send`)에는 본문이 없으므로 보낸 글을 다시 만들 수 있어야 한다
 * (승인된 리포트는 이미 잠겨 있고, 총평까지 잠그면 같은 글이 다시 만들어진다).
 */

/** 보호자 발송 본문 상한 — `GuardianSendDto.body` 의 MaxLength 와 같은 수다(한 번에 보낼 수 있는 글의 크기) */
export const WEEKLY_BODY_MAX = 2000;

/** 줄 사이 구분선 — 하루 발송(RSEND.body)이 리포트를 잇는 줄과 같다 */
const DIVIDER = '\n\n────────\n\n';

/** 그 날이 든 주의 월요일(ISO 주 · KST 달력 날짜) */
export function weekOfMonday(iso: string): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return addDays(iso, -(dow === 0 ? 6 : dow - 1));
}

export interface WeeklyLesson {
  repId: number; serId: number; onDate: string; date: string;
  startMin: number | null; endMin: number | null;
  subjectName: string; teacherName: string | null;
  state: RepStateDb; stateLabel: string; written: boolean; approved: boolean;
  body: ReportBody | null;
}

export interface WeeklySummary { text: string; byId: number | null; byName: string | null; at: string }

export interface WeeklyBundle {
  studentId: number; studentName: string; grade: string | null;
  wrepId: number | null;
  summary: WeeklySummary | null;
  legacy: boolean;
  lessons: WeeklyLesson[];
  sentAt: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
}

export interface WeeklyGate {
  canWriteSummary: boolean; summaryBlockedReason: string | null;
  canSend: boolean; sendBlockedReason: string | null;
  plainText: string | null;
}

interface Queryer {
  query<T = unknown>(sql: string, parameters?: unknown[]): Promise<T>;
}

type R = Record<string, unknown>;

function readBody(raw: unknown): ReportBody {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    content: typeof value.content === 'string' ? value.content : '',
    progress: typeof value.progress === 'string' ? value.progress : '',
    homework: typeof value.homework === 'string' ? value.homework : '',
  };
}

/** `wrep.body` 가 N-54 모양(`{summary, by, at}`)인가 — 아니면 옛 행이다(N-25 · 고치지 않고 「옛 기록」으로 둔다) */
function readSummary(raw: unknown, byName: string | null): { summary: WeeklySummary | null; legacy: boolean } {
  if (raw === null || raw === undefined) return { summary: null, legacy: false };
  const value = typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const keys = value ? Object.keys(value).sort().join(',') : '';
  if (!value || keys !== 'at,by,summary' || typeof value.summary !== 'string' || typeof value.by !== 'number'
    || typeof value.at !== 'string' || value.summary.trim() === '') {
    return { summary: null, legacy: true };
  }
  return { summary: { text: value.summary, byId: value.by, byName, at: value.at }, legacy: false };
}

/**
 * 그 주의 학생별 묶음 — 리포트 대상 종류 · 취소 아님 · 발송 대상 학생(`rep_stu.deliver`)만.
 * `studentId` 를 주면 그 학생 하나. `lockWrep` 이면 그 학생의 `wrep` 행을 잠근다(총평 쓰기 · 보내기가 줄을 선다).
 */
export async function loadWeeklyBundles(
  q: Queryer, weekOf: string, studentId: number | null, lockWrep = false,
): Promise<WeeklyBundle[]> {
  const weekTo = addDays(weekOf, 6);
  if (lockWrep && studentId !== null) {
    await q.query(`SELECT id FROM wrep WHERE student_id = $1 AND week_of = $2 FOR UPDATE`, [studentId, weekOf]);
  }
  const lessons = await q.query<R[]>(
    `SELECT r.id AS rep_id, r.ser_id, to_char(r.on_date, 'YYYY-MM-DD') AS on_date,
            to_char(${REPORT_DATE_SQL}, 'YYYY-MM-DD') AS date,
            ${START_MIN} AS start_min, ${END_MIN} AS end_min,
            COALESCE(sb.name, s.title, k.name) AS subject_name, t.name AS teacher_name,
            r.state, k.rep AS reportable, COALESCE(upper(o.span) <= now(), false) AS ended, r.body,
            st.id AS student_id, st.name AS student_name, st.grade
       FROM rep r
       JOIN ser s ON s.id = r.ser_id
       JOIN kind k ON k.key = COALESCE(r.kind_key, s.kind_key)
       LEFT JOIN sub sb ON sb.key = s.sub_key
       LEFT JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
       LEFT JOIN att a ON a.ser_id = r.ser_id AND a.on_date = r.on_date
       LEFT JOIN staff t ON t.id = COALESCE(o.teacher_id, r.teacher_id)
       JOIN rep_stu x ON x.rep_id = r.id AND x.deliver
       JOIN stu st ON st.id = x.student_id
      WHERE ${REPORT_DATE_SQL} BETWEEN $1::date AND $2::date
        AND k.rep AND NOT ${REPORT_CANCELED_SQL}
        AND ($3::bigint IS NULL OR st.id = $3)
      ORDER BY st.name, st.id, date, start_min NULLS LAST, r.id`,
    [weekOf, weekTo, studentId],
  );
  const wreps = await q.query<R[]>(
    `SELECT w.id, w.student_id, w.body, sf.name AS by_name
       FROM wrep w
       LEFT JOIN staff sf ON sf.id = CASE WHEN jsonb_typeof(w.body->'by') = 'number' THEN (w.body->>'by')::bigint END
      WHERE w.week_of = $1 AND ($2::bigint IS NULL OR w.student_id = $2)`,
    [weekOf, studentId],
  );
  const wrepIds = wreps.map((w) => Number(w.id));
  const sends = wrepIds.length === 0 ? [] : await q.query<R[]>(
    `SELECT wrep_id, count(*)::int AS attempts,
            ${kstAt('max(sent_at)')} AS last_at,
            ${kstAt("min(sent_at) FILTER (WHERE status = 'sent')")} AS first_sent
       FROM guardian_send WHERE wrep_id = ANY($1::bigint[]) GROUP BY wrep_id`,
    [wrepIds],
  );

  const byStudent = new Map<number, WeeklyBundle>();
  for (const row of lessons) {
    const sid = Number(row.student_id);
    let bundle = byStudent.get(sid);
    if (!bundle) {
      bundle = {
        studentId: sid, studentName: String(row.student_name), grade: (row.grade as string) ?? null,
        wrepId: null, summary: null, legacy: false, lessons: [], sentAt: null, attemptCount: 0, lastAttemptAt: null,
      };
      byStudent.set(sid, bundle);
    }
    const state = effectiveRepStateFromEnded(String(row.state), row.reportable === true, row.ended === true);
    const written = isWrittenDbState(state);
    bundle.lessons.push({
      repId: Number(row.rep_id), serId: Number(row.ser_id), onDate: String(row.on_date), date: String(row.date),
      startMin: row.start_min == null ? null : Number(row.start_min),
      endMin: row.end_min == null ? null : Number(row.end_min),
      subjectName: String(row.subject_name), teacherName: (row.teacher_name as string) ?? null,
      state, stateLabel: REP_STATE_LABEL_DB[state], written, approved: state === 'ok',
      body: written ? readBody(row.body) : null,
    });
  }
  for (const w of wreps) {
    const bundle = byStudent.get(Number(w.student_id));
    // 그 주 리포트가 없는 학생의 총평은 묶음이 서지 않는다(보낼 본문이 없다) — 행은 그대로 둔다
    if (!bundle) continue;
    bundle.wrepId = Number(w.id);
    const read = readSummary(w.body, (w.by_name as string) ?? null);
    bundle.summary = read.summary;
    bundle.legacy = read.legacy;
    const send = sends.find((s) => Number(s.wrep_id) === Number(w.id));
    if (send) {
      bundle.attemptCount = Number(send.attempts);
      bundle.lastAttemptAt = (send.last_at as string) ?? null;
      bundle.sentAt = (send.first_sent as string) ?? null;
    }
  }
  return [...byStudent.values()];
}

/**
 * 보낼 본문 — **짓지 않고 잇는다.** 그 주 리포트(하루 발송과 같은 5섹션 `reportPlainText`)를 수업 차례대로, 끝에 매니저의 총평.
 * 새 문장은 없다 — 「총평」은 칸 이름이다(리포트의 「① 학생」 · 「③ 수업 내용」 같은 자리). 날짜는 줄마다의 「② 수업」이 이미 말한다.
 */
export function weeklyPlainText(bundle: WeeklyBundle): string | null {
  if (!bundle.summary || bundle.lessons.some((lesson) => !lesson.body)) return null;
  const lessons = bundle.lessons.map((lesson) => reportPlainText({
    date: lesson.date, studentName: bundle.studentName, studentGrade: bundle.grade,
    subjectName: lesson.subjectName, startMin: lesson.startMin, endMin: lesson.endMin, body: lesson.body!,
  }));
  return [...lessons, `총평\n${bundle.summary.text.trim()}`].join(DIVIDER).trim();
}

/** 쓰기 · 보내기가 서는지와 막힌 이유 — 화면과 쓰기 경로가 같은 함수를 부른다(D-R39) */
export function weeklyGate(bundle: WeeklyBundle, canWrite: boolean): WeeklyGate {
  const noPerm = '주간 묶음은 매니저 이상만 다룹니다';
  let summaryBlockedReason: string | null = null;
  if (!canWrite) summaryBlockedReason = noPerm;
  else if (bundle.legacy) summaryBlockedReason = '예전 방식으로 저장된 주간 기록이라 고칠 수 없습니다';
  else if (bundle.sentAt) summaryBlockedReason = '이미 보호자에게 보낸 묶음이라 총평을 고칠 수 없습니다';

  const plainText = weeklyPlainText(bundle);
  let sendBlockedReason: string | null = null;
  const issue = reportDeliveryIssue({
    canCrudAll: canWrite,
    states: bundle.lessons.map((lesson) => lesson.state),
    expectedRepIds: bundle.lessons.map((lesson) => lesson.repId),
    actualRepIds: bundle.lessons.map((lesson) => lesson.repId),
  });
  if (!canWrite) sendBlockedReason = noPerm;
  else if (bundle.legacy) sendBlockedReason = '예전 방식으로 저장된 주간 기록이라 보낼 수 없습니다';
  else if (issue === 'REPORT_DELIVERY_EMPTY') sendBlockedReason = '이 주에 보낼 리포트가 없습니다';
  else if (issue === 'REPORT_DELIVERY_INCOMPLETE') {
    sendBlockedReason = `안 쓴 리포트가 ${bundle.lessons.filter((lesson) => !lesson.written).length}건 있습니다`;
  } else if (issue === 'REPORT_DELIVERY_NOT_APPROVED') {
    sendBlockedReason = `승인되지 않은 리포트가 ${bundle.lessons.filter((lesson) => !lesson.approved).length}건 있습니다`;
  } else if (!bundle.summary) sendBlockedReason = '총평을 먼저 써야 보낼 수 있습니다';
  else if (plainText && plainText.length > WEEKLY_BODY_MAX) {
    sendBlockedReason = `본문이 ${plainText.length.toLocaleString('ko-KR')}자로 한 번에 보낼 수 있는 ${WEEKLY_BODY_MAX.toLocaleString('ko-KR')}자를 넘습니다`;
  }
  return {
    canWriteSummary: summaryBlockedReason === null,
    summaryBlockedReason,
    canSend: sendBlockedReason === null,
    sendBlockedReason,
    // 보낼 수 있을 때만 싣는다 — 창은 이 글을 그대로 보낸다(고쳐 보내지 않는다)
    plainText: sendBlockedReason === null ? plainText : null,
  };
}

/**
 * 보호자 발송(`POST /guardians/send` · `wrepId`)의 서버 판정 — 같은 트랜잭션에서 부른다.
 * 그 학생의 묶음인가 · 보낼 수 있는가(weeklyGate) · 본문이 서버가 모은 글과 같은가. 권한은 발송 경로의 `@Perm` 이 이미 봤다.
 */
export async function assertWeeklyBundleSendable(q: Queryer, wrepId: number, studentId: number, body: string): Promise<void> {
  const [w] = await q.query<Array<{ student_id: string; week_of: string }>>(
    `SELECT student_id, to_char(week_of, 'YYYY-MM-DD') AS week_of FROM wrep WHERE id = $1 FOR UPDATE`, [wrepId],
  );
  if (!w || Number(w.student_id) !== studentId) {
    throw new BadRequestException({ code: 'WEEKLY_NOT_OF_STUDENT', message: '이 학생의 주간 묶음이 아닙니다' });
  }
  if (!isIsoDate(w.week_of)) throw new NotFoundException({ code: 'WEEKLY_NOT_FOUND', message: '주간 묶음을 찾을 수 없습니다' });
  const [bundle] = await loadWeeklyBundles(q, w.week_of, studentId);
  if (!bundle || bundle.wrepId !== wrepId) {
    throw new ConflictException({ code: 'WEEKLY_NO_LESSONS', message: '이 주에 보낼 리포트가 없습니다' });
  }
  const gate = weeklyGate(bundle, true);
  if (!gate.canSend) throw new ConflictException({ code: 'WEEKLY_NOT_SENDABLE', message: gate.sendBlockedReason });
  if (body !== gate.plainText) {
    throw new ConflictException({ code: 'WEEKLY_BUNDLE_CHANGED', message: '주간 묶음이 바뀌었습니다 — 창을 닫고 다시 열어 주세요' });
  }
}
