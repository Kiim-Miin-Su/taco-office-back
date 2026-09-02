import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * REP.body 입력 키를 DTO와 같은 3개로 고정한다 (D-R15 · D-R40).
 *
 * `{}`는 아직 작성을 시작하지 않은 `none · plan`에만 남아 있어야 하므로 호환을 위해 허용한다.
 * 한 번이라도 저장된 body는 content · progress · homework 세 문자열만 가진다.
 * 기존 오염을 자동 삭제하지 않고 마이그레이션을 멈춰 먼저 확인하게 한다.
 */
export class ReportBodyContract1756900000000 implements MigrationInterface {
  name = 'ReportBodyContract1756900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM rep
           WHERE body <> '{}'::jsonb
             AND NOT (
               jsonb_typeof(body) = 'object'
               AND body ?& ARRAY['content', 'progress', 'homework']
               AND body - ARRAY['content', 'progress', 'homework']::text[] = '{}'::jsonb
               AND jsonb_typeof(body->'content') = 'string'
               AND jsonb_typeof(body->'progress') = 'string'
               AND jsonb_typeof(body->'homework') = 'string'
             )
        ) THEN
          RAISE EXCEPTION 'REP.body 입력 계약에 맞지 않는 기존 레코드가 있습니다';
        END IF;
      END $$
    `);
    await q.query(`
      ALTER TABLE rep
      ADD CONSTRAINT rep_body_contract CHECK (
        jsonb_typeof(body) = 'object'
        AND (
          body = '{}'::jsonb
          OR (
            body ?& ARRAY['content', 'progress', 'homework']
            AND body - ARRAY['content', 'progress', 'homework']::text[] = '{}'::jsonb
            AND jsonb_typeof(body->'content') = 'string'
            AND jsonb_typeof(body->'progress') = 'string'
            AND jsonb_typeof(body->'homework') = 'string'
          )
        )
      )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE rep DROP CONSTRAINT rep_body_contract');
  }
}
