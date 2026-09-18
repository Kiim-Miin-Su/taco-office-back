/** @file-guide
 * 목적: 1761200000000-cons-close-gpa-close.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 컨설팅 회차 기록·종료 + GPA 사이클 마감 — C95 (테스트 시나리오 I-91 「회차 기록 — 날짜 3개 고르기」 · I-95 「컨설팅 종료」 · O-150 「4주마다 — GPA 사이클 마감」).
 *
 * ① `cons_event.event_type` 에 세 낱말을 더한다 — `session_added`(회차 잡음) · `session_written`(육하원칙 적음) · `closed`(종료).
 *    컨설팅에는 이미 행위 감사 원장(`cons_event`)이 있다 — 종료의 누가·언제는 그 원장의 `closed` 행이고 `cons` 에 칸을 파지 않는다.
 * ② `gpa_cycle.closed_at/closed_by` — 지금까지 `closed` 는 시드만 켜는 불리언이라 **누가 언제 마감했는지 아무도 모른다.**
 *    짝 CHECK(`gpa_cycle_closed_pair`)와 「찍혔으면 닫혀 있다」 CHECK(`gpa_cycle_closed_stamp`). **기존 행 보정 0**(N-25) —
 *    옛 닫힌 사이클은 `closed=true` 에 도장 NULL 로 남고 화면은 「마감 · 누가」를 세우지 않는다.
 */
export class ConsCloseGpaClose1761200000000 implements MigrationInterface {
  name = 'ConsCloseGpaClose1761200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "cons_event" DROP CONSTRAINT IF EXISTS "cons_event_type_check"`);
    await q.query(`
      ALTER TABLE "cons_event"
        ADD CONSTRAINT "cons_event_type_check"
        CHECK ("event_type" IN ('created','share_changed','file_added','file_removed','feedback_added','feedback_resolved','parent_delivered','payment_added','archived','session_added','session_written','closed'))
    `);
    await q.query(`ALTER TABLE "gpa_cycle" ADD COLUMN "closed_at" timestamptz`);
    await q.query(`ALTER TABLE "gpa_cycle" ADD COLUMN "closed_by" bigint`);
    await q.query(`ALTER TABLE "gpa_cycle" ADD CONSTRAINT "gpa_cycle_closed_by_fk" FOREIGN KEY ("closed_by") REFERENCES "staff"("id") ON DELETE RESTRICT`);
    await q.query(`ALTER TABLE "gpa_cycle" ADD CONSTRAINT "gpa_cycle_closed_pair" CHECK (("closed_at" IS NULL) = ("closed_by" IS NULL))`);
    await q.query(`ALTER TABLE "gpa_cycle" ADD CONSTRAINT "gpa_cycle_closed_stamp" CHECK ("closed_at" IS NULL OR "closed")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "gpa_cycle" DROP CONSTRAINT IF EXISTS "gpa_cycle_closed_stamp"`);
    await q.query(`ALTER TABLE "gpa_cycle" DROP CONSTRAINT IF EXISTS "gpa_cycle_closed_pair"`);
    await q.query(`ALTER TABLE "gpa_cycle" DROP CONSTRAINT IF EXISTS "gpa_cycle_closed_by_fk"`);
    await q.query(`ALTER TABLE "gpa_cycle" DROP COLUMN IF EXISTS "closed_by"`);
    await q.query(`ALTER TABLE "gpa_cycle" DROP COLUMN IF EXISTS "closed_at"`);
    await q.query(`ALTER TABLE "cons_event" DROP CONSTRAINT IF EXISTS "cons_event_type_check"`);
    await q.query(`
      ALTER TABLE "cons_event"
        ADD CONSTRAINT "cons_event_type_check"
        CHECK ("event_type" IN ('created','share_changed','file_added','file_removed','feedback_added','feedback_resolved','parent_delivered','payment_added','archived'))
    `);
  }
}
