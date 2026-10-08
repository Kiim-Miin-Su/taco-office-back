/** @file-guide
 * 목적: BO-11AD-01 PAY별 증빙 발행 현재 상태·불변 event·멱등 요청 원장을 추가한다. (migration)
 * 책임/재사용: 외부 발급기관 번호를 만들지 않고 내부 발행 snapshot/version과 월 마감 제약의 정본만 소유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11AD01-PAYMENT-EVIDENCE-2026-10-09.md · docs/contracts/db/erd.dbml
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 권고안 채택(2026-10-09): 이 표의 `issued`는 외부에서 발행을 끝낸 사실을 관리자가 확인했다는 뜻이다.
 * 국세청·PG API와 발급 번호 계약이 생기면 provider adapter와 별도 참조를 추가하고, 현재 snapshot/event는
 * 과거 감사 자료로 보존한다. DTO/service/Front/DBML/두 수정사항 대조표/portfolio를 함께 고친다.
 */
export class PaymentEvidence1768000000000 implements MigrationInterface {
  name = 'PaymentEvidence1768000000000';

  async up(q: QueryRunner): Promise<void> {
    // 배포 전 PAY를 추정 발행 처리하지 않는다. 이후 실제 등록된 PAY부터 월 마감 gate에 포함한다.
    await q.query(`CREATE TABLE payment_evidence_policy (
      id smallint PRIMARY KEY,
      effective_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payment_evidence_policy_singleton CHECK (id=1)
    )`);
    await q.query(`INSERT INTO payment_evidence_policy(id) VALUES (1)`);

    await q.query(`CREATE TABLE payment_evidence (
      id bigserial PRIMARY KEY,
      pay_id bigint NOT NULL REFERENCES pay(id) ON DELETE RESTRICT,
      state varchar(12) NOT NULL,
      row_version integer NOT NULL,
      snapshot jsonb NOT NULL,
      issued_by bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      issued_at timestamptz NOT NULL,
      canceled_by bigint REFERENCES staff(id) ON DELETE RESTRICT,
      canceled_at timestamptz,
      cancel_reason varchar(200),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payment_evidence_pay_unique UNIQUE(pay_id),
      CONSTRAINT payment_evidence_state_words CHECK (state IN ('issued','canceled')),
      CONSTRAINT payment_evidence_version_positive CHECK (row_version >= 1),
      CONSTRAINT payment_evidence_snapshot_object CHECK (jsonb_typeof(snapshot)='object'),
      CONSTRAINT payment_evidence_state_shape CHECK (
        (state='issued' AND canceled_by IS NULL AND canceled_at IS NULL AND cancel_reason IS NULL)
        OR (state='canceled' AND canceled_by IS NOT NULL AND canceled_at IS NOT NULL AND length(btrim(cancel_reason)) BETWEEN 2 AND 200)
      )
    )`);
    await q.query(`CREATE INDEX payment_evidence_state_idx ON payment_evidence(state,pay_id)`);

    await q.query(`CREATE TABLE payment_evidence_request (
      request_key uuid PRIMARY KEY,
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      action varchar(12) NOT NULL,
      pay_id bigint REFERENCES pay(id) ON DELETE RESTRICT,
      year_month char(7),
      result_count integer NOT NULL DEFAULT 0,
      skipped_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payment_evidence_request_action CHECK (action IN ('issued','canceled','batch_issued')),
      CONSTRAINT payment_evidence_request_counts CHECK (result_count >= 0 AND skipped_count >= 0),
      CONSTRAINT payment_evidence_request_shape CHECK (
        (action IN ('issued','canceled') AND pay_id IS NOT NULL AND year_month IS NULL)
        OR (action='batch_issued' AND pay_id IS NULL AND year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
      )
    )`);

    await q.query(`CREATE TABLE payment_evidence_event (
      id bigserial PRIMARY KEY,
      payment_evidence_id bigint NOT NULL REFERENCES payment_evidence(id) ON DELETE RESTRICT,
      action varchar(12) NOT NULL,
      from_state varchar(12),
      to_state varchar(12) NOT NULL,
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      request_key uuid NOT NULL REFERENCES payment_evidence_request(request_key) ON DELETE RESTRICT,
      result_version integer NOT NULL,
      snapshot jsonb NOT NULL,
      reason varchar(200),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payment_evidence_event_version_unique UNIQUE(payment_evidence_id,result_version),
      CONSTRAINT payment_evidence_event_request_unique UNIQUE(payment_evidence_id,request_key),
      CONSTRAINT payment_evidence_event_action CHECK (action IN ('issued','canceled')),
      CONSTRAINT payment_evidence_event_state CHECK (from_state IS NULL OR from_state IN ('issued','canceled')),
      CONSTRAINT payment_evidence_event_to_state CHECK (to_state IN ('issued','canceled')),
      CONSTRAINT payment_evidence_event_version_positive CHECK (result_version >= 1),
      CONSTRAINT payment_evidence_event_snapshot_object CHECK (jsonb_typeof(snapshot)='object'),
      CONSTRAINT payment_evidence_event_shape CHECK (
        (action='issued' AND to_state='issued' AND reason IS NULL)
        OR (action='canceled' AND from_state='issued' AND to_state='canceled' AND length(btrim(reason)) BETWEEN 2 AND 200)
      )
    )`);
    await q.query(`CREATE INDEX payment_evidence_event_evidence_idx ON payment_evidence_event(payment_evidence_id,created_at,id)`);

    await q.query(`CREATE FUNCTION payment_evidence_row_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='UPDATE' THEN
          IF NEW.pay_id<>OLD.pay_id THEN
            RAISE EXCEPTION 'payment evidence payment identity is immutable'
              USING ERRCODE='23514', CONSTRAINT='payment_evidence_identity_immutable';
          END IF;
          IF NEW.row_version<>OLD.row_version+1 THEN
            RAISE EXCEPTION 'payment evidence version must advance exactly once'
              USING ERRCODE='23514', CONSTRAINT='payment_evidence_version_step';
          END IF;
        END IF;
        NEW.updated_at := now();
        RETURN NEW;
      END
    $$`);
    await q.query(`CREATE TRIGGER payment_evidence_row_guard BEFORE UPDATE ON payment_evidence
      FOR EACH ROW EXECUTE FUNCTION payment_evidence_row_guard_fn()`);

    await q.query(`CREATE FUNCTION payment_evidence_event_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM payment_evidence d
           WHERE d.id=NEW.payment_evidence_id AND d.row_version=NEW.result_version AND d.state=NEW.to_state
        ) THEN
          RAISE EXCEPTION 'payment evidence final state must have a matching event'
            USING ERRCODE='23514', CONSTRAINT='payment_evidence_event_matches_row';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER payment_evidence_event_guard AFTER INSERT ON payment_evidence_event
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payment_evidence_event_guard_fn()`);

    await q.query(`CREATE FUNCTION payment_evidence_receipt_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM payment_evidence_event e
           WHERE e.payment_evidence_id=NEW.id AND e.result_version=NEW.row_version AND e.to_state=NEW.state
        ) THEN
          RAISE EXCEPTION 'payment evidence current state must have a matching event receipt'
            USING ERRCODE='23514', CONSTRAINT='payment_evidence_receipt_required';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER payment_evidence_receipt_guard AFTER INSERT OR UPDATE ON payment_evidence
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payment_evidence_receipt_guard_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM payment_evidence LIMIT 1) THEN
      RAISE EXCEPTION 'PaymentEvidence down would discard immutable issuance history'; END IF; END $$`);
    await q.query(`DROP TRIGGER IF EXISTS payment_evidence_receipt_guard ON payment_evidence`);
    await q.query(`DROP FUNCTION IF EXISTS payment_evidence_receipt_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS payment_evidence_event_guard ON payment_evidence_event`);
    await q.query(`DROP FUNCTION IF EXISTS payment_evidence_event_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS payment_evidence_row_guard ON payment_evidence`);
    await q.query(`DROP FUNCTION IF EXISTS payment_evidence_row_guard_fn()`);
    await q.query(`DROP TABLE IF EXISTS payment_evidence_event`);
    await q.query(`DROP TABLE IF EXISTS payment_evidence_request`);
    await q.query(`DROP TABLE IF EXISTS payment_evidence`);
    await q.query(`DROP TABLE IF EXISTS payment_evidence_policy`);
  }
}
