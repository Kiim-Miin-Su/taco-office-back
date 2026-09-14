/** @file-guide
 * 목적: §29 생성·§30 계약 5단계의 날짜/요청자/보관/파일/피드백/감사 원장을 DB에 고정한다.
 * 책임/재사용: 기존 행을 추측해 보정하지 않고 nullable로 보존하며 새 쓰기는 FK/CHECK/트리거로 방어한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConsultingWorkflow1759900000000 implements MigrationInterface {
  name = 'ConsultingWorkflow1759900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE cons ADD COLUMN start_on date`);
    await q.query(`ALTER TABLE cons ADD COLUMN requester varchar(8)`);
    await q.query(`ALTER TABLE cons ADD COLUMN deleted_at timestamptz`);
    await q.query(`ALTER TABLE cons ADD COLUMN deleted_by bigint`);
    await q.query(`ALTER TABLE cons ADD CONSTRAINT cons_requester_check CHECK (requester IS NULL OR requester IN ('mother','father'))`);
    await q.query(`ALTER TABLE cons ADD CONSTRAINT cons_dates_check CHECK (start_on IS NULL OR end_on IS NULL OR start_on <= end_on)`);
    await q.query(`ALTER TABLE cons ADD CONSTRAINT cons_deleted_pair_check CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))`);
    await q.query(`ALTER TABLE cons ADD CONSTRAINT cons_owner_fk FOREIGN KEY (owner_id) REFERENCES staff(id) NOT VALID`);
    await q.query(`ALTER TABLE cons ADD CONSTRAINT cons_deleted_by_fk FOREIGN KEY (deleted_by) REFERENCES staff(id)`);

    await q.query(`ALTER TABLE cons_stu ADD CONSTRAINT cons_stu_cons_fk FOREIGN KEY (cons_id) REFERENCES cons(id) NOT VALID`);
    await q.query(`ALTER TABLE cons_stu ADD CONSTRAINT cons_stu_student_fk FOREIGN KEY (student_id) REFERENCES stu(id) NOT VALID`);
    await q.query(`ALTER TABLE cons_pick ADD CONSTRAINT cons_pick_cons_fk FOREIGN KEY (cons_id) REFERENCES cons(id) NOT VALID`);
    await q.query(`ALTER TABLE cons_pick ADD CONSTRAINT cons_pick_staff_fk FOREIGN KEY (staff_id) REFERENCES staff(id) NOT VALID`);
    await q.query(`ALTER TABLE cons_sess ADD CONSTRAINT cons_sess_cons_fk FOREIGN KEY (cons_id) REFERENCES cons(id) NOT VALID`);
    await q.query(`ALTER TABLE cons_sess ADD CONSTRAINT cons_sess_ser_fk FOREIGN KEY (ser_id) REFERENCES ser(id) NOT VALID`);
    await q.query(`ALTER TABLE cons VALIDATE CONSTRAINT cons_owner_fk`);
    await q.query(`ALTER TABLE cons_stu VALIDATE CONSTRAINT cons_stu_cons_fk`);
    await q.query(`ALTER TABLE cons_stu VALIDATE CONSTRAINT cons_stu_student_fk`);
    await q.query(`ALTER TABLE cons_pick VALIDATE CONSTRAINT cons_pick_cons_fk`);
    await q.query(`ALTER TABLE cons_pick VALIDATE CONSTRAINT cons_pick_staff_fk`);
    await q.query(`ALTER TABLE cons_sess VALIDATE CONSTRAINT cons_sess_cons_fk`);
    await q.query(`ALTER TABLE cons_sess VALIDATE CONSTRAINT cons_sess_ser_fk`);
    await q.query(`CREATE INDEX cons_owner_created_idx ON cons (owner_id,created_at DESC) WHERE deleted_at IS NULL`);

    await q.query(`CREATE TABLE cons_file (
      file_id bigint PRIMARY KEY,
      cons_id bigint NOT NULL,
      role varchar(12) NOT NULL,
      created_by bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT cons_file_file_fk FOREIGN KEY (file_id) REFERENCES file(id),
      CONSTRAINT cons_file_cons_fk FOREIGN KEY (cons_id) REFERENCES cons(id),
      CONSTRAINT cons_file_created_by_fk FOREIGN KEY (created_by) REFERENCES staff(id),
      CONSTRAINT cons_file_role_check CHECK (role IN ('draft','revision','signed'))
    )`);
    await q.query(`CREATE INDEX cons_file_cons_created_idx ON cons_file (cons_id,created_at,file_id)`);
    await q.query(`CREATE FUNCTION cons_file_limit_guard() RETURNS trigger AS $$
      BEGIN
        PERFORM 1 FROM cons WHERE id=NEW.cons_id FOR UPDATE;
        IF (SELECT count(*) FROM cons_file WHERE cons_id=NEW.cons_id) >= 10 THEN
          RAISE EXCEPTION 'contract files are limited to 10'
            USING ERRCODE='23514', CONSTRAINT='cons_file_limit';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await q.query(`CREATE TRIGGER cons_file_limit_guard_trigger BEFORE INSERT ON cons_file
      FOR EACH ROW EXECUTE FUNCTION cons_file_limit_guard()`);

    await q.query(`CREATE TABLE cons_feedback (
      id bigserial PRIMARY KEY,
      cons_id bigint NOT NULL,
      body varchar(2000) NOT NULL,
      created_by bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      resolved_by bigint,
      CONSTRAINT cons_feedback_cons_fk FOREIGN KEY (cons_id) REFERENCES cons(id),
      CONSTRAINT cons_feedback_created_by_fk FOREIGN KEY (created_by) REFERENCES staff(id),
      CONSTRAINT cons_feedback_resolved_by_fk FOREIGN KEY (resolved_by) REFERENCES staff(id),
      CONSTRAINT cons_feedback_body_check CHECK (length(btrim(body)) > 0),
      CONSTRAINT cons_feedback_resolved_pair_check CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
    )`);
    await q.query(`CREATE INDEX cons_feedback_cons_created_idx ON cons_feedback (cons_id,created_at,id)`);

    await q.query(`CREATE TABLE cons_event (
      id bigserial PRIMARY KEY,
      cons_id bigint NOT NULL,
      event_type varchar(24) NOT NULL,
      ref_id bigint,
      by_id bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT cons_event_cons_fk FOREIGN KEY (cons_id) REFERENCES cons(id),
      CONSTRAINT cons_event_by_fk FOREIGN KEY (by_id) REFERENCES staff(id),
      CONSTRAINT cons_event_type_check CHECK (event_type IN ('created','share_changed','file_added','file_removed','feedback_added','feedback_resolved','parent_delivered','payment_added','archived'))
    )`);
    await q.query(`CREATE INDEX cons_event_cons_created_idx ON cons_event (cons_id,created_at,id)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS cons_event`);
    await q.query(`DROP TABLE IF EXISTS cons_feedback`);
    await q.query(`DROP TRIGGER IF EXISTS cons_file_limit_guard_trigger ON cons_file`);
    await q.query(`DROP FUNCTION IF EXISTS cons_file_limit_guard()`);
    await q.query(`DROP TABLE IF EXISTS cons_file`);
    await q.query(`DROP INDEX IF EXISTS cons_owner_created_idx`);
    await q.query(`ALTER TABLE cons_pick DROP CONSTRAINT IF EXISTS cons_pick_staff_fk`);
    await q.query(`ALTER TABLE cons_pick DROP CONSTRAINT IF EXISTS cons_pick_cons_fk`);
    await q.query(`ALTER TABLE cons_sess DROP CONSTRAINT IF EXISTS cons_sess_ser_fk`);
    await q.query(`ALTER TABLE cons_sess DROP CONSTRAINT IF EXISTS cons_sess_cons_fk`);
    await q.query(`ALTER TABLE cons_stu DROP CONSTRAINT IF EXISTS cons_stu_student_fk`);
    await q.query(`ALTER TABLE cons_stu DROP CONSTRAINT IF EXISTS cons_stu_cons_fk`);
    await q.query(`ALTER TABLE cons DROP CONSTRAINT IF EXISTS cons_deleted_by_fk`);
    await q.query(`ALTER TABLE cons DROP CONSTRAINT IF EXISTS cons_owner_fk`);
    await q.query(`ALTER TABLE cons DROP CONSTRAINT IF EXISTS cons_deleted_pair_check`);
    await q.query(`ALTER TABLE cons DROP CONSTRAINT IF EXISTS cons_dates_check`);
    await q.query(`ALTER TABLE cons DROP CONSTRAINT IF EXISTS cons_requester_check`);
    await q.query(`ALTER TABLE cons DROP COLUMN IF EXISTS deleted_by`);
    await q.query(`ALTER TABLE cons DROP COLUMN IF EXISTS deleted_at`);
    await q.query(`ALTER TABLE cons DROP COLUMN IF EXISTS requester`);
    await q.query(`ALTER TABLE cons DROP COLUMN IF EXISTS start_on`);
  }
}
