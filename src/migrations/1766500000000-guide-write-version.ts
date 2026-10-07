/** @file-guide
 * 목적: BOC-04D-03a 안내 본문 동시 편집 버전과 요청 키 멱등 원장을 추가한다. (historical)
 * 책임/재사용: GUIDE 본문 계열의 version과 GUIDE_WRITE_REQ만 소유하며 발송·확인 상태 원장은 바꾸지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-04D3A-GUIDE-WRITER-SAFETY-2026-10-08.md · docs/contracts/db/erd.dbml
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BOC-04D-03a 권고안 채택(2026-10-08): 본문·지도 방향·관리자 코멘트는 한 version으로
 * 잠그고, requestKey의 actor·fingerprint·결과 version을 별도 원장에 보존한다. 정책 변경 시
 * GuideBodyWriteDto/GuidesService/GuideWriter, 정본·목표 DBML과 P-BOC04D03A를 함께 바꾼다.
 */
export class GuideWriteVersion1766500000000 implements MigrationInterface {
  name = 'GuideWriteVersion1766500000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE guide ADD COLUMN body_version integer NOT NULL DEFAULT 1`);
    await q.query(`ALTER TABLE guide ADD CONSTRAINT guide_body_version_positive CHECK (body_version >= 1)`);
    await q.query(`
      CREATE TABLE guide_write_req (
        request_key uuid PRIMARY KEY,
        guide_id bigint NOT NULL,
        fingerprint char(64) NOT NULL,
        result_version integer NOT NULL,
        actor_id bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT guide_write_req_guide_fk FOREIGN KEY (guide_id) REFERENCES guide(id) ON DELETE CASCADE,
        CONSTRAINT guide_write_req_actor_fk FOREIGN KEY (actor_id) REFERENCES staff(id) ON DELETE RESTRICT,
        CONSTRAINT guide_write_req_fingerprint_hex CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT guide_write_req_version_positive CHECK (result_version >= 1)
      )
    `);
    await q.query(`CREATE INDEX guide_write_req_guide_idx ON guide_write_req(guide_id,created_at DESC,request_key)`);
    await q.query(`
      CREATE FUNCTION guide_body_version_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.body IS DISTINCT FROM OLD.body
           OR NEW.direction IS DISTINCT FROM OLD.direction
           OR NEW.admin_note IS DISTINCT FROM OLD.admin_note
           OR (OLD.state = 'draft'::guide_state_t AND NEW.state = 'ready'::guide_state_t) THEN
          IF NEW.body_version <> OLD.body_version + 1 THEN
            RAISE EXCEPTION 'guide body version must increase by exactly one'
              USING ERRCODE = '23514', CONSTRAINT = 'guide_body_version_step';
          END IF;
        ELSIF NEW.body_version IS DISTINCT FROM OLD.body_version THEN
          RAISE EXCEPTION 'guide body version cannot change without body fields'
            USING ERRCODE = '23514', CONSTRAINT = 'guide_body_version_without_change';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await q.query(`
      CREATE TRIGGER guide_body_version_guard
      BEFORE UPDATE OF body,direction,admin_note,body_version ON guide
      FOR EACH ROW EXECUTE FUNCTION guide_body_version_guard_fn()
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS guide_body_version_guard ON guide`);
    await q.query(`DROP FUNCTION IF EXISTS guide_body_version_guard_fn()`);
    await q.query(`DROP TABLE IF EXISTS guide_write_req`);
    await q.query(`ALTER TABLE guide DROP CONSTRAINT IF EXISTS guide_body_version_positive`);
    await q.query(`ALTER TABLE guide DROP COLUMN IF EXISTS body_version`);
  }
}
