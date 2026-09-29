/** @file-guide
 * 목적: schedule.service.ts — OccQuery, ScheduleService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SerOcc } from '../../entities';
import {
  ATTENDANCE_CANCEL_REASON_LABEL, CANCEL_TREAT_LABEL, GUIDE_DONE_DB, REPORT_WRITTEN_DB, guideLabel,
  canEditAttendance, effectiveRepStateFromEnded, isPast, isWrittenDbState, rosterPricing, tierFor, REP_STATE_LABEL_DB,
  type AttendanceCancelReason, type AttendanceResult, type CancelTreat, type RepStateDb,
} from '../../lib/rules';
import { addD, isRecurring, parseRule, ruleHits, type IsoDate, type Ser } from '../../lib/recurrence';
import type {
  HolidayDto, LessonPrepRowDto, LessonTrackingDto, OccurrenceDto, OccurrenceQueryDto, ScheduleSeriesCountsDto,
  ScheduleStudentBooksDto, ScheduleTeacherGuidesDto, ScheduleUnavRowDto, TrackedReportDto, TrackedStudentDto,
  NoteCreateDto, TrackedNoteDto, DayCancelParentNoticeDto,
} from './schedule.dto';
import { START_MIN, END_MIN, effectiveModeOf, kstAt, kstDateOf, serStuEndedOn, serStuOn, spanOf, stuPausedOn } from '../../lib/sql';
import { REPORT_CANCELED_SQL } from '../reports/report-sql';
import { nowMinKst, todayKst } from '../../lib/kst';
import { progressPercent } from '../../lib/book';
import { CANCEL_NOTICE_LIKE, cancelNoticeTitle } from '../../lib/cancel-notice';
import { KIND_GROUPS, kindGroupLabel } from '../../lib/catalog-words';

export interface OccQuery extends OccurrenceQueryDto {
  canCrudAttendance?: boolean;
}

/**
 * 학생 손에 있는 교재 — **배부 완료(ISSUE ok)만**이다. 승인 대기·전달 대기는 아직 학생에게 없다.
 * §79 「교재 N」 · §12 준비 「교재 배정」 · §10 머리 「교재 없음」이 이 한 조각을 쓴다 — 셋이 갈리면
 * 같은 학생이 한 화면에서는 교재가 있고 다른 화면에서는 없다.
 */
const bookHeld = (alias: string) => `${alias}.state = 'ok'`;

/** §10 개인 머리 낱말 — 원문 `§10 학생별 시간표` 컷 「홍채원 [K] 교재 없음」 그대로 */
export const STUDENT_NO_BOOK_LABEL = '교재 없음';

/**
 * 규칙상 `today`(포함) 이후에 놓일 날이 하나라도 남았는가 — 판정은 규칙 엔진 `ruleHits` 하나다(투영과 같은 판정).
 * 끝날이 없는 반복은 한 주기(주 간격 × 7일) 안에 반드시 한 번 맞으므로 거기까지만 훑는다.
 * 단발은 그 날이 오늘 이후인가, 시작 전에 통째로 접힌 규칙(끝날 < 시작일)은 늘 거짓이다.
 */
export function seriesHasDateFrom(ser: Pick<Ser, 'rrule' | 'fromDate' | 'toDate'>, today: IsoDate): boolean {
  const { interval } = parseRule(ser.rrule);
  const start = ser.fromDate > today ? ser.fromDate : today;
  const reach = addD(start, 7 * interval + 7);
  const end = ser.toDate && ser.toDate < reach ? ser.toDate : reach;
  for (let day = start; day <= end; day = addD(day, 1)) if (ruleHits(ser as Ser, day)) return true;
  return false;
}

/** DB 가 돌려준 한 줄 — 컬럼 이름은 아래 SQL 과 짝이다 */
interface Row {
  ser_id: string; date: string; on_date: string; start_min: number; end_min: number;
  kind_key: string; sub_key: string | null; title: string | null;
  rrule: string; ser_from: string; ser_to: string | null;
  teacher_id: string | null; teacher_name: string | null;
  room_id: string | null; room_name: string | null;
  zacc_id: string | null; mode: string; memo: string | null; canceled: boolean;
  cancel_kind: AttendanceCancelReason | null; cancel_treat: CancelTreat | null;
  makeup_ser_id: string | null; makeup_date: string | null; makeup_start_min: number | null; makeup_of_date: string | null;
  has_exception: boolean; reportable: boolean; extra: boolean; rep_state: string | null; report_canceled: boolean;
  attendance_id: string | null; attendance_result: AttendanceResult | null;
  attendance_reason: AttendanceCancelReason | null; attendance_confirmed_by: string | null;
  attendance_confirmed_by_name: string | null; attendance_confirmed_at: Date | string | null;
  attendance_late_students: Array<{
    studentId: string | number; studentName: string; confirmedBy: string | number;
    confirmedByName: string; confirmedAt: Date | string;
  }> | null;
  students: Array<{
    id: number; name: string; grade: string | null; droppedOnce: boolean; paused: boolean; late: boolean;
  }> | null;
}

@Injectable()
export class ScheduleService {
  constructor(@InjectRepository(SerOcc) private readonly occ: Repository<SerOcc>) {}

  private q<T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.occ.query(sql, p) as Promise<T[]>;
  }

  /**
   * N-133 · C-32 — 학원 사유 휴강 뒤 reload해도 남은 보호자 선택 발송을 같은 날짜에서 이어 간다.
   * 두 갈래(전일 휴원 · 한 회차 학원 사정 휴강)를 같은 목록에 싣고, 무슨 안내인지는 서버가 이름(`title`)으로 준다(D-R18).
   * 한 학생이 한 날 두 수업에서 휴강 안내를 받으면 두 줄이다 — 학생으로 접으면 한 수업의 안내가 사라진다.
   */
  async dayCancelNotices(date: string): Promise<DayCancelParentNoticeDto[]> {
    const rows = await this.q<{
      id: string; student_id: string; student_name: string; body: string; sent_at: string | null;
    }>(
      `SELECT p.id,p.student_id,st.name AS student_name,p.body,
              ${kstAt('p.sent_at')} AS sent_at
         FROM pnoti p
         JOIN stu st ON st.id=p.student_id
        WHERE p.on_date=$1::date AND p.audience='parent' AND p.body LIKE ANY($2::text[])
        ORDER BY st.name,p.student_id,p.id`,
      [date, CANCEL_NOTICE_LIKE],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      studentId: Number(row.student_id),
      studentName: row.student_name,
      body: row.body,
      title: cancelNoticeTitle(row.body),
      sentAt: row.sent_at,
    }));
  }

  /**
   * 공휴일 이름표 — 기간 안의 날만 (원문 §09 「광복절」·「광복절 대체」 칩 · §10 요일 머리).
   * 표시만 한다: 일정을 막거나 회차를 바꾸지 않는다. 한 날에 이름이 둘이면 둘 다 돌려준다.
   */
  async holidays(from: string, to: string): Promise<HolidayDto[]> {
    const rows = await this.q<{ date: string; name: string }>(
      `SELECT to_char(on_date, 'YYYY-MM-DD') AS date, name
         FROM holiday
        WHERE on_date BETWEEN $1::date AND $2::date
        ORDER BY on_date, name`,
      [from, to],
    );
    return rows.map((r) => ({ date: String(r.date), name: String(r.name) }));
  }

  /**
   * 강사 불가 시간 — **관리자 읽기** (원문 §07 데이터 「읽기: … UNAV」 · §11 「UNAV(불가 시간)」 · G37).
   *
   * 지금까지 UNAV 는 강사 본인 화면(`GET /teacher/unavailable`)에서만 읽혀 **적어 낸 강사만 알고
   * 잡는 사람은 몰랐다**(저장 뒤 경고 띠 하나뿐). 시간표의 「가능 시간」 겹쳐 보기와 「빈 시간 찾기」가
   * 이것을 읽는다. **막지 않는다** — UNAV 는 DB 제약이 아니고, 겹침 판정은 쓰기 때 경고로만 한다.
   * 날짜가 없는 옛 줄(N-20 legacy)은 격자 어디에도 놓을 수 없어 싣지 않는다.
   */
  async unavailable(q: { from: string; to: string; teacherId?: number }): Promise<ScheduleUnavRowDto[]> {
    const params: unknown[] = [q.from, q.to];
    let who = '';
    if (q.teacherId) { params.push(q.teacherId); who = `AND u.staff_id = $${params.length}`; }
    const rows = await this.q<Record<string, unknown>>(
      `SELECT u.id, u.staff_id, st.name AS teacher_name, to_char(u.on_date, 'YYYY-MM-DD') AS date,
              u.start_min, u.end_min, u.reason
         FROM unav u
         JOIN staff st ON st.id = u.staff_id
        WHERE u.on_date BETWEEN $1::date AND $2::date ${who}
        ORDER BY u.on_date, u.start_min, st.name, u.id`,
      params,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      teacherId: Number(r.staff_id),
      teacherName: String(r.teacher_name),
      date: String(r.date),
      startMin: Number(r.start_min),
      endMin: Number(r.end_min),
      reason: String(r.reason),
    }));
  }

  /**
   * §07 좌측 사이드바 「프로그램」·「과목」 수 — 보는 기간과 무관한 **일정 원본(SER) 수** (D-R44 · w5-7 결정).
   * 원문 §07 「수업 24 · 상담·진단 6 · 회의 5」 합 35 = v2 slide 05 「SER 일정 원본 35」 · §08~§11 컷도 같은 수다.
   *
   * 원문 시드의 SER 35 줄은 전부 살아 있는 원본이었다. 우리 표에는 끝난 원본도 남는다 — 「향후」 편집이 규칙을
   * 가르고(D-R17) 이력이 있는 수업은 지우지 않고 기간을 마감한다. 행을 다 세면 지운 수업·지난 단발이 수에 남는다.
   * 그래서 「일정 원본」 = **오늘(KST) 이후에 놓일 날이 남은 SER**:
   *   · 규칙상 날짜가 남았는가 — `seriesHasDateFrom`(규칙 엔진) · 투영 창 밖에서 시작하는 원본도 센다
   *   · 또는 「이번만」 옮겨 실제로 오늘 이후에 놓인 회차가 있는가(휴강 제외) — 투영(ser_occ)의 실제 날짜
   * 휴강·옮김은 원본의 예외다 — 남은 날이 휴강이어도 원본은 끝나지 않았다.
   * 화면은 이 수를 그리기만 한다(이름·색은 코드표 `GET /meta`).
   */
  async seriesCounts(today: IsoDate = todayKst()): Promise<ScheduleSeriesCountsDto> {
    const [kinds, subs, sers] = await Promise.all([
      this.q<{ key: string; grp: string }>(`SELECT key, grp::text AS grp FROM kind ORDER BY sort, key`),
      this.q<{ key: string }>(`SELECT key FROM sub WHERE active ORDER BY sort, key`),
      this.q<{
        kind_key: string; sub_key: string | null; rrule: string; from_date: string; to_date: string | null; placed_ahead: boolean;
      }>(
        `SELECT s.kind_key, s.sub_key, s.rrule,
                to_char(s.from_date, 'YYYY-MM-DD') AS from_date,
                to_char(s.to_date, 'YYYY-MM-DD') AS to_date,
                EXISTS (SELECT 1 FROM ser_occ o
                         WHERE o.ser_id = s.id AND NOT o.canceled
                           AND ${kstDateOf('lower(o.span)')} >= $1::date) AS placed_ahead
           FROM ser s`,
        [today],
      ),
    ]);
    const byKind = new Map<string, number>();
    const bySub = new Map<string, number>();
    for (const s of sers) {
      const live = s.placed_ahead === true
        || seriesHasDateFrom({ rrule: s.rrule, fromDate: s.from_date, toDate: s.to_date }, today);
      if (!live) continue;
      byKind.set(s.kind_key, (byKind.get(s.kind_key) ?? 0) + 1);
      if (s.sub_key) bySub.set(s.sub_key, (bySub.get(s.sub_key) ?? 0) + 1);
    }
    const groups = KIND_GROUPS.map((grp) => {
      const list = kinds.filter((k) => k.grp === grp).map((k) => ({ key: k.key, count: byKind.get(k.key) ?? 0 }));
      return { grp, label: kindGroupLabel(grp), count: list.reduce((n, k) => n + k.count, 0), kinds: list };
    }).filter((g) => g.kinds.length > 0);
    return {
      asOf: today,
      total: groups.reduce((n, g) => n + g.count, 0),
      groups,
      subs: subs.map((s) => ({ key: s.key, count: bySub.get(s.key) ?? 0 })).filter((s) => s.count > 0),
    };
  }

  /**
   * §10 학생별 개인 머리 「교재 없음」 (원문 §10 데이터 줄 「ISSUE」). 학생이 없으면 null.
   * 판정은 §79·§12 와 같은 `bookHeld` — 화면은 `label` 을 그대로 적는다.
   */
  async studentBooks(studentId: number): Promise<ScheduleStudentBooksDto | null> {
    const [row] = await this.q<{ book_count: string | number }>(
      `SELECT (SELECT count(*) FROM issue i WHERE i.student_id = st.id AND ${bookHeld('i')}) AS book_count
         FROM stu st WHERE st.id = $1`,
      [studentId],
    );
    if (!row) return null;
    const bookCount = Number(row.book_count);
    return { studentId, bookCount, label: bookCount === 0 ? STUDENT_NO_BOOK_LABEL : null };
  }

  /**
   * 회차 목록. 화면 다섯이 이 하나를 쓰고 **묶는 방법만 다르다**.
   *
   * 리포트 상태를 여기서 함께 내려보내는 이유: 캘린더 블록 색이 그 값이기 때문이다.
   * 화면이 리포트를 따로 부르면 N+1 이 되고, 색이 늦게 칠해진다.
   */
  async list(q: OccQuery): Promise<OccurrenceDto[]> {
    const params: unknown[] = [q.from, q.to];
    // 표시 범위는 EXC 키(on_date)가 아니라 실제 span 날짜로 자른다. 다른 날로 옮긴 회차가
    // 원래 날에 남거나 새 날 조회에서 빠지면 date/onDate 두 칸을 둔 이유가 사라진다.
    const cond: string[] = [`${kstDateOf('lower(o.span)')} BETWEEN $1::date AND $2::date`];
    if (q.teacherId) { params.push(q.teacherId); cond.push(`o.teacher_id = $${params.length}`); }
    if (q.roomId) { params.push(q.roomId); cond.push(`o.room_id = $${params.length}`); }
    if (q.studentId) {
      params.push(q.studentId);
      cond.push(`EXISTS (
        SELECT 1 FROM ser_stu ss
         WHERE ss.ser_id = o.ser_id AND ss.student_id = $${params.length}
           -- 「이 회차만 빼기」는 규칙 명단을 보존하되 그날 학생 시간표에서는 제외한다 (D-R21).
           AND NOT EXISTS (
             SELECT 1 FROM exc e2 JOIN exc_stu_out xo ON xo.exc_id = e2.id
              WHERE e2.ser_id = o.ser_id AND e2.on_date = o.on_date
                AND xo.student_id = ss.student_id
           )
           -- 휴원 기간의 회차도 그 학생 시간표에서 빠진다 (C92-c · C-36)
           AND NOT ${stuPausedOn('ss.student_id', 'o.on_date')}
           -- 수강 종료 뒤의 회차도 (C94-c · H-80) — 명단 행은 남고 기간이 끝난 것이다
           AND ${serStuOn('ss', 'o.on_date')}
      )`);
    }

    const rows = (await this.occ.query(
      // 시각은 **회차(span)** 에서 뽑는다. 규칙(ser)에서 뽑으면 「이번만 시간 옮김」 예외가
      // 화면에 반영되지 않는다 — 예외를 승인해 놓고 시간표는 원래 시각을 보여 주게 된다.
      `SELECT o.ser_id,
              to_char(${kstDateOf('lower(o.span)')}, 'YYYY-MM-DD') AS date,
              to_char(o.on_date, 'YYYY-MM-DD') AS on_date,
              ${START_MIN} AS start_min,
              ${END_MIN} AS end_min,
              -- 회차의 실제 방식 — 예외가 바꿨으면 그 값 (N-56 · lib/sql.effectiveModeOf 한 조각)
              s.kind_key, s.sub_key, s.title, ${effectiveModeOf('e', 's')} AS mode, e.memo,
              k.rep AS reportable, k.extra AS extra,
              s.rrule, to_char(s.from_date, 'YYYY-MM-DD') AS ser_from,
              to_char(s.to_date, 'YYYY-MM-DD') AS ser_to,
              o.teacher_id, t.name AS teacher_name,
              o.room_id, rm.name AS room_name, o.zacc_id, o.canceled,
              e.cancel_kind, e.cancel_treat,
              -- 보강 링크 (C92-b · C-34): 원래 회차 → 보강이 언제인지 · 보강 회차 → 어느 회차의 보강인지
              e.makeup_ser_id,
              (SELECT to_char(ms.from_date, 'YYYY-MM-DD') FROM ser ms WHERE ms.id = e.makeup_ser_id) AS makeup_date,
              (SELECT ms.start_min FROM ser ms WHERE ms.id = e.makeup_ser_id) AS makeup_start_min,
              (SELECT to_char(mo.on_date, 'YYYY-MM-DD') FROM exc mo WHERE mo.makeup_ser_id = o.ser_id ORDER BY mo.on_date LIMIT 1) AS makeup_of_date,
              (e.id IS NOT NULL) AS has_exception,
              r.state AS rep_state,
              -- 리포트를 쓰지 않는 회차(휴강 · 출결 취소) — 리포트 목록 · 발송과 **같은 조각**이다(A′ · 한 판정)
              ${REPORT_CANCELED_SQL} AS report_canceled,
              a.id AS attendance_id, a.result AS attendance_result, a.reason AS attendance_reason,
              a.confirmed_by AS attendance_confirmed_by,
              ac.name AS attendance_confirmed_by_name,
              a.confirmed_at AS attendance_confirmed_at,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'studentId', al.student_id,
                  'studentName', late_st.name,
                  'confirmedBy', al.confirmed_by,
                  'confirmedByName', late_by.name,
                  'confirmedAt', al.confirmed_at
                ) ORDER BY al.student_id)
                  FROM att_late al
                  JOIN stu late_st ON late_st.id=al.student_id
                  JOIN staff late_by ON late_by.id=al.confirmed_by
                 WHERE al.att_id=a.id
              ), '[]'::json) AS attendance_late_students,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'id', st.id, 'name', st.name, 'grade', st.grade,
                         -- 그날만 빠진 학생은 지우지 않고 표시만 한다 (D-R21)
                         'droppedOnce', EXISTS (
                           SELECT 1 FROM exc_stu_out xo
                            WHERE xo.exc_id = e.id AND xo.student_id = st.id),
                         -- 휴원 중인 학생도 같다 — 명단에 남기고 「휴원」으로 표시한다 (C92-c)
                         'paused', ${stuPausedOn('st.id', 'o.on_date')},
                         'late', EXISTS (
                           SELECT 1 FROM att_late al
                            WHERE al.att_id=a.id AND al.student_id=st.id)
                       ) ORDER BY st.id)
                FROM ser_stu ss JOIN stu st ON st.id = ss.student_id
                -- 수강 종료 뒤의 회차에는 그 학생이 없다 — 블록의 인원·이름은 그날 명단이다 (C94-c)
                WHERE ss.ser_id = o.ser_id AND ${serStuOn('ss', 'o.on_date')}
              ), '[]'::json) AS students
         FROM ser_occ o
         JOIN ser s   ON s.id = o.ser_id
         JOIN kind k  ON k.key = s.kind_key
         LEFT JOIN staff t ON t.id = o.teacher_id
         LEFT JOIN room rm ON rm.id = o.room_id
         LEFT JOIN exc e   ON e.ser_id = o.ser_id AND e.on_date = o.on_date
         LEFT JOIN rep r   ON r.ser_id = o.ser_id AND r.on_date = o.on_date
         LEFT JOIN att a   ON a.ser_id = o.ser_id AND a.on_date = o.on_date
         LEFT JOIN staff ac ON ac.id = a.confirmed_by
        WHERE ${cond.join(' AND ')}
        -- **회차의 시각**으로 정렬한다. 규칙(ser.start_min)으로 정렬하면
        -- 「이번만 시간 옮김」한 수업이 옮기기 전 자리에 그려진다 — 시각은 span 에서 뽑아 놓고
        -- 순서만 규칙을 보던 자리였다.
        ORDER BY o.on_date, lower(o.span), o.ser_id`,
      params,
    )) as Row[];

    const today = todayKst();
    const nowMin = nowMinKst();
    return rows.map((r) => {
      const when = { date: r.date, startMin: r.start_min, durationMin: r.end_min - r.start_min };
      // 「끝났는가」를 먼저 한 번 구해서 리포트 상태와 DTO 가 **같은 값**을 쓴다.
      // 두 번 구하면 자정·수업 종료 순간에 둘이 갈린다.
      const ended = isPast(when, today, nowMin);
      // na/plan/none 은 회차 시각에서 파생한다. 오래된 잘못된 시드와 리포트 행이 없는
      // 신규 수업도 같은 규칙을 타므로 화면마다 상태가 갈라지지 않는다.
      // 휴강 · 출결 취소한 회차는 리포트 대상이 아니다(na) — 리포트 목록(toRow)과 같은 식이라, 이미 올린 리포트가 있어도
      // 두 목록이 같은 낱말을 쓴다. 전에는 출결 취소만 빼서 휴강 회차가 「리포트 미제출」·「리포트」 보기 빨강에 섰다.
      const repState = effectiveRepStateFromEnded(
        r.rep_state,
        r.reportable && !r.report_canceled,
        ended,
      );
      return {
        serId: Number(r.ser_id),
        // 그릴 날짜와 EXC 키를 **둘 다** 내려보낸다. 옮긴 회차는 둘이 다르고,
        // 쓰기는 원래 날짜로만 예외를 찾는다.
        date: r.date,
        onDate: r.on_date,
        startMin: r.start_min,
        endMin: r.end_min,
        kindKey: r.kind_key,
        extra: r.extra === true,
        subKey: r.sub_key,
        title: r.title,
        rrule: r.rrule,
        fromDate: r.ser_from,
        toDate: r.ser_to,
        teacherId: r.teacher_id ? Number(r.teacher_id) : null,
        teacherName: r.teacher_name,
        roomId: r.room_id ? Number(r.room_id) : null,
        roomName: r.room_name,
        zaccId: r.zacc_id ? Number(r.zacc_id) : null,
        mode: r.mode,
        // 회차 메모 한 줄 (N-57) — 블록 「노트」 배지와 수업 상세의 회차 메모 줄이 읽는다
        memo: r.memo ?? null,
        canceled: r.canceled,
        // 휴강의 사유·처리와 그 낱말 — 취소된 회차만, 옛 휴강은 null (기본 정책 이월 · C92)
        cancelKind: r.canceled ? (r.cancel_kind ?? null) : null,
        cancelKindLabel: r.canceled && r.cancel_kind ? ATTENDANCE_CANCEL_REASON_LABEL[r.cancel_kind] ?? null : null,
        cancelTreat: r.canceled ? (r.cancel_treat ?? null) : null,
        cancelTreatLabel: r.canceled && r.cancel_treat ? CANCEL_TREAT_LABEL[r.cancel_treat] ?? null : null,
        makeupSerId: r.canceled && r.makeup_ser_id ? Number(r.makeup_ser_id) : null,
        makeupDate: r.canceled && r.makeup_ser_id ? r.makeup_date : null,
        makeupStartMin: r.canceled && r.makeup_ser_id && r.makeup_start_min !== null ? Number(r.makeup_start_min) : null,
        makeupOfDate: r.makeup_of_date ?? null,
        hasException: r.has_exception,
        // 「물어야 하는가」는 규칙이 정한다 — 화면은 이 값만 본다 (§5A.0). 남은 회차는
        // **이 회차의 날짜부터** 센다: 마지막 한 회만 남은 반복은 단발처럼 바로 저장한다.
        recurring: isRecurring(
          { rrule: r.rrule, fromDate: r.ser_from, toDate: r.ser_to } as Ser,
          r.on_date,
        ),
        repState,
        ended,
        // 판정은 rules.ts 한 곳에서만 한다 — 화면도 서버도 여기서 나온 값을 읽기만 한다
        written: isWrittenDbState(repState),
        attendanceMode: canEditAttendance(
          { ...when, canceled: r.canceled },
          { canCrudAttendance: q.canCrudAttendance ?? false, today, nowMin },
        ),
        attendance: r.attendance_id == null ? null : {
          id: Number(r.attendance_id),
          result: r.attendance_result!,
          reason: r.attendance_reason,
          confirmedBy: Number(r.attendance_confirmed_by),
          confirmedByName: r.attendance_confirmed_by_name!,
          confirmedAt: new Date(r.attendance_confirmed_at!).toISOString(),
          countsForPay: r.attendance_result === 'completed',
          lateStudents: (r.attendance_late_students ?? []).map((late) => ({
            studentId: Number(late.studentId), studentName: late.studentName,
            confirmedBy: Number(late.confirmedBy), confirmedByName: late.confirmedByName,
            confirmedAt: new Date(late.confirmedAt).toISOString(),
          })),
        },
        students: (r.students ?? []).map((s) => ({
          id: Number(s.id), name: s.name, grade: s.grade, droppedOnce: Boolean(s.droppedOnce),
          paused: Boolean(s.paused), late: Boolean(s.late),
        })),
      };
    });
  }

  /**
   * 겹침 미리보기 — **누구와 겹치는지**를 돌려준다 (§19).
   *
   * DB 의 EXCLUDE 가 어차피 막지만(D-R43), 409 만 던지면 화면은 「안 됩니다」밖에 못 쓴다.
   * 사람이 시간을 고치려면 *무엇과* 겹치는지를 알아야 한다. 막는 것은 DB 가, 설명은 여기가 한다 —
   * 여기서 통과했다고 저장을 건너뛰지 않는다. 이 사이에 남이 잡을 수 있기 때문이다.
   */
  async conflicts(q: {
    onDate: string; startMin: number; endMin: number;
    teacherId?: number | null; roomId?: number | null; zaccId?: number | null;
    exceptSerId?: number | null;
  }): Promise<Array<{ serId: number; onDate: string; startMin: number; endMin: number; title: string | null; with: 'teacher' | 'room' | 'zoom'; whoName: string | null }>> {
    const who: Array<['teacher' | 'room' | 'zoom', string, number]> = [];
    if (q.teacherId) who.push(['teacher', 'o.teacher_id', q.teacherId]);
    if (q.roomId) who.push(['room', 'o.room_id', q.roomId]);
    if (q.zaccId) who.push(['zoom', 'o.zacc_id', q.zaccId]);
    if (who.length === 0) return [];

    const out: Array<{ serId: number; onDate: string; startMin: number; endMin: number; title: string | null; with: 'teacher' | 'room' | 'zoom'; whoName: string | null }> = [];
    for (const [label, col, id] of who) {
      const rows = (await this.occ.query(
        // 겹침의 정의는 **DB 의 EXCLUDE 와 같은 것**을 쓴다 (`span &&`).
        // 분으로 되돌려 비교하면 자정을 넘는 회차에서 둘의 답이 갈린다.
        `SELECT o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date,
                ${START_MIN} AS start_min,
                ${END_MIN} AS end_min,
                COALESCE(s.title, k.name) AS title,
                CASE WHEN $5 = 'teacher' THEN t.name WHEN $5 = 'room' THEN rm.name ELSE z.label END AS who_name
           FROM ser_occ o
           JOIN ser s ON s.id = o.ser_id
           LEFT JOIN kind k ON k.key = s.kind_key
           LEFT JOIN staff t ON t.id = o.teacher_id
           LEFT JOIN room rm ON rm.id = o.room_id
           LEFT JOIN zacc z ON z.id = o.zacc_id
          WHERE NOT o.canceled
            AND ${col} = $1
            AND o.span && ${spanOf('$2', '$3', '$4')}
            AND ($6::bigint IS NULL OR o.ser_id <> $6)
          ORDER BY lower(o.span)`,
        [id, q.onDate, q.startMin, q.endMin, label, q.exceptSerId ?? null],
      )) as Array<Record<string, unknown>>;
      for (const r of rows) {
        out.push({
          serId: Number(r.ser_id), onDate: String(r.on_date),
          startMin: Number(r.start_min), endMin: Number(r.end_min),
          title: r.title === null || r.title === undefined ? null : String(r.title),
          with: label, whoName: r.who_name === null || r.who_name === undefined ? null : String(r.who_name),
        });
      }
    }
    return out;
  }

  /**
   * 409 뒤 설명 한 줄 — **그 시각 비어 있는 강의실 · 줌 계정 이름**(각 최대 셋 · N-70 채택 ②).
   *
   * 누를 수 없고 미리 잡지 않는다 — 제안한 순간과 누른 순간 사이의 경쟁을 만들지 않는다(막는 것은 그대로 DB · C84-b).
   * 「비어 있다」는 §21 「지금 가능」과 같은 판정이다: **쓰는 계정·강의실(active)** 중 그 구간에 취소 아닌 회차(`ser_occ`)가
   * 하나도 없는 것. 시각은 EXCLUDE 와 같은 `span &&` 로 본다. 물은 자원 종류만 적는다 — 강의실을 묻지 않았으면
   * 강의실 줄이 없다. 옮기는 수업 자신(exceptSerId)은 자리를 비워 줄 것이므로 세지 않는다. 시간을 옮기자는 제안은 하지 않는다.
   */
  async freeLine(q: {
    onDate: string; startMin: number; endMin: number;
    roomId?: number | null; zaccId?: number | null; exceptSerId?: number | null;
  }): Promise<string | null> {
    const parts: string[] = [];
    const busy = (col: string) => `NOT EXISTS (
      SELECT 1 FROM ser_occ o
       WHERE ${col} AND NOT o.canceled
         AND o.span && ${spanOf('$2', '$3', '$4')}
         AND ($5::bigint IS NULL OR o.ser_id <> $5))`;
    const args = (id: number) => [id, q.onDate, q.startMin, q.endMin, q.exceptSerId ?? null];
    if (q.roomId) {
      const rooms = await this.q<{ name: string }>(
        `SELECT rm.name FROM room rm
          WHERE rm.active AND rm.id <> $1 AND ${busy('o.room_id = rm.id')}
          ORDER BY rm.id LIMIT 3`,
        args(q.roomId),
      );
      parts.push(rooms.length
        ? `그 시각 비어 있는 강의실 — ${rooms.map((r) => r.name).join(' · ')}`
        : '그 시각 비어 있는 다른 강의실이 없습니다');
    }
    if (q.zaccId) {
      const accounts = await this.q<{ label: string }>(
        `SELECT z.label FROM zacc z
          WHERE z.active AND z.id <> $1 AND ${busy('o.zacc_id = z.id')}
          ORDER BY z.id LIMIT 3`,
        args(q.zaccId),
      );
      parts.push(accounts.length
        ? `그 시각 비어 있는 줌 계정 — ${accounts.map((a) => a.label).join(' · ')}`
        : '그 시각 비어 있는 다른 줌 계정이 없습니다');
    }
    return parts.length ? parts.join(' / ') : null;
  }

  /**
   * §11 선생님별 개인 도구줄 「안내 N」 (N-100 채택 ⓐ) — 그 강사에게 **보냈는데 강사가 아직 확인하지 않은** 안내 수.
   * 안내의 S4 상태 그대로다: 보냄(`sent`) → 강사가 확인하면 읽음(`read`). 안내 화면 머리의 「강사 미확인」과
   * 같은 판정(`guides.service` stats.teacherUnconfirmed · 확인 단추 `canAck`)이다. 읽기 전용 — 안내 표를 쓰지 않는다.
   */
  async teacherGuides(teacherId: number): Promise<ScheduleTeacherGuidesDto | null> {
    const [row] = await this.q<{ n: number }>(
      `SELECT (SELECT count(*)::int FROM guide g WHERE g.teacher_id = st.id AND g.state = 'sent') AS n
         FROM staff st WHERE st.id = $1`,
      [teacherId],
    );
    if (!row) return null;
    return { teacherId, unconfirmed: Number(row.n) };
  }

  /* ══ §79 수강 학생 — 학생 트래킹 (C55) ═════════════════════════════════ */

  /**
   * 원문 §79 의 오른쪽 칸. 학생마다 교재·안내·30일 출결·미수와 **최신 리포트 3건**을 싣는다.
   *
   * 회차 목록에 끼워 넣지 않는 이유: 한 주치 회차마다 학생별 질의가 붙는다.
   * 이 창은 눌러야 열리므로 **열 때 한 번** 부른다.
   *
   * 「진도 평균」은 `ISSUE.progress_page / LIB.pages`의 기존 `progressPercent` 산식을 재사용한다.
   * 쪽수를 아는 배부 완료 교재를 책별 동일가중하고, 알려진 책이 없으면 0%가 아니라 null이다.
   */
  async tracking(
    serId: number,
    onDate: string,
    canSeeAmounts: boolean,
  ): Promise<LessonTrackingDto | null> {
    const today = todayKst();

    const [head] = (await this.q(
      `SELECT s.id, s.kind_key, s.sub_key, k.cap,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'id', st.id, 'name', st.name, 'grade', st.grade,
                  'droppedOnce', EXISTS (
                    SELECT 1 FROM exc e JOIN exc_stu_out xo ON xo.exc_id = e.id
                     WHERE e.ser_id = s.id AND e.on_date = $2::date AND xo.student_id = st.id
                  ),
                  'paused', ${stuPausedOn('st.id', '$2::date')},
                  -- 수강 종료 (C94-c · H-80) — 명단 행은 남고 to_date 가 끝났다. 카드는 「종료 M/D」로 보이고 인원·단가에서 빠진다
                  'ended', ${serStuEndedOn('ss', '$2::date')},
                  'endedOn', to_char(ss.to_date, 'YYYY-MM-DD'),
                  -- 학생 카드의 「휴원」 — 지금 진행 중이거나 앞으로 잡힌 기간 하나 (C92-c · C-36/C-37)
                  'pause', (SELECT json_build_object('id', sp.id, 'fromDate', to_char(sp.from_date,'YYYY-MM-DD'),
                                                     'toDate', to_char(sp.to_date,'YYYY-MM-DD'), 'reason', sp.reason,
                                                     'resumed', sp.resumed_at IS NOT NULL)
                              FROM stu_pause sp
                             WHERE sp.student_id = st.id AND (sp.to_date IS NULL OR sp.to_date >= $3::date)
                             ORDER BY sp.from_date LIMIT 1)
                ) ORDER BY st.name)
                FROM ser_stu ss JOIN stu st ON st.id = ss.student_id
               WHERE ss.ser_id = s.id
              ), '[]'::json) AS students
         FROM ser s
         JOIN kind k ON k.key = s.kind_key
         -- 상세는 목록에서 연 실제 회차 하나만 받는다. 같은 SER의 임의 날짜로 가격·명단
         -- 스냅숏을 만들지 않도록 물리 회차의 원래 날짜 키를 함께 검증한다.
         JOIN ser_occ o ON o.ser_id = s.id AND o.on_date = $2::date
        WHERE s.id = $1`,
      [serId, onDate, today],
    )) as Array<Record<string, unknown>>;
    if (!head) return null;

    const roster = (head.students ?? []) as Array<{
      id: number; name: string; grade: string | null; droppedOnce: boolean; paused: boolean;
      ended: boolean; endedOn: string | null;
      pause: { id: number; fromDate: string; toDate: string | null; reason: string | null; resumed: boolean } | null;
    }>;
    // 그날 빠졌거나 휴원 중이거나 수강 종료 뒤면 그날 명단이 아니다 — 정원·단가도 그 수로 센다 (N-136 「남은 학생 단가가 다시 계산된다」)
    const active = roster.filter((r) => !r.droppedOnce && !r.paused && !r.ended);
    const ids = roster.map((r) => r.id);
    const cap = Number(head.cap);
    const count = active.length;
    const canAdd = Math.max(0, cap - count);

    // 가격은 명단 쓰기 응답과 **같은 함수**에서 나온다 (lib/rules.rosterPricing · §54 · D-R22)
    const tiers = (await this.q(
      `SELECT DISTINCT ON (heads) heads, unit_price
         FROM rate
        WHERE kind_key = $1 AND sub_key IS NOT DISTINCT FROM $2 AND from_date <= $3
        ORDER BY heads, from_date DESC, id DESC`,
      [head.kind_key, head.sub_key ?? null, onDate],
    )) as Array<{ heads: number; unit_price: number }>;
    const overrides = active.length ? (await this.q(
      `SELECT DISTINCT ON (st.id) st.id, r.unit_price
         FROM stu st
         LEFT JOIN sturate r
           ON r.student_id = st.id AND (r.kind_key IS NULL OR r.kind_key = $2) AND r.from_date <= $3
        WHERE st.id = ANY($1::bigint[])
        ORDER BY st.id, r.from_date DESC NULLS LAST, r.id DESC`,
      [active.map((a) => a.id), head.kind_key, onDate],
    )) as Array<{ unit_price: number | null }> : [];
    const pricing = rosterPricing(
      tiers.map((t) => ({ heads: Number(t.heads), unitPrice: Number(t.unit_price) })),
      overrides.map((o) => (o.unit_price === null || o.unit_price === undefined ? null : Number(o.unit_price))),
    );

    const students: TrackedStudentDto[] = roster.map((r) => ({
      ...r, bookCount: 0, progressAverage: null, progressKnownBooks: 0,
      guided: false, attendDone: 0, attendTotal: 0,
      unpaid: canSeeAmounts ? 0 : null, reports: [], notes: [], noteCount: 0,
    }));

    if (ids.length > 0) {
      const byId = new Map(students.map((s) => [s.id, s]));

      const facts = (await this.q(
        `SELECT st.id,
                (SELECT count(*) FROM issue i
                  WHERE i.student_id = st.id AND ${bookHeld('i')}) AS book_count,
                COALESCE((
                  SELECT json_agg(json_build_object('page', i.progress_page, 'pages', l.pages) ORDER BY i.id)
                    FROM issue i JOIN lib l ON l.id = i.lib_id
                   WHERE i.student_id = st.id AND ${bookHeld('i')}
                     AND i.progress_page IS NOT NULL AND l.pages IS NOT NULL AND l.pages > 0
                ), '[]'::json) AS progress_books,
                EXISTS (
                  SELECT 1 FROM guide g
                   WHERE g.ser_id = $2 AND g.student_id = st.id
                     AND g.state::text = ANY($3::text[])
                ) AS guided,
                -- 30일 출결: **확정된 것만** 센다. 그날 빠진 회차는 분모에도 없다
                (SELECT count(*) FROM att a
                   JOIN ser_stu ss2 ON ss2.ser_id = a.ser_id AND ss2.student_id = st.id AND ${serStuOn('ss2', 'a.on_date')}
                  WHERE a.on_date > $4::date - 30 AND a.on_date <= $4::date
                    AND NOT EXISTS (
                      SELECT 1 FROM exc e JOIN exc_stu_out xo ON xo.exc_id = e.id
                       WHERE e.ser_id = a.ser_id AND e.on_date = a.on_date AND xo.student_id = st.id
                    )) AS att_total,
                (SELECT count(*) FROM att a
                   JOIN ser_stu ss2 ON ss2.ser_id = a.ser_id AND ss2.student_id = st.id AND ${serStuOn('ss2', 'a.on_date')}
                  WHERE a.on_date > $4::date - 30 AND a.on_date <= $4::date
                    AND a.result = 'completed'
                    AND NOT EXISTS (
                      SELECT 1 FROM exc e JOIN exc_stu_out xo ON xo.exc_id = e.id
                       WHERE e.ser_id = a.ser_id AND e.on_date = a.on_date AND xo.student_id = st.id
                    )) AS att_done,
                COALESCE((SELECT sum(i.amount - i.paid_amount) FROM inv i
                   WHERE i.student_id = st.id AND i.state IN ('sent','unpaid','partial')), 0) AS unpaid
           FROM stu st WHERE st.id = ANY($1::bigint[])`,
        [ids, serId, [...GUIDE_DONE_DB], today],
      )) as Array<Record<string, unknown>>;
      for (const f of facts) {
        const s = byId.get(Number(f.id));
        if (!s) continue;
        s.bookCount = Number(f.book_count);
        const progressValues = ((f.progress_books ?? []) as Array<{ page: number | string; pages: number | string }>)
          .map((book) => progressPercent(Number(book.page), Number(book.pages)))
          .filter((value): value is number => value !== null);
        s.progressKnownBooks = progressValues.length;
        s.progressAverage = progressValues.length
          ? Math.round(progressValues.reduce((sum, value) => sum + value, 0) / progressValues.length)
          : null;
        s.guided = f.guided === true;
        s.attendTotal = Number(f.att_total);
        s.attendDone = Number(f.att_done);
        // 금액은 대표만 (D-R39) — 0 원과 「가려짐」을 화면이 구분할 수 있게 0 을 null 로 바꾸지 않는다
        s.unpaid = canSeeAmounts ? Number(f.unpaid) : null;
      }

      const reps = (await this.q(
        `SELECT * FROM (
           SELECT rs.student_id, r.id AS rep_id, to_char(r.on_date,'YYYY-MM-DD') AS on_date,
                  COALESCE(sb.name, s.title, k.name) AS subject_name, t.name AS teacher_name,
                  r.body, r.submitted_at,
                  to_char(upper(o.span) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_utc,
                  row_number() OVER (PARTITION BY rs.student_id ORDER BY r.on_date DESC, r.id DESC) AS rn
             FROM rep r
             JOIN rep_stu rs ON rs.rep_id = r.id
             JOIN ser s ON s.id = r.ser_id
             JOIN kind k ON k.key = COALESCE(r.kind_key, s.kind_key)
             LEFT JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
             LEFT JOIN sub sb ON sb.key = s.sub_key
             LEFT JOIN staff t ON t.id = COALESCE(o.teacher_id, r.teacher_id)
            WHERE rs.student_id = ANY($1::bigint[]) AND r.state::text = ANY($2::text[])
         ) q WHERE rn <= 3 ORDER BY student_id, on_date DESC`,
        [ids, [...REPORT_WRITTEN_DB]],
      )) as Array<Record<string, unknown>>;
      for (const r of reps) {
        const s = byId.get(Number(r.student_id));
        if (!s) continue;
        s.reports.push(ScheduleService.toTrackedReport(r));
      }

      // 인수인계 메모 (N-36 ② · W11 M2) — 학생 단위 · 최근 스무 줄 + 전체 줄 수
      const notes = (await this.q(
        `SELECT * FROM (
           SELECT n.id, n.student_id, n.body, w.name AS author_name, ${kstAt('n.created_at')} AS created_at,
                  row_number() OVER (PARTITION BY n.student_id ORDER BY n.created_at DESC, n.id DESC) AS rn,
                  count(*) OVER (PARTITION BY n.student_id) AS total
             FROM note n LEFT JOIN staff w ON w.id = n.author_id
            WHERE n.student_id = ANY($1::bigint[])
         ) x WHERE rn <= 20 ORDER BY student_id, rn`,
        [ids],
      )) as Array<Record<string, unknown>>;
      for (const n of notes) {
        const s = byId.get(Number(n.student_id));
        if (!s) continue;
        s.notes.push({ id: Number(n.id), body: String(n.body), authorName: (n.author_name as string) ?? null, createdAt: String(n.created_at) });
        s.noteCount = Number(n.total);
      }
    }

    const prep = await this.prepRows(serId, onDate, {
      cap, count, active: active.map((a) => a.name), roster: roster.map((r) => r.id),
    });
    const prepDone = prep.filter((r) => r.done).length;
    const remain = prep.length - prepDone;

    return {
      prep,
      prepDone,
      prepTotal: prep.length,
      // 원문 머리 그대로 — 「3가지 남았습니다」. 화면이 빼기를 다시 하지 않는다 (D-R37)
      prepRemainLabel: remain > 0 ? `${remain}가지 남았습니다` : '다 됐습니다',
      serId, onDate, cap, count, canAdd,
      // 원문 머리줄 그대로 — 화면이 cap − count 를 다시 하지 않는다 (D-R37)
      capLabel: count > cap
        ? `정원 ${cap}명 · ${count - cap}명 넘었습니다`
        : canAdd > 0
          ? `정원 ${cap}명 · ${canAdd}명 더 넣을 수 있습니다`
          : `정원 ${cap}명 · 자리가 없습니다`,
      priced: pricing !== null,
      unitPrice: canSeeAmounts && pricing ? pricing.unitPrice : null,
      total: canSeeAmounts && pricing ? pricing.total : null,
      canSeeAmounts,
      students,
    };
  }

  /**
   * 인수인계 메모 한 줄 더하기 (N-36 ② · W11 M2) — §79 학생 트래킹의 「메모 남기기」.
   *
   * **더하기만 있다** — 고치기 · 지우기는 경로가 없다(누가 언제 무엇을 넘겼는지가 그대로 남아야 한다 · 표는 note).
   * 수업 맥락(`serId`)을 주면 그 학생이 그 명단에 있어야 한다 — 남의 수업 카드에서 엉뚱한 학생에게 적지 않게.
   * 읽는 쪽은 §79 카드(관리자 · 매니저)와 그 학생을 맡은 강사의 수업 안내 학생 카드뿐이다. 학부모에게는 나가지 않는다.
   */
  async addNote(authorId: number, dto: NoteCreateDto): Promise<TrackedNoteDto> {
    const body = dto.body.trim();
    if (!body) throw new BadRequestException({ code: 'NOTE_EMPTY', message: '메모가 비었습니다 — 한 줄이라도 적어 주세요' });
    return this.occ.manager.transaction(async (m) => {
      const [stu] = (await m.query(`SELECT id FROM stu WHERE id = $1 FOR KEY SHARE`, [dto.studentId])) as Array<{ id: string }>;
      if (!stu) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '그 학생을 찾을 수 없습니다' });
      const serId = dto.serId ?? null;
      if (serId !== null) {
        const [on] = (await m.query(
          `SELECT 1 AS hit FROM ser_stu ss JOIN ser s ON s.id = ss.ser_id WHERE ss.ser_id = $1 AND ss.student_id = $2 FOR KEY SHARE OF s`,
          [serId, dto.studentId],
        )) as Array<{ hit: number }>;
        if (!on) throw new NotFoundException({ code: 'NOTE_TARGET_NOT_FOUND', message: '그 수업의 명단에 없는 학생입니다' });
      }
      const [made] = (await m.query(
        `INSERT INTO note (student_id, ser_id, author_id, body) VALUES ($1, $2, $3, $4)
         RETURNING id, body, ${kstAt('created_at')} AS created_at`,
        [dto.studentId, serId, authorId, body],
      )) as Array<{ id: string; body: string; created_at: string }>;
      const [who] = (await m.query(`SELECT name FROM staff WHERE id = $1`, [authorId])) as Array<{ name: string }>;
      return { id: Number(made.id), body: made.body, authorName: who?.name ?? null, createdAt: made.created_at };
    });
  }

  /** 원문의 날짜 문장 — 「26년 8월 21일 금요일」 */
  private static readonly KO_DOW = ['일', '월', '화', '수', '목', '금', '토'];

  private static whenLabel(drawnDate: string, from: string, to: string): string {
    const d = new Date(`${drawnDate}T00:00:00Z`);
    const dow = ScheduleService.KO_DOW[d.getUTCDay()];
    return `${drawnDate.slice(2, 4)}년 ${+drawnDate.slice(5, 7)}월 ${+drawnDate.slice(8, 10)}일 ${dow}요일 ${from}-${to}`;
  }

  /**
   * §12 준비 줄 — **원문 두 컷이 정한 목록**이다 (C82-b 원장).
   *
   * 기본 일곱: 일정 확정 · 강사 배정 · 수강 학생 · (강의실|줌 계정) · 교재 배정 · 수업 안내 · 강사 피드백.
   * 온라인이면 「줌 안내」가 더 서고(§12 아홉 줄 · §79 일곱 줄의 차이),
   * **그 회차에 걸린 대표 지시가 있으면** 「대표 지시 할 일」이 맨 위에 더 선다.
   *
   * 판정도 낱말도 여기서 한 번만 만든다 — 화면이 다시 판정하면 현황판과 갈린다 (D-R39 · D-R18).
   */
  private async prepRows(
    serId: number,
    onDate: string,
    ctx: { cap: number; count: number; active: string[]; roster: number[] },
  ): Promise<LessonPrepRowDto[]> {
    const [f] = (await this.q(
      `SELECT ${effectiveModeOf('e', 's')} AS mode,
              to_char(lower(o.span) AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS drawn_date,
              to_char(lower(o.span) AT TIME ZONE 'Asia/Seoul','HH24:MI') AS from_hm,
              to_char(upper(o.span) AT TIME ZONE 'Asia/Seoul','HH24:MI') AS to_hm,
              t.name  AS teacher_name,
              rm.name AS room_name,
              za.label AS zacc_label,
              -- 회차 예외 대상 배정(변동)이 규칙 배정(고정)보다 먼저다 — 투영(zaccOf)과 같은 차례 (N-56)
              (SELECT z.fixed FROM zassign z
                WHERE z.exc_id = e.id OR z.ser_id = s.id ORDER BY z.exc_id NULLS LAST, z.id DESC LIMIT 1) AS zacc_fixed,
              (SELECT g.state::text FROM guide g
                WHERE g.ser_id = s.id ORDER BY g.created_at DESC LIMIT 1) AS guide_state,
              (SELECT r.state::text FROM rep r WHERE r.ser_id = s.id AND r.on_date = $2::date) AS rep_state,
              (SELECT to_char(COALESCE(r.submitted_at, r.written_at) AT TIME ZONE 'Asia/Seoul','MM-DD HH24:MI')
                 FROM rep r WHERE r.ser_id = s.id AND r.on_date = $2::date) AS rep_at,
              (SELECT count(*)::int FROM todo td
                WHERE td.src = 'lesson' AND td.ser_id = s.id AND td.on_date = $2::date) AS todo_total,
              (SELECT count(*)::int FROM todo td
                WHERE td.src = 'lesson' AND td.ser_id = s.id AND td.on_date = $2::date AND td.done) AS todo_done,
              (SELECT count(*)::int FROM pnoti p
                WHERE p.ser_id = s.id AND p.on_date = $2::date
                  AND p.audience = 'parent' AND p.sent_at IS NOT NULL) AS parent_sent,
              (SELECT count(*)::int FROM pnoti p
                WHERE p.ser_id = s.id AND p.on_date = $2::date
                  AND p.audience = 'parent') AS parent_total,
              (SELECT count(*)::int FROM pnoti p
                WHERE p.ser_id = s.id AND p.on_date = $2::date
                  AND p.audience = 'teacher' AND p.sent_at IS NOT NULL) AS teacher_sent
         FROM ser s
         JOIN ser_occ o ON o.ser_id = s.id AND o.on_date = $2::date
         LEFT JOIN exc e ON e.ser_id = s.id AND e.on_date = $2::date
         LEFT JOIN staff t ON t.id = o.teacher_id
         LEFT JOIN room rm ON rm.id = o.room_id
         LEFT JOIN zacc za ON za.id = o.zacc_id
        WHERE s.id = $1`,
      [serId, onDate],
    )) as Array<Record<string, unknown>>;
    if (!f) return [];

    const online = String(f.mode) === 'online';
    const rows: LessonPrepRowDto[] = [];

    /* 있을 때만 서는 줄 — 지시가 0건이면 원문 §79 처럼 줄 자체가 없다 */
    const todoTotal = Number(f.todo_total ?? 0);
    if (todoTotal > 0) {
      const todoDone = Number(f.todo_done ?? 0);
      rows.push({
        key: 'directive', label: '대표 지시 할 일',
        done: todoDone === todoTotal,
        detail: `${todoDone}/${todoTotal} 끝남`,
      });
    }

    rows.push({
      key: 'fixed', label: '일정 확정', done: true,
      // 회차가 있다는 것이 곧 확정이다. 날짜는 **그려지는 날**이라 옮긴 회차도 옳게 적힌다
      detail: ScheduleService.whenLabel(String(f.drawn_date), String(f.from_hm), String(f.to_hm)),
    });

    rows.push({
      key: 'teacher', label: '강사 배정',
      done: f.teacher_name !== null && f.teacher_name !== undefined,
      detail: (f.teacher_name as string | null) ?? '아직 없습니다',
    });

    rows.push({
      key: 'roster', label: '수강 학생',
      done: ctx.count > 0,
      detail: ctx.count > 0
        ? `${ctx.count}명 / 정원 ${ctx.cap}명 · ${ctx.active.join(', ')}`
        : `0명 / 정원 ${ctx.cap}명`,
    });

    if (online) {
      const label = f.zacc_label as string | null;
      rows.push({
        key: 'zacc', label: '줌 계정',
        done: label !== null && label !== undefined,
        // 원문 「Study · 변동」 — 고정 배정인지 변동인지가 함께 적힌다
        detail: label ? `${label} · ${f.zacc_fixed === false ? '변동' : '고정'}` : '아직 없습니다',
      });
    } else {
      rows.push({
        key: 'room', label: '강의실',
        done: f.room_name !== null && f.room_name !== undefined,
        detail: (f.room_name as string | null) ?? '아직 없습니다',
      });
    }

    /* 교재는 학생마다다 — 원문은 못 받은 사람의 이름을 적는다 (「이담흔 없음」) */
    const missing = ctx.roster.length
      ? ((await this.q(
          `SELECT st.name FROM stu st
            WHERE st.id = ANY($1::bigint[])
              AND NOT EXISTS (SELECT 1 FROM issue i WHERE i.student_id = st.id AND ${bookHeld('i')})
            ORDER BY st.name`,
          [ctx.roster],
        )) as Array<{ name: string }>).map((r) => r.name)
      : [];
    rows.push({
      key: 'book', label: '교재 배정',
      done: ctx.roster.length > 0 && missing.length === 0,
      detail: ctx.roster.length === 0 ? '학생이 없습니다'
        : missing.length ? `${missing.join(', ')} 없음`
        : `${ctx.roster.length}명 배부`,
    });

    const guideState = f.guide_state as string | null;
    rows.push({
      key: 'guide', label: '수업 안내',
      done: guideState !== null && GUIDE_DONE_DB.includes(guideState as never),
      detail: guideState ? guideLabel(guideState) : '작성되지 않았습니다',
    });

    if (online) {
      /*
       * 원문 「학부모 없음 · 강사 대기」 모양 그대로 — 학부모 칸과 강사 칸을 나란히 적는다.
       * DQ3(2026-09-25)로 학부모 수신처(보호자)와 선택 발송이 생겼다. 학부모 칸은 이제 그 회차의 학부모 안내 줄(PNOTI parent)
       * 중 **실제로 나간 것**(`sent_at` — 보호자 발송이 한 건이라도 성공했을 때만 찍힌다)을 센다. 줄이 없으면 「없음」이다.
       * 줄의 완료(done)는 전과 같이 강사 안내다 — 학부모 채널 설정이 없는 환경에서 준비가 영영 안 끝나지 않게 한다.
       */
      const teacherSent = Number(f.teacher_sent ?? 0) > 0;
      const parentTotal = Number(f.parent_total ?? 0);
      const parentSent = Number(f.parent_sent ?? 0);
      rows.push({
        key: 'zoomNoti', label: '줌 안내',
        done: teacherSent,
        detail: `${parentTotal === 0 ? '학부모 없음' : `학부모 ${parentSent}/${parentTotal} 보냄`} · 강사 ${teacherSent ? '보냄' : '대기'}`,
      });
    }

    const repState = f.rep_state as string | null;
    rows.push({
      key: 'feedback', label: '강사 피드백',
      done: repState === 'ok',
      // 원문 「ok · 08-21 10:35」 모양 — 상태와 시각. 상태는 코드값 대신 낱말로 적는다(REP_STATE_LABEL_DB · QA 0925 H14)
      detail: repState
        ? (() => {
          const word = REP_STATE_LABEL_DB[repState as RepStateDb] ?? repState;
          return f.rep_at ? `${word} · ${f.rep_at}` : word;
        })()
        : '아직 없습니다',
    });

    return rows;
  }

  /** 「정시 / 지연」은 `tierFor` 한 곳이 정한다 — 강사 화면의 차감액과 같은 판정이다 (D-R32) */
  private static toTrackedReport(r: Record<string, unknown>): TrackedReportDto {
    const body = (r.body ?? {}) as Record<string, unknown>;
    const end = r.end_utc ? new Date(String(r.end_utc)) : null;
    const submitted = r.submitted_at ? new Date(r.submitted_at as string) : null;
    const after = end && submitted ? Math.floor((submitted.getTime() - end.getTime()) / 60000) : 0;
    const onTime = tierFor(Math.max(0, after)).amount === 0;
    const text = typeof body.content === 'string' ? body.content : null;
    return {
      repId: Number(r.rep_id),
      onDate: String(r.on_date),
      subjectName: (r.subject_name as string) ?? null,
      teacherName: (r.teacher_name as string) ?? null,
      onTime,
      onTimeLabel: onTime ? '정시' : '지연',
      excerpt: text,
      homework: typeof body.homework === 'string' ? body.homework : null,
    };
  }
}
