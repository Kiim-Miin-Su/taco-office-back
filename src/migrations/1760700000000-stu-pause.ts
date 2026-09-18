/** @file-guide
 * 목적: 1760700000000-stu-pause.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 학생 **휴원 기간** 표 — C92-c (테스트 시나리오 C-36 「장기 휴원」 · C-37 「복귀」).
 *
 * 「그 기간 일정이 시간표에서 빠진다 · 청구가 중단된다 · 복귀하면 재개된다 · 기간은 이력에 남는다」.
 * 회차를 지우거나 규칙을 끊으면 복귀할 때 되살릴 것이 없다. 그래서 기간 하나를 표에 적고,
 * 시간표·청구·명단이 그 기간의 회차를 「그날만 빠짐」과 같은 것으로 읽는다.
 *
 * 같은 학생의 기간은 겹치지 않는다 — EXCLUDE (btree_gist 는 init 이 이미 켰다).
 * 기존 행 0 (N-25 — 지금까지 휴원이 있었는지 아무도 모른다).
 */
export class StuPause1760700000000 implements MigrationInterface {
  name = 'StuPause1760700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "stu_pause" (
        "id"         bigserial PRIMARY KEY,
        "student_id" bigint NOT NULL REFERENCES "stu"("id") ON DELETE CASCADE,
        "from_date"  date   NOT NULL,
        "to_date"    date,
        "reason"     text,
        "by_id"      bigint NOT NULL REFERENCES "staff"("id"),
        "at"         timestamptz NOT NULL DEFAULT now(),
        "resumed_by" bigint REFERENCES "staff"("id"),
        "resumed_at" timestamptz,
        CONSTRAINT "stu_pause_range" CHECK ("to_date" IS NULL OR "to_date" >= "from_date"),
        CONSTRAINT "stu_pause_no_overlap" EXCLUDE USING gist (
          "student_id" WITH =,
          daterange("from_date", COALESCE("to_date", 'infinity'::date), '[]') WITH &&
        )
      )
    `);
    await q.query(`CREATE INDEX "stu_pause_student_from" ON "stu_pause" ("student_id", "from_date")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "stu_pause"`);
  }
}
