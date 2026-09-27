/** @file-guide
 * 목적: 1764110000000-stu-gender.ts — StuGender1764110000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 학생 성별 선택 칸 — N-83 채택 (대표 위임 2026-09-26 · W11).
 *
 * 원문 §10 학생별 시간표 목록이 성별 아바타(여/남/—)를 보인다. 개인정보 칸이라 **최소 수집 · 최소 노출**로 좁혔다:
 *   · 선택이다 — 비워 둬도 된다(두 값 CHECK · NULL 허용). 등록 확정 창이 학생을 새로 만들 때만 받는다.
 *   · 관리자 §10 아바타에만 쓴다 — 학부모·외부 출력(리포트 · 안내 · 보호자 발송 · PNG)에는 싣지 않는다.
 * **옛 행은 NULL 그대로**(N-25) — 이름이나 다른 칸으로 추정해 채우지 않는다. 그 학생은 지금처럼 「—」 아바타다.
 */
export class StuGender1764110000000 implements MigrationInterface {
  name = 'StuGender1764110000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "stu" ADD COLUMN "gender" varchar(6)`);
    await q.query(`
      ALTER TABLE "stu"
        ADD CONSTRAINT "stu_gender_words"
        CHECK ("gender" IS NULL OR "gender" IN ('female','male'))
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "stu" DROP CONSTRAINT IF EXISTS "stu_gender_words"`);
    await q.query(`ALTER TABLE "stu" DROP COLUMN IF EXISTS "gender"`);
  }
}
