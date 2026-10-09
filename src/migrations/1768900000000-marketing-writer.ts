/** @file-guide
 * 목적: 마케팅 활동 쓰기의 행 버전과 requestKey 멱등 receipt, 최근 30일 조회 인덱스를 추가한다.
 * 책임/재사용: MKT가 current 상태를 소유하고 receipt는 같은 명령의 재시도만 수렴시킨다. 집계값은 별도 저장하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class MarketingWriter1768900000000 implements MigrationInterface {
  name = 'MarketingWriter1768900000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE mkt ADD COLUMN row_version integer NOT NULL DEFAULT 1`);
    await q.query(`ALTER TABLE mkt ADD CONSTRAINT mkt_row_version_chk CHECK (row_version >= 1)`);
    await q.query(`CREATE INDEX mkt_recent_channel_idx ON mkt(on_date DESC, channel, id DESC)`);
    await q.query(`
      CREATE TABLE mkt_write_req (
        request_key uuid PRIMARY KEY,
        mkt_id bigint NOT NULL REFERENCES mkt(id) ON DELETE CASCADE,
        action varchar(12) NOT NULL,
        command_fingerprint char(64) NOT NULL,
        result_version integer NOT NULL,
        actor_id bigint NOT NULL REFERENCES staff(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT mkt_write_req_action_chk CHECK (action IN ('create','patch')),
        CONSTRAINT mkt_write_req_version_chk CHECK (result_version >= 1)
      )
    `);
    await q.query(`CREATE INDEX mkt_write_req_mkt_idx ON mkt_write_req(mkt_id,created_at DESC)`);
    await q.query(`COMMENT ON TABLE mkt_write_req IS 'BO-12D 권고안: 마케팅 create/patch requestKey 멱등 receipt'`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE mkt_write_req`);
    await q.query(`DROP INDEX mkt_recent_channel_idx`);
    await q.query(`ALTER TABLE mkt DROP CONSTRAINT mkt_row_version_chk`);
    await q.query(`ALTER TABLE mkt DROP COLUMN row_version`);
  }
}
