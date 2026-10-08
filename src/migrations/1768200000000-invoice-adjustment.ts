/** @file-guide
 * 목적: BO-11BD-01 청구 조정의 원금 snapshot·현재 상태·불변 event와 청구액 합계 방어를 추가한다.
 * 책임/재사용: INV를 정본 청구서로 유지하고 승인된 조정 합만 amount에 반영하며 직접 current/event/amount 변조를 DB가 거절한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11BD01-INVOICE-ADJUSTMENT-APPROVAL-2026-10-09.md · docs/contracts/db/erd.dbml
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BO-11BD-01 권고안 채택(2026-10-09): 네 조정 종류는 적용 월의 단일 유효 tuition 청구액을 줄인다.
 * pending/rejected는 금액 불변, approved는 차감, canceled는 보상 복구다. 실제 환불 송금은 BO-Q9가 소유한다.
 * 정책 변경 시 DTO/service/Front/generated schema/DBML/Figma A24/두 수정사항 대조표/portfolio를 함께 고친다.
 */
export class InvoiceAdjustment1768200000000 implements MigrationInterface {
  name = 'InvoiceAdjustment1768200000000';

  async up(q: QueryRunner): Promise<void> {
    // 승인 조정 뒤에는 이미 받은 금액이 새 청구액을 넘을 수 있다. 그 차이는 환불 예정액이며,
    // 아래 지연 trigger가 승인 조정 없이 생긴 일반 초과 수납은 계속 거절한다.
    await q.query(`ALTER TABLE inv DROP CONSTRAINT inv_paid_le_amount`);
    await q.query(`ALTER TABLE inv ADD CONSTRAINT inv_paid_nonnegative CHECK (paid_amount >= 0)`);

    await q.query(`CREATE TABLE invoice_adjustment_base (
      inv_id bigint PRIMARY KEY REFERENCES inv(id) ON DELETE RESTRICT,
      original_amount integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT invoice_adjustment_base_amount_nonnegative CHECK (original_amount >= 0)
    )`);

    await q.query(`CREATE TABLE invoice_adjustment (
      id bigserial PRIMARY KEY,
      inv_id bigint NOT NULL REFERENCES inv(id) ON DELETE RESTRICT,
      student_id bigint NOT NULL REFERENCES stu(id) ON DELETE RESTRICT,
      year_month char(7) NOT NULL,
      effective_on date NOT NULL,
      kind varchar(24) NOT NULL,
      reason varchar(500) NOT NULL,
      amount integer NOT NULL,
      state varchar(16) NOT NULL DEFAULT 'pending',
      row_version integer NOT NULL DEFAULT 1,
      requested_by bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      requested_at timestamptz NOT NULL DEFAULT now(),
      decided_by bigint REFERENCES staff(id) ON DELETE RESTRICT,
      decided_at timestamptz,
      reject_reason varchar(200),
      canceled_by bigint REFERENCES staff(id) ON DELETE RESTRICT,
      canceled_at timestamptz,
      cancel_reason varchar(200),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT invoice_adjustment_month_shape CHECK (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      CONSTRAINT invoice_adjustment_effective_month CHECK (to_char(effective_on,'YYYY-MM')=year_month),
      CONSTRAINT invoice_adjustment_kind_words CHECK (kind IN ('discount','refund','sibling_discount','carry')),
      CONSTRAINT invoice_adjustment_state_words CHECK (state IN ('pending','approved','rejected','canceled')),
      CONSTRAINT invoice_adjustment_reason_present CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
      CONSTRAINT invoice_adjustment_amount_positive CHECK (amount > 0),
      CONSTRAINT invoice_adjustment_version_positive CHECK (row_version >= 1),
      CONSTRAINT invoice_adjustment_state_shape CHECK (
        (state='pending' AND decided_by IS NULL AND decided_at IS NULL AND reject_reason IS NULL
          AND canceled_by IS NULL AND canceled_at IS NULL AND cancel_reason IS NULL)
        OR (state='approved' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND reject_reason IS NULL
          AND canceled_by IS NULL AND canceled_at IS NULL AND cancel_reason IS NULL)
        OR (state='rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
          AND length(btrim(reject_reason)) BETWEEN 2 AND 200
          AND canceled_by IS NULL AND canceled_at IS NULL AND cancel_reason IS NULL)
        OR (state='canceled' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND reject_reason IS NULL
          AND canceled_by IS NOT NULL AND canceled_at IS NOT NULL AND length(btrim(cancel_reason)) BETWEEN 2 AND 200)
      )
    )`);
    await q.query(`CREATE INDEX invoice_adjustment_month_state_idx ON invoice_adjustment(year_month,state,effective_on,id)`);
    await q.query(`CREATE INDEX invoice_adjustment_invoice_idx ON invoice_adjustment(inv_id,requested_at,id)`);
    await q.query(`CREATE INDEX invoice_adjustment_student_idx ON invoice_adjustment(student_id,year_month,id)`);

    await q.query(`CREATE TABLE invoice_adjustment_event (
      id bigserial PRIMARY KEY,
      invoice_adjustment_id bigint NOT NULL REFERENCES invoice_adjustment(id) ON DELETE RESTRICT,
      action varchar(20) NOT NULL,
      from_state varchar(16),
      to_state varchar(16) NOT NULL,
      reason varchar(200),
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      request_key uuid NOT NULL,
      payload_sha256 char(64) NOT NULL,
      result_version integer NOT NULL,
      invoice_amount_before integer NOT NULL,
      invoice_amount_after integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT invoice_adjustment_event_request_unique UNIQUE(request_key),
      CONSTRAINT invoice_adjustment_event_version_unique UNIQUE(invoice_adjustment_id,result_version),
      CONSTRAINT invoice_adjustment_event_action_words CHECK (action IN ('created','approved','rejected','canceled','restored')),
      CONSTRAINT invoice_adjustment_event_state_words CHECK (
        to_state IN ('pending','approved','rejected','canceled')
        AND (from_state IS NULL OR from_state IN ('pending','approved','rejected','canceled'))
      ),
      CONSTRAINT invoice_adjustment_event_payload_sha CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT invoice_adjustment_event_version_positive CHECK (result_version >= 1),
      CONSTRAINT invoice_adjustment_event_amount_nonnegative CHECK (invoice_amount_before >= 0 AND invoice_amount_after >= 0),
      CONSTRAINT invoice_adjustment_event_shape CHECK (
        (action='created' AND from_state IS NULL AND to_state='pending' AND result_version=1 AND reason IS NULL
          AND invoice_amount_before=invoice_amount_after)
        OR (action='approved' AND from_state='pending' AND to_state='approved' AND reason IS NULL
          AND invoice_amount_after < invoice_amount_before)
        OR (action='rejected' AND from_state='pending' AND to_state='rejected' AND length(btrim(reason)) BETWEEN 2 AND 200
          AND invoice_amount_before=invoice_amount_after)
        OR (action='canceled' AND from_state='approved' AND to_state='canceled' AND length(btrim(reason)) BETWEEN 2 AND 200
          AND invoice_amount_after > invoice_amount_before)
        OR (action='restored' AND length(btrim(reason)) BETWEEN 2 AND 200 AND (
          (from_state='canceled' AND to_state='approved' AND invoice_amount_after < invoice_amount_before)
          OR (from_state='rejected' AND to_state='pending' AND invoice_amount_before=invoice_amount_after)
        ))
      )
    )`);
    await q.query(`CREATE INDEX invoice_adjustment_event_item_idx
      ON invoice_adjustment_event(invoice_adjustment_id,result_version,id)`);

    await q.query(`CREATE FUNCTION invoice_adjustment_base_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'invoice adjustment base snapshot is immutable'
          USING ERRCODE='23514', CONSTRAINT='invoice_adjustment_base_immutable';
      END
    $$`);
    await q.query(`CREATE TRIGGER invoice_adjustment_base_immutable
      BEFORE UPDATE OR DELETE ON invoice_adjustment_base
      FOR EACH ROW EXECUTE FUNCTION invoice_adjustment_base_immutable_fn()`);

    await q.query(`CREATE FUNCTION invoice_adjustment_row_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' THEN
          RAISE EXCEPTION 'invoice adjustment current history cannot be deleted'
            USING ERRCODE='23514', CONSTRAINT='invoice_adjustment_delete_forbidden';
        END IF;
        IF TG_OP='UPDATE' THEN
          IF NEW.inv_id<>OLD.inv_id OR NEW.student_id<>OLD.student_id OR NEW.year_month<>OLD.year_month
             OR NEW.effective_on<>OLD.effective_on OR NEW.kind<>OLD.kind OR NEW.reason<>OLD.reason
             OR NEW.amount<>OLD.amount OR NEW.requested_by<>OLD.requested_by OR NEW.requested_at<>OLD.requested_at THEN
            RAISE EXCEPTION 'invoice adjustment identity is immutable'
              USING ERRCODE='23514', CONSTRAINT='invoice_adjustment_identity_immutable';
          END IF;
          IF NEW.row_version<>OLD.row_version+1 THEN
            RAISE EXCEPTION 'invoice adjustment version must advance exactly once'
              USING ERRCODE='23514', CONSTRAINT='invoice_adjustment_version_step';
          END IF;
        END IF;
        NEW.updated_at := now();
        RETURN NEW;
      END
    $$`);
    await q.query(`CREATE TRIGGER invoice_adjustment_row_guard
      BEFORE UPDATE OR DELETE ON invoice_adjustment
      FOR EACH ROW EXECUTE FUNCTION invoice_adjustment_row_guard_fn()`);

    await q.query(`CREATE FUNCTION invoice_adjustment_current_receipt_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM invoice_adjustment_event e
           WHERE e.invoice_adjustment_id=NEW.id AND e.result_version=NEW.row_version AND e.to_state=NEW.state
        ) THEN
          RAISE EXCEPTION 'invoice adjustment current state must have an event receipt'
            USING ERRCODE='23514', CONSTRAINT='invoice_adjustment_event_receipt';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER invoice_adjustment_current_receipt
      AFTER INSERT OR UPDATE ON invoice_adjustment DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION invoice_adjustment_current_receipt_fn()`);

    await q.query(`CREATE FUNCTION invoice_adjustment_event_matches_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE current_amount integer;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM invoice_adjustment a
           WHERE a.id=NEW.invoice_adjustment_id AND a.row_version=NEW.result_version AND a.state=NEW.to_state
        ) THEN
          RAISE EXCEPTION 'invoice adjustment event must match current state and version'
            USING ERRCODE='23514', CONSTRAINT='invoice_adjustment_event_matches_current';
        END IF;
        SELECT i.amount INTO current_amount FROM inv i JOIN invoice_adjustment a ON a.inv_id=i.id
         WHERE a.id=NEW.invoice_adjustment_id;
        IF current_amount IS DISTINCT FROM NEW.invoice_amount_after THEN
          RAISE EXCEPTION 'invoice adjustment event amount must match current invoice amount'
            USING ERRCODE='23514', CONSTRAINT='invoice_adjustment_event_matches_invoice';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER invoice_adjustment_event_matches
      AFTER INSERT ON invoice_adjustment_event DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION invoice_adjustment_event_matches_fn()`);

    await q.query(`CREATE FUNCTION invoice_adjustment_invoice_total_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE target_inv bigint; original integer; current_amount integer; approved integer;
      BEGIN
        IF TG_TABLE_NAME='inv' THEN
          target_inv := NEW.id;
        ELSE
          target_inv := NEW.inv_id;
        END IF;
        SELECT b.original_amount,i.amount INTO original,current_amount
          FROM invoice_adjustment_base b JOIN inv i ON i.id=b.inv_id WHERE b.inv_id=target_inv;
        IF original IS NULL THEN RETURN NULL; END IF;
        SELECT COALESCE(sum(a.amount),0)::integer INTO approved
          FROM invoice_adjustment a WHERE a.inv_id=target_inv AND a.state='approved';
        IF current_amount IS DISTINCT FROM original-approved THEN
          RAISE EXCEPTION 'invoice amount must equal original amount minus approved adjustments'
            USING ERRCODE='23514', CONSTRAINT='invoice_adjustment_invoice_total';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER invoice_adjustment_invoice_total_from_adjustment
      AFTER INSERT OR UPDATE ON invoice_adjustment DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION invoice_adjustment_invoice_total_fn()`);
    await q.query(`CREATE CONSTRAINT TRIGGER invoice_adjustment_invoice_total_from_invoice
      AFTER UPDATE OF amount ON inv DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION invoice_adjustment_invoice_total_fn()`);

    await q.query(`CREATE FUNCTION invoice_adjustment_overpayment_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.paid_amount > NEW.amount AND NOT EXISTS (
          SELECT 1
            FROM invoice_adjustment a
            JOIN invoice_adjustment_base b ON b.inv_id=a.inv_id
           WHERE a.inv_id=NEW.id
             AND a.state='approved'
             AND NEW.paid_amount <= b.original_amount
        ) THEN
          RAISE EXCEPTION 'paid amount may exceed adjusted invoice amount only up to its original amount'
            USING ERRCODE='23514', CONSTRAINT='inv_paid_le_amount_without_adjustment';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER invoice_adjustment_overpayment_guard
      AFTER INSERT OR UPDATE OF amount,paid_amount ON inv DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION invoice_adjustment_overpayment_guard_fn()`);

    await q.query(`CREATE FUNCTION invoice_adjustment_event_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'invoice adjustment event history is immutable'
          USING ERRCODE='23514', CONSTRAINT='invoice_adjustment_event_immutable';
      END
    $$`);
    await q.query(`CREATE TRIGGER invoice_adjustment_event_immutable
      BEFORE UPDATE OR DELETE ON invoice_adjustment_event
      FOR EACH ROW EXECUTE FUNCTION invoice_adjustment_event_immutable_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM invoice_adjustment LIMIT 1) THEN
      RAISE EXCEPTION 'InvoiceAdjustment down would discard immutable approval history'; END IF; END $$`);
    await q.query(`DROP TRIGGER IF EXISTS invoice_adjustment_event_immutable ON invoice_adjustment_event`);
    await q.query(`DROP FUNCTION IF EXISTS invoice_adjustment_event_immutable_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS invoice_adjustment_overpayment_guard ON inv`);
    await q.query(`DROP FUNCTION IF EXISTS invoice_adjustment_overpayment_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS invoice_adjustment_invoice_total_from_invoice ON inv`);
    await q.query(`DROP TRIGGER IF EXISTS invoice_adjustment_invoice_total_from_adjustment ON invoice_adjustment`);
    await q.query(`DROP FUNCTION IF EXISTS invoice_adjustment_invoice_total_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS invoice_adjustment_event_matches ON invoice_adjustment_event`);
    await q.query(`DROP FUNCTION IF EXISTS invoice_adjustment_event_matches_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS invoice_adjustment_current_receipt ON invoice_adjustment`);
    await q.query(`DROP FUNCTION IF EXISTS invoice_adjustment_current_receipt_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS invoice_adjustment_row_guard ON invoice_adjustment`);
    await q.query(`DROP FUNCTION IF EXISTS invoice_adjustment_row_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS invoice_adjustment_base_immutable ON invoice_adjustment_base`);
    await q.query(`DROP FUNCTION IF EXISTS invoice_adjustment_base_immutable_fn()`);
    await q.query(`DROP TABLE invoice_adjustment_event`);
    await q.query(`DROP TABLE invoice_adjustment`);
    await q.query(`DROP TABLE invoice_adjustment_base`);
    await q.query(`ALTER TABLE inv DROP CONSTRAINT IF EXISTS inv_paid_nonnegative`);
    await q.query(`ALTER TABLE inv DROP CONSTRAINT IF EXISTS inv_paid_le_amount`);
    await q.query(`ALTER TABLE inv ADD CONSTRAINT inv_paid_le_amount CHECK (paid_amount >= 0 AND paid_amount <= amount)`);
  }
}
