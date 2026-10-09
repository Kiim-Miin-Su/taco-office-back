/** @file-guide
 * 목적: T11 리포트 작성 중 교재·보충자료·개인자료를 즉시 등록하는 영속 계약을 추가한다.
 * 책임/재사용: LIB 카탈로그, 정확한 REP 문맥 ISSUE, 멱등 요청과 직접 DB 쓰기 방어를 한 migration으로 묶는다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/T11-REPORT-MATERIAL-WRITER-2026-10-10.md · docs/contracts/db/erd.dbml
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 권고안 채택(2026-10-10): 일반 교재는 관리자 카탈로그에 그대로 합류하고, 보충·개인 자료도
 * 같은 LIB 정본을 쓰되 생성 actor와 자료 종류를 보존한다. 판·학년을 임의로 만들지 않고
 * source_rep_id가 가리키는 실제 리포트 회차로 강사·과목·학생 문맥을 DB에서 검증한다.
 */
export class ReportMaterialWriter1769100000000 implements MigrationInterface {
  name = 'ReportMaterialWriter1769100000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE lib ADD COLUMN material_kind varchar(16) NOT NULL DEFAULT 'regular'`);
    await q.query(`ALTER TABLE lib ADD COLUMN created_by bigint REFERENCES staff(id) ON DELETE RESTRICT`);
    await q.query(`ALTER TABLE lib ADD CONSTRAINT lib_material_kind_words
      CHECK (material_kind IN ('regular','supplementary','personal'))`);
    await q.query(`ALTER TABLE lib ADD CONSTRAINT lib_scoped_material_creator
      CHECK (material_kind='regular' OR created_by IS NOT NULL)`);
    await q.query(`CREATE INDEX lib_created_by_kind_idx ON lib(created_by,material_kind,id)`);
    await q.query(`CREATE UNIQUE INDEX lib_report_regular_name_unique
      ON lib(lower(btrim(title)),sub_key) WHERE created_by IS NOT NULL AND material_kind='regular'`);
    await q.query(`CREATE UNIQUE INDEX lib_report_scoped_name_unique
      ON lib(created_by,lower(btrim(title)),sub_key,material_kind)
      WHERE created_by IS NOT NULL AND material_kind IN ('supplementary','personal')`);

    await q.query(`ALTER TABLE issue ADD COLUMN source_rep_id bigint REFERENCES rep(id) ON DELETE RESTRICT`);
    await q.query(`CREATE INDEX issue_source_rep_idx ON issue(source_rep_id,id) WHERE source_rep_id IS NOT NULL`);

    await q.query(`
      CREATE TABLE report_material_req (
        request_key uuid PRIMARY KEY,
        actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
        rep_id bigint NOT NULL REFERENCES rep(id) ON DELETE RESTRICT,
        lib_id bigint NOT NULL REFERENCES lib(id) ON DELETE RESTRICT,
        selected_issue_id bigint NOT NULL REFERENCES issue(id) ON DELETE RESTRICT,
        fingerprint char(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT report_material_req_fingerprint_hex CHECK (fingerprint ~ '^[0-9a-f]{64}$')
      )
    `);
    await q.query(`CREATE INDEX report_material_req_rep_idx ON report_material_req(rep_id,created_at DESC,request_key)`);

    await q.query(`
      CREATE OR REPLACE FUNCTION issue_assignment_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        student_grade text;
        grade_no integer;
        current_vers bigint;
        report_material boolean;
      BEGIN
        IF NEW.teacher_id IS NULL THEN
          IF NEW.source_rep_id IS NOT NULL THEN
            RAISE EXCEPTION 'report material requires assignment context'
              USING ERRCODE='23514', CONSTRAINT='issue_report_material_context';
          END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE'
           AND NEW.teacher_id IS NOT DISTINCT FROM OLD.teacher_id
           AND NEW.sub_key IS NOT DISTINCT FROM OLD.sub_key
           AND NEW.student_id IS NOT DISTINCT FROM OLD.student_id
           AND NEW.lib_id IS NOT DISTINCT FROM OLD.lib_id
           AND NEW.vers_id IS NOT DISTINCT FROM OLD.vers_id
           AND NEW.source_rep_id IS NOT DISTINCT FROM OLD.source_rep_id THEN
          RETURN NEW;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM staff t WHERE t.id=NEW.teacher_id AND t.active) THEN
          RAISE EXCEPTION 'assignment teacher must be active'
            USING ERRCODE='23514', CONSTRAINT='issue_assignment_teacher_active';
        END IF;
        SELECT l.created_by IS NOT NULL INTO report_material
          FROM lib l WHERE l.id=NEW.lib_id AND l.sub_key=NEW.sub_key;
        IF report_material IS NULL THEN
          RAISE EXCEPTION 'assignment subject must match book subject'
            USING ERRCODE='23514', CONSTRAINT='issue_assignment_subject_match';
        END IF;

        IF report_material THEN
          IF NEW.source_rep_id IS NULL OR NOT EXISTS (
            SELECT 1
              FROM rep r JOIN ser s ON s.id=r.ser_id
              LEFT JOIN ser_occ o ON o.ser_id=r.ser_id AND o.on_date=r.on_date
              JOIN rep_stu rs ON rs.rep_id=r.id
             WHERE r.id=NEW.source_rep_id
               AND COALESCE(o.teacher_id,r.teacher_id)=NEW.teacher_id
               AND s.sub_key=NEW.sub_key AND rs.student_id=NEW.student_id
          ) THEN
            RAISE EXCEPTION 'report material must match its report teacher, subject, and student'
              USING ERRCODE='23514', CONSTRAINT='issue_report_material_rep_context';
          END IF;
          IF NEW.vers_id IS NOT NULL THEN
            RAISE EXCEPTION 'report material cannot invent a book version'
              USING ERRCODE='23514', CONSTRAINT='issue_report_material_no_version';
          END IF;
          RETURN NEW;
        ELSIF NEW.source_rep_id IS NOT NULL THEN
          RAISE EXCEPTION 'catalog assignment cannot claim report material origin'
            USING ERRCODE='23514', CONSTRAINT='issue_catalog_source_rep_forbidden';
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

    await q.query(`
      CREATE OR REPLACE FUNCTION issue_assignment_version_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
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
             OR NEW.source_rep_id IS DISTINCT FROM OLD.source_rep_id
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

  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM report_material_req)
         OR EXISTS (SELECT 1 FROM issue WHERE source_rep_id IS NOT NULL)
         OR EXISTS (SELECT 1 FROM lib WHERE created_by IS NOT NULL) THEN
        RAISE EXCEPTION 'ReportMaterialWriter down would discard material origin or request history';
      END IF;
    END $$`);
    await q.query(`DROP TABLE report_material_req`);
    await q.query(`DROP INDEX issue_source_rep_idx`);
    await q.query(`ALTER TABLE issue DROP COLUMN source_rep_id`);
    await q.query(`DROP INDEX lib_report_scoped_name_unique`);
    await q.query(`DROP INDEX lib_report_regular_name_unique`);
    await q.query(`DROP INDEX lib_created_by_kind_idx`);
    await q.query(`ALTER TABLE lib DROP CONSTRAINT lib_scoped_material_creator`);
    await q.query(`ALTER TABLE lib DROP CONSTRAINT lib_material_kind_words`);
    await q.query(`ALTER TABLE lib DROP COLUMN created_by, DROP COLUMN material_kind`);
    await q.query(`
      CREATE OR REPLACE FUNCTION issue_assignment_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
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
    await q.query(`
      CREATE OR REPLACE FUNCTION issue_assignment_version_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
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
  }
}
