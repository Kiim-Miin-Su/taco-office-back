/** @file-guide
 * 목적: 1763300000000-cpl-requester-closed.ts — CplRequesterClosed1763300000000 (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 컴플레인 문의자 관계 · 마무리 시각 — erd.dbml v4.49 (TBO-52 wave 6 · 원본 §67 카드 · g6 67-5 · 67-6).
 *
 * 원본 §67 카드는 학생 이름 옆에 **누가 알렸는지**(「고은설 어머니」)를, 「결과」 칸 카드의 바닥 오른쪽에
 * **마무리한 날**(「08-12」 — 열린 칸의 같은 자리는 「N일 지남」)을 적는다. 두 칸 다 `cpl` 에 없었다.
 *
 * - `requester` — 어머니 · 아버지(원본 §29 「누가 요청」과 같은 말 · 코드도 `cons.requester` 와 같다). 낱말은 `lib/complaint-words`.
 * - `closed_at` — 「결과」로 옮기는 **그 순간**을 서버가 찍는다(입력 칸이 아니다). 다시 열면 비운다.
 *   `cpl_closed_at_stage` 가 「열린 건에 마무리 시각」을 막는다 — 끝나지 않은 건이 마무리 날짜를 들면 거짓이다.
 *
 * **기존 행 보정 0 (N-25)** — 옛 컴플레인의 문의자도, 옛 「결과」 건이 언제 마무리됐는지도 아무도 모른다.
 * 둘 다 NULL 로 남고 화면은 짓지 않는다(관계는 안 서고 · 날짜는 「—」). 접수일이나 LOG 로 거꾸로 채우지 않는다.
 * 새 칸이라 옛 행은 전부 NULL 이고 두 CHECK 는 NOT VALID 로 새 쓰기부터 지킨다(규약 · 옛 행을 다시 훑지 않는다).
 *
 * `down` 은 제약 둘을 먼저 내리고 칸 둘을 지운다 — 이 칸들을 참조하는 표는 없다.
 */
export class CplRequesterClosed1763300000000 implements MigrationInterface {
  name = 'CplRequesterClosed1763300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "cpl" ADD COLUMN "requester" varchar(8)`);
    await q.query(`ALTER TABLE "cpl" ADD COLUMN "closed_at" timestamptz`);
    await q.query(`
      ALTER TABLE "cpl"
        ADD CONSTRAINT "cpl_requester_words"
        CHECK ("requester" IS NULL OR "requester" IN ('mother','father')) NOT VALID
    `);
    await q.query(`
      ALTER TABLE "cpl"
        ADD CONSTRAINT "cpl_closed_at_stage"
        CHECK ("closed_at" IS NULL OR "stage" = 'closed') NOT VALID
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "cpl" DROP CONSTRAINT IF EXISTS "cpl_closed_at_stage"`);
    await q.query(`ALTER TABLE "cpl" DROP CONSTRAINT IF EXISTS "cpl_requester_words"`);
    await q.query(`ALTER TABLE "cpl" DROP COLUMN IF EXISTS "closed_at"`);
    await q.query(`ALTER TABLE "cpl" DROP COLUMN IF EXISTS "requester"`);
  }
}
