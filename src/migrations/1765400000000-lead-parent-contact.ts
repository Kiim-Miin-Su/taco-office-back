/** @file-guide
 * 목적: 상담 건(LEAD)에 학부모 관계 · 연락처 · 원하는 것 세 칸을 새긴다 (테스트 시나리오 A-01).
 * 책임/재사용: 새 칸만 더한다 — 옛 행은 NULL(N-25 · 그때 무엇을 적었는지는 접촉 원장의 자유 글에 섞여 있고 되짚지 않는다). 연락처 모양은 보호자 번호와 같은 CHECK 다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A-01 「② 이름 · 학년 · 학교 ③ 학부모 어머니 · 연락처 010-1234-5678 ⑤ 원하는 것 MAP Reading 점수 올리기」.
 * C90 은 LEAD 에 이 칸이 없어(N-42 · 학부모 수신처를 정하기 전) 셋을 **첫 접촉 한 줄**(자유 글)에 섞어 두었다 —
 * 그래서 카드에 「원하는 것」을 올리지 못했고(연락처가 섞일 수 있다 · 23-11) 등록 뒤 보호자(GUARDIAN · DQ3)로 이어 줄 수도 없었다.
 *
 * - `parent_phone` 은 보호자 번호(`guardian_phone_digits`)와 **같은 모양**이다(숫자만 010xxxxxxxx) — 등록 확정이 그대로 옮긴다.
 * - 옛 행은 NULL 이다 — 접촉 원장의 글에서 번호를 뽑아 채우지 않는다(추정 이관 금지 · N-25).
 * - down 은 채워진 행이 있으면 멈춘다 — 칸을 버리면 적어 둔 연락처가 사라진다.
 */
export class LeadParentContact1765400000000 implements MigrationInterface {
  name = 'LeadParentContact1765400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "lead" ADD COLUMN "parent_relation" varchar(20), ADD COLUMN "parent_phone" varchar(11), ADD COLUMN "want" varchar(120)`);
    await q.query(`ALTER TABLE "lead" ADD CONSTRAINT "lead_parent_phone_digits" CHECK ("parent_phone" IS NULL OR "parent_phone" ~ '^0[0-9]{9,10}$')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM "lead" WHERE "parent_relation" IS NOT NULL OR "parent_phone" IS NOT NULL OR "want" IS NOT NULL) THEN
        RAISE EXCEPTION 'LeadParentContact down would discard stored inquiry contacts';
      END IF;
    END $$`);
    await q.query(`ALTER TABLE "lead" DROP CONSTRAINT IF EXISTS "lead_parent_phone_digits"`);
    await q.query(`ALTER TABLE "lead" DROP COLUMN "want", DROP COLUMN "parent_phone", DROP COLUMN "parent_relation"`);
  }
}
