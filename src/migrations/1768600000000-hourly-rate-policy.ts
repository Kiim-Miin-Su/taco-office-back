/** @file-guide
 * 목적: BOC-11E 시간당 수업료와 학생별 예외를 기간·버전·감사 원장으로 추가한다.
 * 책임/재사용: 기존 회당 RATE/STURATE를 보존하고 새 hourly policy current/request/event와 기간 비중첩을 소유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11E-HOURLY-RATE-POLICY-2026-10-09.md
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 권고안 채택(2026-10-09): 기존 RATE/STURATE는 회당 역사로 남긴다. 새 정책은 실제 수업일과
 * 시간에만 적용하고, 일반·Kinder·그룹·학생 예외 identity별 기간은 겹치지 않는다.
 * 수정은 과거 줄을 덮지 않고 기존 기간 종료 + 신규 줄 생성으로 처리한다.
 */
export class HourlyRatePolicy1768600000000 implements MigrationInterface {
  name = 'HourlyRatePolicy1768600000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE hourly_rate_policy (
      id bigserial PRIMARY KEY,
      scope varchar(12) NOT NULL CHECK (scope IN ('general','kinder','group','student')),
      student_id bigint REFERENCES stu(id) ON DELETE RESTRICT,
      kind_key varchar(16) REFERENCES kind(key) ON DELETE RESTRICT,
      capacity integer,
      hourly_amount integer NOT NULL CHECK (hourly_amount BETWEEN 1 AND 100000000),
      effective_from date NOT NULL,
      effective_to date,
      reason varchar(200),
      row_version integer NOT NULL DEFAULT 1 CHECK (row_version>=1),
      voided boolean NOT NULL DEFAULT false,
      created_by bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      updated_by bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT hourly_rate_policy_shape CHECK (
        (scope='student' AND student_id IS NOT NULL AND capacity IS NULL)
        OR (scope='group' AND student_id IS NULL AND kind_key IS NULL AND capacity BETWEEN 2 AND 100)
        OR (scope IN ('general','kinder') AND student_id IS NULL AND kind_key IS NULL AND capacity IS NULL)
      ),
      CONSTRAINT hourly_rate_policy_period CHECK (effective_to IS NULL OR effective_to>=effective_from),
      CONSTRAINT hourly_rate_policy_student_reason CHECK (
        scope<>'student' OR length(btrim(reason)) BETWEEN 1 AND 200
      ),
      CONSTRAINT hourly_rate_policy_voided_future CHECK (
        NOT voided OR effective_from>=(created_at AT TIME ZONE 'Asia/Seoul')::date
      )
    )`);
    await q.query(`ALTER TABLE hourly_rate_policy ADD CONSTRAINT hourly_rate_policy_no_overlap
      EXCLUDE USING gist (
        scope WITH =,
        COALESCE(student_id,0) WITH =,
        COALESCE(kind_key,'') WITH =,
        COALESCE(capacity,0) WITH =,
        daterange(effective_from,COALESCE(effective_to + 1,'infinity'::date),'[)') WITH &&
      ) WHERE (NOT voided)`);
    await q.query(`CREATE INDEX hourly_rate_policy_lookup_idx
      ON hourly_rate_policy(scope,student_id,kind_key,capacity,effective_from DESC,id DESC)`);

    await q.query(`CREATE TABLE hourly_rate_policy_request (
      request_key uuid PRIMARY KEY,
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      action varchar(12) NOT NULL CHECK (action IN ('created','replaced','retired')),
      source_policy_id bigint REFERENCES hourly_rate_policy(id) ON DELETE RESTRICT,
      expected_version integer NOT NULL CHECK (expected_version>=0),
      payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
      result_policy_id bigint NOT NULL REFERENCES hourly_rate_policy(id) ON DELETE RESTRICT,
      result_version integer NOT NULL CHECK (result_version>=1),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX hourly_rate_policy_request_source_idx
      ON hourly_rate_policy_request(source_policy_id,created_at)`);

    await q.query(`CREATE TABLE hourly_rate_policy_event (
      id bigserial PRIMARY KEY,
      policy_id bigint NOT NULL REFERENCES hourly_rate_policy(id) ON DELETE RESTRICT,
      action varchar(12) NOT NULL CHECK (action IN ('created','superseded','retired')),
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      request_key uuid NOT NULL REFERENCES hourly_rate_policy_request(request_key) ON DELETE RESTRICT,
      result_version integer NOT NULL CHECK (result_version>=1),
      hourly_amount integer NOT NULL CHECK (hourly_amount BETWEEN 1 AND 100000000),
      effective_from date NOT NULL,
      effective_to date,
      reason varchar(200),
      voided boolean NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT hourly_rate_policy_event_version_unique UNIQUE(policy_id,result_version),
      CONSTRAINT hourly_rate_policy_event_period CHECK (effective_to IS NULL OR effective_to>=effective_from)
    )`);
    await q.query(`CREATE INDEX hourly_rate_policy_event_policy_idx
      ON hourly_rate_policy_event(policy_id,created_at,id)`);

    await q.query(`CREATE FUNCTION hourly_rate_policy_event_transition_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM hourly_rate_policy_event e
           WHERE e.policy_id=NEW.policy_id AND e.action IN ('superseded','retired')
        ) THEN
          RAISE EXCEPTION 'superseded or retired hourly rate policy cannot transition again'
            USING ERRCODE='23514', CONSTRAINT='hourly_rate_policy_transition_terminal';
        END IF;
        RETURN NEW;
      END
    $$`);
    await q.query(`CREATE TRIGGER hourly_rate_policy_event_transition_guard
      BEFORE INSERT ON hourly_rate_policy_event
      FOR EACH ROW EXECUTE FUNCTION hourly_rate_policy_event_transition_guard_fn()`);

    await q.query(`CREATE FUNCTION hourly_rate_policy_row_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' THEN
          RAISE EXCEPTION 'hourly rate policy rows are preserved'
            USING ERRCODE='23514', CONSTRAINT='hourly_rate_policy_no_delete';
        END IF;
        IF NEW.scope<>OLD.scope
          OR NEW.student_id IS DISTINCT FROM OLD.student_id
          OR NEW.kind_key IS DISTINCT FROM OLD.kind_key
          OR NEW.capacity IS DISTINCT FROM OLD.capacity
          OR NEW.created_by<>OLD.created_by
          OR NEW.created_at<>OLD.created_at THEN
          RAISE EXCEPTION 'hourly rate policy identity is immutable'
            USING ERRCODE='23514', CONSTRAINT='hourly_rate_policy_identity_immutable';
        END IF;
        IF NEW.row_version<>OLD.row_version+1 THEN
          RAISE EXCEPTION 'hourly rate policy version must advance exactly once'
            USING ERRCODE='23514', CONSTRAINT='hourly_rate_policy_version_step';
        END IF;
        NEW.updated_at := now();
        RETURN NEW;
      END
    $$`);
    await q.query(`CREATE TRIGGER hourly_rate_policy_row_guard
      BEFORE UPDATE OR DELETE ON hourly_rate_policy
      FOR EACH ROW EXECUTE FUNCTION hourly_rate_policy_row_guard_fn()`);

    await q.query(`CREATE FUNCTION hourly_rate_policy_receipt_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM hourly_rate_policy_event e
           WHERE e.policy_id=NEW.id AND e.result_version=NEW.row_version
             AND e.hourly_amount=NEW.hourly_amount
             AND e.effective_from=NEW.effective_from
             AND e.effective_to IS NOT DISTINCT FROM NEW.effective_to
             AND e.reason IS NOT DISTINCT FROM NEW.reason
             AND e.voided=NEW.voided
             AND e.actor_id=NEW.updated_by
        ) THEN
          RAISE EXCEPTION 'hourly rate policy current state must have a matching event receipt'
            USING ERRCODE='23514', CONSTRAINT='hourly_rate_policy_receipt_required';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER hourly_rate_policy_receipt_guard
      AFTER INSERT OR UPDATE ON hourly_rate_policy DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION hourly_rate_policy_receipt_guard_fn()`);

    await q.query(`CREATE FUNCTION hourly_rate_policy_audit_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'hourly rate policy audit history is immutable'
          USING ERRCODE='23514', CONSTRAINT='hourly_rate_policy_audit_immutable';
      END
    $$`);
    await q.query(`CREATE TRIGGER hourly_rate_policy_request_immutable
      BEFORE UPDATE OR DELETE ON hourly_rate_policy_request
      FOR EACH ROW EXECUTE FUNCTION hourly_rate_policy_audit_immutable_fn()`);
    await q.query(`CREATE TRIGGER hourly_rate_policy_event_immutable
      BEFORE UPDATE OR DELETE ON hourly_rate_policy_event
      FOR EACH ROW EXECUTE FUNCTION hourly_rate_policy_audit_immutable_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM hourly_rate_policy_event LIMIT 1) THEN
      RAISE EXCEPTION 'HourlyRatePolicy down would discard immutable rate history'; END IF; END $$`);
    await q.query(`DROP TRIGGER IF EXISTS hourly_rate_policy_event_immutable ON hourly_rate_policy_event`);
    await q.query(`DROP TRIGGER IF EXISTS hourly_rate_policy_request_immutable ON hourly_rate_policy_request`);
    await q.query(`DROP FUNCTION IF EXISTS hourly_rate_policy_audit_immutable_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS hourly_rate_policy_event_transition_guard ON hourly_rate_policy_event`);
    await q.query(`DROP FUNCTION IF EXISTS hourly_rate_policy_event_transition_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS hourly_rate_policy_receipt_guard ON hourly_rate_policy`);
    await q.query(`DROP FUNCTION IF EXISTS hourly_rate_policy_receipt_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS hourly_rate_policy_row_guard ON hourly_rate_policy`);
    await q.query(`DROP FUNCTION IF EXISTS hourly_rate_policy_row_guard_fn()`);
    await q.query(`DROP TABLE hourly_rate_policy_event`);
    await q.query(`DROP TABLE hourly_rate_policy_request`);
    await q.query(`DROP TABLE hourly_rate_policy`);
  }
}
