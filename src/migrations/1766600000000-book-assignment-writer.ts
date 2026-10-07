/** @file-guide
 * 목적: BOC-04D-03b 교재 배정의 강사·과목·판·버전·멱등 원장을 추가한다. (historical)
 * 책임/재사용: legacy ISSUE는 추정 이관하지 않고, 새 문맥 배정의 직접 DB 쓰기와 활성 중복을 방어한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-04D3B-BOOK-ASSIGNMENT-WRITER-2026-10-08.md · docs/contracts/db/erd.dbml
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BOC-04D-03b 권고안 채택(2026-10-08): ISSUE 한 줄은 학생·교재뿐 아니라 실제 담당 강사와
 * 과목을 소유한다. 과거 행은 teacher/sub를 추정하지 않으며, 새 행만 실제 현재·장래 수업과
 * 정확한 현재 판을 DB trigger로 확인한다. 정책 변경 시 DTO/service/Front/DBML/P-BOC04D03B를 함께 수정한다.
 */
export class BookAssignmentWriter1766600000000 implements MigrationInterface {
  name = 'BookAssignmentWriter1766600000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE issue ADD COLUMN teacher_id bigint REFERENCES staff(id)`);
    await q.query(`ALTER TABLE issue ADD COLUMN sub_key varchar(20) REFERENCES sub(key)`);
    await q.query(`ALTER TABLE issue ADD COLUMN row_version integer NOT NULL DEFAULT 1`);
    await q.query(`ALTER TABLE issue ADD CONSTRAINT issue_assignment_context_pair
      CHECK ((teacher_id IS NULL AND sub_key IS NULL) OR (teacher_id IS NOT NULL AND sub_key IS NOT NULL))`);
    await q.query(`ALTER TABLE issue ADD CONSTRAINT issue_row_version_positive CHECK (row_version >= 1)`);

    await q.query(`DROP INDEX issue_active_book_unique`);
    await q.query(`CREATE UNIQUE INDEX issue_active_legacy_book_unique
      ON issue(student_id,lib_id) WHERE state IN ('wait','auto','ok') AND teacher_id IS NULL AND sub_key IS NULL`);
    await q.query(`CREATE UNIQUE INDEX issue_active_assignment_unique
      ON issue(student_id,lib_id,teacher_id,sub_key)
      WHERE state IN ('wait','auto','ok') AND teacher_id IS NOT NULL AND sub_key IS NOT NULL`);

    await q.query(`
      CREATE TABLE issue_write_req (
        request_key uuid PRIMARY KEY,
        issue_id bigint NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
        fingerprint char(64) NOT NULL,
        result_version integer NOT NULL,
        actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT issue_write_req_fingerprint_hex CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT issue_write_req_version_positive CHECK (result_version >= 1)
      )
    `);
    await q.query(`CREATE INDEX issue_write_req_issue_idx ON issue_write_req(issue_id,created_at DESC,request_key)`);

    await q.query(`
      CREATE FUNCTION issue_assignment_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        student_grade text;
        grade_no integer;
        current_vers bigint;
      BEGIN
        IF NEW.teacher_id IS NULL THEN RETURN NEW; END IF;
        -- 권고안: 판·학년·수업 문맥은 배정 신원을 새로 쓰거나 바꿀 때만 검사한다.
        -- 새 판 발행·학년 변경 뒤에도 이미 배정한 ISSUE의 승인·진도·회수는 당시 vers_id 스냅숏으로 계속 처리한다.
        IF TG_OP = 'UPDATE'
           AND NEW.teacher_id IS NOT DISTINCT FROM OLD.teacher_id
           AND NEW.sub_key IS NOT DISTINCT FROM OLD.sub_key
           AND NEW.student_id IS NOT DISTINCT FROM OLD.student_id
           AND NEW.lib_id IS NOT DISTINCT FROM OLD.lib_id
           AND NEW.vers_id IS NOT DISTINCT FROM OLD.vers_id THEN
          RETURN NEW;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM staff t WHERE t.id=NEW.teacher_id AND t.active) THEN
          RAISE EXCEPTION 'assignment teacher must be active'
            USING ERRCODE='23514', CONSTRAINT='issue_assignment_teacher_active';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM lib l WHERE l.id=NEW.lib_id AND l.sub_key=NEW.sub_key) THEN
          RAISE EXCEPTION 'assignment subject must match book subject'
            USING ERRCODE='23514', CONSTRAINT='issue_assignment_subject_match';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM ser s JOIN kind k ON k.key=s.kind_key AND k.grp='lesson'
            JOIN ser_stu ss ON ss.ser_id=s.id
           WHERE s.teacher_id=NEW.teacher_id AND s.sub_key=NEW.sub_key AND ss.student_id=NEW.student_id
             AND GREATEST(s.from_date,COALESCE(ss.from_date,s.from_date),(now() AT TIME ZONE 'Asia/Seoul')::date)
                 <= LEAST(COALESCE(s.to_date,'infinity'::date),COALESCE(ss.to_date,'infinity'::date))
        ) THEN
          RAISE EXCEPTION 'assignment context must reference a current or future class'
            USING ERRCODE='23514', CONSTRAINT='issue_assignment_class_context';
        END IF;

        SELECT grade INTO student_grade FROM stu WHERE id=NEW.student_id;
        grade_no := CASE
          WHEN student_grade IN ('K','Y1','유치원') THEN 0
          WHEN student_grade ~ '^G([1-9]|1[0-2])$' THEN substring(student_grade from 2)::integer
          WHEN student_grade ~ '^Y([2-9]|1[0-3])$' THEN substring(student_grade from 2)::integer - 1
          WHEN student_grade ~ '^초[1-6]$' THEN substring(student_grade from 2)::integer
          WHEN student_grade ~ '^중[1-3]$' THEN substring(student_grade from 2)::integer + 6
          WHEN student_grade ~ '^고[1-3]$' THEN substring(student_grade from 2)::integer + 9
          ELSE NULL END;
        IF grade_no IS NULL OR NOT EXISTS (
          SELECT 1 FROM lib l WHERE l.id=NEW.lib_id
             AND l.grade_from IS NOT NULL AND l.grade_to IS NOT NULL
             AND grade_no BETWEEN l.grade_from AND l.grade_to
        ) THEN
          RAISE EXCEPTION 'assignment book must match the canonical student grade'
            USING ERRCODE='23514', CONSTRAINT='issue_assignment_grade_match';
        END IF;

        SELECT v.id INTO current_vers FROM vers v
         WHERE v.lib_id=NEW.lib_id AND (v.from_date IS NULL OR v.from_date <= (now() AT TIME ZONE 'Asia/Seoul')::date)
         ORDER BY v.from_date DESC NULLS LAST,v.activated_at DESC,v.id DESC LIMIT 1;
        IF NEW.vers_id IS NULL OR NEW.vers_id IS DISTINCT FROM current_vers THEN
          RAISE EXCEPTION 'assignment version must be the current book version'
            USING ERRCODE='23514', CONSTRAINT='issue_assignment_current_version';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await q.query(`CREATE CONSTRAINT TRIGGER issue_assignment_guard
      AFTER INSERT OR UPDATE ON issue
      DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION issue_assignment_guard_fn()`);

    await q.query(`
      CREATE FUNCTION issue_assignment_version_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.teacher_id IS NOT NULL OR NEW.teacher_id IS NOT NULL THEN
          IF NEW.state IS DISTINCT FROM OLD.state
             OR NEW.issued_on IS DISTINCT FROM OLD.issued_on
             OR NEW.returned_on IS DISTINCT FROM OLD.returned_on
             OR NEW.progress_page IS DISTINCT FROM OLD.progress_page
             OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
             OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
             OR NEW.ended_reason IS DISTINCT FROM OLD.ended_reason
             OR NEW.ended_by IS DISTINCT FROM OLD.ended_by
             OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
             OR NEW.teacher_id IS DISTINCT FROM OLD.teacher_id
             OR NEW.sub_key IS DISTINCT FROM OLD.sub_key
             OR NEW.reason IS DISTINCT FROM OLD.reason
             OR NEW.form IS DISTINCT FROM OLD.form
             OR NEW.vers_id IS DISTINCT FROM OLD.vers_id
             OR NEW.reissued_from IS DISTINCT FROM OLD.reissued_from THEN
            IF NEW.row_version <> OLD.row_version + 1 THEN
              RAISE EXCEPTION 'assignment row version must increase by exactly one'
                USING ERRCODE='23514', CONSTRAINT='issue_assignment_version_step';
            END IF;
          ELSIF NEW.row_version IS DISTINCT FROM OLD.row_version THEN
            RAISE EXCEPTION 'assignment row version cannot change without business fields'
              USING ERRCODE='23514', CONSTRAINT='issue_assignment_version_without_change';
          END IF;
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await q.query(`CREATE TRIGGER issue_assignment_version_guard
      BEFORE UPDATE ON issue FOR EACH ROW EXECUTE FUNCTION issue_assignment_version_guard_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM issue WHERE teacher_id IS NOT NULL OR sub_key IS NOT NULL)
         OR EXISTS (SELECT 1 FROM issue_write_req) THEN
        RAISE EXCEPTION 'BookAssignmentWriter down would discard assignment identity or request history';
      END IF;
    END $$`);
    await q.query(`DROP TRIGGER IF EXISTS issue_assignment_version_guard ON issue`);
    await q.query(`DROP FUNCTION IF EXISTS issue_assignment_version_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS issue_assignment_guard ON issue`);
    await q.query(`DROP FUNCTION IF EXISTS issue_assignment_guard_fn()`);
    await q.query(`DROP TABLE issue_write_req`);
    await q.query(`DROP INDEX issue_active_assignment_unique`);
    await q.query(`DROP INDEX issue_active_legacy_book_unique`);
    await q.query(`CREATE UNIQUE INDEX issue_active_book_unique
      ON issue(student_id,lib_id) WHERE state IN ('wait','auto','ok')`);
    await q.query(`ALTER TABLE issue DROP CONSTRAINT issue_row_version_positive`);
    await q.query(`ALTER TABLE issue DROP CONSTRAINT issue_assignment_context_pair`);
    await q.query(`ALTER TABLE issue DROP COLUMN row_version, DROP COLUMN sub_key, DROP COLUMN teacher_id`);
  }
}
