/** @file-guide
 * 목적: BO-Q13 별도 versioned 회의 사전 안건 정본과 직접 SQL 방어를 추가한다. (historical)
 * 책임/재사용: additive MTAGENDA 한 표만 만들며 기존 MTREC.minutes·과거 속기록은 바꾸지 않는다.
 * 검증/작업 지침: docs/decisions/PLANNING-REQUIRED.md BO-Q13 · docs/contracts/db/erd.dbml
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BO-Q13 권고안 채택(2026-10-07 사용자 확정).
 * agenda를 MTREC.minutes에 섞지 않고 같은 meeting identity의 1:1 표로 둔다. 정책 변경 시 결정 원장,
 * Front MeetingAgendaPanel/MeetingMinutesLedger, DTO/service와 이 주석을 한 청크에서 함께 수정한다.
 */
export class MeetingAgenda1766100000000 implements MigrationInterface {
  name = 'MeetingAgenda1766100000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "mtagenda" (
        "mt_id" bigint NOT NULL,
        "content" text NOT NULL,
        "version" integer NOT NULL DEFAULT 1,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" bigint NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "updated_by" bigint NOT NULL,
        CONSTRAINT "mtagenda_pkey" PRIMARY KEY ("mt_id"),
        CONSTRAINT "mtagenda_meeting_fk" FOREIGN KEY ("mt_id") REFERENCES "mtrec"("id") ON DELETE CASCADE,
        CONSTRAINT "mtagenda_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "staff"("id") ON DELETE RESTRICT,
        CONSTRAINT "mtagenda_updated_by_fk" FOREIGN KEY ("updated_by") REFERENCES "staff"("id") ON DELETE RESTRICT,
        CONSTRAINT "mtagenda_content_present" CHECK (char_length(btrim("content")) BETWEEN 1 AND 8000),
        CONSTRAINT "mtagenda_version_positive" CHECK ("version" >= 1),
        CONSTRAINT "mtagenda_time_order" CHECK ("updated_at" >= "created_at")
      )
    `);
    await q.query(`
      CREATE FUNCTION mtagenda_update_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.mt_id IS DISTINCT FROM OLD.mt_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
           OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
          RAISE EXCEPTION 'mtagenda identity and creator are immutable' USING ERRCODE = '23514', CONSTRAINT = 'mtagenda_creator_immutable';
        END IF;
        IF NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'mtagenda version must increase by exactly one' USING ERRCODE = '23514', CONSTRAINT = 'mtagenda_version_step';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await q.query(`
      CREATE TRIGGER mtagenda_update_guard
      BEFORE UPDATE ON mtagenda
      FOR EACH ROW EXECUTE FUNCTION mtagenda_update_guard_fn()
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS mtagenda_update_guard ON mtagenda`);
    await q.query(`DROP FUNCTION IF EXISTS mtagenda_update_guard_fn()`);
    await q.query(`DROP TABLE IF EXISTS mtagenda`);
  }
}
