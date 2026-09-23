/** @file-guide
 * 목적: 이미 migration33을 적용한 DB에도 GPAPACK 원문 상태 보존 칸을 맞춘다.
 * 책임/재사용: 과거 변환으로 사라진 상태·전달 사실을 추측하지 않고 nullable 칸만 보완한다.
 * 검증/작업 지침: docs/AGENT.md · TBO-52 production-transition.md · book-workflow-upgrade-db.spec.ts
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class GpapackLegacyState1762100000000 implements MigrationInterface {
  name = 'GpapackLegacyState1762100000000';

  public async up(q: QueryRunner): Promise<void> {
    // 수정된33을 지나온 DB의 원본 값은 그대로 두고, 옛33 적용 DB에는 미상(NULL)으로 둔다.
    await q.query('ALTER TABLE gpapack ADD COLUMN IF NOT EXISTS legacy_state varchar(12)');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM gpapack WHERE legacy_state IS NOT NULL) THEN
        RAISE EXCEPTION 'GPAPACK original states must be preserved; use a forward migration';
      END IF;
    END $$`);
    await q.query('ALTER TABLE gpapack DROP COLUMN legacy_state');
  }
}
