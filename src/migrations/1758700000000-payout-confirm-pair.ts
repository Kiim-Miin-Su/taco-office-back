/** @file-guide
 * 목적: 1758700000000-payout-confirm-pair.ts — PayoutConfirmPair1758700000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PAYOUT 의 확정 흔적을 **짝으로** 묶는다 — 누가·언제 (N-27 · 대표 결정 2026-09-12).
 *
 * 대표 원문: 「전부 단일 진실원을 지키며 구현하며 **confirmed_by는 필요함**」.
 * 그래서 정산이 확정됐는지는 `payout.state` 낱말이 아니라 `confirmed_by` 로 본다
 * (판정은 `lib/rules` 의 `payoutConfirmed` 한 곳). 판정이 그 칸에 걸린 이상,
 * **그 칸이 반쪽으로 남는 길을 표가 막아야 한다** — 애플리케이션 검사로 끝내지 않는다
 * (원칙 26 · D-R43 세 층 방어의 마지막 층).
 *
 * 확정은 「누가」와 「언제」가 함께 남는 사건이다. 한쪽만 채워진 행은 확정도 미확정도 아닌
 * 말할 수 없는 상태가 되고, 그 순간 판정이 다시 흔들린다.
 *
 * **낱말은 이 마이그레이션이 정하지 않는다.** `payout.state` 에는 여전히 CHECK 를 걸지 않는다 —
 * 정본 낱말은 원문에 없고, 정해지기 전에 표에 굳히면 그 자체가 발명이 된다.
 *
 * 기존 행은 **건드리지 않는다**(NOT VALID). 한쪽만 채워진 옛 행이 어느 쪽 뜻이었는지
 * 알 방법이 없고, 추정해서 채우면 원장이 거짓이 된다 (추정 이관 금지).
 * 대표가 낱말을 정한 뒤 `VALIDATE CONSTRAINT` 로 굳힌다.
 */
export class PayoutConfirmPair1758700000000 implements MigrationInterface {
  name = 'PayoutConfirmPair1758700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `COMMENT ON COLUMN payout.confirmed_by IS '확정한 사람 — 정산 확정 판정의 단일 진실원이다 (N-27). state 낱말로 판정하지 않는다'`,
    );
    await q.query(
      `COMMENT ON COLUMN payout.confirmed_at IS '확정한 시각 — confirmed_by 와 반드시 짝이다 (payout_confirm_pair)'`,
    );
    await q.query(
      `ALTER TABLE payout ADD CONSTRAINT payout_confirm_pair
         CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL)) NOT VALID`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE payout DROP CONSTRAINT IF EXISTS payout_confirm_pair`);
  }
}
