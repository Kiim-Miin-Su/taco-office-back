/** @file-guide
 * 목적: BOC-07 구조화 리포트 양식 snapshot과 optimistic version·실제 작성 actor를 REP에 추가한다.
 * 책임/재사용: 기존 format 0 본문을 그대로 보존하고 format 1의 기본 JSON 모양만 DB에서 방어한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-07-REPORT-DIAGNOSTIC-FRONT-2026-10-07.md · docs/contracts/db/erd.dbml
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ReportStructuredBody1767700000000 implements MigrationInterface {
  name = 'ReportStructuredBody1767700000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE rep ADD COLUMN format_version smallint NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE rep ADD COLUMN row_version bigint NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE rep ADD COLUMN last_writer_id bigint REFERENCES staff(id) ON DELETE RESTRICT`);
    await q.query(`ALTER TABLE rep ADD CONSTRAINT rep_format_version_known CHECK (format_version IN (0,1))`);
    await q.query(`ALTER TABLE rep ADD CONSTRAINT rep_row_version_nonnegative CHECK (row_version >= 0)`);
    await q.query(`ALTER TABLE rep DROP CONSTRAINT rep_body_contract`);
    await q.query(`ALTER TABLE rep ADD CONSTRAINT rep_body_contract CHECK (
      jsonb_typeof(body)='object' AND (
        (format_version=0 AND (
          body='{}'::jsonb OR (
            body ?& ARRAY['content','progress','homework']
            AND body-ARRAY['content','progress','homework']::text[]='{}'::jsonb
            AND jsonb_typeof(body->'content')='string'
            AND jsonb_typeof(body->'progress')='string'
            AND jsonb_typeof(body->'homework')='string'
          )
        )) OR
        (format_version=1 AND body->>'kind' IN ('individual','group','kinder','mock','diagnostic') AND (
          (body->>'kind'='individual'
            AND body ?& ARRAY['kind','content','progress','homework']
            AND body-ARRAY['kind','content','progress','homework']::text[]='{}'::jsonb
            AND jsonb_typeof(body->'content')='string'
            AND jsonb_typeof(body->'progress') IN ('object','null')
            AND jsonb_typeof(body->'homework') IN ('object','null'))
          OR
          (body->>'kind'='group'
            AND body ?& ARRAY['kind','content','progress','homework','students']
            AND body-ARRAY['kind','content','progress','homework','students']::text[]='{}'::jsonb
            AND jsonb_typeof(body->'content')='string'
            AND jsonb_typeof(body->'progress') IN ('object','null')
            AND jsonb_typeof(body->'homework') IN ('object','null')
            AND jsonb_typeof(body->'students')='array')
          OR
          (body->>'kind' IN ('kinder','mock')
            AND body ?& ARRAY['kind','development','overall']
            AND body-ARRAY['kind','development','overall']::text[]='{}'::jsonb
            AND jsonb_typeof(body->'development')='object'
            AND body->'development' ?& ARRAY['language','math','emotional','physical']
            AND jsonb_typeof(body->'overall')='string')
          OR
          (body->>'kind'='diagnostic'
            AND body ?& ARRAY['kind','students']
            AND body-ARRAY['kind','students']::text[]='{}'::jsonb
            AND jsonb_typeof(body->'students')='array')
        ))
      )
    )`);
    await q.query(`CREATE INDEX rep_format_version_idx ON rep(format_version) WHERE format_version=1`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM rep WHERE format_version<>0 OR row_version<>0 OR last_writer_id IS NOT NULL) THEN
        RAISE EXCEPTION 'ReportStructuredBody down would discard structured/version/actor history';
      END IF;
    END $$`);
    await q.query(`DROP INDEX rep_format_version_idx`);
    await q.query(`ALTER TABLE rep DROP CONSTRAINT rep_body_contract`);
    await q.query(`ALTER TABLE rep DROP CONSTRAINT rep_row_version_nonnegative`);
    await q.query(`ALTER TABLE rep DROP CONSTRAINT rep_format_version_known`);
    await q.query(`ALTER TABLE rep DROP COLUMN last_writer_id`);
    await q.query(`ALTER TABLE rep DROP COLUMN row_version`);
    await q.query(`ALTER TABLE rep DROP COLUMN format_version`);
    await q.query(`ALTER TABLE rep ADD CONSTRAINT rep_body_contract CHECK (
      jsonb_typeof(body)='object' AND (
        body='{}'::jsonb OR (
          body ?& ARRAY['content','progress','homework']
          AND body-ARRAY['content','progress','homework']::text[]='{}'::jsonb
          AND jsonb_typeof(body->'content')='string'
          AND jsonb_typeof(body->'progress')='string'
          AND jsonb_typeof(body->'homework')='string'
        )
      )
    )`);
  }
}
