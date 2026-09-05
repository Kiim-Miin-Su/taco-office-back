import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 회차 출결은 재생성되는 ser_occ가 아니라 독립 현재값에 저장한다.
 * 모든 revision은 기존 append-only log에 기록하고, 이 표는 마지막 확정만 보관한다.
 */
export class AttendanceContract1757400000000 implements MigrationInterface {
  name = 'AttendanceContract1757400000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE att (
      id bigserial NOT NULL,
      ser_id bigint NOT NULL,
      on_date date NOT NULL,
      result varchar(12) NOT NULL,
      reason varchar(24),
      confirmed_by bigint NOT NULL,
      confirmed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT att_ser_fk FOREIGN KEY (ser_id) REFERENCES ser(id),
      CONSTRAINT att_confirmer_fk FOREIGN KEY (confirmed_by) REFERENCES staff(id),
      CONSTRAINT att_result_check CHECK (result IN ('completed', 'canceled')),
      CONSTRAINT att_reason_check CHECK (
        (result = 'completed' AND reason IS NULL)
        OR
        (result = 'canceled' AND reason IN (
          'teacher_absent', 'student_absent', 'academy', 'holiday', 'other'
        ))
      ),
      CONSTRAINT att_ser_date_uniq UNIQUE (ser_id, on_date)
    )`);
    await q.query(`CREATE INDEX att_confirmer_at_idx ON att (confirmed_by, confirmed_at DESC)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS att_confirmer_at_idx`);
    await q.query(`DROP TABLE IF EXISTS att`);
  }
}
