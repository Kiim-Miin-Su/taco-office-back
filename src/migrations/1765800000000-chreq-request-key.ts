/** @file-guide
 * 목적: CHREQ 생성 요청의 재시도 키를 보존하여 응답 유실·더블클릭의 중복 행을 막는다.
 * 책임/재사용: 기존 행은 NULL로 두고, 새 키만 부분 유니크로 보호한다. 키가 채워졌으면 down을 거절한다.
 * 검증/작업 지침: docs/contracts/db/erd.dbml · docs/contracts/CONTRACTS.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class ChreqRequestKey1765800000000 implements MigrationInterface {
  name = 'ChreqRequestKey1765800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE chreq ADD COLUMN request_key uuid`);
    await q.query(`CREATE UNIQUE INDEX chreq_request_key_once ON chreq (request_key) WHERE request_key IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM chreq WHERE request_key IS NOT NULL) THEN
        RAISE EXCEPTION 'ChreqRequestKey down would discard stored request keys';
      END IF;
    END $$`);
    await q.query(`DROP INDEX IF EXISTS chreq_request_key_once`);
    await q.query(`ALTER TABLE chreq DROP COLUMN request_key`);
  }
}
