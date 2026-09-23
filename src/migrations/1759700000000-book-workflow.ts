/** @file-guide
 * 목적: §38~§41 교재 배부·진도·자료 전달의 영속 원장을 만든다.
 * 책임/재사용: 화면 상태를 저장하지 않고 업무 사실과 순서 제약만 추가한다. 기존 행은 결정 가능한 값만 이관한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class BookWorkflow1759700000000 implements MigrationInterface {
  name = 'BookWorkflow1759700000000';

  public async up(q: QueryRunner): Promise<void> {
    /*
     * FILE의 최초 8MiB 계약은 base64 JSON/Vercel Function 4.5MB 경로로 실제 도달할 수 없었다.
     * 신규/기존 DB가 갈리지 않도록 이번 전이에서 실제 end-to-end 상한 3,000,000 bytes로 좁힌다.
     * 기존 초과 행은 조용히 지우거나 자르지 않고 migration을 막아 운영자가 별도 보존 결정을 하게 한다.
     */
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM "file" WHERE "bytes" > 3000000) THEN
        RAISE EXCEPTION 'FILE rows over 3000000 bytes require explicit migration';
      END IF;
    END $$`);
    await q.query(`ALTER TABLE "file" DROP CONSTRAINT "file_size_cap"`);
    await q.query(`ALTER TABLE "file" ADD CONSTRAINT "file_size_cap" CHECK ("bytes" > 0 AND "bytes" <= 3000000)`);
    await q.query(`ALTER TABLE "file" ADD CONSTRAINT "file_kind_valid" CHECK ("kind" IN (
      'cons-contract','cons-item','lib-se','lib-te','expense-receipt','guide-png','report-png','meet-brief'
    ))`);
    await q.query(`ALTER TABLE "lib" ADD CONSTRAINT "lib_sub_fk" FOREIGN KEY ("sub_key") REFERENCES "sub"("key")`);
    await q.query(`ALTER TABLE "vers" ADD CONSTRAINT "vers_lib_fk" FOREIGN KEY ("lib_id") REFERENCES "lib"("id")`);
    await q.query(`ALTER TABLE "vers" ADD CONSTRAINT "vers_lib_id_unique" UNIQUE ("lib_id", "id")`);
    await q.query(`ALTER TABLE "issue" ADD CONSTRAINT "issue_lib_fk" FOREIGN KEY ("lib_id") REFERENCES "lib"("id")`);
    await q.query(`ALTER TABLE "issue" ADD CONSTRAINT "issue_vers_lib_fk" FOREIGN KEY ("lib_id", "vers_id") REFERENCES "vers"("lib_id", "id")`);
    await q.query(`ALTER TABLE "issue" ADD CONSTRAINT "issue_student_fk" FOREIGN KEY ("student_id") REFERENCES "stu"("id")`);
    await q.query(`ALTER TABLE "vers" ADD CONSTRAINT "vers_lib_edition_unique" UNIQUE ("lib_id", "edition")`);
    await q.query(`ALTER TABLE "vers" ADD COLUMN "activated_at" timestamptz NOT NULL DEFAULT now()`);
    await q.query(`ALTER TABLE "vers" ADD COLUMN "se_file_id" bigint REFERENCES "file"("id")`);
    await q.query(`ALTER TABLE "vers" ADD COLUMN "te_file_id" bigint REFERENCES "file"("id")`);
    await q.query(`CREATE FUNCTION "vers_file_kind_guard"() RETURNS trigger AS $$
      BEGIN
        IF NEW."se_file_id" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "file" WHERE "id" = NEW."se_file_id" AND "kind" = 'lib-se'
        ) THEN
          RAISE EXCEPTION 'VERS.se_file_id must reference FILE.kind=lib-se'
            USING ERRCODE = '23514', CONSTRAINT = 'vers_se_file_kind';
        END IF;
        IF NEW."te_file_id" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "file" WHERE "id" = NEW."te_file_id" AND "kind" = 'lib-te'
        ) THEN
          RAISE EXCEPTION 'VERS.te_file_id must reference FILE.kind=lib-te'
            USING ERRCODE = '23514', CONSTRAINT = 'vers_te_file_kind';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await q.query(`CREATE TRIGGER "vers_file_kind_guard_trigger"
      BEFORE INSERT OR UPDATE OF "se_file_id", "te_file_id" ON "vers"
      FOR EACH ROW EXECUTE FUNCTION "vers_file_kind_guard"()`);

    await q.query(`ALTER TABLE "issue" ALTER COLUMN "issued_on" DROP NOT NULL`);
    await q.query(`ALTER TABLE "issue" ADD COLUMN "state" varchar(12) NOT NULL DEFAULT 'ok'`);
    // 기존 반납 사실을 보존한 뒤 상태/날짜 제약과 활성 배부 unique를 적용한다.
    await q.query(`UPDATE "issue" SET "state" = 'returned' WHERE "returned_on" IS NOT NULL`);
    await q.query(`ALTER TABLE "issue" ADD COLUMN "progress_page" int`);
    await q.query(`ALTER TABLE "issue" ADD COLUMN "requested_by" bigint REFERENCES "staff"("id")`);
    await q.query(`ALTER TABLE "issue" ADD COLUMN "approved_by" bigint REFERENCES "staff"("id")`);
    await q.query(`ALTER TABLE "issue" ADD COLUMN "delivered_at" timestamptz`);
    await q.query(`ALTER TABLE "issue" ADD CONSTRAINT "issue_state_valid"
      CHECK ("state" IN ('wait','auto','ok','returned'))`);
    await q.query(`ALTER TABLE "issue" ADD CONSTRAINT "issue_progress_nonnegative"
      CHECK ("progress_page" IS NULL OR "progress_page" >= 0)`);
    await q.query(`ALTER TABLE "issue" ADD CONSTRAINT "issue_return_order"
      CHECK ("returned_on" IS NULL OR "issued_on" IS NULL OR "returned_on" >= "issued_on")`);
    await q.query(`ALTER TABLE "issue" ADD CONSTRAINT "issue_state_dates"
      CHECK (("state" IN ('wait','auto') AND "returned_on" IS NULL)
          OR ("state" = 'ok' AND "issued_on" IS NOT NULL AND "returned_on" IS NULL)
          OR ("state" = 'returned' AND "issued_on" IS NOT NULL AND "returned_on" IS NOT NULL))`);
    await q.query(`CREATE UNIQUE INDEX "issue_active_book_unique"
      ON "issue" ("student_id", "lib_id") WHERE "state" <> 'returned'`);
    await q.query(`ALTER TABLE "req" ADD COLUMN "student_id" bigint REFERENCES "stu"("id")`);

    await q.query(`ALTER TABLE "gpapack" ADD COLUMN "title" varchar(120)`);
    await q.query(`UPDATE "gpapack" SET "title" = CASE "pack_type"
      WHEN 'exam' THEN '시험 대비 자료 요청' ELSE '자습 자료 요청' END`);
    await q.query(`ALTER TABLE "gpapack" ALTER COLUMN "title" SET NOT NULL`);
    await q.query(`ALTER TABLE "gpapack" RENAME COLUMN "detail" TO "memo"`);
    await q.query(`ALTER TABLE "gpapack" ADD COLUMN "effective_on" date`);
    await q.query(`ALTER TABLE "gpapack" ADD COLUMN "coordinator_id" bigint REFERENCES "staff"("id")`);
    await q.query(`ALTER TABLE "gpapack" ADD COLUMN "created_by" bigint REFERENCES "staff"("id")`);
    await q.query(`ALTER TABLE "gpapack" ADD COLUMN "delivered_by" bigint REFERENCES "staff"("id")`);
    await q.query(`ALTER TABLE "gpapack" ADD COLUMN "delivered_at" timestamptz`);
    await q.query(`ALTER TABLE "gpapack" ADD COLUMN "received_by" bigint REFERENCES "staff"("id")`);
    await q.query(`ALTER TABLE "gpapack" ADD COLUMN "received_at" timestamptz`);
    await q.query(`ALTER TABLE "gpapack" ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now()`);
    // 승인과 전달은 다른 사실이다. 옛 상태를 보존하고 확인되지 않은 전달 시각은 만들지 않는다.
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM "gpapack" WHERE "state" NOT IN ('open','pending','approved')) THEN
        RAISE EXCEPTION 'GPAPACK legacy state requires explicit migration';
      END IF;
    END $$`);
    await q.query(`ALTER TABLE "gpapack" ADD COLUMN "legacy_state" varchar(12)`);
    await q.query(`UPDATE "gpapack" SET "legacy_state" = "state", "state" = 'pending'`);
    await q.query(`ALTER TABLE "gpapack" ADD CONSTRAINT "gpapack_type_valid" CHECK ("pack_type" IN ('exam','self'))`);
    await q.query(`ALTER TABLE "gpapack" ADD CONSTRAINT "gpapack_state_valid" CHECK ("state" IN ('pending','delivered','received'))`);
    await q.query(`ALTER TABLE "gpapack" ADD CONSTRAINT "gpapack_delivery_order" CHECK (
      ("state" = 'pending' AND "delivered_at" IS NULL AND "received_at" IS NULL)
      OR ("state" = 'delivered' AND "delivered_at" IS NOT NULL AND "received_at" IS NULL)
          OR ("state" = 'received' AND "delivered_at" IS NOT NULL AND "received_at" IS NOT NULL))`);
    /* 기존 요청의 미확정 적용일/담당자를 추정 이관하지 않는다. NOT VALID는 기존행을 보존하되 신규·수정행은 막는다. */
    await q.query(`ALTER TABLE "gpapack" ADD CONSTRAINT "gpapack_required_for_write"
      CHECK ("effective_on" IS NOT NULL AND "coordinator_id" IS NOT NULL) NOT VALID`);

    await q.query(`CREATE TABLE "gpapack_student" (
      "gpapack_id" bigint NOT NULL REFERENCES "gpapack"("id") ON DELETE CASCADE,
      "student_id" bigint NOT NULL REFERENCES "stu"("id"),
      PRIMARY KEY ("gpapack_id", "student_id")
    )`);
    await q.query(`INSERT INTO "gpapack_student" ("gpapack_id", "student_id")
      SELECT "id", "student_id" FROM "gpapack"`);
    await q.query(`CREATE TABLE "gpapack_lib" (
      "gpapack_id" bigint NOT NULL REFERENCES "gpapack"("id") ON DELETE CASCADE,
      "lib_id" bigint NOT NULL REFERENCES "lib"("id"),
      "vers_id" bigint,
      CONSTRAINT "gpapack_lib_vers_fk" FOREIGN KEY ("lib_id", "vers_id") REFERENCES "vers"("lib_id", "id"),
      PRIMARY KEY ("gpapack_id", "lib_id")
    )`);
    await q.query(`ALTER TABLE "gpapack" DROP COLUMN "student_id"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT g."id" FROM "gpapack" g
        LEFT JOIN "gpapack_student" s ON s."gpapack_id"=g."id"
        GROUP BY g."id" HAVING count(s."student_id") <> 1
      ) THEN
        RAISE EXCEPTION 'BookWorkflow down requires exactly one student per gpapack; refusing lossy rollback';
      END IF;
    END $$`);
    // Legacy rows may lack the new workflow fields; restoring their student must remain possible.
    await q.query(`ALTER TABLE "gpapack" DROP CONSTRAINT IF EXISTS "gpapack_required_for_write"`);
    await q.query(`ALTER TABLE "gpapack" ADD COLUMN "student_id" bigint`);
    await q.query(`UPDATE "gpapack" g SET "student_id" = s."student_id"
      FROM (SELECT "gpapack_id", min("student_id") AS "student_id" FROM "gpapack_student" GROUP BY "gpapack_id") s
      WHERE s."gpapack_id" = g."id"`);
    await q.query(`ALTER TABLE "gpapack" ALTER COLUMN "student_id" SET NOT NULL`);
    await q.query(`DROP TABLE "gpapack_lib"`);
    await q.query(`DROP TABLE "gpapack_student"`);
    await q.query(`ALTER TABLE "gpapack" DROP CONSTRAINT IF EXISTS "gpapack_delivery_order"`);
    await q.query(`ALTER TABLE "gpapack" DROP CONSTRAINT IF EXISTS "gpapack_state_valid"`);
    await q.query(`ALTER TABLE "gpapack" DROP CONSTRAINT IF EXISTS "gpapack_type_valid"`);
    const legacyColumn = await q.query(`SELECT 1 FROM pg_attribute
      WHERE attrelid='gpapack'::regclass AND attname='legacy_state' AND NOT attisdropped`);
    if (legacyColumn.length) {
      await q.query(`UPDATE "gpapack" SET "state" = CASE
        WHEN "state" IN ('delivered','received') THEN 'approved'
        ELSE COALESCE("legacy_state", 'pending') END`);
      await q.query(`ALTER TABLE "gpapack" DROP COLUMN "legacy_state"`);
    } else {
      await q.query(`UPDATE "gpapack" SET "state" = CASE "state"
        WHEN 'delivered' THEN 'approved' WHEN 'received' THEN 'approved' ELSE 'pending' END`);
    }
    await q.query(`ALTER TABLE "gpapack" DROP COLUMN "updated_at", DROP COLUMN "received_at", DROP COLUMN "received_by",
      DROP COLUMN "delivered_at", DROP COLUMN "delivered_by", DROP COLUMN "created_by", DROP COLUMN "coordinator_id", DROP COLUMN "effective_on"`);
    await q.query(`ALTER TABLE "gpapack" RENAME COLUMN "memo" TO "detail"`);
    await q.query(`ALTER TABLE "gpapack" DROP COLUMN "title"`);

    await q.query(`DROP INDEX IF EXISTS "issue_active_book_unique"`);
    await q.query(`ALTER TABLE "issue" DROP CONSTRAINT IF EXISTS "issue_state_dates"`);
    await q.query(`ALTER TABLE "issue" DROP CONSTRAINT IF EXISTS "issue_return_order"`);
    await q.query(`ALTER TABLE "issue" DROP CONSTRAINT IF EXISTS "issue_progress_nonnegative"`);
    await q.query(`ALTER TABLE "issue" DROP CONSTRAINT IF EXISTS "issue_state_valid"`);
    await q.query(`ALTER TABLE "req" DROP COLUMN "student_id"`);
    await q.query(`ALTER TABLE "issue" DROP COLUMN "delivered_at", DROP COLUMN "approved_by", DROP COLUMN "requested_by",
      DROP COLUMN "progress_page", DROP COLUMN "state"`);
    await q.query(`UPDATE "issue" SET "issued_on" = CURRENT_DATE WHERE "issued_on" IS NULL`);
    await q.query(`ALTER TABLE "issue" ALTER COLUMN "issued_on" SET NOT NULL`);

    await q.query(`DROP TRIGGER IF EXISTS "vers_file_kind_guard_trigger" ON "vers"`);
    await q.query(`DROP FUNCTION IF EXISTS "vers_file_kind_guard"()`);
    await q.query(`ALTER TABLE "vers" DROP COLUMN "te_file_id", DROP COLUMN "se_file_id", DROP COLUMN "activated_at"`);
    await q.query(`ALTER TABLE "vers" DROP CONSTRAINT IF EXISTS "vers_lib_edition_unique"`);
    await q.query(`ALTER TABLE "issue" DROP CONSTRAINT IF EXISTS "issue_student_fk"`);
    await q.query(`ALTER TABLE "issue" DROP CONSTRAINT IF EXISTS "issue_vers_lib_fk"`);
    await q.query(`ALTER TABLE "issue" DROP CONSTRAINT IF EXISTS "issue_lib_fk"`);
    await q.query(`ALTER TABLE "vers" DROP CONSTRAINT IF EXISTS "vers_lib_fk"`);
    await q.query(`ALTER TABLE "vers" DROP CONSTRAINT IF EXISTS "vers_lib_id_unique"`);
    await q.query(`ALTER TABLE "lib" DROP CONSTRAINT IF EXISTS "lib_sub_fk"`);
    await q.query(`ALTER TABLE "file" DROP CONSTRAINT IF EXISTS "file_kind_valid"`);
    await q.query(`ALTER TABLE "file" DROP CONSTRAINT "file_size_cap"`);
    await q.query(`ALTER TABLE "file" ADD CONSTRAINT "file_size_cap" CHECK ("bytes" > 0 AND "bytes" <= 8388608)`);
  }
}
