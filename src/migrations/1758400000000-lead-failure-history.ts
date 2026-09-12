/** @file-guide
 * 목적: lead-failure-history.ts (migration)
 * 책임/재사용: 변경 당시 SQL을 고정하고 기존 행을 자동 보정/삭제하지 않는다. preflight·up/down·실제 DB 검증과 운영 적용을 구분한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * N-25 채택 (2026-09-12 §4-17) · v2 §24: 실패 이력 판정 — fail.from **명시값** 우선,
 * 없으면 순서 보장된 도달 기록(lead_stage_log · id 단조) 역순, 근거 없으면 미분류.
 * 기존 행은 자동 보정하지 않는다: stop_at 으로 fail_from 을 추정 이관하는 것이
 * 바로 금지된 «추정»이다 — 레거시는 미분류로 보존한다.
 */
export class LeadFailureHistory1758400000000 implements MigrationInterface {
  name = 'LeadFailureHistory1758400000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE lead ADD COLUMN fail_from varchar(16)`);
    await q.query(`CREATE TABLE lead_stage_log (
      id      bigserial   PRIMARY KEY,
      lead_id bigint      NOT NULL REFERENCES lead(id),
      stage   varchar(16) NOT NULL,
      by_id   bigint      REFERENCES staff(id),
      at      timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX lead_stage_log_lead ON lead_stage_log (lead_id, id)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE lead_stage_log`);
    await q.query(`ALTER TABLE lead DROP COLUMN fail_from`);
  }
}
