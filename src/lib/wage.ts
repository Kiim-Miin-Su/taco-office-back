/** @file-guide
 * 목적: wage.ts — insertWage, wageIssue, WAGE_SAME_DAY, WAGE_RETROACTIVE, wageRateAt (util)
 * 책임/재사용: 강사 시급 새 줄을 쓰는 규칙 한 곳 — §14 승인 경로(C41)와 관리자 직접 수정(C97)이 같은 함수를 부른다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 시급 새 줄 (WAGE) — 규칙은 둘이고 둘 다 여기서만 산다.
 *   · **소급 없음**(D8) — `from_date` 는 오늘 이후. 지난 수업의 시급이 바뀌면 지난 정산이 흔들린다(테스트 시나리오 I-8).
 *   · **같은 날 한 줄** — `(staff_id, from_date)` 유니크. 그날 두 번 바꾸면 어느 줄이 그날 수업의 시급인지 아무도 모른다.
 * 회차의 시급은 `wage.from_date <= 수업일` 인 마지막 줄이다(WAGE 표 주석 · `lib/payout-sheet` 가 그렇게 읽는다) — 그래서 미래 날짜로
 * 미리 적어 두는 것은 된다(그날부터 붙는다).
 */
import { ConflictException } from '@nestjs/common';
import { todayKst } from './kst';

export interface Queryable { query(sql: string, params?: unknown[]): Promise<unknown> }

export const WAGE_SAME_DAY = 'WAGE_SAME_DAY' as const;
export const WAGE_RETROACTIVE = 'WAGE_RETROACTIVE' as const;

export interface WageInsert {
  staffId: number;
  rate: number;
  /** 적용 시작일 YYYY-MM-DD — 오늘 이후. 비우면 오늘 */
  fromDate?: string | null;
  reason?: string | null;
  approvedBy: number;
}

/** 규칙 판정만 — DB 를 보지 않는다. 같은 날 한 줄은 표가 마지막에 막고 `insertWage` 가 먼저 읽는다 */
export function wageIssue(fromDate: string, today = todayKst()): { code: typeof WAGE_RETROACTIVE; message: string } | null {
  if (fromDate < today) {
    return {
      code: WAGE_RETROACTIVE,
      message: `${fromDate} 부터로는 적을 수 없습니다 — 시급은 오늘 이후의 수업에만 붙습니다(소급 없음 · 지난 정산은 그때 시급 그대로)`,
    };
  }
  return null;
}

/**
 * 한 줄을 쓴다. 트랜잭션 안에서 부른다(`m` 은 EntityManager/QueryRunner).
 * 같은 날 줄이 있으면 409 `WAGE_SAME_DAY` · 과거 날짜면 409 `WAGE_RETROACTIVE`.
 */
export async function insertWage(m: Queryable, w: WageInsert, today = todayKst()): Promise<{ id: number; fromDate: string }> {
  const fromDate = w.fromDate ?? today;
  const issue = wageIssue(fromDate, today);
  if (issue) throw new ConflictException(issue);
  const dup = (await m.query(`SELECT id FROM wage WHERE staff_id = $1 AND from_date = $2::date`, [w.staffId, fromDate])) as Array<{ id: string }>;
  if (dup.length) {
    throw new ConflictException({
      code: WAGE_SAME_DAY,
      message: `${fromDate} 부터 적용된 시급이 이미 있습니다 — 그날 수업의 시급이 둘이 될 수 없어 같은 날 두 번 바꾸지 않습니다`,
    });
  }
  const [made] = (await m.query(
    `INSERT INTO wage (staff_id, rate, from_date, reason, approved_by) VALUES ($1, $2, $3::date, $4, $5) RETURNING id`,
    [w.staffId, w.rate, fromDate, w.reason ?? null, w.approvedBy],
  )) as Array<{ id: string }>;
  return { id: Number(made.id), fromDate };
}

/** 어느 날짜에 붙는 시급 — 그 날짜 이하의 마지막 줄. 없으면 null (payout-sheet · 강사 히스토리와 같은 정의) */
export async function wageRateAt(m: Queryable, staffId: number, date: string): Promise<number | null> {
  const [row] = (await m.query(
    `SELECT rate FROM wage WHERE staff_id = $1 AND from_date <= $2::date ORDER BY from_date DESC LIMIT 1`, [staffId, date],
  )) as Array<{ rate: number | string }>;
  return row ? Number(row.rate) : null;
}
