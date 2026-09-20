/** @file-guide
 * 목적: 1761600000000-expense-filed-by.ts — 지출을 실제로 올린 사람 (대리 등록 · 자기 심사 옆문) (migration)
 * 책임/재사용: 스키마 변경만 소유한다. 기존 행을 추정으로 보정하지 않고, 되돌릴 수 있는 down 을 함께 둔다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * **지출을 실제로 올린 사람**(`expense.filed_by`) — A-5 자기 심사 금지의 옆문을 닫는다.
 *
 * `expense_no_self_review CHECK (reviewer_id <> requester_id)` 는 migration 1758500000000 부터 있었다.
 * 그런데 `POST /accounting/expenses` 는 `requesterId` 를 **누가 보내든 그대로 받고** 있었고
 * (컨트롤러 주석만 「대표가 직원 대신 올릴 때만」이라 적었다) 심사 쪽은 `requester_id` 하나만 봤다 —
 * **남의 이름으로 올린 뒤 자기가 승인**하면 제도가 통째로 비켜간다 (2026-09-20 전수 검수 §2 ②).
 *
 * 그래서 두 가지를 한다: **① 대리 등록은 대표만**(서비스 403 `EXPENSE_PROXY_FORBIDDEN`)
 * **② 실제로 올린 사람을 행에 남기고 심사 쪽이 그 사람도 본다**(`expense_no_self_file_review`).
 * ①만 하면 대표 자신은 여전히 남의 이름으로 올려 스스로 승인할 수 있어 구멍이 닫히지 않는다.
 *
 * **옛 행은 NULL 이다** — 누가 올렸는지 어디에도 안 남아 있고 `requester_id` 로 미루어 채우는 것은
 * 추정이다(N-25 · 기존 행 보정 0). NULL 은 CHECK 가 막지 않는다 — 모르는 것은 막지 않는다.
 *
 * `NOT VALID` 는 **기존 행만** 면제하고 새 INSERT 는 그대로 검사한다. 시드는 언제나 새 INSERT 이므로
 * (C86-g · S1 에서 한 번 더 겪었다) 아래 preflight 가 먼저 세고, 걸리면 **고르지 않고 멈춘다.**
 */
export class ExpenseFiledBy1761600000000 implements MigrationInterface {
  name = 'ExpenseFiledBy1761600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE expense ADD COLUMN filed_by bigint REFERENCES staff(id) ON DELETE RESTRICT`);

    // ── preflight — 새 칸이라 위반은 0 이어야 한다. 0 이 아니면 이 마이그레이션을 두 번 돌린 것이다
    const [{ n }] = (await q.query(
      `SELECT count(*)::text AS n FROM expense
        WHERE filed_by IS NOT NULL AND reviewer_id IS NOT NULL AND filed_by = reviewer_id`,
    )) as [{ n: string }];
    if (Number(n) > 0) {
      throw new Error(
        `expense 에 「대신 올린 사람이 스스로 심사한」 행이 ${n}건 있습니다 — 어느 쪽이 맞는지 사람이 정해야 합니다(추정 보정 금지 · N-25).`,
      );
    }

    await q.query(`
      ALTER TABLE expense ADD CONSTRAINT expense_no_self_file_review
      CHECK (filed_by IS NULL OR reviewer_id IS NULL OR filed_by <> reviewer_id) NOT VALID
    `);
    await q.query(`CREATE INDEX expense_filed_by_idx ON expense (filed_by)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS expense_filed_by_idx`);
    await q.query(`ALTER TABLE expense DROP CONSTRAINT IF EXISTS expense_no_self_file_review`);
    await q.query(`ALTER TABLE expense DROP COLUMN IF EXISTS filed_by`);
  }
}
