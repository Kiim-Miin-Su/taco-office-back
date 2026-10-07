/** @file-guide
 * 목적: BOC-03D-04b 신규 학생 15절 writer가 필요한 계약 표식·PII·보호자 확장·담당·형제 영속화를 additive로 추가한다.
 * 책임/재사용: 기존 contract=0 학생/최소 등록 writer를 보존하고 새 StudentCreateDto writer의 최종 DB 상태만 지연 검증한다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-03-SCENARIOS-2026-10-06.md · docs/contracts/db/student-registration-target.dbml
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class StudentRegistrationWriter1766300000000 implements MigrationInterface {
  name = 'StudentRegistrationWriter1766300000000';

  public async up(q: QueryRunner): Promise<void> {
    /*
     * BOC-03D-04b 권고안 채택(2026-10-07): 기존 최소 등록 writer와 legacy 학생은 contract=0으로
     * 보존하고, StudentCreateDto 신규 writer만 contract=1을 명시한다. 정책 변경 시 StudentsService,
     * StudentCreateDto, P-STU15, BOC-03, target/current DBML과 Front 생성 계약을 함께 수정한다.
     */
    await q.query(`ALTER TABLE stu
      ADD COLUMN cash_receipt_encrypted bytea,
      ADD COLUMN cash_receipt_key_version varchar(40),
      ADD COLUMN created_by bigint REFERENCES staff(id),
      ADD COLUMN registration_contract_version smallint NOT NULL DEFAULT 0,
      ADD COLUMN registration_request_key uuid`);
    await q.query(`ALTER TABLE stu ADD CONSTRAINT stu_cash_receipt_pair CHECK (
      (cash_receipt_encrypted IS NULL AND cash_receipt_key_version IS NULL)
      OR (cash_receipt_encrypted IS NOT NULL AND cash_receipt_key_version IS NOT NULL
        AND length(btrim(cash_receipt_key_version)) BETWEEN 1 AND 40)
    )`);
    await q.query(`ALTER TABLE stu ADD CONSTRAINT stu_registration_contract CHECK (
      registration_contract_version IN (0,1)
      AND (registration_contract_version = 0 OR
        (gender IS NOT NULL AND created_by IS NOT NULL AND registration_request_key IS NOT NULL))
    )`);
    await q.query(`CREATE UNIQUE INDEX stu_registration_request_once
      ON stu(registration_request_key) WHERE registration_request_key IS NOT NULL`);

    await q.query(`ALTER TABLE guardian DROP CONSTRAINT guardian_contact_present`);
    await q.query(`ALTER TABLE guardian DROP CONSTRAINT guardian_name_present`);
    await q.query(`ALTER TABLE guardian ALTER COLUMN name DROP NOT NULL`);
    await q.query(`ALTER TABLE guardian
      ADD COLUMN relation_code varchar(6),
      ADD COLUMN relation_other varchar(80),
      ADD COLUMN residence_country_code char(2) REFERENCES country(code),
      ADD COLUMN is_payer boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE guardian ADD CONSTRAINT guardian_name_present CHECK (
      name IS NULL OR (name = btrim(name) AND length(name) > 0)
    )`);
    await q.query(`ALTER TABLE guardian ADD CONSTRAINT guardian_relation_code CHECK (
      relation_code IS NULL OR relation_code IN ('mother','father','aunt','driver','other')
    )`);
    await q.query(`ALTER TABLE guardian ADD CONSTRAINT guardian_relation_other CHECK (
      (relation_code = 'other' AND relation_other IS NOT NULL
        AND relation_other = btrim(relation_other) AND length(relation_other) > 0)
      OR (relation_code IS DISTINCT FROM 'other' AND relation_other IS NULL)
    )`);
    await q.query(`CREATE UNIQUE INDEX guardian_contact_active_identity ON guardian_contact(
      guardian_id, kind, canonical_contact_value(kind, value), coalesce(label,'')) WHERE active`);

    await q.query(`CREATE TABLE stu_staff (
      student_id bigint NOT NULL REFERENCES stu(id),
      staff_id bigint NOT NULL REFERENCES staff(id),
      active boolean NOT NULL DEFAULT true,
      assigned_by bigint NOT NULL REFERENCES staff(id),
      assigned_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (student_id, staff_id)
    )`);
    await q.query(`CREATE INDEX stu_staff_reverse ON stu_staff(staff_id, active, student_id)`);
    await q.query(`CREATE TABLE stu_sibling (
      student_low_id bigint NOT NULL REFERENCES stu(id),
      student_high_id bigint NOT NULL REFERENCES stu(id),
      active boolean NOT NULL DEFAULT true,
      linked_by bigint NOT NULL REFERENCES staff(id),
      linked_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (student_low_id, student_high_id),
      CONSTRAINT stu_sibling_order CHECK (student_low_id < student_high_id)
    )`);
    await q.query(`CREATE INDEX stu_sibling_reverse ON stu_sibling(student_high_id, active, student_low_id)`);

    // 새 학생은 권위 상태 원장에도 active로 시작한다. legacy 학생의 상태는 계속 추정하지 않는다.
    await q.query(`ALTER TABLE stu_status_event DROP CONSTRAINT stu_status_event_action`);
    await q.query(`ALTER TABLE stu_status_event DROP CONSTRAINT stu_status_event_request_shape`);
    await q.query(`ALTER TABLE stu_status_event ADD CONSTRAINT stu_status_event_action CHECK (
      action IN ('create','withdraw','reactivate')
    )`);
    await q.query(`ALTER TABLE stu_status_event ADD CONSTRAINT stu_status_event_request_shape CHECK (
      (action = 'create' AND from_status IS NULL AND to_status = 'active'
        AND consultation_id IS NULL AND request_key IS NOT NULL AND request_fingerprint IS NOT NULL
        AND octet_length(request_fingerprint) = 32
        AND profile_version_before = 0 AND profile_version_after = 1)
      OR
      (action = 'withdraw' AND to_status = 'withdrawn'
        AND consultation_id IS NULL AND request_key IS NULL AND request_fingerprint IS NULL
        AND profile_version_before IS NULL AND profile_version_after IS NULL)
      OR
      (action = 'reactivate' AND from_status = 'withdrawn' AND to_status = 'active'
        AND consultation_id IS NOT NULL AND request_key IS NOT NULL AND request_fingerprint IS NOT NULL
        AND octet_length(request_fingerprint) = 32
        AND profile_version_before >= 0 AND profile_version_after = profile_version_before + 1)
    )`);
    await q.query(`CREATE OR REPLACE FUNCTION stu_status_event_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_previous varchar(16);
      BEGIN
        PERFORM 1 FROM stu WHERE id = NEW.student_id FOR NO KEY UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'student_status_student_missing' USING ERRCODE = '23503'; END IF;
        SELECT e.to_status INTO v_previous FROM stu_status_event e
          WHERE e.student_id = NEW.student_id ORDER BY e.id DESC LIMIT 1;
        IF NEW.from_status IS DISTINCT FROM v_previous THEN
          RAISE EXCEPTION 'student_status_stale_transition' USING ERRCODE = '40001';
        END IF;
        IF NEW.action = 'create' AND (v_previous IS NOT NULL OR NEW.to_status <> 'active') THEN
          RAISE EXCEPTION 'student_status_invalid_create' USING ERRCODE = '23514';
        END IF;
        IF NEW.action = 'withdraw' AND (v_previous = 'withdrawn' OR NEW.to_status <> 'withdrawn') THEN
          RAISE EXCEPTION 'student_status_invalid_withdraw' USING ERRCODE = '23514';
        END IF;
        IF NEW.action = 'reactivate' AND (v_previous IS DISTINCT FROM 'withdrawn' OR NEW.to_status <> 'active') THEN
          RAISE EXCEPTION 'student_status_invalid_reactivate' USING ERRCODE = '23514';
        END IF;
        NEW.created_at := clock_timestamp();
        NEW.write_txid := txid_current();
        RETURN NEW;
      END $$`);

    await q.query(`CREATE FUNCTION is_registration_student(v_student bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (SELECT 1 FROM stu s WHERE s.id=v_student AND s.registration_contract_version=1)
    $$`);
    await q.query(`CREATE FUNCTION is_registration_guardian(v_guardian bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (SELECT 1 FROM guardian g JOIN stu s ON s.id=g.student_id
        WHERE g.id=v_guardian AND s.registration_contract_version=1)
    $$`);

    // BOC-03D-04b 권고안: contract=1 신규 등록의 활성 보호자만 최종 상태에서 활성 연락처를 요구한다.
    // 기존 연락처 정합화 CLI가 다루는 legacy 보호자는 소급 차단하지 않고, 생성 transaction 안의 순서는 지연 트리거로 허용한다.
    await q.query(`CREATE FUNCTION assert_guardian_contact_complete(v_guardian bigint) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM guardian g JOIN stu s ON s.id=g.student_id
            WHERE g.id = v_guardian AND g.active AND s.registration_contract_version=1)
          AND NOT EXISTS (SELECT 1 FROM guardian_contact c WHERE c.guardian_id = v_guardian AND c.active) THEN
          RAISE EXCEPTION 'guardian_active_contact_required' USING ERRCODE = '23514';
        END IF;
      END $$`);
    await q.query(`CREATE FUNCTION guardian_contact_complete_guardian() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM assert_guardian_contact_complete(CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END);
        RETURN NULL;
      END $$`);
    await q.query(`CREATE FUNCTION guardian_contact_complete_contact() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM assert_guardian_contact_complete(CASE WHEN TG_OP='DELETE' THEN OLD.guardian_id ELSE NEW.guardian_id END);
        IF TG_OP='UPDATE' AND OLD.guardian_id IS DISTINCT FROM NEW.guardian_id THEN
          PERFORM assert_guardian_contact_complete(OLD.guardian_id);
        END IF;
        RETURN NULL;
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER guardian_contact_complete_guardian_insert
      AFTER INSERT ON guardian DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (is_registration_student(NEW.student_id)) EXECUTE FUNCTION guardian_contact_complete_guardian()`);
    await q.query(`CREATE CONSTRAINT TRIGGER guardian_contact_complete_guardian_update
      AFTER UPDATE ON guardian DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (is_registration_student(NEW.student_id) OR is_registration_student(OLD.student_id))
      EXECUTE FUNCTION guardian_contact_complete_guardian()`);
    await q.query(`CREATE CONSTRAINT TRIGGER guardian_contact_complete_guardian_delete
      AFTER DELETE ON guardian DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (is_registration_student(OLD.student_id)) EXECUTE FUNCTION guardian_contact_complete_guardian()`);
    await q.query(`CREATE CONSTRAINT TRIGGER guardian_contact_complete_contact_insert
      AFTER INSERT ON guardian_contact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (is_registration_guardian(NEW.guardian_id)) EXECUTE FUNCTION guardian_contact_complete_contact()`);
    await q.query(`CREATE CONSTRAINT TRIGGER guardian_contact_complete_contact_update
      AFTER UPDATE ON guardian_contact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (is_registration_guardian(NEW.guardian_id) OR is_registration_guardian(OLD.guardian_id))
      EXECUTE FUNCTION guardian_contact_complete_contact()`);
    await q.query(`CREATE CONSTRAINT TRIGGER guardian_contact_complete_contact_delete
      AFTER DELETE ON guardian_contact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (is_registration_guardian(OLD.guardian_id)) EXECUTE FUNCTION guardian_contact_complete_contact()`);

    // contract=1은 create audit/status, 현재 grade/residence와 활성 보호자까지 한 transaction에서 완성돼야 한다.
    await q.query(`CREATE FUNCTION assert_student_registration_complete(v_student bigint) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE v_today date;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM stu s WHERE s.id = v_student AND s.registration_contract_version = 1) THEN
          RETURN;
        END IF;
        v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date;
        IF NOT EXISTS (SELECT 1 FROM stu s WHERE s.id=v_student AND s.profile_version >= 1
          AND s.gender IS NOT NULL AND s.created_by IS NOT NULL AND s.registration_request_key IS NOT NULL) THEN
          RAISE EXCEPTION 'student_registration_identity_incomplete' USING ERRCODE = '23514';
        END IF;
        IF (SELECT count(*) FROM stu_profile_period p WHERE p.student_id=v_student AND p.field='grade'
          AND p.superseded_at IS NULL AND p.valid_from <= v_today AND (p.valid_to IS NULL OR p.valid_to >= v_today)) <> 1 THEN
          RAISE EXCEPTION 'student_registration_current_grade_required' USING ERRCODE = '23514';
        END IF;
        IF (SELECT count(*) FROM stu_profile_period p WHERE p.student_id=v_student AND p.field='residence'
          AND p.superseded_at IS NULL AND p.valid_from <= v_today AND (p.valid_to IS NULL OR p.valid_to >= v_today)) <> 1 THEN
          RAISE EXCEPTION 'student_registration_current_residence_required' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM guardian g WHERE g.student_id=v_student AND g.active) THEN
          RAISE EXCEPTION 'student_registration_guardian_required' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM stu_profile_audit a JOIN stu s ON s.id=a.student_id
          WHERE a.student_id=v_student AND a.action='create' AND a.request_key=s.registration_request_key
            AND a.recorded_by=s.created_by AND a.version_before=0 AND a.version_after=1) THEN
          RAISE EXCEPTION 'student_registration_audit_required' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM stu_status_event e JOIN stu s ON s.id=e.student_id
          WHERE e.student_id=v_student AND e.action='create' AND e.to_status='active'
            AND e.request_key=s.registration_request_key AND e.actor_id=s.created_by) THEN
          RAISE EXCEPTION 'student_registration_status_required' USING ERRCODE = '23514';
        END IF;
      END $$`);
    await q.query(`CREATE FUNCTION student_registration_complete_stu() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM assert_student_registration_complete(NEW.id);
        RETURN NULL;
      END $$`);
    await q.query(`CREATE FUNCTION student_registration_complete_guardian() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM assert_student_registration_complete(CASE WHEN TG_OP='DELETE' THEN OLD.student_id ELSE NEW.student_id END);
        IF TG_OP='UPDATE' AND OLD.student_id IS DISTINCT FROM NEW.student_id THEN
          PERFORM assert_student_registration_complete(OLD.student_id);
        END IF;
        RETURN NULL;
      END $$`);
    await q.query(`CREATE FUNCTION student_registration_complete_period() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM assert_student_registration_complete(CASE WHEN TG_OP='DELETE' THEN OLD.student_id ELSE NEW.student_id END);
        IF TG_OP='UPDATE' AND OLD.student_id IS DISTINCT FROM NEW.student_id THEN
          PERFORM assert_student_registration_complete(OLD.student_id);
        END IF;
        RETURN NULL;
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER student_registration_complete_stu
      AFTER INSERT OR UPDATE ON stu DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW WHEN (NEW.registration_contract_version=1)
      EXECUTE FUNCTION student_registration_complete_stu()`);
    await q.query(`CREATE CONSTRAINT TRIGGER student_registration_complete_guardian_insert
      AFTER INSERT ON guardian DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (is_registration_student(NEW.student_id)) EXECUTE FUNCTION student_registration_complete_guardian()`);
    await q.query(`CREATE CONSTRAINT TRIGGER student_registration_complete_guardian_update
      AFTER UPDATE ON guardian DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (is_registration_student(NEW.student_id) OR is_registration_student(OLD.student_id))
      EXECUTE FUNCTION student_registration_complete_guardian()`);
    await q.query(`CREATE CONSTRAINT TRIGGER student_registration_complete_guardian_delete
      AFTER DELETE ON guardian DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (is_registration_student(OLD.student_id)) EXECUTE FUNCTION student_registration_complete_guardian()`);
    await q.query(`CREATE CONSTRAINT TRIGGER student_registration_complete_period_insert
      AFTER INSERT ON stu_profile_period DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (is_registration_student(NEW.student_id)) EXECUTE FUNCTION student_registration_complete_period()`);
    await q.query(`CREATE CONSTRAINT TRIGGER student_registration_complete_period_update
      AFTER UPDATE ON stu_profile_period DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (is_registration_student(NEW.student_id) OR is_registration_student(OLD.student_id))
      EXECUTE FUNCTION student_registration_complete_period()`);
    await q.query(`CREATE CONSTRAINT TRIGGER student_registration_complete_period_delete
      AFTER DELETE ON stu_profile_period DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (is_registration_student(OLD.student_id)) EXECUTE FUNCTION student_registration_complete_period()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`LOCK TABLE stu, guardian, guardian_contact, stu_staff, stu_sibling, stu_status_event IN ACCESS EXCLUSIVE MODE`);
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM stu WHERE registration_contract_version = 1)
        OR EXISTS (SELECT 1 FROM stu_staff) OR EXISTS (SELECT 1 FROM stu_sibling)
        OR EXISTS (SELECT 1 FROM guardian WHERE name IS NULL OR (email IS NULL AND phone IS NULL)
          OR relation_code IS NOT NULL OR residence_country_code IS NOT NULL OR is_payer)
        OR EXISTS (SELECT 1 FROM stu_status_event WHERE action='create') THEN
        RAISE EXCEPTION 'StudentRegistrationWriter down would discard registration data; roll forward instead';
      END IF;
    END $$`);
    await q.query(`DROP TRIGGER student_registration_complete_period_delete ON stu_profile_period`);
    await q.query(`DROP TRIGGER student_registration_complete_period_update ON stu_profile_period`);
    await q.query(`DROP TRIGGER student_registration_complete_period_insert ON stu_profile_period`);
    await q.query(`DROP TRIGGER student_registration_complete_guardian_delete ON guardian`);
    await q.query(`DROP TRIGGER student_registration_complete_guardian_update ON guardian`);
    await q.query(`DROP TRIGGER student_registration_complete_guardian_insert ON guardian`);
    await q.query(`DROP TRIGGER student_registration_complete_stu ON stu`);
    await q.query(`DROP FUNCTION student_registration_complete_period()`);
    await q.query(`DROP FUNCTION student_registration_complete_guardian()`);
    await q.query(`DROP FUNCTION student_registration_complete_stu()`);
    await q.query(`DROP FUNCTION assert_student_registration_complete(bigint)`);
    await q.query(`DROP TRIGGER guardian_contact_complete_contact_delete ON guardian_contact`);
    await q.query(`DROP TRIGGER guardian_contact_complete_contact_update ON guardian_contact`);
    await q.query(`DROP TRIGGER guardian_contact_complete_contact_insert ON guardian_contact`);
    await q.query(`DROP TRIGGER guardian_contact_complete_guardian_delete ON guardian`);
    await q.query(`DROP TRIGGER guardian_contact_complete_guardian_update ON guardian`);
    await q.query(`DROP TRIGGER guardian_contact_complete_guardian_insert ON guardian`);
    await q.query(`DROP FUNCTION guardian_contact_complete_contact()`);
    await q.query(`DROP FUNCTION guardian_contact_complete_guardian()`);
    await q.query(`DROP FUNCTION assert_guardian_contact_complete(bigint)`);
    await q.query(`DROP FUNCTION is_registration_guardian(bigint)`);
    await q.query(`DROP FUNCTION is_registration_student(bigint)`);
    await q.query(`ALTER TABLE stu_status_event DROP CONSTRAINT stu_status_event_action`);
    await q.query(`ALTER TABLE stu_status_event DROP CONSTRAINT stu_status_event_request_shape`);
    await q.query(`ALTER TABLE stu_status_event ADD CONSTRAINT stu_status_event_action CHECK (action IN ('withdraw','reactivate'))`);
    await q.query(`ALTER TABLE stu_status_event ADD CONSTRAINT stu_status_event_request_shape CHECK (
      (action = 'withdraw' AND to_status = 'withdrawn' AND consultation_id IS NULL AND request_key IS NULL
        AND request_fingerprint IS NULL AND profile_version_before IS NULL AND profile_version_after IS NULL)
      OR (action = 'reactivate' AND from_status = 'withdrawn' AND to_status = 'active'
        AND consultation_id IS NOT NULL AND request_key IS NOT NULL AND request_fingerprint IS NOT NULL
        AND octet_length(request_fingerprint) = 32 AND profile_version_before >= 0
        AND profile_version_after = profile_version_before + 1)
    )`);
    // down 뒤에는 176620 계약의 두 동작만 남는다. 함수도 원형으로 복구해 CHECK와 실행 규칙이 어긋나지 않게 한다.
    await q.query(`CREATE OR REPLACE FUNCTION stu_status_event_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_previous varchar(16);
      BEGIN
        PERFORM 1 FROM stu WHERE id = NEW.student_id FOR NO KEY UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'student_status_student_missing' USING ERRCODE = '23503'; END IF;
        SELECT e.to_status INTO v_previous FROM stu_status_event e
          WHERE e.student_id = NEW.student_id ORDER BY e.id DESC LIMIT 1;
        IF NEW.from_status IS DISTINCT FROM v_previous THEN
          RAISE EXCEPTION 'student_status_stale_transition' USING ERRCODE = '40001';
        END IF;
        IF NEW.action = 'withdraw' AND (v_previous = 'withdrawn' OR NEW.to_status <> 'withdrawn') THEN
          RAISE EXCEPTION 'student_status_invalid_withdraw' USING ERRCODE = '23514';
        END IF;
        IF NEW.action = 'reactivate' AND (v_previous IS DISTINCT FROM 'withdrawn' OR NEW.to_status <> 'active') THEN
          RAISE EXCEPTION 'student_status_invalid_reactivate' USING ERRCODE = '23514';
        END IF;
        NEW.created_at := clock_timestamp();
        NEW.write_txid := txid_current();
        RETURN NEW;
      END $$`);
    await q.query(`DROP TABLE stu_sibling`);
    await q.query(`DROP TABLE stu_staff`);
    await q.query(`DROP INDEX guardian_contact_active_identity`);
    await q.query(`ALTER TABLE guardian DROP CONSTRAINT guardian_relation_other`);
    await q.query(`ALTER TABLE guardian DROP CONSTRAINT guardian_relation_code`);
    await q.query(`ALTER TABLE guardian DROP CONSTRAINT guardian_name_present`);
    await q.query(`ALTER TABLE guardian DROP COLUMN is_payer, DROP COLUMN residence_country_code,
      DROP COLUMN relation_other, DROP COLUMN relation_code`);
    await q.query(`ALTER TABLE guardian ALTER COLUMN name SET NOT NULL`);
    await q.query(`ALTER TABLE guardian ADD CONSTRAINT guardian_name_present CHECK (length(btrim(name)) > 0)`);
    await q.query(`ALTER TABLE guardian ADD CONSTRAINT guardian_contact_present CHECK (email IS NOT NULL OR phone IS NOT NULL)`);
    await q.query(`DROP INDEX stu_registration_request_once`);
    await q.query(`ALTER TABLE stu DROP CONSTRAINT stu_registration_contract`);
    await q.query(`ALTER TABLE stu DROP CONSTRAINT stu_cash_receipt_pair`);
    await q.query(`ALTER TABLE stu DROP COLUMN registration_request_key, DROP COLUMN registration_contract_version,
      DROP COLUMN created_by, DROP COLUMN cash_receipt_key_version, DROP COLUMN cash_receipt_encrypted`);
  }
}
