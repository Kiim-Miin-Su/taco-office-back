/** @file-guide
 * 목적: BOC-11F 교재 판매와 결제 수단별 수수료 policy·PAY 연결·취소 보정 원장을 추가한다.
 * 책임/재사용: 판매/current, 멱등 request, 불변 event, 수수료 효력기간, 원 PAY 보존을 DB 최종 제약으로 방어한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11F-BOOK-SALES-FEES-2026-10-09.md · docs/contracts/db/erd.dbml
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 권고안 채택(2026-10-09): 초기 계좌이체·현금 수수료는 각각 0원이지만 상수로 계산하지 않는다.
 * 배포일부터 유효한 immutable policy를 판매 당시 snapshot으로 참조하며, 변경 시 새 기간/version 행을 추가한다.
 * 정책 변경 때 DTO/service/Front/Figma A22/두 DBML/기능·시나리오·portfolio를 함께 수정한다.
 */
export class BookSales1768700000000 implements MigrationInterface {
  name = 'BookSales1768700000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE book_sale_fee_policy (
      id bigserial PRIMARY KEY,
      payment_method varchar(16) NOT NULL CHECK (payment_method IN ('transfer','cash')),
      calculation varchar(12) NOT NULL CHECK (calculation IN ('fixed','rate_bps')),
      value integer NOT NULL CHECK (value>=0),
      policy_version integer NOT NULL CHECK (policy_version>=1),
      effective_from date NOT NULL,
      effective_to date,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT book_sale_fee_policy_version_unique UNIQUE(payment_method,policy_version),
      CONSTRAINT book_sale_fee_policy_period CHECK (effective_to IS NULL OR effective_to>=effective_from),
      CONSTRAINT book_sale_fee_policy_value_shape CHECK (
        (calculation='fixed' AND value<=2000000000)
        OR (calculation='rate_bps' AND value<=10000)
      )
    )`);
    await q.query(`ALTER TABLE book_sale_fee_policy ADD CONSTRAINT book_sale_fee_policy_no_overlap
      EXCLUDE USING gist (
        payment_method WITH =,
        daterange(effective_from,COALESCE(effective_to + 1,'infinity'::date),'[)') WITH &&
      )`);
    await q.query(`CREATE INDEX book_sale_fee_policy_lookup_idx
      ON book_sale_fee_policy(payment_method,effective_from DESC,policy_version DESC)`);
    await q.query(`INSERT INTO book_sale_fee_policy(payment_method,calculation,value,policy_version,effective_from)
      VALUES('transfer','fixed',0,1,CURRENT_DATE),('cash','fixed',0,1,CURRENT_DATE)`);

    await q.query(`CREATE TABLE book_sale (
      id bigserial PRIMARY KEY,
      student_id bigint NOT NULL REFERENCES stu(id) ON DELETE RESTRICT,
      book_id bigint NOT NULL REFERENCES lib(id) ON DELETE RESTRICT,
      book_code varchar(30) NOT NULL,
      book_title varchar(120) NOT NULL,
      book_edition varchar(80),
      book_label varchar(260) NOT NULL,
      sold_on date NOT NULL,
      quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
      unit_price integer NOT NULL CHECK (unit_price BETWEEN 0 AND 1000000000),
      total_amount integer NOT NULL CHECK (total_amount BETWEEN 0 AND 2000000000),
      payment_method varchar(16) NOT NULL CHECK (payment_method IN ('transfer','cash')),
      fee_policy_id bigint NOT NULL REFERENCES book_sale_fee_policy(id) ON DELETE RESTRICT,
      fee_policy_version integer NOT NULL CHECK (fee_policy_version>=1),
      fee_amount integer NOT NULL CHECK (fee_amount>=0),
      net_amount integer NOT NULL CHECK (net_amount>=0),
      pay_id bigint NOT NULL UNIQUE REFERENCES pay(id) ON DELETE RESTRICT,
      correction_pay_id bigint UNIQUE REFERENCES pay(id) ON DELETE RESTRICT,
      status varchar(12) NOT NULL CHECK (status IN ('completed','canceled')),
      row_version integer NOT NULL CHECK (row_version>=1),
      memo varchar(500),
      created_by bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      canceled_by bigint REFERENCES staff(id) ON DELETE RESTRICT,
      canceled_at timestamptz,
      cancel_reason varchar(500),
      CONSTRAINT book_sale_amounts CHECK (
        total_amount=quantity*unit_price AND fee_amount<=total_amount AND net_amount=total_amount-fee_amount
      ),
      CONSTRAINT book_sale_distinct_payments CHECK (correction_pay_id IS NULL OR correction_pay_id<>pay_id),
      CONSTRAINT book_sale_state_shape CHECK (
        (status='completed' AND row_version=1 AND correction_pay_id IS NULL
          AND canceled_by IS NULL AND canceled_at IS NULL AND cancel_reason IS NULL)
        OR (status='canceled' AND row_version=2 AND correction_pay_id IS NOT NULL
          AND canceled_by IS NOT NULL AND canceled_at IS NOT NULL AND length(btrim(cancel_reason)) BETWEEN 2 AND 500)
      )
    )`);
    await q.query(`CREATE INDEX book_sale_ledger_idx ON book_sale(sold_on DESC,id DESC)`);
    await q.query(`CREATE INDEX book_sale_student_idx ON book_sale(student_id,sold_on DESC,id DESC)`);

    await q.query(`CREATE TABLE book_sale_request (
      request_key uuid PRIMARY KEY,
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      action varchar(12) NOT NULL CHECK (action IN ('created','canceled')),
      sale_id bigint NOT NULL REFERENCES book_sale(id) ON DELETE RESTRICT,
      expected_version integer NOT NULL CHECK (expected_version>=0),
      payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
      result_version integer NOT NULL CHECK (result_version>=1),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT book_sale_request_shape CHECK (
        (action='created' AND expected_version=0 AND result_version=1)
        OR (action='canceled' AND expected_version=1 AND result_version=2)
      )
    )`);
    await q.query(`CREATE INDEX book_sale_request_sale_idx ON book_sale_request(sale_id,created_at)`);

    await q.query(`CREATE TABLE book_sale_event (
      id bigserial PRIMARY KEY,
      sale_id bigint NOT NULL REFERENCES book_sale(id) ON DELETE RESTRICT,
      action varchar(12) NOT NULL CHECK (action IN ('created','canceled')),
      from_status varchar(12),
      to_status varchar(12) NOT NULL CHECK (to_status IN ('completed','canceled')),
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      request_key uuid NOT NULL REFERENCES book_sale_request(request_key) ON DELETE RESTRICT,
      result_version integer NOT NULL CHECK (result_version>=1),
      total_amount integer NOT NULL CHECK (total_amount>=0),
      fee_amount integer NOT NULL CHECK (fee_amount>=0),
      net_amount integer NOT NULL CHECK (net_amount>=0),
      pay_id bigint NOT NULL REFERENCES pay(id) ON DELETE RESTRICT,
      correction_pay_id bigint REFERENCES pay(id) ON DELETE RESTRICT,
      reason varchar(500),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT book_sale_event_version_unique UNIQUE(sale_id,result_version),
      CONSTRAINT book_sale_event_request_unique UNIQUE(request_key),
      CONSTRAINT book_sale_event_amounts CHECK (fee_amount<=total_amount AND net_amount=total_amount-fee_amount),
      CONSTRAINT book_sale_event_shape CHECK (
        (action='created' AND from_status IS NULL AND to_status='completed' AND result_version=1
          AND correction_pay_id IS NULL AND reason IS NULL)
        OR (action='canceled' AND from_status='completed' AND to_status='canceled' AND result_version=2
          AND correction_pay_id IS NOT NULL AND length(btrim(reason)) BETWEEN 2 AND 500)
      )
    )`);
    await q.query(`CREATE INDEX book_sale_event_sale_idx ON book_sale_event(sale_id,created_at,id)`);

    await q.query(`CREATE FUNCTION book_sale_fee_policy_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'book sale fee policy history is immutable'
          USING ERRCODE='23514', CONSTRAINT='book_sale_fee_policy_immutable';
      END
    $$`);
    await q.query(`CREATE TRIGGER book_sale_fee_policy_immutable BEFORE UPDATE OR DELETE ON book_sale_fee_policy
      FOR EACH ROW EXECUTE FUNCTION book_sale_fee_policy_immutable_fn()`);

    await q.query(`CREATE FUNCTION book_sale_row_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' THEN
          RAISE EXCEPTION 'book sale rows are preserved'
            USING ERRCODE='23514', CONSTRAINT='book_sale_no_delete';
        END IF;
        IF OLD.status<>'completed' OR NEW.status<>'canceled'
          OR NEW.row_version<>OLD.row_version+1
          OR NEW.student_id<>OLD.student_id OR NEW.book_id<>OLD.book_id
          OR NEW.book_code<>OLD.book_code OR NEW.book_title<>OLD.book_title
          OR NEW.book_edition IS DISTINCT FROM OLD.book_edition OR NEW.book_label<>OLD.book_label
          OR NEW.sold_on<>OLD.sold_on OR NEW.quantity<>OLD.quantity OR NEW.unit_price<>OLD.unit_price
          OR NEW.total_amount<>OLD.total_amount OR NEW.payment_method<>OLD.payment_method
          OR NEW.fee_policy_id<>OLD.fee_policy_id OR NEW.fee_policy_version<>OLD.fee_policy_version
          OR NEW.fee_amount<>OLD.fee_amount OR NEW.net_amount<>OLD.net_amount
          OR NEW.pay_id<>OLD.pay_id OR NEW.memo IS DISTINCT FROM OLD.memo
          OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
          RAISE EXCEPTION 'book sale only supports one completed to canceled transition'
            USING ERRCODE='23514', CONSTRAINT='book_sale_transition_only';
        END IF;
        RETURN NEW;
      END
    $$`);
    await q.query(`CREATE TRIGGER book_sale_row_guard BEFORE UPDATE OR DELETE ON book_sale
      FOR EACH ROW EXECUTE FUNCTION book_sale_row_guard_fn()`);

    await q.query(`CREATE FUNCTION book_sale_audit_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'book sale audit history is immutable'
          USING ERRCODE='23514', CONSTRAINT='book_sale_audit_immutable';
      END
    $$`);
    await q.query(`CREATE TRIGGER book_sale_request_immutable BEFORE UPDATE OR DELETE ON book_sale_request
      FOR EACH ROW EXECUTE FUNCTION book_sale_audit_immutable_fn()`);
    await q.query(`CREATE TRIGGER book_sale_event_immutable BEFORE UPDATE OR DELETE ON book_sale_event
      FOR EACH ROW EXECUTE FUNCTION book_sale_audit_immutable_fn()`);

    await q.query(`CREATE FUNCTION book_sale_pay_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM book_sale s WHERE s.pay_id=OLD.id OR s.correction_pay_id=OLD.id) THEN
          RAISE EXCEPTION 'book sale payments are preserved with the sale ledger'
            USING ERRCODE='23514', CONSTRAINT='book_sale_payment_immutable';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
    $$`);
    await q.query(`CREATE TRIGGER book_sale_pay_immutable BEFORE UPDATE OR DELETE ON pay
      FOR EACH ROW EXECUTE FUNCTION book_sale_pay_immutable_fn()`);

    await q.query(`CREATE FUNCTION book_sale_event_matches_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM book_sale s
          JOIN book_sale_request r ON r.request_key=NEW.request_key
           WHERE s.id=NEW.sale_id AND s.status=NEW.to_status AND s.row_version=NEW.result_version
             AND s.total_amount=NEW.total_amount AND s.fee_amount=NEW.fee_amount AND s.net_amount=NEW.net_amount
             AND s.pay_id=NEW.pay_id AND s.correction_pay_id IS NOT DISTINCT FROM NEW.correction_pay_id
             AND r.sale_id=NEW.sale_id AND r.actor_id=NEW.actor_id AND r.action=NEW.action
             AND r.result_version=NEW.result_version
             AND NEW.actor_id=CASE WHEN NEW.action='created' THEN s.created_by ELSE s.canceled_by END
             AND NEW.reason IS NOT DISTINCT FROM CASE WHEN NEW.action='created' THEN NULL ELSE s.cancel_reason END
        ) THEN
          RAISE EXCEPTION 'book sale event must match final current state'
            USING ERRCODE='23514', CONSTRAINT='book_sale_event_matches_row';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER book_sale_event_matches AFTER INSERT ON book_sale_event
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION book_sale_event_matches_fn()`);

    await q.query(`CREATE FUNCTION book_sale_request_receipt_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM book_sale_event e
           WHERE e.request_key=NEW.request_key AND e.sale_id=NEW.sale_id AND e.actor_id=NEW.actor_id
             AND e.action=NEW.action AND e.result_version=NEW.result_version
        ) THEN
          RAISE EXCEPTION 'book sale request requires a matching event receipt'
            USING ERRCODE='23514', CONSTRAINT='book_sale_request_receipt_required';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER book_sale_request_receipt AFTER INSERT ON book_sale_request
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION book_sale_request_receipt_fn()`);

    await q.query(`CREATE FUNCTION book_sale_receipt_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM book_sale_event e
           WHERE e.sale_id=NEW.id AND e.result_version=NEW.row_version AND e.to_status=NEW.status
             AND e.total_amount=NEW.total_amount AND e.fee_amount=NEW.fee_amount AND e.net_amount=NEW.net_amount
             AND e.pay_id=NEW.pay_id AND e.correction_pay_id IS NOT DISTINCT FROM NEW.correction_pay_id
             AND e.action=CASE WHEN NEW.status='completed' THEN 'created' ELSE 'canceled' END
             AND e.actor_id=CASE WHEN NEW.status='completed' THEN NEW.created_by ELSE NEW.canceled_by END
             AND e.reason IS NOT DISTINCT FROM CASE WHEN NEW.status='completed' THEN NULL ELSE NEW.cancel_reason END
        ) THEN
          RAISE EXCEPTION 'book sale current state requires a matching event receipt'
            USING ERRCODE='23514', CONSTRAINT='book_sale_receipt_required';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM book_sale_fee_policy p
           WHERE p.id=NEW.fee_policy_id AND p.policy_version=NEW.fee_policy_version
             AND p.payment_method=NEW.payment_method
             AND p.effective_from<=NEW.sold_on AND (p.effective_to IS NULL OR p.effective_to>=NEW.sold_on)
             AND NEW.fee_amount=CASE WHEN p.calculation='rate_bps'
               THEN floor((NEW.total_amount::numeric*p.value)/10000)::integer ELSE p.value END
        ) THEN
          RAISE EXCEPTION 'book sale fee policy snapshot is not valid for the sale'
            USING ERRCODE='23514', CONSTRAINT='book_sale_fee_policy_mismatch';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pay p JOIN book_sale_event e ON e.sale_id=NEW.id AND e.action='created'
           WHERE p.id=NEW.pay_id AND p.inv_id IS NULL AND p.student_id=NEW.student_id
            AND p.amount=NEW.total_amount AND p.paid_on=NEW.sold_on AND p.method=NEW.payment_method
            AND p.entered_by=NEW.created_by AND p.confirmed_by=NEW.created_by AND p.request_key=e.request_key
        ) THEN
          RAISE EXCEPTION 'book sale payment must match the sale'
            USING ERRCODE='23514', CONSTRAINT='book_sale_payment_mismatch';
        END IF;
        IF NEW.status='canceled' AND NOT EXISTS (
          SELECT 1 FROM pay p JOIN book_sale_event e ON e.sale_id=NEW.id AND e.action='canceled'
           WHERE p.id=NEW.correction_pay_id AND p.inv_id IS NULL AND p.student_id=NEW.student_id
            AND p.amount=-NEW.total_amount AND p.method=NEW.payment_method
            AND p.entered_by=NEW.canceled_by AND p.confirmed_by=NEW.canceled_by AND p.request_key=e.request_key
        ) THEN
          RAISE EXCEPTION 'book sale correction payment must reverse the sale'
            USING ERRCODE='23514', CONSTRAINT='book_sale_correction_mismatch';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER book_sale_receipt_guard AFTER INSERT OR UPDATE ON book_sale
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION book_sale_receipt_guard_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM book_sale LIMIT 1)
        OR EXISTS(SELECT 1 FROM book_sale_request LIMIT 1)
        OR EXISTS(SELECT 1 FROM book_sale_event LIMIT 1) THEN
        RAISE EXCEPTION 'BookSales down would discard immutable sale history';
      END IF;
      IF EXISTS(
        SELECT 1 FROM book_sale_fee_policy
         WHERE policy_version<>1 OR calculation<>'fixed' OR value<>0 OR effective_to IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'BookSales down would discard non-seed fee policy history';
      END IF;
    END $$`);
    await q.query(`DROP TRIGGER IF EXISTS book_sale_receipt_guard ON book_sale`);
    await q.query(`DROP FUNCTION IF EXISTS book_sale_receipt_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS book_sale_request_receipt ON book_sale_request`);
    await q.query(`DROP FUNCTION IF EXISTS book_sale_request_receipt_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS book_sale_event_matches ON book_sale_event`);
    await q.query(`DROP FUNCTION IF EXISTS book_sale_event_matches_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS book_sale_pay_immutable ON pay`);
    await q.query(`DROP FUNCTION IF EXISTS book_sale_pay_immutable_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS book_sale_event_immutable ON book_sale_event`);
    await q.query(`DROP TRIGGER IF EXISTS book_sale_request_immutable ON book_sale_request`);
    await q.query(`DROP FUNCTION IF EXISTS book_sale_audit_immutable_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS book_sale_row_guard ON book_sale`);
    await q.query(`DROP FUNCTION IF EXISTS book_sale_row_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS book_sale_fee_policy_immutable ON book_sale_fee_policy`);
    await q.query(`DROP FUNCTION IF EXISTS book_sale_fee_policy_immutable_fn()`);
    await q.query(`DROP TABLE book_sale_event`);
    await q.query(`DROP TABLE book_sale_request`);
    await q.query(`DROP TABLE book_sale`);
    await q.query(`DROP TABLE book_sale_fee_policy`);
  }
}
