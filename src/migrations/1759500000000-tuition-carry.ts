/** @file-guide
 * 목적: 1759500000000-tuition-carry.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §54 **「이월 처리」가 남기는 줄** (대표 결정 2026-09-13 · N-39).
 *
 * 「**이월 처리는 수업이 결제 됐으나 정해진 시수가 채워지지 않은 경우**」.
 * 즉 **받아 놓고 못 해 준 수업**이다 — 돈을 안 받았으면 이월할 것이 없다(그냥 안 청구된 것이고
 * §54 가 이미 빼고 있다).
 *
 * **왜 표가 필요한가.** 저장하지 않고 화면에서만 옮기면 다음 달에 **같은 결강이 또 넘어오거나
 * 아예 안 넘어온다** — 어느 쪽인지 아무도 모른다. 넘긴 사실은 돈이 걸린 일이라 이력으로 남는다.
 *
 * **한 달은 한 번만 넘긴다** (`carry_once`). 두 번 누르면 같은 돈이 두 번 넘어간다.
 *
 * 기존 행은 **한 줄도 만들지 않는다** (N-25 — 추정 이관 금지). 지난달에 못 해 준 수업이 있었는지는
 * 지금 데이터로 되짚을 수 있지만, **그때 대표가 넘기기로 했는지는 알 수 없다.**
 */
export class TuitionCarry1759500000000 implements MigrationInterface {
  name = 'TuitionCarry1759500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "carry" (
        "id"         bigserial PRIMARY KEY,
        "student_id" bigint NOT NULL REFERENCES "stu"("id"),
        "from_month" text   NOT NULL,
        "to_month"   text   NOT NULL,
        "amount"     int    NOT NULL,
        "sessions"   int    NOT NULL,
        "inv_id"     bigint REFERENCES "inv"("id"),
        "by_id"      bigint NOT NULL REFERENCES "staff"("id"),
        "at"         timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "carry_month_shape" CHECK (
          "from_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND "to_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
        ),
        CONSTRAINT "carry_forward" CHECK ("to_month" > "from_month"),
        CONSTRAINT "carry_positive" CHECK ("amount" > 0 AND "sessions" > 0)
      )
    `);
    // 한 달은 한 번만 넘긴다 — 두 번 누르면 같은 돈이 두 번 넘어간다
    await q.query(`CREATE UNIQUE INDEX "carry_once" ON "carry" ("student_id", "from_month")`);
    await q.query(`CREATE INDEX "carry_to_month" ON "carry" ("to_month")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "carry"`);
  }
}
