/** @file-guide
 * 목적: 교재 배부의 취소·반려 종료 사실과 재배부 계보를 ISSUE 원장에 보존한다.
 * 책임/재사용: 활성 상태를 wait·auto·ok 하나로 정의하고, 종료 사유·처리자·시각과 1:1 재배부 계보를 DB 제약으로 막는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class BookIssueTerminalReissue1765100000000 implements MigrationInterface {
  name = 'BookIssueTerminalReissue1765100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "issue_active_book_unique"`);
    await q.query(`ALTER TABLE "issue" DROP CONSTRAINT "issue_state_dates"`);
    await q.query(`ALTER TABLE "issue" DROP CONSTRAINT "issue_state_valid"`);
    await q.query(`ALTER TABLE "issue" ADD COLUMN "ended_reason" varchar(500)`);
    await q.query(`ALTER TABLE "issue" ADD COLUMN "ended_by" bigint REFERENCES "staff"("id")`);
    await q.query(`ALTER TABLE "issue" ADD COLUMN "ended_at" timestamptz`);
    await q.query(`ALTER TABLE "issue" ADD COLUMN "reissued_from" bigint REFERENCES "issue"("id")`);
    await q.query(`ALTER TABLE "issue" ADD CONSTRAINT "issue_reissued_not_self"
      CHECK ("reissued_from" IS NULL OR "reissued_from" <> "id")`);
    await q.query(`ALTER TABLE "issue" ADD CONSTRAINT "issue_state_valid"
      CHECK ("state" IN ('wait','auto','ok','returned','canceled','rejected'))`);
    await q.query(`ALTER TABLE "issue" ADD CONSTRAINT "issue_state_dates" CHECK (
      ("state" IN ('wait','auto') AND "issued_on" IS NULL AND "returned_on" IS NULL
        AND "ended_reason" IS NULL AND "ended_by" IS NULL AND "ended_at" IS NULL)
      OR ("state" = 'ok' AND "issued_on" IS NOT NULL AND "returned_on" IS NULL
        AND "ended_reason" IS NULL AND "ended_by" IS NULL AND "ended_at" IS NULL)
      OR ("state" = 'returned' AND "issued_on" IS NOT NULL AND "returned_on" IS NOT NULL
        AND "ended_reason" IS NULL AND "ended_by" IS NULL AND "ended_at" IS NULL)
      OR ("state" IN ('canceled','rejected') AND "issued_on" IS NULL AND "returned_on" IS NULL
        AND length(btrim("ended_reason")) > 0 AND "ended_by" IS NOT NULL AND "ended_at" IS NOT NULL)
    )`);
    await q.query(`CREATE UNIQUE INDEX "issue_active_book_unique"
      ON "issue" ("student_id", "lib_id") WHERE "state" IN ('wait','auto','ok')`);
    await q.query(`CREATE UNIQUE INDEX "issue_reissued_from_unique"
      ON "issue" ("reissued_from") WHERE "reissued_from" IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM "issue" WHERE "state" IN ('canceled','rejected') OR "reissued_from" IS NOT NULL) THEN
        RAISE EXCEPTION 'BookIssueTerminalReissue down would discard terminal/reissue facts';
      END IF;
    END $$`);
    await q.query(`DROP INDEX "issue_reissued_from_unique"`);
    await q.query(`DROP INDEX "issue_active_book_unique"`);
    await q.query(`ALTER TABLE "issue" DROP CONSTRAINT "issue_state_dates"`);
    await q.query(`ALTER TABLE "issue" DROP CONSTRAINT "issue_state_valid"`);
    await q.query(`ALTER TABLE "issue" DROP CONSTRAINT "issue_reissued_not_self"`);
    await q.query(`ALTER TABLE "issue" DROP COLUMN "reissued_from"`);
    await q.query(`ALTER TABLE "issue" DROP COLUMN "ended_at"`);
    await q.query(`ALTER TABLE "issue" DROP COLUMN "ended_by"`);
    await q.query(`ALTER TABLE "issue" DROP COLUMN "ended_reason"`);
    await q.query(`ALTER TABLE "issue" ADD CONSTRAINT "issue_state_valid"
      CHECK ("state" IN ('wait','auto','ok','returned'))`);
    await q.query(`ALTER TABLE "issue" ADD CONSTRAINT "issue_state_dates"
      CHECK (("state" IN ('wait','auto') AND "returned_on" IS NULL)
          OR ("state" = 'ok' AND "issued_on" IS NOT NULL AND "returned_on" IS NULL)
          OR ("state" = 'returned' AND "issued_on" IS NOT NULL AND "returned_on" IS NOT NULL))`);
    await q.query(`CREATE UNIQUE INDEX "issue_active_book_unique"
      ON "issue" ("student_id", "lib_id") WHERE "state" <> 'returned'`);
  }
}
