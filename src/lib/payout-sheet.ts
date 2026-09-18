/** @file-guide
 * 목적: payout-sheet.ts — payoutSheet, TEACHER_OF_OCC (util)
 * 책임/재사용: 강사 한 사람 한 달의 정산 시트를 회차·리포트·시급에서 세는 한 곳. 강사 히스토리(§57 강사 화면)와 §57 지급 확정이 같은 함수를 부른다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 강사료 시트 — C94-b (테스트 시나리오 H-82 · O-148 · D-43).
 *
 * 규칙은 전부 `lib/rules` 한 곳이다 — 「리포트를 썼는가」(D-R7 · 승인 여부 무관) · 지각 차감(D-R32) · 원천징수(D-15).
 * 여기 있는 것은 그 규칙을 **한 달 한 강사의 회차에 적용해 더하는 일**뿐이다. 세는 것을 두 곳(강사 화면 · 대표 정산)이
 * 각자 하면 H-82 「미작성분이 포함되면 실패」가 한쪽에서만 지켜진다.
 *   · 휴강(canceled)은 세지 않는다 — 시수도 금액도 (H-82 「휴강이 잡히면 실패」)
 *   · 리포트 대상이 아닌 종류(`kind.rep = false` · 자습·회의 …)는 **쓴 것도 안 쓴 것도 아니다**(`na` · `effectiveRepStateFromEnded`) —
 *     「쓴 수업만 준다」는 규칙 아래 정산에 안 들고, 못 쓰는 리포트를 「미작성」이라 재촉하지도 않는다. 따로 센다(naCount)
 *   · 끝났는데 리포트를 안 쓴 회차는 **빠진다** — 얼마가 빠지는지(unwrittenAmount)를 함께 센다 (D-43)
 *   · 시급은 그 회차 날짜의 것(WAGE from_date) — 달 중간에 시급이 바뀌면 회차마다 다르다 (D8)
 */
import {
  REPORT_WRITTEN_DB, effectiveRepStateFromEnded, latePenalty, minutesSinceEnd, tierFor, withholding, type SessionLike,
} from './rules';

export interface Queryable { query(sql: string, params?: unknown[]): Promise<unknown> }

/** 회차의 담당 강사 — 회차 오버라이드가 있으면 그것, 없으면 규칙의 강사 (ser_occ.teacher_id ?? ser.teacher_id). */
export const TEACHER_OF_OCC = 'COALESCE(o.teacher_id, s.teacher_id)';

export interface PayoutLesson {
  serId: number; onDate: string; startMin: number; durMin: number;
  kindKey: string; subKey: string | null; mode: 'offline' | 'online'; title: string | null;
  students: string | null; studentCount: number;
  repState: string; canceled: boolean; submittedAt: string | null;
  pay: number | null; lateCut: number | null; penaltyIfNow: number | null;
}

export interface PayoutAgg {
  doneCount: number; doneMinutes: number;
  writtenCount: number; writtenMinutes: number;
  unwrittenCount: number; unwrittenMinutes: number; unwrittenAmount: number;
  remainingCount: number; remainingMinutes: number; remainingAmount: number;
  canceledCount: number;
  /** 리포트 대상이 아닌 종류의 회차 — 정산에 들지 않는다 */
  naCount: number;
  gross: number; lateCut: number;
  /** 시급이 없어 못 센 회차 — 0 이 아니면 시트가 완전하지 않다 */
  noRateCount: number;
}

export interface PayoutSheet {
  lessons: PayoutLesson[];
  agg: PayoutAgg;
  /** 과세표준 = gross − 지각 차감 · 세금은 `withholding` */
  base: number;
  incomeTax: number;
  localTax: number;
  net: number;
}

/** 시급×분 — 항상 정수 절사. 60분 격자 밖 길이도 원 단위가 흔들리지 않게 한 번만 버린다. */
export const payOf = (rate: number, min: number): number => Math.floor((rate * min) / 60);

export async function payoutSheet(
  q: Queryable, teacherId: number, month: string, today: string, nowMin: number,
): Promise<PayoutSheet> {
  const first = `${month}-01`;
  const rows = await q.query(
    `SELECT o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date, o.canceled,
            (EXTRACT(EPOCH FROM (lower(o.span) AT TIME ZONE 'Asia/Seoul')::time)/60)::int AS start_min,
            (EXTRACT(EPOCH FROM (upper(o.span) - lower(o.span)))/60)::int AS dur_min,
            s.kind_key, s.sub_key, s.mode, s.title, k.rep AS reportable,
            r.state::text AS rep_state,
            to_char(r.submitted_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') AS submitted_at,
            (SELECT string_agg(st.name, ', ' ORDER BY st.name)
               FROM ser_stu ss JOIN stu st ON st.id = ss.student_id
              WHERE ss.ser_id = o.ser_id) AS students,
            (SELECT COUNT(*)::int FROM ser_stu ss WHERE ss.ser_id = o.ser_id) AS student_count,
            w.rate AS wage_rate
       FROM ser_occ o
       JOIN ser s      ON s.id = o.ser_id
       JOIN kind k     ON k.key = s.kind_key
       LEFT JOIN rep r ON r.ser_id = o.ser_id AND r.on_date = o.on_date
       LEFT JOIN LATERAL (
              SELECT rate FROM wage
               WHERE staff_id = $1 AND from_date <= o.on_date
               ORDER BY from_date DESC LIMIT 1
            ) w ON true
      WHERE ${TEACHER_OF_OCC} = $1
        AND o.on_date >= $2::date
        AND o.on_date < $2::date + interval '1 month'
      ORDER BY o.on_date DESC, start_min`,
    [teacherId, first],
  ) as Array<Record<string, unknown>>;

  const written = new Set(REPORT_WRITTEN_DB as readonly string[]);
  const lessons: PayoutLesson[] = [];
  const agg: PayoutAgg = {
    doneCount: 0, doneMinutes: 0, writtenCount: 0, writtenMinutes: 0,
    unwrittenCount: 0, unwrittenMinutes: 0, unwrittenAmount: 0,
    remainingCount: 0, remainingMinutes: 0, remainingAmount: 0,
    canceledCount: 0, naCount: 0, gross: 0, lateCut: 0, noRateCount: 0,
  };

  for (const r of rows) {
    const onDate = String(r.on_date);
    const startMin = Number(r.start_min);
    const durMin = Number(r.dur_min);
    const canceled = Boolean(r.canceled);
    const submittedAt = (r.submitted_at as string) ?? null;
    const rate = r.wage_rate === null || r.wage_rate === undefined ? null : Number(r.wage_rate);

    const s: SessionLike = { date: onDate, startMin, durationMin: durMin, canceled, submittedAt };
    const ended = minutesSinceEnd(s, today, nowMin) > 0;
    // 리포트 상태는 규칙 한 곳이 정한다 — 대상 아닌 종류는 `na`, 대상인데 행이 없으면 끝났으면 `none` 아니면 `plan`
    const repState = effectiveRepStateFromEnded((r.rep_state as string | null) ?? null, r.reportable !== false, ended);
    const na = !canceled && repState === 'na';
    const isWritten = !canceled && !na && written.has(repState);
    const isUnwritten = !canceled && !na && ended && !isWritten;

    let pay: number | null = null;
    let lateCut: number | null = null;
    let penaltyIfNow: number | null = null;
    if (canceled) {
      agg.canceledCount += 1;
    } else if (na) {
      agg.naCount += 1;
    } else if (isWritten) {
      if (rate !== null) {
        pay = payOf(rate, durMin);
        lateCut = latePenalty(s);
        agg.gross += pay; agg.lateCut += lateCut;
      } else {
        agg.noRateCount += 1;
      }
      agg.writtenCount += 1; agg.writtenMinutes += durMin;
    } else if (isUnwritten) {
      const after = minutesSinceEnd(s, today, nowMin);
      penaltyIfNow = tierFor(after).amount;
      agg.unwrittenCount += 1; agg.unwrittenMinutes += durMin;
      if (rate !== null) agg.unwrittenAmount += payOf(rate, durMin);
    } else if (!ended) {
      agg.remainingCount += 1; agg.remainingMinutes += durMin;
      if (rate !== null) agg.remainingAmount += payOf(rate, durMin);
    }
    if (!canceled && !na && ended) { agg.doneCount += 1; agg.doneMinutes += durMin; }

    lessons.push({
      serId: Number(r.ser_id), onDate, startMin, durMin,
      kindKey: String(r.kind_key), subKey: (r.sub_key as string) ?? null,
      mode: r.mode === 'online' ? 'online' : 'offline',
      title: (r.title as string) ?? null,
      students: (r.students as string) ?? null,
      studentCount: Number(r.student_count ?? 0),
      repState, canceled, submittedAt, pay, lateCut, penaltyIfNow,
    });
  }

  const base = agg.gross - agg.lateCut;
  const tax = withholding(base);
  return { lessons, agg, base, incomeTax: tax.income, localTax: tax.local, net: base - tax.total };
}
