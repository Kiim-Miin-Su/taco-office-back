import { MigrationInterface, QueryRunner } from 'typeorm';

/** CHREQ의 열 대상과 종류별 JSONB 모양을 API 계약과 같은 수준으로 고정한다. */
export class ChreqPayloadContract1757100000000 implements MigrationInterface {
  name = 'ChreqPayloadContract1757100000000';

  public async up(q: QueryRunner): Promise<void> {
    // 운영에 예전 임의 payload가 있으면 자동 보정하지 않는다. 어떤 요청이었는지 사람이 확인해야 한다.
    await q.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM chreq
           WHERE ser_id IS NULL OR on_date IS NULL OR btrim(reason) = '' OR char_length(reason) > 500
              OR NOT (
                jsonb_typeof(payload) = 'object'
                AND (
                  (req_type = 'time_move'
                    AND payload ?& ARRAY['startMin', 'endMin']
                    AND payload - ARRAY['startMin', 'endMin']::text[] = '{}'::jsonb
                    AND jsonb_typeof(payload->'startMin') = 'number'
                    AND jsonb_typeof(payload->'endMin') = 'number'
                    AND payload->>'startMin' ~ '^[0-9]+$'
                    AND payload->>'endMin' ~ '^[0-9]+$'
                    AND (payload->>'startMin')::int >= 0
                    AND (payload->>'endMin')::int <= 1440
                    AND (payload->>'endMin')::int - (payload->>'startMin')::int BETWEEN 10 AND 480)
                  OR (req_type = 'teacher'
                    AND payload ? 'teacherId'
                    AND payload - 'teacherId' = '{}'::jsonb
                    AND jsonb_typeof(payload->'teacherId') = 'number'
                    AND payload->>'teacherId' ~ '^[1-9][0-9]*$')
                  OR (req_type = 'room'
                    AND (
                      (payload ? 'roomId'
                        AND payload - 'roomId' = '{}'::jsonb
                        AND jsonb_typeof(payload->'roomId') = 'number'
                        AND payload->>'roomId' ~ '^[1-9][0-9]*$')
                      OR (payload ? 'zaccId'
                        AND payload - 'zaccId' = '{}'::jsonb
                        AND jsonb_typeof(payload->'zaccId') = 'number'
                        AND payload->>'zaccId' ~ '^[1-9][0-9]*$')
                    ))
                  OR (req_type = 'cancel' AND payload = '{}'::jsonb)
                )
              )
        ) THEN
          RAISE EXCEPTION 'CHREQ 입력 계약에 맞지 않는 기존 레코드가 있습니다';
        END IF;
      END $$
    `);
    await q.query('ALTER TABLE chreq ALTER COLUMN ser_id SET NOT NULL');
    await q.query('ALTER TABLE chreq ALTER COLUMN on_date SET NOT NULL');
    await q.query(`
      ALTER TABLE chreq ADD CONSTRAINT chreq_payload_contract CHECK (
        btrim(reason) <> '' AND char_length(reason) <= 500
        AND jsonb_typeof(payload) = 'object'
        AND (
          (req_type = 'time_move'
            AND payload ?& ARRAY['startMin', 'endMin']
            AND payload - ARRAY['startMin', 'endMin']::text[] = '{}'::jsonb
            AND jsonb_typeof(payload->'startMin') = 'number'
            AND jsonb_typeof(payload->'endMin') = 'number'
            AND payload->>'startMin' ~ '^[0-9]+$'
            AND payload->>'endMin' ~ '^[0-9]+$'
            AND (payload->>'startMin')::int >= 0
            AND (payload->>'endMin')::int <= 1440
            AND (payload->>'endMin')::int - (payload->>'startMin')::int BETWEEN 10 AND 480)
          OR (req_type = 'teacher'
            AND payload ? 'teacherId'
            AND payload - 'teacherId' = '{}'::jsonb
            AND jsonb_typeof(payload->'teacherId') = 'number'
            AND payload->>'teacherId' ~ '^[1-9][0-9]*$')
          OR (req_type = 'room'
            AND (
              (payload ? 'roomId'
                AND payload - 'roomId' = '{}'::jsonb
                AND jsonb_typeof(payload->'roomId') = 'number'
                AND payload->>'roomId' ~ '^[1-9][0-9]*$')
              OR (payload ? 'zaccId'
                AND payload - 'zaccId' = '{}'::jsonb
                AND jsonb_typeof(payload->'zaccId') = 'number'
                AND payload->>'zaccId' ~ '^[1-9][0-9]*$')
            ))
          OR (req_type = 'cancel' AND payload = '{}'::jsonb)
        )
      )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE chreq DROP CONSTRAINT chreq_payload_contract');
    await q.query('ALTER TABLE chreq ALTER COLUMN on_date DROP NOT NULL');
    await q.query('ALTER TABLE chreq ALTER COLUMN ser_id DROP NOT NULL');
  }
}
