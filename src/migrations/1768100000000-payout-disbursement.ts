/** @file-guide
 * 목적: BO-11AD-03 확정 정산과 실제 계좌이체를 분리한 current/event/request 지급 원장을 추가한다. (migration)
 * 책임/재사용: payout snapshot을 참조하고 실제 지급·취소·재지급의 불변 이력과 동시성 제약만 소유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11AD03-PAYOUT-DISBURSEMENT-2026-10-09.md · docs/contracts/db/erd.dbml
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 권고안 채택(2026-10-09): `payout`/`payout_line`은 계산 확정의 불변 근거이고,
 * 실제 송금은 이 별도 원장에 남긴다. 계좌 식별자는 BO-Q9 계좌 보호 계약 전까지 저장하지 않는다.
 * 정책을 바꾸면 DTO/OpenAPI/Frontend/DBML/두 수정사항 대조표/portfolio를 같은 청크에서 고친다.
 */
export class PayoutDisbursement1768100000000 implements MigrationInterface {
  name = 'PayoutDisbursement1768100000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE payout_disbursement (
      id bigserial PRIMARY KEY,
      payout_id bigint NOT NULL REFERENCES payout(id) ON DELETE RESTRICT,
      state varchar(12) NOT NULL,
      row_version integer NOT NULL,
      snapshot jsonb NOT NULL,
      paid_on date NOT NULL,
      method varchar(24) NOT NULL,
      paid_by bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      paid_at timestamptz NOT NULL,
      canceled_by bigint REFERENCES staff(id) ON DELETE RESTRICT,
      canceled_at timestamptz,
      cancel_reason varchar(200),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payout_disbursement_payout_unique UNIQUE(payout_id),
      CONSTRAINT payout_disbursement_state_words CHECK (state IN ('paid','canceled')),
      CONSTRAINT payout_disbursement_method_words CHECK (method IN ('bank_transfer')),
      CONSTRAINT payout_disbursement_version_positive CHECK (row_version >= 1),
      CONSTRAINT payout_disbursement_snapshot_object CHECK (jsonb_typeof(snapshot)='object'),
      CONSTRAINT payout_disbursement_state_shape CHECK (
        (state='paid' AND canceled_by IS NULL AND canceled_at IS NULL AND cancel_reason IS NULL)
        OR (state='canceled' AND canceled_by IS NOT NULL AND canceled_at IS NOT NULL
          AND length(btrim(cancel_reason)) BETWEEN 2 AND 200)
      )
    )`);
    await q.query(`CREATE INDEX payout_disbursement_state_idx ON payout_disbursement(state,payout_id)`);

    await q.query(`CREATE TABLE payout_disbursement_request (
      request_key uuid PRIMARY KEY,
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      action varchar(16) NOT NULL,
      payout_id bigint REFERENCES payout(id) ON DELETE RESTRICT,
      year_month char(7),
      paid_on date,
      method varchar(24),
      result_count integer NOT NULL DEFAULT 0,
      skipped_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payout_disbursement_request_action CHECK (action IN ('paid','canceled','batch_paid')),
      CONSTRAINT payout_disbursement_request_method CHECK (method IS NULL OR method='bank_transfer'),
      CONSTRAINT payout_disbursement_request_counts CHECK (result_count >= 0 AND skipped_count >= 0),
      CONSTRAINT payout_disbursement_request_shape CHECK (
        (action='paid' AND payout_id IS NOT NULL AND year_month IS NULL AND paid_on IS NOT NULL AND method='bank_transfer')
        OR (action='canceled' AND payout_id IS NOT NULL AND year_month IS NULL AND paid_on IS NULL AND method IS NULL)
        OR (action='batch_paid' AND payout_id IS NULL AND year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
          AND paid_on IS NOT NULL AND method='bank_transfer')
      )
    )`);

    await q.query(`CREATE TABLE payout_disbursement_event (
      id bigserial PRIMARY KEY,
      payout_disbursement_id bigint NOT NULL REFERENCES payout_disbursement(id) ON DELETE RESTRICT,
      action varchar(12) NOT NULL,
      from_state varchar(12),
      to_state varchar(12) NOT NULL,
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      request_key uuid NOT NULL REFERENCES payout_disbursement_request(request_key) ON DELETE RESTRICT,
      result_version integer NOT NULL,
      snapshot jsonb NOT NULL,
      paid_on date,
      method varchar(24),
      reason varchar(200),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payout_disbursement_event_version_unique UNIQUE(payout_disbursement_id,result_version),
      CONSTRAINT payout_disbursement_event_request_unique UNIQUE(payout_disbursement_id,request_key),
      CONSTRAINT payout_disbursement_event_action CHECK (action IN ('paid','canceled')),
      CONSTRAINT payout_disbursement_event_state CHECK (from_state IS NULL OR from_state IN ('paid','canceled')),
      CONSTRAINT payout_disbursement_event_to_state CHECK (to_state IN ('paid','canceled')),
      CONSTRAINT payout_disbursement_event_method CHECK (method IS NULL OR method='bank_transfer'),
      CONSTRAINT payout_disbursement_event_version_positive CHECK (result_version >= 1),
      CONSTRAINT payout_disbursement_event_snapshot_object CHECK (jsonb_typeof(snapshot)='object'),
      CONSTRAINT payout_disbursement_event_shape CHECK (
        (action='paid' AND to_state='paid' AND paid_on IS NOT NULL AND method='bank_transfer' AND reason IS NULL)
        OR (action='canceled' AND from_state='paid' AND to_state='canceled'
          AND paid_on IS NULL AND method IS NULL AND length(btrim(reason)) BETWEEN 2 AND 200)
      )
    )`);
    await q.query(`CREATE INDEX payout_disbursement_event_current_idx
      ON payout_disbursement_event(payout_disbursement_id,created_at,id)`);

    await q.query(`CREATE FUNCTION payout_disbursement_row_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='UPDATE' THEN
          IF NEW.payout_id<>OLD.payout_id OR NEW.snapshot<>OLD.snapshot THEN
            RAISE EXCEPTION 'payout disbursement identity and confirmed snapshot are immutable'
              USING ERRCODE='23514', CONSTRAINT='payout_disbursement_identity_immutable';
          END IF;
          IF NEW.row_version<>OLD.row_version+1 THEN
            RAISE EXCEPTION 'payout disbursement version must advance exactly once'
              USING ERRCODE='23514', CONSTRAINT='payout_disbursement_version_step';
          END IF;
        END IF;
        NEW.updated_at := now();
        RETURN NEW;
      END
    $$`);
    await q.query(`CREATE TRIGGER payout_disbursement_row_guard BEFORE UPDATE ON payout_disbursement
      FOR EACH ROW EXECUTE FUNCTION payout_disbursement_row_guard_fn()`);

    await q.query(`CREATE FUNCTION payout_disbursement_event_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM payout_disbursement d
           WHERE d.id=NEW.payout_disbursement_id AND d.row_version=NEW.result_version AND d.state=NEW.to_state
        ) THEN
          RAISE EXCEPTION 'payout disbursement final state must have a matching event'
            USING ERRCODE='23514', CONSTRAINT='payout_disbursement_event_matches_row';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER payout_disbursement_event_guard
      AFTER INSERT ON payout_disbursement_event DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION payout_disbursement_event_guard_fn()`);

    await q.query(`CREATE FUNCTION payout_disbursement_receipt_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM payout_disbursement_event e
           WHERE e.payout_disbursement_id=NEW.id AND e.result_version=NEW.row_version AND e.to_state=NEW.state
        ) THEN
          RAISE EXCEPTION 'payout disbursement current state must have a matching event receipt'
            USING ERRCODE='23514', CONSTRAINT='payout_disbursement_receipt_required';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER payout_disbursement_receipt_guard
      AFTER INSERT OR UPDATE ON payout_disbursement DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION payout_disbursement_receipt_guard_fn()`);

    await q.query(`CREATE FUNCTION payout_disbursement_event_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'payout disbursement event history is immutable'
          USING ERRCODE='23514', CONSTRAINT='payout_disbursement_event_immutable';
      END
    $$`);
    await q.query(`CREATE TRIGGER payout_disbursement_event_immutable
      BEFORE UPDATE OR DELETE ON payout_disbursement_event
      FOR EACH ROW EXECUTE FUNCTION payout_disbursement_event_immutable_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM payout_disbursement_event LIMIT 1) THEN
      RAISE EXCEPTION 'PayoutDisbursement down would discard immutable payment history'; END IF; END $$`);
    await q.query(`DROP TRIGGER IF EXISTS payout_disbursement_event_immutable ON payout_disbursement_event`);
    await q.query(`DROP FUNCTION IF EXISTS payout_disbursement_event_immutable_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS payout_disbursement_receipt_guard ON payout_disbursement`);
    await q.query(`DROP FUNCTION IF EXISTS payout_disbursement_receipt_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS payout_disbursement_event_guard ON payout_disbursement_event`);
    await q.query(`DROP FUNCTION IF EXISTS payout_disbursement_event_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS payout_disbursement_row_guard ON payout_disbursement`);
    await q.query(`DROP FUNCTION IF EXISTS payout_disbursement_row_guard_fn()`);
    await q.query(`DROP TABLE IF EXISTS payout_disbursement_event`);
    await q.query(`DROP TABLE IF EXISTS payout_disbursement_request`);
    await q.query(`DROP TABLE IF EXISTS payout_disbursement`);
  }
}
