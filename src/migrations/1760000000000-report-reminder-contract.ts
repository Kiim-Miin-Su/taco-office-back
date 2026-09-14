/** @file-guide
 * 목적: §47 리포트 독촉의 requestKey 멱등성을 NOTI 원장에 고정한다.
 * 책임/재사용: 기존 null 알림을 보존하고 같은 요청·수신자 중복만 DB에서 막는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReportReminderContract1760000000000 implements MigrationInterface {
  name = 'ReportReminderContract1760000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE noti ADD COLUMN request_key uuid`);
    await q.query(`ALTER TABLE noti ADD COLUMN request_teacher_id bigint`);
    await q.query(`CREATE UNIQUE INDEX noti_request_key_to_uniq
      ON noti (request_key, to_id) WHERE request_key IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS noti_request_key_to_uniq`);
    await q.query(`ALTER TABLE noti DROP COLUMN IF EXISTS request_teacher_id`);
    await q.query(`ALTER TABLE noti DROP COLUMN IF EXISTS request_key`);
  }
}
