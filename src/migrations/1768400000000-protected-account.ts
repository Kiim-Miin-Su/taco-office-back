/** @file-guide
 * 목적: BOC-11D-01 학생 환불·강사 지급 계좌의 암호화 current/request/event와 지급 snapshot 연결을 추가한다.
 * 책임/재사용: 평문은 저장하지 않고 version·멱등·감사·직접쓰기 방어와 payout 계좌 snapshot만 소유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11D1-PROTECTED-ACCOUNT-2026-10-09.md
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ProtectedAccount1768400000000 implements MigrationInterface {
  name = 'ProtectedAccount1768400000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE protected_account (
      id bigserial PRIMARY KEY,
      purpose varchar(24) NOT NULL CHECK (purpose IN ('student_refund','teacher_payout')),
      target_id bigint NOT NULL,
      state varchar(12) NOT NULL CHECK (state IN ('active','deleted')),
      row_version integer NOT NULL CHECK (row_version>=1),
      ciphertext bytea,
      key_version varchar(32),
      last4 char(4),
      created_by bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_by bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_by bigint REFERENCES staff(id) ON DELETE RESTRICT,
      deleted_at timestamptz,
      delete_reason varchar(200),
      CONSTRAINT protected_account_subject_unique UNIQUE(purpose,target_id),
      CONSTRAINT protected_account_secret_shape CHECK (
        (state='active' AND ciphertext IS NOT NULL AND octet_length(ciphertext)>28
          AND key_version IS NOT NULL AND length(btrim(key_version))>0 AND last4 ~ '^[0-9]{4}$'
          AND deleted_by IS NULL AND deleted_at IS NULL AND delete_reason IS NULL)
        OR (state='deleted' AND ciphertext IS NULL AND key_version IS NULL AND last4 IS NULL
          AND deleted_by IS NOT NULL AND deleted_at IS NOT NULL
          AND delete_reason IS NOT NULL AND length(btrim(delete_reason)) BETWEEN 2 AND 200)
      )
    )`);
    await q.query(`CREATE INDEX protected_account_state_idx ON protected_account(state,purpose,target_id)`);

    await q.query(`CREATE TABLE protected_account_request (
      request_key uuid PRIMARY KEY,
      account_id bigint NOT NULL REFERENCES protected_account(id) ON DELETE RESTRICT,
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      action varchar(12) NOT NULL CHECK (action IN ('created','updated','deleted','revealed')),
      purpose varchar(24) NOT NULL CHECK (purpose IN ('student_refund','teacher_payout')),
      target_id bigint NOT NULL,
      expected_version integer NOT NULL CHECK (expected_version>=0),
      payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
      result_version integer NOT NULL CHECK (result_version>=1),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX protected_account_request_subject_idx
      ON protected_account_request(purpose,target_id,created_at)`);

    await q.query(`CREATE TABLE protected_account_event (
      id bigserial PRIMARY KEY,
      account_id bigint NOT NULL REFERENCES protected_account(id) ON DELETE RESTRICT,
      action varchar(12) NOT NULL CHECK (action IN ('created','updated','deleted','revealed')),
      from_state varchar(12) CHECK (from_state IN ('active','deleted')),
      to_state varchar(12) NOT NULL CHECK (to_state IN ('active','deleted')),
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      request_key uuid NOT NULL UNIQUE REFERENCES protected_account_request(request_key) ON DELETE RESTRICT,
      result_version integer NOT NULL CHECK (result_version>=1),
      reason varchar(200),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT protected_account_event_shape CHECK (
        (action='created' AND to_state='active' AND from_state IS NULL)
        OR (action='updated' AND to_state='active' AND from_state IN ('active','deleted'))
        OR (action='deleted' AND from_state='active' AND to_state='deleted'
          AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 2 AND 200)
        OR (action='revealed' AND from_state='active' AND to_state='active'
          AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 2 AND 200)
      )
    )`);
    await q.query(`CREATE UNIQUE INDEX protected_account_state_event_version_unique
      ON protected_account_event(account_id,result_version)
      WHERE action IN ('created','updated','deleted')`);
    await q.query(`CREATE INDEX protected_account_event_account_idx
      ON protected_account_event(account_id,created_at,id)`);

    await q.query(`CREATE FUNCTION protected_account_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='protected account audit is immutable'; END $$`);
    await q.query(`CREATE TRIGGER protected_account_request_immutable BEFORE UPDATE OR DELETE ON protected_account_request
      FOR EACH ROW EXECUTE FUNCTION protected_account_immutable_guard()`);
    await q.query(`CREATE TRIGGER protected_account_event_immutable BEFORE UPDATE OR DELETE ON protected_account_event
      FOR EACH ROW EXECUTE FUNCTION protected_account_immutable_guard()`);

    await q.query(`CREATE FUNCTION protected_account_target_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.purpose='student_refund' AND NOT EXISTS (SELECT 1 FROM stu WHERE id=NEW.target_id)
        THEN RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='PROTECTED_ACCOUNT_STUDENT_NOT_FOUND'; END IF;
        IF NEW.purpose='teacher_payout' AND NOT EXISTS (
          SELECT 1 FROM staff s WHERE s.id=NEW.target_id AND s.active
            AND (s.role='teacher' OR EXISTS(SELECT 1 FROM ser se WHERE se.teacher_id=s.id))
        )
        THEN RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='PROTECTED_ACCOUNT_STAFF_NOT_FOUND'; END IF;
        RETURN NULL;
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER protected_account_target
      AFTER INSERT OR UPDATE OF purpose,target_id ON protected_account DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION protected_account_target_guard()`);

    await q.query(`CREATE FUNCTION protected_account_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.purpose,NEW.target_id,NEW.created_by,NEW.created_at)
             IS DISTINCT FROM ROW(OLD.purpose,OLD.target_id,OLD.created_by,OLD.created_at)
        THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PROTECTED_ACCOUNT_IDENTITY_IMMUTABLE'; END IF;
        IF NEW.row_version<>OLD.row_version+1
        THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PROTECTED_ACCOUNT_VERSION_STEP'; END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER protected_account_row_write BEFORE UPDATE ON protected_account
      FOR EACH ROW EXECUTE FUNCTION protected_account_row_guard()`);

    await q.query(`CREATE FUNCTION protected_account_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM protected_account_event e
           WHERE e.account_id=NEW.id AND e.result_version=NEW.row_version AND e.to_state=NEW.state
             AND e.action IN ('created','updated','deleted')
        ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PROTECTED_ACCOUNT_RECEIPT_MISSING'; END IF;
        RETURN NULL;
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER protected_account_receipt
      AFTER INSERT OR UPDATE ON protected_account DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION protected_account_receipt_guard()`);

    await q.query(`CREATE FUNCTION protected_account_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='protected account current rows are preserved'; END $$`);
    await q.query(`CREATE TRIGGER protected_account_no_delete BEFORE DELETE ON protected_account
      FOR EACH ROW EXECUTE FUNCTION protected_account_delete_guard()`);

    await q.query(`ALTER TABLE payout_disbursement
      ADD COLUMN account_id bigint REFERENCES protected_account(id) ON DELETE RESTRICT,
      ADD COLUMN account_version integer,
      ADD COLUMN account_last4 char(4),
      ADD CONSTRAINT payout_disbursement_account_snapshot CHECK (
        (account_id IS NULL AND account_version IS NULL AND account_last4 IS NULL)
        OR (account_id IS NOT NULL AND account_version>=1 AND account_last4 ~ '^[0-9]{4}$')
      )`);
    await q.query(`ALTER TABLE payout_disbursement_event
      ADD COLUMN account_id bigint REFERENCES protected_account(id) ON DELETE RESTRICT,
      ADD COLUMN account_version integer,
      ADD COLUMN account_last4 char(4),
      ADD CONSTRAINT payout_disbursement_event_account_snapshot CHECK (
        (account_id IS NULL AND account_version IS NULL AND account_last4 IS NULL)
        OR (account_id IS NOT NULL AND account_version>=1 AND account_last4 ~ '^[0-9]{4}$')
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE payout_disbursement_event DROP CONSTRAINT payout_disbursement_event_account_snapshot,
      DROP COLUMN account_last4,DROP COLUMN account_version,DROP COLUMN account_id`);
    await q.query(`ALTER TABLE payout_disbursement DROP CONSTRAINT payout_disbursement_account_snapshot,
      DROP COLUMN account_last4,DROP COLUMN account_version,DROP COLUMN account_id`);
    await q.query(`DROP TRIGGER IF EXISTS protected_account_no_delete ON protected_account`);
    await q.query(`DROP TRIGGER IF EXISTS protected_account_receipt ON protected_account`);
    await q.query(`DROP TRIGGER IF EXISTS protected_account_row_write ON protected_account`);
    await q.query(`DROP TRIGGER IF EXISTS protected_account_target ON protected_account`);
    await q.query(`DROP FUNCTION IF EXISTS protected_account_delete_guard()`);
    await q.query(`DROP FUNCTION IF EXISTS protected_account_receipt_guard()`);
    await q.query(`DROP FUNCTION IF EXISTS protected_account_row_guard()`);
    await q.query(`DROP FUNCTION IF EXISTS protected_account_target_guard()`);
    await q.query(`DROP TRIGGER IF EXISTS protected_account_event_immutable ON protected_account_event`);
    await q.query(`DROP TRIGGER IF EXISTS protected_account_request_immutable ON protected_account_request`);
    await q.query(`DROP FUNCTION IF EXISTS protected_account_immutable_guard()`);
    await q.query(`DROP TABLE protected_account_event`);
    await q.query(`DROP TABLE protected_account_request`);
    await q.query(`DROP TABLE protected_account`);
  }
}
