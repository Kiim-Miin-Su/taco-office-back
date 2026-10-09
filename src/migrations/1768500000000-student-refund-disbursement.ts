/** @file-guide
 * 목적: BOC-11D-02 승인 청구 조정의 환불 예정 증가분을 실제 지급·취소·재지급 원장으로 추가한다.
 * 책임/재사용: source/account snapshot, current/request/event 불변 이력과 지급 뒤 조정 취소 차단을 소유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11D2-STUDENT-REFUND-DISBURSEMENT-2026-10-09.md
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 권고안 채택(2026-10-09): 실제 환불액은 승인 조정의 전후 환불 예정액 증가분이다.
 * 수납 PAY는 그대로 두고 실제 송금 current/request/event를 분리하며, 지급 완료 뒤에는
 * 지급을 먼저 취소하기 전까지 원천 조정의 승인 반영을 되돌리지 못한다.
 */
export class StudentRefundDisbursement1768500000000 implements MigrationInterface {
  name = 'StudentRefundDisbursement1768500000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE student_refund_disbursement (
      id bigserial PRIMARY KEY,
      invoice_adjustment_id bigint NOT NULL UNIQUE REFERENCES invoice_adjustment(id) ON DELETE RESTRICT,
      state varchar(12) NOT NULL CHECK (state IN ('paid','canceled')),
      row_version integer NOT NULL CHECK (row_version>=1),
      amount integer NOT NULL CHECK (amount>0),
      source_adjustment_version integer NOT NULL CHECK (source_adjustment_version>=1),
      paid_on date NOT NULL,
      method varchar(24) NOT NULL CHECK (method='bank_transfer'),
      paid_by bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      paid_at timestamptz NOT NULL,
      account_id bigint NOT NULL REFERENCES protected_account(id) ON DELETE RESTRICT,
      account_version integer NOT NULL CHECK (account_version>=1),
      account_last4 char(4) NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
      canceled_by bigint REFERENCES staff(id) ON DELETE RESTRICT,
      canceled_at timestamptz,
      cancel_reason varchar(200),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT student_refund_disbursement_state_shape CHECK (
        (state='paid' AND canceled_by IS NULL AND canceled_at IS NULL AND cancel_reason IS NULL)
        OR (state='canceled' AND canceled_by IS NOT NULL AND canceled_at IS NOT NULL
          AND length(btrim(cancel_reason)) BETWEEN 2 AND 200)
      )
    )`);
    await q.query(`CREATE INDEX student_refund_disbursement_state_idx
      ON student_refund_disbursement(state,invoice_adjustment_id)`);

    await q.query(`CREATE TABLE student_refund_disbursement_request (
      request_key uuid PRIMARY KEY,
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      action varchar(12) NOT NULL CHECK (action IN ('paid','canceled')),
      invoice_adjustment_id bigint NOT NULL REFERENCES invoice_adjustment(id) ON DELETE RESTRICT,
      expected_version integer NOT NULL CHECK (expected_version>=0),
      payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
      result_version integer NOT NULL CHECK (result_version>=1),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX student_refund_disbursement_request_source_idx
      ON student_refund_disbursement_request(invoice_adjustment_id,created_at)`);

    await q.query(`CREATE TABLE student_refund_disbursement_event (
      id bigserial PRIMARY KEY,
      student_refund_disbursement_id bigint NOT NULL REFERENCES student_refund_disbursement(id) ON DELETE RESTRICT,
      action varchar(12) NOT NULL CHECK (action IN ('paid','canceled')),
      from_state varchar(12) CHECK (from_state IN ('paid','canceled')),
      to_state varchar(12) NOT NULL CHECK (to_state IN ('paid','canceled')),
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      request_key uuid NOT NULL UNIQUE REFERENCES student_refund_disbursement_request(request_key) ON DELETE RESTRICT,
      result_version integer NOT NULL CHECK (result_version>=1),
      amount integer NOT NULL CHECK (amount>0),
      source_adjustment_version integer NOT NULL CHECK (source_adjustment_version>=1),
      paid_on date,
      method varchar(24),
      reason varchar(200),
      account_id bigint NOT NULL REFERENCES protected_account(id) ON DELETE RESTRICT,
      account_version integer NOT NULL CHECK (account_version>=1),
      account_last4 char(4) NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT student_refund_disbursement_event_version_unique
        UNIQUE(student_refund_disbursement_id,result_version),
      CONSTRAINT student_refund_disbursement_event_shape CHECK (
        (action='paid' AND to_state='paid' AND paid_on IS NOT NULL AND method='bank_transfer' AND reason IS NULL)
        OR (action='canceled' AND from_state='paid' AND to_state='canceled'
          AND paid_on IS NULL AND method IS NULL AND length(btrim(reason)) BETWEEN 2 AND 200)
      )
    )`);
    await q.query(`CREATE INDEX student_refund_disbursement_event_current_idx
      ON student_refund_disbursement_event(student_refund_disbursement_id,created_at,id)`);

    await q.query(`CREATE FUNCTION student_refund_disbursement_row_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' THEN
          RAISE EXCEPTION 'student refund current rows are preserved'
            USING ERRCODE='23514', CONSTRAINT='student_refund_disbursement_no_delete';
        END IF;
        IF NEW.invoice_adjustment_id<>OLD.invoice_adjustment_id THEN
          RAISE EXCEPTION 'student refund source identity is immutable'
            USING ERRCODE='23514', CONSTRAINT='student_refund_disbursement_identity_immutable';
        END IF;
        IF NEW.row_version<>OLD.row_version+1 THEN
          RAISE EXCEPTION 'student refund version must advance exactly once'
            USING ERRCODE='23514', CONSTRAINT='student_refund_disbursement_version_step';
        END IF;
        NEW.updated_at := now();
        RETURN NEW;
      END
    $$`);
    await q.query(`CREATE TRIGGER student_refund_disbursement_row_guard
      BEFORE UPDATE OR DELETE ON student_refund_disbursement
      FOR EACH ROW EXECUTE FUNCTION student_refund_disbursement_row_guard_fn()`);

    await q.query(`CREATE FUNCTION student_refund_disbursement_receipt_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM student_refund_disbursement_event e
          WHERE e.student_refund_disbursement_id=NEW.id AND e.result_version=NEW.row_version
            AND e.to_state=NEW.state AND e.amount=NEW.amount
            AND e.source_adjustment_version=NEW.source_adjustment_version
            AND e.account_id=NEW.account_id AND e.account_version=NEW.account_version
            AND e.account_last4=NEW.account_last4
        ) THEN
          RAISE EXCEPTION 'student refund current state must have a matching event receipt'
            USING ERRCODE='23514', CONSTRAINT='student_refund_disbursement_receipt_required';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER student_refund_disbursement_receipt_guard
      AFTER INSERT OR UPDATE ON student_refund_disbursement DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION student_refund_disbursement_receipt_guard_fn()`);

    await q.query(`CREATE FUNCTION student_refund_source_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE expected_amount integer;
      BEGIN
        SELECT GREATEST(0,i.paid_amount-e.invoice_amount_after)-GREATEST(0,i.paid_amount-e.invoice_amount_before)
          INTO expected_amount
          FROM invoice_adjustment a
          JOIN invoice_adjustment_event e ON e.invoice_adjustment_id=a.id
            AND e.result_version=NEW.source_adjustment_version AND e.to_state='approved'
          JOIN inv i ON i.id=a.inv_id
         WHERE a.id=NEW.invoice_adjustment_id AND a.state='approved'
           AND a.row_version=NEW.source_adjustment_version;
        IF expected_amount IS NULL OR expected_amount<=0 OR expected_amount<>NEW.amount THEN
          RAISE EXCEPTION 'student refund source adjustment or amount is invalid'
            USING ERRCODE='23514', CONSTRAINT='student_refund_source_invalid';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM protected_account pa JOIN invoice_adjustment a ON a.student_id=pa.target_id
           WHERE a.id=NEW.invoice_adjustment_id AND pa.id=NEW.account_id
             AND pa.purpose='student_refund'
        ) THEN
          RAISE EXCEPTION 'student refund account target does not match student'
            USING ERRCODE='23514', CONSTRAINT='student_refund_account_target_mismatch';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER student_refund_source_guard
      AFTER INSERT OR UPDATE ON student_refund_disbursement DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION student_refund_source_guard_fn()`);

    await q.query(`CREATE FUNCTION student_refund_audit_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'student refund audit history is immutable'
          USING ERRCODE='23514', CONSTRAINT='student_refund_audit_immutable';
      END
    $$`);
    await q.query(`CREATE TRIGGER student_refund_disbursement_request_immutable
      BEFORE UPDATE OR DELETE ON student_refund_disbursement_request
      FOR EACH ROW EXECUTE FUNCTION student_refund_audit_immutable_fn()`);
    await q.query(`CREATE TRIGGER student_refund_disbursement_event_immutable
      BEFORE UPDATE OR DELETE ON student_refund_disbursement_event
      FOR EACH ROW EXECUTE FUNCTION student_refund_audit_immutable_fn()`);

    await q.query(`CREATE FUNCTION invoice_adjustment_paid_refund_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.state='approved' AND NEW.state<>'approved' AND EXISTS (
          SELECT 1 FROM student_refund_disbursement d
           WHERE d.invoice_adjustment_id=OLD.id AND d.state='paid'
        ) THEN
          RAISE EXCEPTION 'STUDENT_REFUND_CANCEL_REQUIRED'
            USING ERRCODE='23514', CONSTRAINT='invoice_adjustment_paid_refund_guard';
        END IF;
        RETURN NEW;
      END
    $$`);
    await q.query(`CREATE TRIGGER invoice_adjustment_paid_refund_guard
      BEFORE UPDATE OF state ON invoice_adjustment
      FOR EACH ROW EXECUTE FUNCTION invoice_adjustment_paid_refund_guard_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM student_refund_disbursement_event LIMIT 1) THEN
      RAISE EXCEPTION 'StudentRefundDisbursement down would discard immutable refund history'; END IF; END $$`);
    await q.query(`DROP TRIGGER IF EXISTS invoice_adjustment_paid_refund_guard ON invoice_adjustment`);
    await q.query(`DROP FUNCTION IF EXISTS invoice_adjustment_paid_refund_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS student_refund_disbursement_event_immutable ON student_refund_disbursement_event`);
    await q.query(`DROP TRIGGER IF EXISTS student_refund_disbursement_request_immutable ON student_refund_disbursement_request`);
    await q.query(`DROP FUNCTION IF EXISTS student_refund_audit_immutable_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS student_refund_source_guard ON student_refund_disbursement`);
    await q.query(`DROP FUNCTION IF EXISTS student_refund_source_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS student_refund_disbursement_receipt_guard ON student_refund_disbursement`);
    await q.query(`DROP FUNCTION IF EXISTS student_refund_disbursement_receipt_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS student_refund_disbursement_row_guard ON student_refund_disbursement`);
    await q.query(`DROP FUNCTION IF EXISTS student_refund_disbursement_row_guard_fn()`);
    await q.query(`DROP TABLE student_refund_disbursement_event`);
    await q.query(`DROP TABLE student_refund_disbursement_request`);
    await q.query(`DROP TABLE student_refund_disbursement`);
  }
}
