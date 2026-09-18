/** @file-guide
 * 목적: month-close.ts — closedMonthBetween, assertMonthOpen, assertRangeOpen, MONTH_CLOSED (util)
 * 책임/재사용: §54 월 마감 판정 한 곳. 스케줄·출결·청구·이월·휴원 쓰기가 같은 함수로 409 MONTH_CLOSED 를 던진다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 월 마감 (C92-d · 테스트 시나리오 C-39 · L-123 · N-140).
 *
 * 「마감 후에도 자유롭게 고쳐지면 실패」 — 어느 쓰기가 마감 달을 건드리는지를 여기 한 곳이 판정한다.
 *   · 날짜 하나(출결 · 회차 예외)        → `assertMonthOpen(q, date)`
 *   · 기간(휴원 · 복귀)                 → `assertRangeOpen(q, from, to)`
 *   · 달(청구서 발행 · 이월 처리)         → `assertMonthOpen(q, 'YYYY-MM')`
 *   · 스케줄 쓰기(규칙 전체가 바뀐다)     → `closedOccSnapshot` 을 persist/project 앞뒤로 견줘 다르면 던진다
 * 마감 달은 `month_close` 의 열린 행(`reopened_at IS NULL`)이다 — 해제된 달은 이력만 남고 다시 열린다.
 */
import { ConflictException } from '@nestjs/common';

export interface Queryable { query(sql: string, params?: unknown[]): Promise<unknown> }

export const MONTH_CLOSED = 'MONTH_CLOSED' as const;

export const monthOf = (iso: string): string => iso.slice(0, 7);

export function monthClosedError(month: string): ConflictException {
  return new ConflictException({
    code: MONTH_CLOSED,
    message: `${month.slice(0, 4)}년 ${Number(month.slice(5, 7))}월은 마감됐습니다 — 대표가 마감을 해제한 뒤 고칠 수 있습니다`,
  });
}

/** 지금 마감돼 있는 달 전부 — `YYYY-MM` 오름차순 */
export async function closedMonths(q: Queryable): Promise<string[]> {
  const rows = await q.query(`SELECT year_month FROM month_close WHERE reopened_at IS NULL ORDER BY year_month`) as Array<{ year_month: string }>;
  return rows.map((r) => r.year_month);
}

/** `[from, to]`(to 가 null 이면 무기한) 와 겹치는 마감 달 중 첫 것. 날짜든 달이든 앞 7자로 본다 */
export async function closedMonthBetween(q: Queryable, from: string, to: string | null): Promise<string | null> {
  const rows = await q.query(
    `SELECT year_month FROM month_close
      WHERE reopened_at IS NULL AND year_month >= $1 AND ($2::text IS NULL OR year_month <= $2)
      ORDER BY year_month LIMIT 1`,
    [monthOf(from), to === null ? null : monthOf(to)],
  ) as Array<{ year_month: string }>;
  return rows[0]?.year_month ?? null;
}

/** 날짜(`YYYY-MM-DD`) 또는 달(`YYYY-MM`) 하나가 마감이면 409 */
export async function assertMonthOpen(q: Queryable, dateOrMonth: string): Promise<void> {
  const hit = await closedMonthBetween(q, dateOrMonth, dateOrMonth);
  if (hit) throw monthClosedError(hit);
}

/** 기간이 마감 달과 겹치면 409 — 휴원·복귀처럼 여러 달을 덮는 쓰기 */
export async function assertRangeOpen(q: Queryable, from: string, to: string | null): Promise<void> {
  const hit = await closedMonthBetween(q, from, to);
  if (hit) throw monthClosedError(hit);
}

/**
 * 마감 달에 놓인 회차·예외의 모양 — 스케줄 쓰기 앞뒤로 두 번 찍어 견준다.
 * 규칙 전체를 고치면(scope=all · 시각 변경) 투영이 지난 달 회차까지 다시 쓰므로 날짜 하나로는 못 막는다.
 * 명단(SER_STU)은 날짜가 없어 여기 들지 않는다 — N-50.
 */
export async function closedOccSnapshot(q: Queryable, serIds: number[], closed: string[]): Promise<string> {
  // 빈 상태도 같은 모양으로 적는다 — 새 규칙(앞 스냅숏 0건)과 「마감 달에 줄 0건」이 같은 문자열이어야 한다
  if (!serIds.length || !closed.length) return JSON.stringify({ occ: [], exc: [] });
  const occ = await q.query(
    `SELECT o.ser_id, to_char(o.on_date, 'YYYY-MM-DD') AS on_date, lower(o.span) AS s, upper(o.span) AS e,
            o.canceled, o.teacher_id, o.room_id, o.zacc_id
       FROM ser_occ o
      WHERE o.ser_id = ANY($1::bigint[])
        AND (to_char(o.on_date, 'YYYY-MM') = ANY($2::text[])
             OR to_char(lower(o.span) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM') = ANY($2::text[]))
      ORDER BY o.ser_id, o.on_date`,
    [serIds, closed],
  ) as Array<Record<string, unknown>>;
  const exc = await q.query(
    `SELECT e.ser_id, to_char(e.on_date, 'YYYY-MM-DD') AS on_date, e.canceled, e.cancel_kind, e.cancel_treat, e.makeup_ser_id,
            e.start_min, e.end_min, e.teacher_set, e.teacher_id, e.room_set, e.room_id, to_char(e.new_date, 'YYYY-MM-DD') AS moved_to,
            (SELECT array_agg(xo.student_id ORDER BY xo.student_id) FROM exc_stu_out xo WHERE xo.exc_id = e.id) AS stu_out
       FROM exc e
      WHERE e.ser_id = ANY($1::bigint[]) AND to_char(e.on_date, 'YYYY-MM') = ANY($2::text[])
      ORDER BY e.ser_id, e.on_date`,
    [serIds, closed],
  ) as Array<Record<string, unknown>>;
  return JSON.stringify({ occ, exc }, (_k, v: unknown) => (v instanceof Date ? v.toISOString() : v));
}
