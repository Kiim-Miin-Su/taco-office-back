/** @file-guide
 * 목적: BO-06D-02 변경 요청의 원본 실제 날짜와 읽은 일정 version을 보존한다.
 * 책임/재사용: legacy CHREQ는 NULL로 유지하고 신규 강사 요청만 API에서 필수화한다. 승인 경합 판정은 서비스가 같은 SER 잠금 안에서 수행한다.
 * 검증/작업 지침: docs/contracts/db/erd.dbml · docs/contracts/CONTRACTS.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class ChreqSourceVersion1767500000000 implements MigrationInterface {
  name = 'ChreqSourceVersion1767500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE chreq ADD COLUMN source_date date`);
    await q.query(`ALTER TABLE chreq ADD COLUMN read_version bigint`);
    await q.query(`ALTER TABLE chreq ADD CONSTRAINT chreq_read_version_nonnegative CHECK (read_version IS NULL OR read_version >= 0)`);
    await q.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM chreq WHERE state='pending' AND req_type='time_move'
        GROUP BY ser_id,on_date,by_id HAVING count(*)>1
      ) THEN
        RAISE EXCEPTION 'duplicate pending time_move CHREQ rows require review before migration';
      END IF;
    END $$`);
    await q.query(`CREATE UNIQUE INDEX chreq_pending_time_move_once
      ON chreq(ser_id,on_date,by_id) WHERE state='pending' AND req_type='time_move'`);
    await q.query(`ALTER TABLE chreq DROP CONSTRAINT chreq_payload_contract`);
    await q.query(`ALTER TABLE chreq ADD CONSTRAINT chreq_payload_contract CHECK (
      btrim(reason) <> '' AND char_length(reason) <= 500
      AND jsonb_typeof(payload) = 'object'
      AND (
        (req_type = 'time_move'
          AND payload ?& ARRAY['startMin', 'endMin']
          AND payload - ARRAY['startMin', 'endMin', 'requestedDate']::text[] = '{}'::jsonb
          AND jsonb_typeof(payload->'startMin') = 'number'
          AND jsonb_typeof(payload->'endMin') = 'number'
          AND payload->>'startMin' ~ '^[0-9]+$'
          AND payload->>'endMin' ~ '^[0-9]+$'
          AND (payload->>'startMin')::int >= 0
          AND (payload->>'endMin')::int <= 1440
          AND (payload->>'endMin')::int - (payload->>'startMin')::int BETWEEN 10 AND 480
          AND (NOT (payload ? 'requestedDate') OR (
            jsonb_typeof(payload->'requestedDate') = 'string'
            AND payload->>'requestedDate' ~ '^\\d{4}-\\d{2}-\\d{2}$'
          )))
        OR (req_type = 'teacher'
          AND payload ? 'teacherId' AND payload - 'teacherId' = '{}'::jsonb
          AND jsonb_typeof(payload->'teacherId') = 'number' AND payload->>'teacherId' ~ '^[1-9][0-9]*$')
        OR (req_type = 'room' AND (
          (payload ? 'roomId' AND payload - 'roomId' = '{}'::jsonb
            AND jsonb_typeof(payload->'roomId') = 'number' AND payload->>'roomId' ~ '^[1-9][0-9]*$')
          OR (payload ? 'zaccId' AND payload - 'zaccId' = '{}'::jsonb
            AND jsonb_typeof(payload->'zaccId') = 'number' AND payload->>'zaccId' ~ '^[1-9][0-9]*$')
        ))
        OR (req_type = 'cancel' AND payload = '{}'::jsonb)
      )
    )`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM chreq
                  WHERE source_date IS NOT NULL OR read_version IS NOT NULL OR payload ? 'requestedDate') THEN
        RAISE EXCEPTION 'ChreqSourceVersion down would discard stored source identity';
      END IF;
    END $$`);
    await q.query(`ALTER TABLE chreq DROP CONSTRAINT chreq_read_version_nonnegative`);
    await q.query(`DROP INDEX chreq_pending_time_move_once`);
    await q.query(`ALTER TABLE chreq DROP CONSTRAINT chreq_payload_contract`);
    await q.query(`ALTER TABLE chreq ADD CONSTRAINT chreq_payload_contract CHECK (
      btrim(reason) <> '' AND char_length(reason) <= 500
      AND jsonb_typeof(payload) = 'object'
      AND (
        (req_type = 'time_move'
          AND payload ?& ARRAY['startMin', 'endMin']
          AND payload - ARRAY['startMin', 'endMin']::text[] = '{}'::jsonb
          AND jsonb_typeof(payload->'startMin') = 'number'
          AND jsonb_typeof(payload->'endMin') = 'number'
          AND payload->>'startMin' ~ '^[0-9]+$' AND payload->>'endMin' ~ '^[0-9]+$'
          AND (payload->>'startMin')::int >= 0 AND (payload->>'endMin')::int <= 1440
          AND (payload->>'endMin')::int - (payload->>'startMin')::int BETWEEN 10 AND 480)
        OR (req_type = 'teacher' AND payload ? 'teacherId' AND payload - 'teacherId' = '{}'::jsonb
          AND jsonb_typeof(payload->'teacherId') = 'number' AND payload->>'teacherId' ~ '^[1-9][0-9]*$')
        OR (req_type = 'room' AND (
          (payload ? 'roomId' AND payload - 'roomId' = '{}'::jsonb
            AND jsonb_typeof(payload->'roomId') = 'number' AND payload->>'roomId' ~ '^[1-9][0-9]*$')
          OR (payload ? 'zaccId' AND payload - 'zaccId' = '{}'::jsonb
            AND jsonb_typeof(payload->'zaccId') = 'number' AND payload->>'zaccId' ~ '^[1-9][0-9]*$')
        ))
        OR (req_type = 'cancel' AND payload = '{}'::jsonb)
      )
    )`);
    await q.query(`ALTER TABLE chreq DROP COLUMN read_version`);
    await q.query(`ALTER TABLE chreq DROP COLUMN source_date`);
  }
}
