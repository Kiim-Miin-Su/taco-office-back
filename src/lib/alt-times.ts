/** @file-guide
 * 목적: alt-times.ts — altTimes, ALT_TIME_RANGE (service)
 * 책임/재사용: 409 뒤 「다른 시간 제안」을 한 벌 SQL로 계산한다. 겹침 정의는 ser_occ EXCLUDE 와 같은 span && 이고, 막는 것은 여전히 DB다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { spanOf } from './sql';

/**
 * 제안을 찾는 시간대 — 화면 시간표의 기본 범위(프론트 `SCHEDULE_BASE_TIME_RANGE` 09:00~22:00)와 같다.
 * 기준 밖(이른 아침 · 밤)은 제안하지 않는다 — 사람이 직접 고르면 저장은 그대로 된다.
 */
export const ALT_TIME_RANGE = { from: 9 * 60, to: 22 * 60 } as const;
/** 제안 간격 — 일간 표의 30분 칸과 같다 */
export const ALT_STEP_MIN = 30;

export interface AltTimeQuery {
  /** 같은 시각이 **모든 날짜에서** 비어야 한다 — 매주 월·수 규칙이면 첫 월 · 첫 수를 함께 준다 */
  dates: string[];
  startMin: number;
  endMin: number;
  teacherId?: number | null;
  roomId?: number | null;
  zaccId?: number | null;
  /** 그 시각에 쓸 수 있는(active · 비어 있는) 줌 계정이 **하나라도** 있어야 한다 — 계정이 모자랄 때(N-134) */
  anyZoom?: boolean;
  /** 옮기는 수업 자신은 자리를 비워 줄 것이므로 세지 않는다 */
  exceptSerId?: number | null;
  limit?: number;
}

type Run = (sql: string, params: unknown[]) => Promise<unknown[]>;

/**
 * 다른 시간 제안 (테스트 시나리오 A-06 「다른 시간을 제안한다」 · N-134 「시간 조정 … 을 제안」).
 *
 * 같은 길이의 시각을 30분 간격으로 훑어, 물은 자원(강사 · 강의실 · 줌 계정)이 **준 날짜 모두에서** 비어 있는 것을
 * 원래 시각에 가까운 순서로 최대 셋 돌려준다. 강사를 물었으면 그 강사가 적어 낸 불가 시간(UNAV · 날짜 있는 줄)도 피한다 —
 * 불가 시간은 막지 않는 경고지만, 제안을 경고 위에 세우면 제안의 뜻이 없다.
 *
 * **미리 잡지 않는다.** 제안과 저장 사이에 남이 그 자리를 잡을 수 있고, 저장은 늘 EXCLUDE 가 다시 판정한다(N-70 · C84-b).
 */
export async function altTimes(run: Run, q: AltTimeQuery): Promise<Array<{ startMin: number; endMin: number }>> {
  const dur = q.endMin - q.startMin;
  const dates = [...new Set(q.dates)];
  if (dur <= 0 || !dates.length) return [];
  if (!q.teacherId && !q.roomId && !q.zaccId && !q.anyZoom) return [];
  const last = ALT_TIME_RANGE.to - dur;
  if (last < ALT_TIME_RANGE.from) return [];
  const span = spanOf('d.on_date', 'c.start_min', 'c.end_min');
  const rows = (await run(
    `WITH d AS (SELECT unnest($1::date[]) AS on_date),
          c AS (SELECT s AS start_min, s + $3::int AS end_min
                  FROM generate_series($4::int, $5::int, $6::int) s
                 WHERE s <> $2::int)
     SELECT c.start_min, c.end_min
       FROM c
      WHERE NOT EXISTS (
              SELECT 1 FROM d JOIN ser_occ o ON NOT o.canceled AND o.span && ${span}
               WHERE ($7::bigint IS NULL OR o.ser_id <> $7)
                 AND (($8::bigint IS NOT NULL AND o.teacher_id = $8)
                   OR ($9::bigint IS NOT NULL AND o.room_id = $9)
                   OR ($10::bigint IS NOT NULL AND o.zacc_id = $10)))
        AND ($8::bigint IS NULL OR NOT EXISTS (
              SELECT 1 FROM d JOIN unav u ON u.staff_id = $8 AND u.on_date = d.on_date
               WHERE u.start_min < c.end_min AND c.start_min < u.end_min))
        AND (NOT $11::boolean OR EXISTS (
              SELECT 1 FROM zacc z
               WHERE z.active AND NOT EXISTS (
                 SELECT 1 FROM d JOIN ser_occ o ON NOT o.canceled AND o.zacc_id = z.id AND o.span && ${span}
                  WHERE ($7::bigint IS NULL OR o.ser_id <> $7))))
      ORDER BY abs(c.start_min - $2::int), c.start_min
      LIMIT $12::int`,
    [dates, q.startMin, dur, ALT_TIME_RANGE.from, last, ALT_STEP_MIN, q.exceptSerId ?? null,
      q.teacherId ?? null, q.roomId ?? null, q.zaccId ?? null, q.anyZoom === true, q.limit ?? 3],
  )) as Array<{ start_min: number | string; end_min: number | string }>;
  return rows.map((r) => ({ startMin: Number(r.start_min), endMin: Number(r.end_min) }));
}

/** 「14:00–15:00 · 15:30–16:30」 — 제안 줄의 시각 모양 */
export function altTimesText(times: Array<{ startMin: number; endMin: number }>): string {
  const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return times.map((t) => `${hm(t.startMin)}–${hm(t.endMin)}`).join(' · ');
}
