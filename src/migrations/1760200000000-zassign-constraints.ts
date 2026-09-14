/** @file-guide
 * 목적: ZASSIGN 의 물리 제약 — DBML 이 선언한 참조와 코드가 지켜 온 「한 줄」을 DB 에 새긴다.
 * 책임/재사용: 기존 행을 보정하지 않고 제약만 더한다. 배정 판정은 서비스가, 저장 보장은 여기가 맡는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C84-c — **선언과 실물이 달랐다.**
 *
 * `docs/contracts/db/erd.dbml` 의 ZASSIGN 은 `ser_id → SER`, `exc_id → EXC`, `zacc_id → ZACC`
 * 셋을 **참조로 선언**해 두었는데, 초기 마이그레이션의 `CREATE TABLE zassign` 에는 기본키
 * 하나뿐이었다. 외래키도, 「ser 냐 exc 냐」를 가르는 CHECK 도, 「한 규칙에 한 줄」을 지키는
 * 유니크도 없었다.
 *
 * 그런데 코드는 셋 다 **있다고 믿고** 쓰고 있었다.
 *   - `zoom.service.ts` 는 `DELETE … WHERE ser_id=$1` 뒤 INSERT 로 「한 줄」을 손으로 지킨다.
 *   - `schedule.project.ts` 는 `zassign` 을 **정본**으로 읽어 `ser_occ.zacc_id` 를 채운다 —
 *     그 칸이 비면 겹침 EXCLUDE 가 줌 계정을 지키지 못한다.
 *   - `schedule.state.repo.ts` 는 필요 없어진 EXC 를 지우는데, 그 EXC 에 붙은 배정 줄은
 *     **아무도 지우지 않는다**(외래키가 없으니 CASCADE 도 없다). 고아가 남는다.
 *
 * 그래서 세 가지를 새긴다.
 *   ① 외래키 셋 — DBML 이 이미 선언한 그대로. SER·EXC 가 사라지면 배정도 따라간다(CASCADE).
 *      ZACC 는 RESTRICT 다 — 쓰이고 있는 계정을 지우면 **조용히 배정이 사라지는** 대신
 *      막고 알린다(계정을 그만 쓰는 길은 `ZACC.active=false` 다).
 *   ② CHECK — `ser_id` 와 `exc_id` 중 **정확히 하나**. 둘 다이거나 둘 다 아닌 줄은 뜻이 없다.
 *   ③ 부분 유니크 둘 — 한 규칙에 한 줄, 한 회차 예외에 한 줄. 코드가 손으로 지켜 온 것이다.
 *
 * **기존 행은 보정하지 않는다** (N-25). 외래키와 CHECK 는 `NOT VALID` 로 걸어 **새 행만**
 * 검사한다. 유니크 인덱스는 `NOT VALID` 가 없으므로, 중복이 있으면 **어느 줄이 이기는지를
 * 사람이 정해야 한다** — 그 판단을 마이그레이션이 대신하지 않고 세어서 멈춘다.
 */
export class ZassignConstraints1760200000000 implements MigrationInterface {
  name = 'ZassignConstraints1760200000000';

  public async up(q: QueryRunner): Promise<void> {
    /* ── 멈출 자리를 먼저 본다 — 고르는 일을 마이그레이션이 대신하지 않는다 ── */
    const dup = (await q.query(`
      SELECT 'ser_id' AS col, ser_id::text AS ref, count(*)::int AS n
        FROM zassign WHERE ser_id IS NOT NULL GROUP BY ser_id HAVING count(*) > 1
      UNION ALL
      SELECT 'exc_id', exc_id::text, count(*)::int
        FROM zassign WHERE exc_id IS NOT NULL GROUP BY exc_id HAVING count(*) > 1
      ORDER BY 1, 2
    `)) as Array<{ col: string; ref: string; n: number }>;
    if (dup.length > 0) {
      const where = dup.map((d) => `${d.col}=${d.ref}(${d.n}줄)`).join(', ');
      throw new Error(
        `ZASSIGN 에 같은 대상을 가리키는 줄이 여럿입니다 — ${where}. `
        + '어느 배정이 맞는지는 사람이 정해야 합니다(마이그레이션이 고르지 않습니다). '
        + '남길 줄만 두고 다시 실행해 주세요.',
      );
    }

    /* ── ① 외래키 — DBML 이 선언한 그대로 ───────────────────────── */
    await q.query(`ALTER TABLE zassign
      ADD CONSTRAINT zassign_ser_fk FOREIGN KEY (ser_id) REFERENCES ser(id) ON DELETE CASCADE NOT VALID`);
    await q.query(`ALTER TABLE zassign
      ADD CONSTRAINT zassign_exc_fk FOREIGN KEY (exc_id) REFERENCES exc(id) ON DELETE CASCADE NOT VALID`);
    await q.query(`ALTER TABLE zassign
      ADD CONSTRAINT zassign_zacc_fk FOREIGN KEY (zacc_id) REFERENCES zacc(id) ON DELETE RESTRICT NOT VALID`);

    /* ── ② 규칙에 붙거나 회차 예외에 붙거나 — 둘 중 하나다 ────────── */
    await q.query(`ALTER TABLE zassign
      ADD CONSTRAINT zassign_target_one CHECK ((ser_id IS NULL) <> (exc_id IS NULL)) NOT VALID`);

    /* ── ③ 한 대상에 한 줄 — 코드가 손으로 지켜 온 것 ─────────────── */
    await q.query(`CREATE UNIQUE INDEX zassign_ser_once ON zassign (ser_id) WHERE ser_id IS NOT NULL`);
    await q.query(`CREATE UNIQUE INDEX zassign_exc_once ON zassign (exc_id) WHERE exc_id IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS zassign_exc_once`);
    await q.query(`DROP INDEX IF EXISTS zassign_ser_once`);
    await q.query(`ALTER TABLE zassign DROP CONSTRAINT IF EXISTS zassign_target_one`);
    await q.query(`ALTER TABLE zassign DROP CONSTRAINT IF EXISTS zassign_zacc_fk`);
    await q.query(`ALTER TABLE zassign DROP CONSTRAINT IF EXISTS zassign_exc_fk`);
    await q.query(`ALTER TABLE zassign DROP CONSTRAINT IF EXISTS zassign_ser_fk`);
  }
}
