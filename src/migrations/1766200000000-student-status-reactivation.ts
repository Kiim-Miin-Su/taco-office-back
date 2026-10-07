/** @file-guide
 * 목적: BOC-03D-03b 학생 권위 상태·재활성화 상담/감사 원장의 additive DB 계약.
 * 책임/재사용: active/withdrawn 상태를 append-only event로 소유하고 재활성화 transaction의 상담·profile audit 완결성을 DB에서 방어한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-03D3A-STUDENT-REACTIVATION-POLICY-2026-10-07.md · docs/contracts/db/student-registration-target.dbml
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class StudentStatusReactivation1766200000000 implements MigrationInterface {
  name = 'StudentStatusReactivation1766200000000';

  public async up(q: QueryRunner): Promise<void> {
    /*
     * BOC-03D-03b 권고안 채택(2026-10-07): 기존 수강·휴원·LOG를 상태로 추정하지 않는다.
     * 기존 학생은 event가 생기기 전까지 unknown이며, 전체 수강 종료와 신규 등록/재활성화 writer만
     * 이후의 명시 상태를 적는다. 정책 변경 시 P-REACT·BOC-03·DTO/OpenAPI·writer를 함께 바꾼다.
     */
    await q.query(`CREATE TABLE stu_reactivation_consultation (
      id bigserial PRIMARY KEY,
      student_id bigint NOT NULL REFERENCES stu(id),
      entry_source varchar(16) NOT NULL,
      lead_id bigint REFERENCES lead(id),
      reactivate_on date NOT NULL,
      channel varchar(16) NOT NULL,
      content text NOT NULL,
      next_on date,
      created_by bigint NOT NULL REFERENCES staff(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      request_key uuid NOT NULL,
      request_fingerprint bytea NOT NULL,
      profile_version_before bigint NOT NULL,
      profile_version_after bigint NOT NULL,
      CONSTRAINT stu_reactivation_consultation_request_once UNIQUE (created_by, request_key),
      CONSTRAINT stu_reactivation_consultation_entry CHECK (
        (entry_source = 'students' AND lead_id IS NULL)
        OR (entry_source = 'intake' AND lead_id IS NOT NULL)
      ),
      CONSTRAINT stu_reactivation_consultation_channel CHECK (channel IN ('visit','phone','kakao','other')),
      CONSTRAINT stu_reactivation_consultation_content CHECK (length(btrim(content)) BETWEEN 1 AND 2000),
      CONSTRAINT stu_reactivation_consultation_dates CHECK (
        reactivate_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
        AND (next_on IS NULL OR next_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
      ),
      CONSTRAINT stu_reactivation_consultation_fingerprint CHECK (octet_length(request_fingerprint) = 32),
      CONSTRAINT stu_reactivation_consultation_version CHECK (
        profile_version_before >= 0 AND profile_version_after = profile_version_before + 1
      )
    )`);
    await q.query(`CREATE INDEX stu_reactivation_consultation_timeline
      ON stu_reactivation_consultation(student_id, created_at DESC, id DESC)`);
    await q.query(`CREATE FUNCTION stu_reactivation_consultation_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.created_at := clock_timestamp(); RETURN NEW; END $$`);
    await q.query(`CREATE TRIGGER stu_reactivation_consultation_insert BEFORE INSERT ON stu_reactivation_consultation
      FOR EACH ROW EXECUTE FUNCTION stu_reactivation_consultation_before_insert()`);

    await q.query(`CREATE TABLE stu_status_event (
      id bigserial PRIMARY KEY,
      student_id bigint NOT NULL REFERENCES stu(id),
      action varchar(16) NOT NULL,
      from_status varchar(16),
      to_status varchar(16) NOT NULL,
      effective_on date NOT NULL,
      reason text,
      actor_id bigint NOT NULL REFERENCES staff(id),
      consultation_id bigint UNIQUE REFERENCES stu_reactivation_consultation(id),
      request_key uuid,
      request_fingerprint bytea,
      profile_version_before bigint,
      profile_version_after bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      write_txid bigint NOT NULL DEFAULT txid_current(),
      CONSTRAINT stu_status_event_status CHECK (
        (from_status IS NULL OR from_status IN ('active','withdrawn'))
        AND to_status IN ('active','withdrawn')
      ),
      CONSTRAINT stu_status_event_action CHECK (action IN ('withdraw','reactivate')),
      CONSTRAINT stu_status_event_reason CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000),
      CONSTRAINT stu_status_event_request_shape CHECK (
        (action = 'withdraw' AND to_status = 'withdrawn'
          AND consultation_id IS NULL AND request_key IS NULL AND request_fingerprint IS NULL
          AND profile_version_before IS NULL AND profile_version_after IS NULL)
        OR
        (action = 'reactivate' AND from_status = 'withdrawn' AND to_status = 'active'
          AND consultation_id IS NOT NULL AND request_key IS NOT NULL AND request_fingerprint IS NOT NULL
          AND octet_length(request_fingerprint) = 32
          AND profile_version_before >= 0 AND profile_version_after = profile_version_before + 1)
      )
    )`);
    await q.query(`CREATE INDEX stu_status_event_timeline
      ON stu_status_event(student_id, id DESC)`);
    await q.query(`CREATE UNIQUE INDEX stu_status_event_request_once
      ON stu_status_event(actor_id, request_key) WHERE request_key IS NOT NULL`);

    await q.query(`CREATE FUNCTION stu_status_event_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
    await q.query(`CREATE TRIGGER stu_status_event_insert BEFORE INSERT ON stu_status_event
      FOR EACH ROW EXECUTE FUNCTION stu_status_event_before_insert()`);

    await q.query(`CREATE FUNCTION stu_status_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'student_status_event_immutable' USING ERRCODE = '23514'; END $$`);
    await q.query(`CREATE TRIGGER stu_status_event_no_change BEFORE UPDATE OR DELETE ON stu_status_event
      FOR EACH ROW EXECUTE FUNCTION stu_status_event_immutable()`);
    await q.query(`CREATE FUNCTION stu_reactivation_consultation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'student_reactivation_consultation_immutable' USING ERRCODE = '23514'; END $$`);
    await q.query(`CREATE TRIGGER stu_reactivation_consultation_no_change
      BEFORE UPDATE OR DELETE ON stu_reactivation_consultation
      FOR EACH ROW EXECUTE FUNCTION stu_reactivation_consultation_immutable()`);

    await q.query(`ALTER TABLE stu_profile_audit DROP CONSTRAINT stu_profile_audit_action`);
    await q.query(`ALTER TABLE stu_profile_audit ADD CONSTRAINT stu_profile_audit_action CHECK (action IN
      ('create','static_patch','period_append','period_correct','period_split','contact_change',
       'guardian_change','staff_change','sibling_change','reactivate'))`);

    await q.query(`CREATE FUNCTION stu_reactivation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM stu_status_event e
          WHERE e.consultation_id = NEW.id AND e.student_id = NEW.student_id
            AND e.action = 'reactivate' AND e.actor_id = NEW.created_by
            AND e.request_key = NEW.request_key AND e.request_fingerprint = NEW.request_fingerprint
            AND e.profile_version_before = NEW.profile_version_before
            AND e.profile_version_after = NEW.profile_version_after
            AND e.effective_on = NEW.reactivate_on AND e.write_txid = txid_current()
        ) OR NOT EXISTS (
          SELECT 1 FROM stu_profile_audit a
          WHERE a.student_id = NEW.student_id AND a.action = 'reactivate'
            AND a.recorded_by = NEW.created_by AND a.request_key = NEW.request_key
            AND a.request_fingerprint = NEW.request_fingerprint
            AND a.version_before = NEW.profile_version_before
            AND a.version_after = NEW.profile_version_after AND a.write_txid = txid_current()
        ) THEN
          RAISE EXCEPTION 'student_reactivation_transaction_incomplete' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER stu_reactivation_complete
      AFTER INSERT ON stu_reactivation_consultation DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION stu_reactivation_complete()`);

    await q.query(`CREATE VIEW student_status_current WITH (security_invoker = true) AS
      SELECT DISTINCT ON (student_id)
        student_id, to_status AS status, effective_on, actor_id, created_at, id AS event_id
      FROM stu_status_event ORDER BY student_id, id DESC`);

    /*
     * BOC-03D-03b 권고안 채택(2026-10-07): 재활성화 전 명단 복귀 우회를 DB에서도 막는다.
     * 휴원일에 끝나는 과거 명단은 보존/복구할 수 있지만 그 뒤에 참여하는 INSERT·기간 연장은
     * 반드시 active 상태 event를 먼저 만든 뒤 수행해야 한다.
     */
    await q.query(`CREATE FUNCTION ser_stu_require_reactivated() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_status varchar(16); v_effective_on date;
      BEGIN
        -- status transition과 명단 쓰기가 같은 STU 잠금에서 직렬화되어 동시 요청도 우회하지 못한다.
        PERFORM 1 FROM stu WHERE id = NEW.student_id FOR NO KEY UPDATE;
        SELECT e.to_status, e.effective_on INTO v_status, v_effective_on
          FROM stu_status_event e WHERE e.student_id = NEW.student_id ORDER BY e.id DESC LIMIT 1;
        IF v_status = 'withdrawn' AND COALESCE(NEW.to_date, DATE '9999-12-31') > v_effective_on THEN
          RAISE EXCEPTION 'student_reactivation_required' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER ser_stu_require_reactivated
      BEFORE INSERT OR UPDATE OF student_id, from_date, to_date ON ser_stu
      FOR EACH ROW EXECUTE FUNCTION ser_stu_require_reactivated()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`LOCK TABLE stu_status_event, stu_reactivation_consultation, stu_profile_audit IN ACCESS EXCLUSIVE MODE`);
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM stu_status_event)
        OR EXISTS (SELECT 1 FROM stu_reactivation_consultation)
        OR EXISTS (SELECT 1 FROM stu_profile_audit WHERE action = 'reactivate') THEN
        RAISE EXCEPTION 'StudentStatusReactivation down would discard student history; roll forward instead';
      END IF;
    END $$`);
    await q.query(`DROP TRIGGER ser_stu_require_reactivated ON ser_stu`);
    await q.query(`DROP FUNCTION ser_stu_require_reactivated()`);
    await q.query(`DROP VIEW student_status_current`);
    await q.query(`DROP TABLE stu_status_event`);
    await q.query(`DROP TABLE stu_reactivation_consultation`);
    await q.query(`DROP FUNCTION stu_reactivation_complete()`);
    await q.query(`DROP FUNCTION stu_reactivation_consultation_immutable()`);
    await q.query(`DROP FUNCTION stu_reactivation_consultation_before_insert()`);
    await q.query(`DROP FUNCTION stu_status_event_immutable()`);
    await q.query(`DROP FUNCTION stu_status_event_before_insert()`);
    await q.query(`ALTER TABLE stu_profile_audit DROP CONSTRAINT stu_profile_audit_action`);
    await q.query(`ALTER TABLE stu_profile_audit ADD CONSTRAINT stu_profile_audit_action CHECK (action IN
      ('create','static_patch','period_append','period_correct','period_split','contact_change',
       'guardian_change','staff_change','sibling_change'))`);
  }
}
