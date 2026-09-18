import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EXC 에 **보강 회차 링크**를 새긴다 — C92-b (테스트 시나리오 C-34 「회차가 두 번 세어지면 실패」).
 *
 * 보강 이관은 원래 회차를 접고(treat=makeup) **새 ONCE 규칙 하나**를 만드는 일이다. 회계는 원래 회차를
 * 세지 않고 보강 회차를 센다 — 그러려면 둘이 서로를 알아야 한다. 원래 회차 예외가 보강 SER 를 가리킨다.
 * FK 는 ON DELETE SET NULL — 보강을 지우면 링크만 풀리고 휴강 사실은 남는다.
 * `exc_makeup_link` CHECK: 링크는 처리가 makeup 일 때만. NOT VALID · 기존 행 보정 0 (N-25).
 */
export class MakeupLink1760600000000 implements MigrationInterface {
  name = 'MakeupLink1760600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE exc ADD COLUMN IF NOT EXISTS makeup_ser_id bigint`);
    await q.query(
      `ALTER TABLE exc ADD CONSTRAINT exc_makeup_ser_fk FOREIGN KEY (makeup_ser_id) REFERENCES ser(id) ON DELETE SET NULL NOT VALID`,
    );
    await q.query(`ALTER TABLE exc ADD CONSTRAINT exc_makeup_link CHECK (makeup_ser_id IS NULL OR cancel_treat = 'makeup') NOT VALID`);
    await q.query(`CREATE INDEX IF NOT EXISTS exc_makeup_ser_idx ON exc (makeup_ser_id) WHERE makeup_ser_id IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS exc_makeup_ser_idx`);
    await q.query(`ALTER TABLE exc DROP CONSTRAINT IF EXISTS exc_makeup_link`);
    await q.query(`ALTER TABLE exc DROP CONSTRAINT IF EXISTS exc_makeup_ser_fk`);
    await q.query(`ALTER TABLE exc DROP COLUMN IF EXISTS makeup_ser_id`);
  }
}
