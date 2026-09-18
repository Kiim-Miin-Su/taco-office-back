/** @file-guide
 * 목적: 1761100000000-cpl-due-severity.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 컴플레인 기한 · 심각도 — C93 (테스트 시나리오 J-96 「수업 진도 불만 접수」 · J-98 「대응 기한을 넘김」 · N-46 ③).
 *
 * 원본 §67 카드에는 심각도(가벼움 · 보통 · 심각)가 붙고, PDF J-98 은 「대응 기한」을 넘긴 건을 본다.
 * 두 칸 다 없었다 — 접수하는 길(`POST /ops/complaints`)이 생기면서 채울 수 있게 됐다.
 * **기존 행 보정 0**(N-25 · N-46 결정문 그대로) — 옛 컴플레인의 심각도와 기한은 아무도 모른다. NULL 로 남고 화면은 「미지정」이라 적지 않고 칩을 세우지 않는다.
 * 심각도 낱말은 `lib/complaint-words` 한 곳이고 표의 CHECK 가 마지막에 막는다(NULL 허용).
 */
export class CplDueSeverity1761100000000 implements MigrationInterface {
  name = 'CplDueSeverity1761100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "cpl" ADD COLUMN "due_on" date`);
    await q.query(`ALTER TABLE "cpl" ADD COLUMN "severity" varchar(8)`);
    await q.query(`
      ALTER TABLE "cpl"
        ADD CONSTRAINT "cpl_severity_words"
        CHECK ("severity" IS NULL OR "severity" IN ('light','normal','severe'))
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "cpl" DROP CONSTRAINT IF EXISTS "cpl_severity_words"`);
    await q.query(`ALTER TABLE "cpl" DROP COLUMN IF EXISTS "severity"`);
    await q.query(`ALTER TABLE "cpl" DROP COLUMN IF EXISTS "due_on"`);
  }
}
