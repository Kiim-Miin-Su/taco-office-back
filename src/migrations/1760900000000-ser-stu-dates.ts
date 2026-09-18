/** @file-guide
 * 목적: 1760900000000-ser-stu-dates.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 명단(SER_STU)에 **기간** — C94-c (테스트 시나리오 H-80 「중도 환불」 · N-135 · N-136 「학생이 갑자기 그만둠」 · N-50 ①).
 *
 * 「수강이 종료 처리된다 · 이후 일정이 정리된다 · 그룹 수업이면 남은 학생 단가가 다시 계산된다」.
 * 명단 행을 지우면(「아주 빼기」) 지난달 회차까지 그 학생이 사라져 이미 청구한 달의 셈이 바뀐다(N-50).
 * 그래서 행을 지우지 않고 `to_date` 를 적는다 — 그 날까지는 있었고 그 뒤로는 없는 학생이다.
 * 시간표·§54·청구서·단가 구간(인원)이 `lib/sql.serStuOn` 한 조각으로 그 날짜의 명단을 읽는다.
 * `from_date` 는 같은 모양의 시작 — 등록 확정(C91)이 적을 자리다.
 *
 * 기존 행은 둘 다 NULL(= 기간 없음 · 지금까지와 같다) — 보정 0 (N-25).
 */
export class SerStuDates1760900000000 implements MigrationInterface {
  name = 'SerStuDates1760900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "ser_stu" ADD COLUMN "from_date" date`);
    await q.query(`ALTER TABLE "ser_stu" ADD COLUMN "to_date" date`);
    await q.query(`
      ALTER TABLE "ser_stu"
        ADD CONSTRAINT "ser_stu_range"
        CHECK ("from_date" IS NULL OR "to_date" IS NULL OR "to_date" >= "from_date")
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "ser_stu" DROP CONSTRAINT IF EXISTS "ser_stu_range"`);
    await q.query(`ALTER TABLE "ser_stu" DROP COLUMN IF EXISTS "to_date"`);
    await q.query(`ALTER TABLE "ser_stu" DROP COLUMN IF EXISTS "from_date"`);
  }
}
