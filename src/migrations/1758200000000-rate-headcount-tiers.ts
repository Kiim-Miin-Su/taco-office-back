/** @file-guide
 * 목적: rate-headcount-tiers.ts (migration)
 * 책임/재사용: 변경 당시 SQL을 고정하고 기존 행을 자동 보정/삭제하지 않는다. preflight·up/down·실제 DB 검증과 운영 적용을 구분한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * N-17 채택 (2026-09-12 §4-17 ①) · 44D-3B: RATE 에 인원 구간(heads)을 둔다.
 * 기존 행은 DEFAULT 1 로 1인 기준 단가로 재해석한다 — rate 테이블을 계산에 소비하는
 * 코드가 0 임을 확인한 재해석이며(청구 라인은 inv_line.unit_price 를 따로 가짐),
 * 값 자체는 바꾸지 않는다. 산식은 lib/rules.rosterPricing 한 곳이다.
 */
export class RateHeadcountTiers1758200000000 implements MigrationInterface {
  name = 'RateHeadcountTiers1758200000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE rate ADD COLUMN heads smallint NOT NULL DEFAULT 1`);
    await q.query(`ALTER TABLE rate ADD CONSTRAINT rate_heads_check CHECK (heads >= 1)`);
    await q.query(`CREATE UNIQUE INDEX rate_tier_key ON rate (kind_key, COALESCE(sub_key, ''), heads, from_date)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX rate_tier_key`);
    await q.query(`ALTER TABLE rate DROP CONSTRAINT rate_heads_check`);
    await q.query(`ALTER TABLE rate DROP COLUMN heads`);
  }
}
