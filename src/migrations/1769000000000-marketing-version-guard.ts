/** @file-guide
 * 목적: MKT 직접 UPDATE도 row_version을 정확히 한 단계 올리도록 DB 경계를 보강한다.
 * 책임/재사용: API의 expectedVersion 검사와 별개로 current 행·멱등 receipt의 버전 대응을 보존한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class MarketingVersionGuard1769000000000 implements MigrationInterface {
  name = 'MarketingVersionGuard1769000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE FUNCTION mkt_row_version_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.row_version <> OLD.row_version + 1 THEN
          RAISE EXCEPTION 'marketing version must advance exactly once'
            USING ERRCODE='23514', CONSTRAINT='mkt_row_version_step';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await q.query(`CREATE TRIGGER mkt_row_version_guard BEFORE UPDATE ON mkt FOR EACH ROW EXECUTE FUNCTION mkt_row_version_guard_fn()`);
    await q.query(`
      CREATE FUNCTION mkt_write_req_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'marketing request receipts are immutable'
          USING ERRCODE='23514', CONSTRAINT='mkt_write_req_immutable';
      END
      $$
    `);
    await q.query(`CREATE TRIGGER mkt_write_req_immutable BEFORE UPDATE OR DELETE ON mkt_write_req FOR EACH ROW EXECUTE FUNCTION mkt_write_req_immutable_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER mkt_write_req_immutable ON mkt_write_req`);
    await q.query(`DROP FUNCTION mkt_write_req_immutable_fn`);
    await q.query(`DROP TRIGGER mkt_row_version_guard ON mkt`);
    await q.query(`DROP FUNCTION mkt_row_version_guard_fn`);
  }
}
