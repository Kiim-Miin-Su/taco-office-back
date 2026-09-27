/** @file-guide
 * 목적: 1764100000000-exc-mode-memo.ts — ExcModeMemo1764100000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 회차 예외(EXC)에 칸 둘 — N-56 · N-57 채택 (대표 위임 2026-09-26 · W11).
 *
 * ① `exc.mode` — 그 회차 하나의 방식(offline · online). **NULL 이면 규칙(SER.mode)을 따른다.**
 *    원문이 EXC 를 「그날만 다른 것」(슬라이드 2)으로 두고 줌 배정 키를 회차 단위로 두므로(슬라이드 94)
 *    회차 방식 전환은 그 모델의 칸이다. 온라인이면 강의실을 비우고 줌을 EXC 대상 ZASSIGN 에 붙인다(쓰기 쪽 일).
 * ② `exc.memo` — 그 회차에 붙는 한 줄(「이번 회차만」). 블록 「노트」 배지 · §08 #2 회차 메모 줄이 읽는다.
 *    `exc.reason` 은 휴강 메모 자리라 섞지 않는다. 누가·언제는 스케줄 쓰기 LOG(N-73)가 남긴다.
 *
 * **옛 행 보정 0**(N-25) — 두 칸 다 NULL 로 시작한다. 새 칸이라 어긋난 행이 있을 수 없어 CHECK 를 바로 건다.
 * 메모 CHECK 는 DTO 와 같은 선(공백만은 안 된다 · 200자)이다 — 빈 메모가 남으면 「노트」 배지가 거짓이 된다.
 */
export class ExcModeMemo1764100000000 implements MigrationInterface {
  name = 'ExcModeMemo1764100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "exc" ADD COLUMN "mode" varchar(8)`);
    await q.query(`ALTER TABLE "exc" ADD COLUMN "memo" text`);
    await q.query(`
      ALTER TABLE "exc"
        ADD CONSTRAINT "exc_mode_words"
        CHECK ("mode" IS NULL OR "mode" IN ('offline','online'))
    `);
    await q.query(`
      ALTER TABLE "exc"
        ADD CONSTRAINT "exc_memo_len"
        CHECK ("memo" IS NULL OR (char_length(btrim("memo")) > 0 AND char_length("memo") <= 200))
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "exc" DROP CONSTRAINT IF EXISTS "exc_memo_len"`);
    await q.query(`ALTER TABLE "exc" DROP CONSTRAINT IF EXISTS "exc_mode_words"`);
    await q.query(`ALTER TABLE "exc" DROP COLUMN IF EXISTS "memo"`);
    await q.query(`ALTER TABLE "exc" DROP COLUMN IF EXISTS "mode"`);
  }
}
