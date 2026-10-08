/** @file-guide
 * 목적: BO-06D-03 수업 팝업 건의의 exact 회차 identity와 제출 당시 표시 스냅숏을 보존한다.
 * 책임/재사용: 기존 일반 건의는 NULL로 유지한다. 새 writer만 구조화 링크를 만들고 DB는 all-or-none·멱등 키를 방어한다.
 * 검증/작업 지침: docs/contracts/db/erd.dbml · docs/contracts/CONTRACTS.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class SuggestionLessonLink1767600000000 implements MigrationInterface {
  name = 'SuggestionLessonLink1767600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE suggestion ADD COLUMN ser_id bigint`);
    await q.query(`ALTER TABLE suggestion ADD COLUMN on_date date`);
    await q.query(`ALTER TABLE suggestion ADD COLUMN source_date date`);
    await q.query(`ALTER TABLE suggestion ADD COLUMN read_version bigint`);
    await q.query(`ALTER TABLE suggestion ADD COLUMN lesson_snapshot jsonb`);
    await q.query(`ALTER TABLE suggestion ADD COLUMN request_key uuid`);
    await q.query(`ALTER TABLE suggestion ADD CONSTRAINT suggestion_read_version_nonnegative
      CHECK (read_version IS NULL OR read_version >= 0)`);
    await q.query(`ALTER TABLE suggestion ADD CONSTRAINT suggestion_lesson_link_contract CHECK (
      (ser_id IS NULL AND on_date IS NULL AND source_date IS NULL AND read_version IS NULL AND lesson_snapshot IS NULL)
      OR
      (ser_id IS NOT NULL AND on_date IS NOT NULL AND source_date IS NOT NULL AND read_version IS NOT NULL
       AND lesson_snapshot IS NOT NULL AND request_key IS NOT NULL
       AND jsonb_typeof(lesson_snapshot) = 'object'
       AND lesson_snapshot ?& ARRAY['serId','onDate','date','startMin','endMin','subject','students']
       AND jsonb_typeof(lesson_snapshot->'serId') = 'number'
       AND jsonb_typeof(lesson_snapshot->'onDate') = 'string'
       AND jsonb_typeof(lesson_snapshot->'date') = 'string'
       AND jsonb_typeof(lesson_snapshot->'startMin') = 'number'
       AND jsonb_typeof(lesson_snapshot->'endMin') = 'number'
       AND jsonb_typeof(lesson_snapshot->'subject') = 'string'
       AND jsonb_typeof(lesson_snapshot->'students') = 'array'
       AND (lesson_snapshot->>'serId')::bigint = ser_id
       AND lesson_snapshot->>'onDate' = to_char(on_date,'YYYY-MM-DD')
       AND lesson_snapshot->>'date' = to_char(source_date,'YYYY-MM-DD')
       AND lesson_snapshot->>'startMin' ~ '^[0-9]+$'
       AND lesson_snapshot->>'endMin' ~ '^[0-9]+$'
       AND (lesson_snapshot->>'startMin')::int >= 0
       AND (lesson_snapshot->>'endMin')::int <= 1440
       AND (lesson_snapshot->>'endMin')::int > (lesson_snapshot->>'startMin')::int)
    )`);
    await q.query(`CREATE UNIQUE INDEX suggestion_staff_request_key_once
      ON suggestion(staff_id,request_key) WHERE request_key IS NOT NULL`);
    await q.query(`CREATE INDEX suggestion_lesson_lookup
      ON suggestion(ser_id,on_date) WHERE ser_id IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM suggestion WHERE ser_id IS NOT NULL OR request_key IS NOT NULL) THEN
        RAISE EXCEPTION 'SuggestionLessonLink down would discard linked lesson suggestions';
      END IF;
    END $$`);
    await q.query(`DROP INDEX suggestion_lesson_lookup`);
    await q.query(`DROP INDEX suggestion_staff_request_key_once`);
    await q.query(`ALTER TABLE suggestion DROP CONSTRAINT suggestion_lesson_link_contract`);
    await q.query(`ALTER TABLE suggestion DROP CONSTRAINT suggestion_read_version_nonnegative`);
    await q.query(`ALTER TABLE suggestion DROP COLUMN request_key`);
    await q.query(`ALTER TABLE suggestion DROP COLUMN lesson_snapshot`);
    await q.query(`ALTER TABLE suggestion DROP COLUMN read_version`);
    await q.query(`ALTER TABLE suggestion DROP COLUMN source_date`);
    await q.query(`ALTER TABLE suggestion DROP COLUMN on_date`);
    await q.query(`ALTER TABLE suggestion DROP COLUMN ser_id`);
  }
}
