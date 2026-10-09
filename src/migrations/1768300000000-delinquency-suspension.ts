/** @file-guide
 * 목적: BOC-11C 연체 후보 정책과 수강 정지 current/event 원장, schedule 직접쓰기 방어를 추가한다.
 * 책임/재사용: 과거 INV/PAY/일정은 바꾸지 않고 forward schema와 지연 정합성만 소유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11C-DELINQUENCY-SUSPENSION-2026-10-09.md
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DelinquencySuspension1768300000000 implements MigrationInterface {
  name = 'DelinquencySuspension1768300000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE delinquency_policy (
      id smallint PRIMARY KEY CHECK (id=1),
      threshold_days integer NOT NULL CHECK (threshold_days BETWEEN 1 AND 365),
      row_version integer NOT NULL CHECK (row_version>=1),
      updated_by bigint REFERENCES staff(id) ON DELETE RESTRICT,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`INSERT INTO delinquency_policy(id,threshold_days,row_version) VALUES(1,14,1)`);

    await q.query(`CREATE TABLE delinquency_policy_event (
      id bigserial PRIMARY KEY,
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      request_key uuid NOT NULL UNIQUE,
      payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
      threshold_before integer NOT NULL CHECK (threshold_before BETWEEN 1 AND 365),
      threshold_after integer NOT NULL CHECK (threshold_after BETWEEN 1 AND 365),
      result_version integer NOT NULL UNIQUE CHECK (result_version>=2),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);

    await q.query(`CREATE TABLE delinquency_suspension (
      student_id bigint PRIMARY KEY REFERENCES stu(id) ON DELETE RESTRICT,
      state varchar(12) NOT NULL CHECK (state IN ('suspended','released')),
      row_version integer NOT NULL CHECK (row_version>=1),
      threshold_snapshot integer NOT NULL CHECK (threshold_snapshot BETWEEN 1 AND 365),
      overdue_days_snapshot integer NOT NULL CHECK (overdue_days_snapshot>=0),
      outstanding_snapshot bigint NOT NULL CHECK (outstanding_snapshot>=0),
      suspended_by bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      suspended_at timestamptz NOT NULL,
      suspend_reason varchar(200) NOT NULL CHECK (length(btrim(suspend_reason))>=2),
      released_by bigint REFERENCES staff(id) ON DELETE RESTRICT,
      released_at timestamptz,
      release_reason varchar(200),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT delinquency_release_shape CHECK (
        (state='suspended' AND released_by IS NULL AND released_at IS NULL AND release_reason IS NULL)
        OR (state='released' AND released_by IS NOT NULL AND released_at IS NOT NULL
            AND release_reason IS NOT NULL AND length(btrim(release_reason))>=2)
      )
    )`);
    await q.query(`CREATE INDEX delinquency_suspension_state_idx ON delinquency_suspension(state,student_id)`);

    await q.query(`CREATE TABLE delinquency_suspension_event (
      id bigserial PRIMARY KEY,
      student_id bigint NOT NULL REFERENCES stu(id) ON DELETE RESTRICT,
      action varchar(12) NOT NULL CHECK (action IN ('reminded','suspended','released')),
      from_state varchar(12) CHECK (from_state IN ('candidate','suspended','released')),
      to_state varchar(12) CHECK (to_state IN ('candidate','suspended','released')),
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      request_key uuid NOT NULL UNIQUE,
      payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
      result_version integer NOT NULL CHECK (result_version>=0),
      overdue_days integer NOT NULL CHECK (overdue_days>=0),
      outstanding bigint NOT NULL CHECK (outstanding>=0),
      affected_series_count integer NOT NULL CHECK (affected_series_count>=0),
      reason varchar(200),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT delinquency_event_shape CHECK (
        (action='reminded' AND from_state=to_state)
        OR (action='suspended' AND to_state='suspended' AND result_version>=1)
        OR (action='released' AND from_state='suspended' AND to_state='released' AND result_version>=2)
      )
    )`);
    await q.query(`CREATE UNIQUE INDEX delinquency_state_event_version_unique
      ON delinquency_suspension_event(student_id,result_version)
      WHERE action IN ('suspended','released')`);
    await q.query(`CREATE INDEX delinquency_event_student_idx
      ON delinquency_suspension_event(student_id,created_at,id)`);

    await q.query(`CREATE FUNCTION delinquency_immutable_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='delinquency event is immutable'; END $$`);
    await q.query(`CREATE TRIGGER delinquency_policy_event_immutable BEFORE UPDATE OR DELETE ON delinquency_policy_event
      FOR EACH ROW EXECUTE FUNCTION delinquency_immutable_event_guard()`);
    await q.query(`CREATE TRIGGER delinquency_suspension_event_immutable BEFORE UPDATE OR DELETE ON delinquency_suspension_event
      FOR EACH ROW EXECUTE FUNCTION delinquency_immutable_event_guard()`);

    await q.query(`CREATE FUNCTION delinquency_policy_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.row_version>1 AND NOT EXISTS (
          SELECT 1 FROM delinquency_policy_event e
           WHERE e.result_version=NEW.row_version AND e.threshold_after=NEW.threshold_days
        ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='DELINQUENCY_POLICY_RECEIPT_MISSING'; END IF;
        RETURN NULL;
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER delinquency_policy_receipt
      AFTER INSERT OR UPDATE ON delinquency_policy DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION delinquency_policy_receipt_guard()`);

    await q.query(`CREATE FUNCTION delinquency_current_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM delinquency_suspension_event e
           WHERE e.student_id=NEW.student_id AND e.result_version=NEW.row_version AND e.to_state=NEW.state
             AND e.action IN ('suspended','released')
        ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='DELINQUENCY_CURRENT_RECEIPT_MISSING'; END IF;
        RETURN NULL;
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER delinquency_current_receipt
      AFTER INSERT OR UPDATE ON delinquency_suspension DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION delinquency_current_receipt_guard()`);

    await q.query(`CREATE FUNCTION delinquency_current_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='delinquency current rows are preserved'; END $$`);
    await q.query(`CREATE TRIGGER delinquency_current_no_delete BEFORE DELETE ON delinquency_suspension
      FOR EACH ROW EXECUTE FUNCTION delinquency_current_delete_guard()`);

    await q.query(`CREATE FUNCTION delinquency_ser_stu_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE expanded boolean;
      BEGIN
        expanded := TG_OP='INSERT'
          OR NEW.student_id IS DISTINCT FROM OLD.student_id
          OR COALESCE(NEW.from_date,'0001-01-01'::date) < COALESCE(OLD.from_date,'0001-01-01'::date)
          OR COALESCE(NEW.to_date,'9999-12-31'::date) > COALESCE(OLD.to_date,'9999-12-31'::date);
        IF expanded AND EXISTS (SELECT 1 FROM delinquency_suspension d WHERE d.student_id=NEW.student_id AND d.state='suspended')
        THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='DELINQUENCY_SCHEDULE_BLOCKED'; END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER delinquency_ser_stu_write BEFORE INSERT OR UPDATE ON ser_stu
      FOR EACH ROW EXECUTE FUNCTION delinquency_ser_stu_guard()`);

    await q.query(`CREATE FUNCTION delinquency_ser_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.start_min,NEW.end_min,NEW.rrule,NEW.from_date,NEW.to_date)
             IS DISTINCT FROM ROW(OLD.start_min,OLD.end_min,OLD.rrule,OLD.from_date,OLD.to_date)
           AND NOT (ROW(NEW.start_min,NEW.end_min,NEW.rrule,NEW.from_date)
             IS NOT DISTINCT FROM ROW(OLD.start_min,OLD.end_min,OLD.rrule,OLD.from_date)
             AND COALESCE(NEW.to_date,'9999-12-31'::date)<COALESCE(OLD.to_date,'9999-12-31'::date))
           AND EXISTS (SELECT 1 FROM ser_stu ss JOIN delinquency_suspension d ON d.student_id=ss.student_id
                        WHERE ss.ser_id=NEW.id AND d.state='suspended')
        THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='DELINQUENCY_SCHEDULE_BLOCKED'; END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER delinquency_ser_write BEFORE UPDATE ON ser
      FOR EACH ROW EXECUTE FUNCTION delinquency_ser_guard()`);

    await q.query(`CREATE FUNCTION delinquency_exc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.canceled=false
           AND (TG_OP='INSERT' OR OLD.canceled=true
             OR ROW(NEW.new_date,NEW.start_min,NEW.end_min)
                IS DISTINCT FROM ROW(OLD.new_date,OLD.start_min,OLD.end_min))
           AND EXISTS (
             SELECT 1 FROM ser_stu ss JOIN delinquency_suspension d ON d.student_id=ss.student_id
              WHERE ss.ser_id=NEW.ser_id AND d.state='suspended'
           )
        THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='DELINQUENCY_SCHEDULE_BLOCKED'; END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER delinquency_exc_write BEFORE INSERT OR UPDATE ON exc
      FOR EACH ROW EXECUTE FUNCTION delinquency_exc_guard()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS delinquency_exc_write ON exc`);
    await q.query(`DROP TRIGGER IF EXISTS delinquency_ser_write ON ser`);
    await q.query(`DROP TRIGGER IF EXISTS delinquency_ser_stu_write ON ser_stu`);
    await q.query(`DROP FUNCTION IF EXISTS delinquency_exc_guard()`);
    await q.query(`DROP FUNCTION IF EXISTS delinquency_ser_guard()`);
    await q.query(`DROP FUNCTION IF EXISTS delinquency_ser_stu_guard()`);
    await q.query(`DROP TRIGGER IF EXISTS delinquency_current_no_delete ON delinquency_suspension`);
    await q.query(`DROP TRIGGER IF EXISTS delinquency_current_receipt ON delinquency_suspension`);
    await q.query(`DROP TRIGGER IF EXISTS delinquency_policy_receipt ON delinquency_policy`);
    await q.query(`DROP FUNCTION IF EXISTS delinquency_current_delete_guard()`);
    await q.query(`DROP FUNCTION IF EXISTS delinquency_current_receipt_guard()`);
    await q.query(`DROP FUNCTION IF EXISTS delinquency_policy_receipt_guard()`);
    await q.query(`DROP TRIGGER IF EXISTS delinquency_suspension_event_immutable ON delinquency_suspension_event`);
    await q.query(`DROP TRIGGER IF EXISTS delinquency_policy_event_immutable ON delinquency_policy_event`);
    await q.query(`DROP FUNCTION IF EXISTS delinquency_immutable_event_guard()`);
    await q.query(`DROP TABLE delinquency_suspension_event`);
    await q.query(`DROP TABLE delinquency_suspension`);
    await q.query(`DROP TABLE delinquency_policy_event`);
    await q.query(`DROP TABLE delinquency_policy`);
  }
}
