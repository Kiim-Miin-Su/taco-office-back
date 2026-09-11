/** @file-guide
 * 목적: cons-item-ledger.ts (migration)
 * 책임/재사용: 변경 당시 SQL을 고정하고 기존 행을 자동 보정/삭제하지 않는다. preflight·up/down·실제 DB 검증과 운영 적용을 구분한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * N-18 채택 (2026-09-12 §4-17) · 47D-B: 컨설팅 항목 원장.
 * 항목(체크리스트)과 회차 기록(cons_sess)은 원문에서 구분된다 — TODO 를 분모로 세지 않고
 * 진행률은 이 원장의 projection 이다. 완료 개수를 별도 숫자로 저장하지 않는다 (47D-A).
 */
export class ConsItemLedger1758100000000 implements MigrationInterface {
  name = 'ConsItemLedger1758100000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE cons_item (
      id         bigserial PRIMARY KEY,
      cons_id    bigint      NOT NULL REFERENCES cons(id),
      seq        smallint    NOT NULL,
      label      varchar(80) NOT NULL,
      required   boolean     NOT NULL DEFAULT false,
      done       boolean     NOT NULL DEFAULT false,
      done_by    bigint      REFERENCES staff(id),
      done_at    timestamptz,
      source     varchar(10) NOT NULL DEFAULT 'template',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT cons_item_source_check CHECK (source IN ('template','manual')),
      CONSTRAINT cons_item_done_stamp_check CHECK ((done AND done_by IS NOT NULL AND done_at IS NOT NULL) OR ((NOT done) AND done_by IS NULL AND done_at IS NULL))
    )`);
    await q.query(`CREATE UNIQUE INDEX cons_item_cons_seq ON cons_item (cons_id, seq)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE cons_item`);
  }
}
