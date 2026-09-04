import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 학생 단위 리포트 발송은 최초 1회와 명시적 재발송을 구분한다.
 * request_key는 네트워크 재시도/더블클릭의 중복 행을 DB에서 최종 차단한다.
 */
export class ReportDeliveryContract1757300000000 implements MigrationInterface {
  name = 'ReportDeliveryContract1757300000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE rsend ADD COLUMN request_key uuid`);
    await q.query(`ALTER TABLE rsend ADD COLUMN source_send_id bigint`);
    await q.query(`UPDATE rsend SET request_key = gen_random_uuid() WHERE request_key IS NULL`);
    await q.query(`ALTER TABLE rsend ALTER COLUMN request_key SET NOT NULL`);
    await q.query(`ALTER TABLE rsend ADD CONSTRAINT rsend_request_key_uniq UNIQUE (request_key)`);
    await q.query(
      `ALTER TABLE rsend ADD CONSTRAINT rsend_source_send_fk
         FOREIGN KEY (source_send_id) REFERENCES rsend(id)`,
    );
    // 구 이력에 같은 학생·날짜가 여러 건이면 가장 오래된 행을 최초 발송으로 보존하고 나머지를 재발송으로 연결한다.
    await q.query(
      `WITH ranked AS (
         SELECT id,
                first_value(id) OVER (PARTITION BY student_id, on_date ORDER BY sent_at, id) AS first_id,
                row_number() OVER (PARTITION BY student_id, on_date ORDER BY sent_at, id) AS seq
           FROM rsend
       )
       UPDATE rsend target
          SET source_send_id = ranked.first_id
         FROM ranked
        WHERE target.id = ranked.id AND ranked.seq > 1`,
    );
    await q.query(
      `ALTER TABLE rsend ADD CONSTRAINT rsend_rep_ids_nonempty
         CHECK (jsonb_typeof(rep_ids) = 'array' AND jsonb_array_length(rep_ids) > 0)`,
    );
    await q.query(
      `CREATE UNIQUE INDEX rsend_student_date_first_uniq
         ON rsend (student_id, on_date) WHERE source_send_id IS NULL`,
    );
    await q.query(`CREATE INDEX rsend_date_sent_at_idx ON rsend (on_date, sent_at DESC)`);
    await q.query(`CREATE INDEX pdflog_kind_ref_at_idx ON pdflog (kind, ref_id, at DESC)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS pdflog_kind_ref_at_idx`);
    await q.query(`DROP INDEX IF EXISTS rsend_date_sent_at_idx`);
    await q.query(`DROP INDEX IF EXISTS rsend_student_date_first_uniq`);
    await q.query(`ALTER TABLE rsend DROP CONSTRAINT IF EXISTS rsend_rep_ids_nonempty`);
    await q.query(`ALTER TABLE rsend DROP CONSTRAINT IF EXISTS rsend_source_send_fk`);
    await q.query(`ALTER TABLE rsend DROP CONSTRAINT IF EXISTS rsend_request_key_uniq`);
    await q.query(`ALTER TABLE rsend DROP COLUMN IF EXISTS source_send_id`);
    await q.query(`ALTER TABLE rsend DROP COLUMN IF EXISTS request_key`);
  }
}
