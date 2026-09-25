/** @file-guide
 * 목적: 1762500000000-guide-direction.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §44 안내 학생별 — 「지도 방향」 상자와 「관리자 코멘트 · 강사만」 상자 (g4 §44-3 · C78 「§44 구조화·별도 코멘트 미완」).
 *
 * 원문 §44 는 안내 본문 한 상자가 아니라 두 상자를 더 둔다. `GUIDE.body` 한 칸으로는
 * 「학부모에게 나가는 말」과 「강사에게만 남기는 말」을 가를 수 없다 — 섞어 두면 관리자 메모가
 * 그대로 학부모 발송 본문·안내문 PNG 에 실린다. 그래서 칸을 둘로 나눈다.
 *
 * - `direction`  — 지도 방향(강사·관리자가 함께 보는 수업 방향).
 * - `admin_note` — 관리자 코멘트. **강사에게만** 보인다 — 학부모 발송 본문(body)·안내문 PNG 에 싣지 않는다.
 * 둘 다 NULL 허용 · 옛 안내는 NULL(추정 보정 0 · N-25) · 길이는 본문과 같은 4000자(DTO 와 같은 한도)를 표가 마지막으로 막는다.
 */
export class GuideDirection1762500000000 implements MigrationInterface {
  name = 'GuideDirection1762500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "guide" ADD COLUMN "direction" text`);
    await q.query(`ALTER TABLE "guide" ADD COLUMN "admin_note" text`);
    await q.query(
      `ALTER TABLE "guide" ADD CONSTRAINT "guide_direction_len" CHECK ("direction" IS NULL OR char_length("direction") <= 4000)`,
    );
    await q.query(
      `ALTER TABLE "guide" ADD CONSTRAINT "guide_admin_note_len" CHECK ("admin_note" IS NULL OR char_length("admin_note") <= 4000)`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "guide" DROP CONSTRAINT IF EXISTS "guide_admin_note_len"`);
    await q.query(`ALTER TABLE "guide" DROP CONSTRAINT IF EXISTS "guide_direction_len"`);
    await q.query(`ALTER TABLE "guide" DROP COLUMN IF EXISTS "admin_note"`);
    await q.query(`ALTER TABLE "guide" DROP COLUMN IF EXISTS "direction"`);
  }
}
