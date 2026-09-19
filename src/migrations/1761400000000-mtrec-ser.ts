/** @file-guide
 * 목적: 1761400000000-mtrec-ser.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 회의 기록을 **시간표의 회차에 잇는다** — C96 (N-46 ③ · 원문 §63 회의 목록).
 *
 * 컷 §63 의 줄은 「26년 9월 18일 금요일 **11:00–12:00**」과 **「1호」 또는 「온라인 TN」**을 보여 준다.
 * `mtrec` 에는 `on_date`(DATE)뿐이라 시각도 자리도 담을 수 없다. 그런데 **회의는 이미 시간표에 있다** —
 * 시드의 `ser 21`(`kind_key='meeting'` · `sub_key='mt-pg'` · 월 10:00 · 강의실 4)이 그것이다.
 *
 * 그래서 `mtrec` 에 `start_min`·`end_min`·`room_id`·`zacc_id` 네 칸을 새기지 않는다. 새기면
 *   ① 같은 사실이 두 곳에 산다(D-R22) — 회의를 시간표에서 옮기면 둘이 갈린다
 *   ② **겹침을 아무도 안 막는다** — `ser_occ` 의 EXCLUDE 는 강사·강의실·줌을 이미 지키지만
 *      `mtrec` 의 칸은 그 판정 밖이라, 회의가 수업이 쓰는 줌 계정을 조용히 겹쳐 잡는다.
 * 대신 **한 칸**으로 잇는다. C95 가 컨설팅 회차에서 이미 낸 길이다(`cons_sess.ser_id`).
 *
 * `ON DELETE SET NULL` — 회차가 사라져도 **회의 기록은 남는다.** 속기록·참석·거기서 나온 할 일은
 * 「그 회의가 있었다」는 사실이고, 일정이 지워졌다고 없던 일이 되지 않는다.
 * 부분 유니크 — 한 회차에 회의 기록 하나(`ser_id IS NOT NULL` 인 줄만).
 *
 * **기존 5행은 NULL — 보정 0**(N-25). 옛 회의가 어느 회차였는지는 아무도 모른다
 * (시드의 `on_date` 는 화요일인데 `ser 21` 은 월요일이다 — 추측해 이으면 없는 사실이 생긴다).
 * 화면은 시각·자리를 비워 두고 그 사실을 말한다.
 */
export class MtrecSer1761400000000 implements MigrationInterface {
  name = 'MtrecSer1761400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "mtrec" ADD COLUMN "ser_id" bigint`);
    await q.query(`
      ALTER TABLE "mtrec"
        ADD CONSTRAINT "mtrec_ser_fk"
        FOREIGN KEY ("ser_id") REFERENCES "ser"("id") ON DELETE SET NULL
    `);
    await q.query(`CREATE UNIQUE INDEX "mtrec_ser_once" ON "mtrec" ("ser_id") WHERE "ser_id" IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "mtrec_ser_once"`);
    await q.query(`ALTER TABLE "mtrec" DROP CONSTRAINT IF EXISTS "mtrec_ser_fk"`);
    await q.query(`ALTER TABLE "mtrec" DROP COLUMN IF EXISTS "ser_id"`);
  }
}
