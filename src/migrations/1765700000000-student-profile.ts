/** @file-guide
 * 목적: ST1-b2 학생 유효기간·기록시점 감사 원장의 additive DB 계약.
 * 책임/재사용: legacy STU scalar를 보존하고 기간/감사/현재값 SQL만 더한다. DTO·권한·HTTP writer는 후속 청크다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/contracts/db/student-registration-target.dbml
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class StudentProfile1765700000000 implements MigrationInterface {
  name = 'StudentProfile1765700000000';

  public async up(q: QueryRunner): Promise<void> {
    // 기존 학생과 현행 INSERT는 version=0으로 남는다. 새 등록 필수 계약은 writer가 준비된 ST2에서 켠다.
    await q.query(`ALTER TABLE stu ADD COLUMN profile_version bigint NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE stu ADD CONSTRAINT stu_profile_version_nonnegative CHECK (profile_version >= 0)`);

    await q.query(`CREATE TABLE stu_profile_audit (
      id bigserial PRIMARY KEY,
      student_id bigint NOT NULL REFERENCES stu(id),
      action varchar(32) NOT NULL,
      field varchar(16),
      request_key uuid NOT NULL,
      request_fingerprint bytea NOT NULL,
      version_before bigint NOT NULL,
      version_after bigint NOT NULL,
      before_data jsonb,
      after_data jsonb,
      reason text,
      recorded_by bigint NOT NULL REFERENCES staff(id),
      recorded_at timestamptz NOT NULL DEFAULT now(),
      write_txid bigint NOT NULL DEFAULT txid_current(),
      CONSTRAINT stu_profile_audit_student_identity UNIQUE (id, student_id),
      CONSTRAINT stu_profile_audit_version_unique UNIQUE (student_id, version_after),
      CONSTRAINT stu_profile_audit_request_unique UNIQUE (student_id, request_key),
      CONSTRAINT stu_profile_audit_version_step CHECK (version_before >= 0 AND version_after = version_before + 1),
      CONSTRAINT stu_profile_audit_create_initial CHECK (action <> 'create' OR version_before = 0),
      CONSTRAINT stu_profile_audit_fingerprint CHECK (octet_length(request_fingerprint) = 32),
      CONSTRAINT stu_profile_audit_action CHECK (action IN
        ('create','static_patch','period_append','period_correct','period_split','contact_change',
         'guardian_change','staff_change','sibling_change')),
      CONSTRAINT stu_profile_audit_field CHECK (field IS NULL OR field IN
        ('grade','school','want','residence','guidance','lang','target_exam','notes')),
      CONSTRAINT stu_profile_audit_period_field CHECK
        (action NOT IN ('period_append','period_correct','period_split') OR field IS NOT NULL),
      CONSTRAINT stu_profile_audit_before_object CHECK (before_data IS NULL OR jsonb_typeof(before_data) = 'object'),
      CONSTRAINT stu_profile_audit_after_object CHECK (after_data IS NULL OR jsonb_typeof(after_data) = 'object'),
      CONSTRAINT stu_profile_audit_reason CHECK
        (reason IS NULL OR (length(btrim(reason)) BETWEEN 1 AND 1000)),
      CONSTRAINT stu_profile_audit_correction_reason CHECK
        (action NOT IN ('period_correct','period_split') OR reason IS NOT NULL)
    )`);
    await q.query(`CREATE INDEX stu_profile_audit_timeline
      ON stu_profile_audit(student_id, recorded_at DESC, id DESC)`);

    await q.query(`CREATE TABLE stu_profile_period (
      id bigserial PRIMARY KEY,
      student_id bigint NOT NULL REFERENCES stu(id),
      field varchar(16) NOT NULL,
      valid_from date NOT NULL,
      valid_to date,
      from_precision varchar(5) NOT NULL DEFAULT 'day',
      to_precision varchar(5),
      from_derived boolean NOT NULL DEFAULT false,
      to_derived boolean NOT NULL DEFAULT false,
      education_system varchar(5),
      grade_code varchar(16),
      school_id bigint REFERENCES school(id),
      residence_country_code char(2) REFERENCES country(code),
      residence_timezone varchar(64),
      text_value text,
      memo text,
      created_audit_id bigint NOT NULL,
      recorded_by bigint NOT NULL REFERENCES staff(id),
      recorded_at timestamptz NOT NULL DEFAULT now(),
      superseded_by_audit_id bigint,
      superseded_at timestamptz,
      CONSTRAINT stu_profile_period_created_audit_fk FOREIGN KEY (created_audit_id, student_id)
        REFERENCES stu_profile_audit(id, student_id),
      CONSTRAINT stu_profile_period_superseded_audit_fk FOREIGN KEY (superseded_by_audit_id, student_id)
        REFERENCES stu_profile_audit(id, student_id),
      CONSTRAINT stu_profile_period_grade_fk FOREIGN KEY (education_system, grade_code)
        REFERENCES education_grade(education_system, code),
      CONSTRAINT stu_profile_period_timezone_fk FOREIGN KEY (residence_country_code, residence_timezone)
        REFERENCES country_timezone(country_code, timezone),
      CONSTRAINT stu_profile_period_dates CHECK (
        valid_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
        AND (valid_to IS NULL OR (valid_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' AND valid_to >= valid_from))
      ),
      CONSTRAINT stu_profile_period_precision CHECK (
        from_precision IN ('day','month','year')
        AND ((valid_to IS NULL AND to_precision IS NULL AND NOT to_derived)
          OR (valid_to IS NOT NULL AND to_precision IN ('day','month','year')))
        AND (NOT from_derived OR from_precision = 'day')
        AND (NOT to_derived OR to_precision = 'day')
        AND (from_precision <> 'month' OR EXTRACT(DAY FROM valid_from) = 1)
        AND (from_precision <> 'year' OR (EXTRACT(MONTH FROM valid_from) = 1 AND EXTRACT(DAY FROM valid_from) = 1))
        AND (to_precision IS DISTINCT FROM 'month' OR
          valid_to = (date_trunc('month', valid_to)::date + interval '1 month' - interval '1 day')::date)
        AND (to_precision IS DISTINCT FROM 'year' OR
          (EXTRACT(MONTH FROM valid_to) = 12 AND EXTRACT(DAY FROM valid_to) = 31))
      ),
      CONSTRAINT stu_profile_period_payload CHECK (
        (field = 'grade' AND education_system IS NOT NULL AND grade_code IS NOT NULL
          AND school_id IS NULL AND residence_country_code IS NULL AND residence_timezone IS NULL AND text_value IS NULL)
        OR (field = 'school' AND school_id IS NOT NULL
          AND education_system IS NULL AND grade_code IS NULL AND residence_country_code IS NULL
          AND residence_timezone IS NULL AND text_value IS NULL)
        OR (field = 'residence' AND residence_country_code IS NOT NULL
          AND education_system IS NULL AND grade_code IS NULL AND school_id IS NULL AND text_value IS NULL)
        OR (field IN ('want','guidance','lang','target_exam','notes') AND text_value IS NOT NULL
          AND education_system IS NULL AND grade_code IS NULL AND school_id IS NULL
          AND residence_country_code IS NULL AND residence_timezone IS NULL)
      ),
      CONSTRAINT stu_profile_period_text CHECK (
        text_value IS NULL OR (length(btrim(text_value)) > 0 AND length(text_value) <= CASE field
          WHEN 'guidance' THEN 20 WHEN 'lang' THEN 20 WHEN 'target_exam' THEN 40
          WHEN 'want' THEN 1000 ELSE 2000 END)
      ),
      CONSTRAINT stu_profile_period_memo CHECK (memo IS NULL OR length(btrim(memo)) BETWEEN 1 AND 1000),
      CONSTRAINT stu_profile_period_supersede_pair CHECK (
        (superseded_by_audit_id IS NULL AND superseded_at IS NULL)
        OR (superseded_by_audit_id IS NOT NULL AND superseded_at IS NOT NULL
          AND superseded_by_audit_id <> created_audit_id AND superseded_at >= recorded_at)
      ),
      CONSTRAINT stu_profile_period_no_overlap EXCLUDE USING gist (
        student_id WITH =, field WITH =, daterange(valid_from, valid_to, '[]') WITH &&
      ) WHERE (superseded_at IS NULL) DEFERRABLE INITIALLY DEFERRED
    )`);
    await q.query(`CREATE INDEX stu_profile_period_timeline
      ON stu_profile_period(student_id, field, valid_from DESC, recorded_at DESC, id DESC)`);
    await q.query(`CREATE INDEX stu_profile_period_grade_filter
      ON stu_profile_period(education_system, grade_code, student_id) WHERE superseded_at IS NULL`);
    await q.query(`CREATE INDEX stu_profile_period_school_filter
      ON stu_profile_period(school_id, student_id) WHERE superseded_at IS NULL`);
    await q.query(`CREATE INDEX stu_profile_period_created_audit ON stu_profile_period(created_audit_id)`);
    await q.query(`CREATE INDEX stu_profile_period_superseded_audit ON stu_profile_period(superseded_by_audit_id)`);

    // 감사 INSERT가 학생 row lock과 optimistic version 전진을 소유한다. 실패는 전체 statement/transaction rollback.
    await q.query(`CREATE FUNCTION student_profile_audit_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_version bigint;
      BEGIN
        SELECT profile_version INTO v_version FROM stu WHERE id = NEW.student_id FOR NO KEY UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'student_profile_student_missing' USING ERRCODE = '23503'; END IF;
        IF v_version <> NEW.version_before THEN
          RAISE EXCEPTION 'student_profile_stale_version: expected %, current %', NEW.version_before, v_version
            USING ERRCODE = '40001';
        END IF;
        NEW.recorded_at := clock_timestamp();
        NEW.write_txid := txid_current();
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER stu_profile_audit_insert BEFORE INSERT ON stu_profile_audit
      FOR EACH ROW EXECUTE FUNCTION student_profile_audit_before_insert()`);
    // audit 행이 먼저 존재해야 STU version guard가 같은 transaction의 합법적인 전진을 식별할 수 있다.
    await q.query(`CREATE FUNCTION student_profile_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.profile_version <> 0 THEN
            RAISE EXCEPTION 'student_profile_version_audit_required' USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.profile_version IS DISTINCT FROM OLD.profile_version AND NOT EXISTS (
          SELECT 1 FROM stu_profile_audit a
          WHERE a.student_id = NEW.id AND a.version_before = OLD.profile_version
            AND a.version_after = NEW.profile_version AND a.write_txid = txid_current()
        ) THEN
          RAISE EXCEPTION 'student_profile_version_audit_required' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER stu_profile_version_insert BEFORE INSERT ON stu
      FOR EACH ROW EXECUTE FUNCTION student_profile_version_guard()`);
    await q.query(`CREATE TRIGGER stu_profile_version_update BEFORE UPDATE OF profile_version ON stu
      FOR EACH ROW EXECUTE FUNCTION student_profile_version_guard()`);
    await q.query(`CREATE FUNCTION student_profile_audit_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE stu SET profile_version = NEW.version_after WHERE id = NEW.student_id;
        RETURN NULL;
      END $$`);
    await q.query(`CREATE TRIGGER stu_profile_audit_version AFTER INSERT ON stu_profile_audit
      FOR EACH ROW EXECUTE FUNCTION student_profile_audit_after_insert()`);
    await q.query(`CREATE FUNCTION student_profile_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'student_profile_audit_immutable' USING ERRCODE = '23514'; END $$`);
    await q.query(`CREATE TRIGGER stu_profile_audit_no_change BEFORE UPDATE OR DELETE ON stu_profile_audit
      FOR EACH ROW EXECUTE FUNCTION student_profile_audit_immutable()`);

    await q.query(`CREATE FUNCTION student_profile_period_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE a stu_profile_audit%ROWTYPE; v_active boolean; v_zone_count integer;
      BEGIN
        SELECT * INTO a FROM stu_profile_audit WHERE id = NEW.created_audit_id;
        IF NOT FOUND OR a.student_id <> NEW.student_id OR a.write_txid <> txid_current()
          OR a.action NOT IN ('create','period_append','period_correct','period_split')
          OR (a.field IS NOT NULL AND a.field <> NEW.field) THEN
          RAISE EXCEPTION 'student_profile_created_audit_invalid' USING ERRCODE = '23514';
        END IF;
        IF NEW.field = 'grade' THEN
          SELECT active INTO v_active FROM education_grade
            WHERE education_system = NEW.education_system AND code = NEW.grade_code FOR SHARE;
          IF NOT coalesce(v_active, false) THEN
            RAISE EXCEPTION 'student_profile_grade_inactive' USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.field = 'school' THEN
          SELECT active INTO v_active FROM school WHERE id = NEW.school_id FOR SHARE;
          IF NOT coalesce(v_active, false) THEN
            RAISE EXCEPTION 'student_profile_school_inactive' USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.field = 'residence' THEN
          SELECT active INTO v_active FROM country WHERE code = NEW.residence_country_code FOR SHARE;
          IF NOT coalesce(v_active, false) THEN
            RAISE EXCEPTION 'student_profile_country_inactive' USING ERRCODE = '23514';
          END IF;
          -- NULL zone이 허용되는 단일 활성 시간대도 잠근다. 비활성화 경합 중 무시간대 기간을 만들지 않는다.
          SELECT count(*) INTO v_zone_count FROM (
            SELECT 1 FROM country_timezone
              WHERE country_code = NEW.residence_country_code AND active FOR SHARE
          ) active_zones;
          IF v_zone_count = 0 OR (v_zone_count > 1 AND NEW.residence_timezone IS NULL) THEN
            RAISE EXCEPTION 'student_profile_timezone_required' USING ERRCODE = '23514';
          END IF;
          IF NEW.residence_timezone IS NOT NULL THEN
            SELECT active INTO v_active FROM country_timezone
              WHERE country_code = NEW.residence_country_code AND timezone = NEW.residence_timezone FOR SHARE;
            IF NOT coalesce(v_active, false) THEN
              RAISE EXCEPTION 'student_profile_timezone_inactive' USING ERRCODE = '23514';
            END IF;
          END IF;
        END IF;
        NEW.recorded_by := a.recorded_by;
        NEW.recorded_at := a.recorded_at;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER stu_profile_period_insert BEFORE INSERT ON stu_profile_period
      FOR EACH ROW EXECUTE FUNCTION student_profile_period_before_insert()`);

    await q.query(`CREATE FUNCTION student_profile_period_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE a stu_profile_audit%ROWTYPE;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'student_profile_period_immutable' USING ERRCODE = '23514';
        END IF;
        IF (to_jsonb(NEW) - 'superseded_by_audit_id' - 'superseded_at') IS DISTINCT FROM
           (to_jsonb(OLD) - 'superseded_by_audit_id' - 'superseded_at')
           OR OLD.superseded_by_audit_id IS NOT NULL OR OLD.superseded_at IS NOT NULL
           OR NEW.superseded_by_audit_id IS NULL THEN
          RAISE EXCEPTION 'student_profile_period_immutable' USING ERRCODE = '23514';
        END IF;
        SELECT * INTO a FROM stu_profile_audit WHERE id = NEW.superseded_by_audit_id;
        IF NOT FOUND OR a.student_id <> OLD.student_id OR a.field <> OLD.field
          OR a.action NOT IN ('period_correct','period_split') OR a.write_txid <> txid_current() THEN
          RAISE EXCEPTION 'student_profile_supersede_audit_invalid' USING ERRCODE = '23514';
        END IF;
        NEW.superseded_at := a.recorded_at;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER stu_profile_period_no_change BEFORE UPDATE OR DELETE ON stu_profile_period
      FOR EACH ROW EXECUTE FUNCTION student_profile_period_immutable()`);

    // 한 audit의 기간 분할은 원본 하나를 1~3개 연속 구간으로 전부 덮어야 한다. 중간/양끝 소실 금지.
    await q.query(`CREATE FUNCTION student_profile_audit_complete() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_created integer; v_superseded integer; v_original stu_profile_period%ROWTYPE;
        v_child stu_profile_period%ROWTYPE; v_expected date; v_last_to date; v_seen_open boolean := false;
        v_index integer := 0; v_changed integer := 0; v_first_changed boolean := false;
        v_last_changed boolean := false; v_payload_changed boolean;
      BEGIN
        SELECT count(*) INTO v_created FROM stu_profile_period WHERE created_audit_id = NEW.id;
        SELECT count(*) INTO v_superseded FROM stu_profile_period WHERE superseded_by_audit_id = NEW.id;
        IF NEW.action IN ('create','period_append') THEN
          IF v_created = 0 OR v_superseded <> 0 THEN
            RAISE EXCEPTION 'student_profile_audit_period_count' USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.action IN ('period_correct','period_split') THEN
          IF v_superseded <> 1 OR v_created NOT BETWEEN 1 AND 3
            OR (NEW.action = 'period_correct' AND v_created <> 1)
            OR (NEW.action = 'period_split' AND v_created < 2) THEN
            RAISE EXCEPTION 'student_profile_audit_revision_count' USING ERRCODE = '23514';
          END IF;
          SELECT * INTO v_original FROM stu_profile_period WHERE superseded_by_audit_id = NEW.id;
          v_expected := v_original.valid_from;
          FOR v_child IN SELECT * FROM stu_profile_period
            WHERE created_audit_id = NEW.id ORDER BY valid_from, id LOOP
            v_index := v_index + 1;
            IF v_seen_open OR v_child.student_id <> v_original.student_id OR v_child.field <> v_original.field
              OR v_child.valid_from <> v_expected THEN
              RAISE EXCEPTION 'student_profile_audit_revision_gap' USING ERRCODE = '23514';
            END IF;
            v_payload_changed := ROW(v_child.education_system, v_child.grade_code, v_child.school_id,
              v_child.residence_country_code, v_child.residence_timezone, v_child.text_value, v_child.memo)
              IS DISTINCT FROM ROW(v_original.education_system, v_original.grade_code, v_original.school_id,
              v_original.residence_country_code, v_original.residence_timezone, v_original.text_value, v_original.memo);
            IF v_payload_changed THEN v_changed := v_changed + 1; END IF;
            IF v_index = 1 THEN v_first_changed := v_payload_changed; END IF;
            v_last_changed := v_payload_changed;
            v_last_to := v_child.valid_to;
            IF v_child.valid_to IS NULL THEN v_seen_open := true;
            ELSE v_expected := v_child.valid_to + 1; END IF;
          END LOOP;
          IF v_last_to IS DISTINCT FROM v_original.valid_to THEN
            RAISE EXCEPTION 'student_profile_audit_revision_tail' USING ERRCODE = '23514';
          END IF;
          IF NEW.action = 'period_split' AND (v_changed > 1
            OR (v_created = 3 AND (v_first_changed OR v_last_changed))
            OR (v_created = 2 AND v_first_changed AND v_last_changed)) THEN
            RAISE EXCEPTION 'student_profile_audit_split_side_changed' USING ERRCODE = '23514';
          END IF;
        ELSIF v_created <> 0 OR v_superseded <> 0 THEN
          RAISE EXCEPTION 'student_profile_audit_unexpected_period' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER stu_profile_audit_complete
      AFTER INSERT ON stu_profile_audit DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION student_profile_audit_complete()`);

    // 유효시점(as_of)과 기록시점(recorded_at)은 별개다. 과거 scalar를 해당 날짜의 사실로 추정하지 않는다.
    await q.query(`CREATE FUNCTION student_profile_at(p_as_of date)
      RETURNS TABLE (
        student_id bigint, field varchar(16), as_of date, source text, period_id bigint,
        valid_from date, valid_to date, from_precision varchar(5), to_precision varchar(5),
        from_derived boolean, to_derived boolean, education_system varchar(5), grade_code varchar(16),
        school_id bigint, residence_country_code char(2), residence_timezone varchar(64),
        text_value text, legacy_text text, recorded_by bigint, recorded_at timestamptz, profile_version bigint
      ) LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
      BEGIN
        IF p_as_of IS NULL OR p_as_of NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' THEN
          RAISE EXCEPTION 'student_profile_as_of_invalid' USING ERRCODE = '22007';
        END IF;
        RETURN QUERY
        SELECT s.id, f.name, p_as_of,
          CASE WHEN p.id IS NOT NULL THEN 'period'::text
               WHEN seen.managed THEN 'gap'::text
               WHEN legacy.value IS NOT NULL THEN 'legacy_unknown'::text ELSE 'gap'::text END,
          p.id, p.valid_from, p.valid_to, p.from_precision, p.to_precision,
          p.from_derived, p.to_derived, p.education_system, p.grade_code, p.school_id,
          p.residence_country_code, p.residence_timezone, p.text_value,
          -- legacy scalar는 오늘 보존값만 공개한다. 과거/미래 시점의 사실로 되돌려 주지 않는다.
          CASE WHEN p.id IS NULL AND NOT seen.managed
                      AND p_as_of = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date
               THEN legacy.value ELSE NULL::text END,
          p.recorded_by, p.recorded_at, s.profile_version
        FROM stu s
        CROSS JOIN (VALUES ('grade'::varchar(16)), ('school'::varchar(16)), ('want'::varchar(16)),
          ('residence'::varchar(16)), ('guidance'::varchar(16)), ('lang'::varchar(16)),
          ('target_exam'::varchar(16)), ('notes'::varchar(16))) f(name)
        CROSS JOIN LATERAL (SELECT CASE f.name
          WHEN 'grade' THEN s.grade::text WHEN 'school' THEN s.school::text
          WHEN 'guidance' THEN s.guidance::text WHEN 'lang' THEN s.lang::text
          WHEN 'target_exam' THEN s.target_exam::text ELSE NULL::text END AS value) legacy
        CROSS JOIN LATERAL (SELECT EXISTS (
          SELECT 1 FROM stu_profile_period ever WHERE ever.student_id = s.id AND ever.field = f.name
        ) AS managed) seen
        LEFT JOIN LATERAL (
          SELECT row.* FROM stu_profile_period row
          WHERE row.student_id = s.id AND row.field = f.name AND row.superseded_at IS NULL
            AND row.valid_from <= p_as_of AND (row.valid_to IS NULL OR row.valid_to >= p_as_of)
          ORDER BY row.valid_from DESC, row.id DESC LIMIT 1
        ) p ON true;
      END $$`);
    await q.query(`CREATE VIEW student_profile_current WITH (security_invoker = true) AS
      SELECT * FROM student_profile_at((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // 감사가 한 건이라도 생긴 뒤 DROP하면 법적·업무 이력을 지운다. 운영 복구는 roll-forward.
    await q.query(`LOCK TABLE stu_profile_period, stu_profile_audit, stu IN ACCESS EXCLUSIVE MODE`);
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM stu_profile_audit) OR EXISTS (SELECT 1 FROM stu_profile_period)
        OR EXISTS (SELECT 1 FROM stu WHERE profile_version <> 0) THEN
        RAISE EXCEPTION 'StudentProfile down would discard student history; roll forward instead';
      END IF;
    END $$`);
    await q.query(`DROP VIEW student_profile_current`);
    await q.query(`DROP FUNCTION student_profile_at(date)`);
    await q.query(`DROP TABLE stu_profile_period`);
    await q.query(`DROP TABLE stu_profile_audit`);
    await q.query(`DROP FUNCTION student_profile_audit_complete()`);
    await q.query(`DROP FUNCTION student_profile_period_immutable()`);
    await q.query(`DROP FUNCTION student_profile_period_before_insert()`);
    await q.query(`DROP FUNCTION student_profile_audit_immutable()`);
    await q.query(`DROP FUNCTION student_profile_audit_after_insert()`);
    await q.query(`DROP FUNCTION student_profile_audit_before_insert()`);
    await q.query(`DROP TRIGGER stu_profile_version_insert ON stu`);
    await q.query(`DROP TRIGGER stu_profile_version_update ON stu`);
    await q.query(`DROP FUNCTION student_profile_version_guard()`);
    await q.query(`ALTER TABLE stu DROP CONSTRAINT stu_profile_version_nonnegative`);
    await q.query(`ALTER TABLE stu DROP COLUMN profile_version`);
  }
}
