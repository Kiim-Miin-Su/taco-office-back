/** @file-guide
 * 목적: 1764400000000-weekly-bundle-pdflog-rep.ts — WeeklyBundlePdflogRep1764400000000 (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W11 R2 — 주간 묶음(N-54) · 리포트 파일의 리포트 칸(7-3 ① F3).
 *
 * - `pdflog.rep_id` — 보존한 리포트 PNG 한 장이 **어느 리포트의 것인지**. 지금까지는 `ref_id`(= RSEND)만 있어
 *   한 학생 하루 묶음 안의 여러 장을 리포트와 짝지을 수 없었다(파일 권한 판정이 `rsend.rep_ids` 전체를 봤다).
 *   **옛 행은 NULL 그대로다**(N-25 · 어느 장이 어느 리포트였는지 지금 와서 짐작하지 않는다) — 읽는 쪽은 NULL 이면
 *   예전처럼 묶음 전체로 판정한다. REP 행은 앱이 지우지 않는다(투영은 UPSERT · 참조가 있으면 규칙을 남긴다) — FK 는 즉시 NO ACTION.
 * - `guardian_send.wrep_id` — 보호자 선택 발송(DQ3)이 **주간 묶음**에서 나갔으면 그 묶음. 한 발송은 회차 안내(`pnoti_id`)나
 *   주간 묶음 중 **하나에서만** 나간다(`guardian_send_one_source`). 옛 행은 전부 NULL 이라 CHECK 를 바로 건다.
 * - `wrep` — 지금까지 제약이 없던 표다(0행). N-54 채택: `body` 에는 **사람이 쓴 총평만** `{summary, by, at}` 세 칸으로 둔다
 *   (그 주의 리포트 본문은 읽을 때 모은다 — 저장하지 않는다). `week_of` 는 그 주의 **월요일**(KST 달력 날짜).
 *   셋 다 `NOT VALID` — 새 행만 검사하고 옛 행은 고치지 않는다(N-25 · 옛 행이 있으면 사람이 본다).
 *
 * `down` 은 칸 둘을 지운다 — 그 사이 쌓인 「어느 리포트 · 어느 묶음」 연결이 사라진다(파일과 발송 줄 자체는 남는다).
 */
export class WeeklyBundlePdflogRep1764400000000 implements MigrationInterface {
  name = 'WeeklyBundlePdflogRep1764400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "pdflog" ADD COLUMN "rep_id" bigint`);
    await q.query(`ALTER TABLE "pdflog" ADD CONSTRAINT "pdflog_rep_id_fkey" FOREIGN KEY ("rep_id") REFERENCES "rep"("id")`);
    await q.query(`CREATE INDEX "pdflog_rep_idx" ON "pdflog" ("rep_id") WHERE "rep_id" IS NOT NULL`);

    await q.query(`ALTER TABLE "guardian_send" ADD COLUMN "wrep_id" bigint`);
    await q.query(`ALTER TABLE "guardian_send" ADD CONSTRAINT "guardian_send_wrep_id_fkey" FOREIGN KEY ("wrep_id") REFERENCES "wrep"("id")`);
    await q.query(`ALTER TABLE "guardian_send" ADD CONSTRAINT "guardian_send_one_source" CHECK ("pnoti_id" IS NULL OR "wrep_id" IS NULL)`);
    await q.query(`CREATE INDEX "guardian_send_wrep_idx" ON "guardian_send" ("wrep_id") WHERE "wrep_id" IS NOT NULL`);

    await q.query(`ALTER TABLE "wrep" ADD CONSTRAINT "wrep_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "stu"("id") NOT VALID`);
    await q.query(`ALTER TABLE "wrep" ADD CONSTRAINT "wrep_week_monday" CHECK (extract(isodow from "week_of") = 1) NOT VALID`);
    await q.query(`
      ALTER TABLE "wrep" ADD CONSTRAINT "wrep_body_summary" CHECK (
        "body" IS NULL OR (
          jsonb_typeof("body") = 'object'
          AND COALESCE(jsonb_typeof("body"->'summary'), '') = 'string'
          AND char_length(btrim("body"->>'summary')) BETWEEN 1 AND 2000
          AND COALESCE(jsonb_typeof("body"->'by'), '') = 'number'
          AND COALESCE(jsonb_typeof("body"->'at'), '') = 'string'
          AND ("body" - 'summary' - 'by' - 'at') = '{}'::jsonb
        )
      ) NOT VALID`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "wrep" DROP CONSTRAINT IF EXISTS "wrep_body_summary"`);
    await q.query(`ALTER TABLE "wrep" DROP CONSTRAINT IF EXISTS "wrep_week_monday"`);
    await q.query(`ALTER TABLE "wrep" DROP CONSTRAINT IF EXISTS "wrep_student_id_fkey"`);

    await q.query(`DROP INDEX IF EXISTS "guardian_send_wrep_idx"`);
    await q.query(`ALTER TABLE "guardian_send" DROP CONSTRAINT IF EXISTS "guardian_send_one_source"`);
    await q.query(`ALTER TABLE "guardian_send" DROP CONSTRAINT IF EXISTS "guardian_send_wrep_id_fkey"`);
    await q.query(`ALTER TABLE "guardian_send" DROP COLUMN IF EXISTS "wrep_id"`);

    await q.query(`DROP INDEX IF EXISTS "pdflog_rep_idx"`);
    await q.query(`ALTER TABLE "pdflog" DROP CONSTRAINT IF EXISTS "pdflog_rep_id_fkey"`);
    await q.query(`ALTER TABLE "pdflog" DROP COLUMN IF EXISTS "rep_id"`);
  }
}
