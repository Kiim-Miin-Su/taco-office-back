/** @file-guide
 * 목적: 1760800000000-month-close.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §54 **「N월 마감」** 표 — C92-d (테스트 시나리오 C-39 「월 마감」 · L-123 「마감 후 과거 수정」 · N-140 「마감 후 잘못 발견」).
 *
 * 「마감 후에도 자유롭게 고쳐지면 실패 · 이월 확정분이 바뀌지 않는다 · 흔적 없이 고쳐지면 실패」.
 * 마감은 행 하나이고 해제는 그 행에 누가·언제·왜를 적는다 — 지우지 않는다. 다시 마감하면 새 행.
 * 열려 있는 마감은 달마다 하나(부분 유니크). 기존 행 0 (N-25).
 */
export class MonthClose1760800000000 implements MigrationInterface {
  name = 'MonthClose1760800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "month_close" (
        "id"            bigserial PRIMARY KEY,
        "year_month"    text   NOT NULL,
        "closed_by"     bigint NOT NULL REFERENCES "staff"("id"),
        "closed_at"     timestamptz NOT NULL DEFAULT now(),
        "reopened_by"   bigint REFERENCES "staff"("id"),
        "reopened_at"   timestamptz,
        "reopen_reason" text,
        CONSTRAINT "month_close_shape" CHECK ("year_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        CONSTRAINT "month_close_reopen_pair" CHECK (
          ("reopened_at" IS NULL) = ("reopened_by" IS NULL) AND ("reopened_at" IS NULL OR "reopen_reason" IS NOT NULL)
        )
      )
    `);
    await q.query(`CREATE UNIQUE INDEX "month_close_open_once" ON "month_close" ("year_month") WHERE "reopened_at" IS NULL`);
    await q.query(`CREATE INDEX "month_close_year_month" ON "month_close" ("year_month")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "month_close"`);
  }
}
