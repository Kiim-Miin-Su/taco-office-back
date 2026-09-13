/** @file-guide
 * 목적: §16 알림 분류를 NOTI 원장에 명시해 최초 독촉과 재알람을 구분한다.
 * 책임/재사용: 영속 스키마와 기존 행의 결정 가능한 분류만 이관한다. 런타임 본문 추론은 하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class NotiCategory1759600000000 implements MigrationInterface {
  name = 'NotiCategory1759600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "noti" ADD COLUMN "category" varchar(20)`);
    /* 과거 행에는 분류 컬럼이 없었다. 링크로 확정 가능한 갈래와 기존 시드의 정확한 재알람
       한 문장만 이관하고, 앞으로의 쓰기는 모든 INSERT가 category를 명시한다. */
    await q.query(`
      UPDATE "noti"
         SET "category" = CASE
           WHEN "body" = '4시간 이상 미작성 16건 — 재알람이 필요합니다.' THEN 're_alarm'
           WHEN "link" LIKE '/reports/unwritten%' THEN 'report_due'
           WHEN "link" LIKE '/reports%' THEN 'report'
           WHEN "link" LIKE '/schedule%' THEN 'schedule'
           WHEN "link" LIKE '/ops%' OR "link" LIKE '/drawer%' OR "link" LIKE '/teacher%' THEN 'request'
           ELSE 'etc'
         END
    `);
    await q.query(`ALTER TABLE "noti" ALTER COLUMN "category" SET DEFAULT 'etc'`);
    await q.query(`ALTER TABLE "noti" ALTER COLUMN "category" SET NOT NULL`);
    await q.query(`ALTER TABLE "noti" ADD CONSTRAINT "noti_category_valid"
      CHECK ("category" IN ('report_due','re_alarm','report','schedule','request','etc'))`);
    await q.query(`CREATE INDEX "noti_category_created" ON "noti" ("category", "created_at")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "noti_category_created"`);
    await q.query(`ALTER TABLE "noti" DROP CONSTRAINT IF EXISTS "noti_category_valid"`);
    await q.query(`ALTER TABLE "noti" DROP COLUMN IF EXISTS "category"`);
  }
}
