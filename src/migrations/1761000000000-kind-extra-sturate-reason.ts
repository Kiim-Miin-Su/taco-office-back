/** @file-guide
 * 목적: 1761000000000-kind-extra-sturate-reason.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 추가 수업 표시 · 단가 예외 사유 — C94-d (테스트 시나리오 C-38 「추가 수업 만들기」 · H-81 「형제 할인 — 사유가 없으면 실패」).
 *
 * ① `kind.extra` — 「이 종류의 회차는 정규 회차가 아니라 **추가 수업**이다」. 시간표에 「추가」 배지가 서고
 *    §54 상단 「추가」 칸에 따로 세며 청구서 줄 이름이 「추가 수업 · 과목」이 된다. 종류(KIND)는 §18 프로그램 관리가
 *    만드는 데이터라 여기서 행을 넣지 않는다 — 깃발 하나만 새긴다. 기존 종류는 전부 false.
 * ② `sturate.reason / by_id / created_at` — 학생별 단가 예외에 **사유·누가·언제**. 새 행은 사유가 있어야 한다
 *    (`sturate_reason_present` · NOT VALID — 시드가 넣어 둔 옛 예외 2행은 사유를 모르므로 보정 0 · N-25).
 */
export class KindExtraSturateReason1761000000000 implements MigrationInterface {
  name = 'KindExtraSturateReason1761000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "kind" ADD COLUMN "extra" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "sturate" ADD COLUMN "reason" text`);
    await q.query(`ALTER TABLE "sturate" ADD COLUMN "by_id" bigint REFERENCES "staff"("id")`);
    await q.query(`ALTER TABLE "sturate" ADD COLUMN "created_at" timestamptz NOT NULL DEFAULT now()`);
    await q.query(`
      ALTER TABLE "sturate"
        ADD CONSTRAINT "sturate_reason_present"
        CHECK ("reason" IS NOT NULL AND btrim("reason") <> '') NOT VALID
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "sturate" DROP CONSTRAINT IF EXISTS "sturate_reason_present"`);
    await q.query(`ALTER TABLE "sturate" DROP COLUMN IF EXISTS "created_at"`);
    await q.query(`ALTER TABLE "sturate" DROP COLUMN IF EXISTS "by_id"`);
    await q.query(`ALTER TABLE "sturate" DROP COLUMN IF EXISTS "reason"`);
    await q.query(`ALTER TABLE "kind" DROP COLUMN IF EXISTS "extra"`);
  }
}
