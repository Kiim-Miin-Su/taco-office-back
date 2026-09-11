/** @file-guide
 * 목적: unav-dated-contract.ts (migration)
 * 책임/재사용: 변경 당시 SQL을 고정하고 기존 행을 자동 보정/삭제하지 않는다. preflight·up/down·실제 DB 검증과 운영 적용을 구분한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * N-20 채택 (2026-09-12 §4-17): 불가 시간 판정 기준을 날짜(on_date)로 —
 * cycle+dow 는 2주 안의 같은 요일을 식별하지 못한다(기록된 계약 결함).
 * 기존 행은 자동 보정하지 않는다: 어느 날짜였는지가 바로 그 결함이라 되살릴 수 없고,
 * on_date NULL 행은 강사 화면에 싣지 않으며 관리자 조정 대상으로 남는다.
 */
export class UnavDatedContract1758000000000 implements MigrationInterface {
  name = 'UnavDatedContract1758000000000';

  async preflight(q: QueryRunner): Promise<Record<string, number>> {
    const [counts] = await q.query(
      `SELECT count(*)::int AS legacy_rows FROM unav`,
    ) as Record<string, number>[];
    return counts;
  }

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE unav ADD COLUMN on_date date`);
    await q.query(`CREATE INDEX unav_staff_date ON unav (staff_id, on_date)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX unav_staff_date`);
    await q.query(`ALTER TABLE unav DROP COLUMN on_date`);
  }
}
