/** @file-guide
 * 목적: GPA 4표를 역사 원장으로 동결하고 일반 INSERT/UPDATE/DELETE를 DB에서 거절한다. (migration)
 * 책임/재사용: 표와 과거 행은 보존하며, 검수된 archive restore·개발 seed·명시적 reset 트랜잭션만 SET LOCAL 우회 키를 쓴다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLES = ['gpasvc', 'gpa_cycle', 'gpa_alloc', 'gpa_use'] as const;

/**
 * BOC-13E 권고안(2026-10-08): 최신 수정사항의 GPA 퇴역은 과거 원장 삭제가 아니다.
 * 그래서 표를 DROP하지 않고 모든 일반 DML을 막는다. 복원·개발 fixture처럼 이미 검수된
 * 최상위 트랜잭션만 `SET LOCAL taco.gpa_archive_restore = 'on'`을 사용한다.
 * 정책을 다시 열 때는 DTO/OpenAPI, Front 생성 타입, Figma, 두 수정사항 교차표, DBML,
 * 시나리오와 portfolio를 같은 청크에서 함께 갱신한다.
 */
export class GpaArchiveGuard1767300000000 implements MigrationInterface {
  name = 'GpaArchiveGuard1767300000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE FUNCTION gpa_archive_reject_write() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('taco.gpa_archive_restore', true) IS DISTINCT FROM 'on' THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'GPA_RETIRED',
            DETAIL = TG_TABLE_NAME || ' is a read-only historical ledger',
            HINT = 'Use the reviewed GPA archive restore transaction';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
      $$`);

    for (const table of TABLES) {
      await q.query(`CREATE TRIGGER ${table}_archive_guard
        BEFORE INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION gpa_archive_reject_write()`);
      await q.query(`CREATE TRIGGER ${table}_archive_truncate_guard
        BEFORE TRUNCATE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION gpa_archive_reject_write()`);
    }
  }

  async down(q: QueryRunner): Promise<void> {
    for (const table of [...TABLES].reverse()) {
      await q.query(`DROP TRIGGER IF EXISTS ${table}_archive_truncate_guard ON ${table}`);
      await q.query(`DROP TRIGGER IF EXISTS ${table}_archive_guard ON ${table}`);
    }
    await q.query(`DROP FUNCTION IF EXISTS gpa_archive_reject_write()`);
  }
}
