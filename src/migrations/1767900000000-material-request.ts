/** @file-guide
 * 목적: BOC-08D-02 일반 자료요청의 현재 상태·불변 이력·요청/전달 파일 원장을 추가한다.
 * 책임/재사용: GPAPACK과 분리하며 최종 projection과 event, FILE 링크가 같은 트랜잭션에서 일치하도록 강제한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-08D2-MATERIAL-REQUEST-PERSISTENCE-2026-10-09.md · docs/contracts/db/erd.dbml
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BOC-08D-02 권고안 채택(2026-10-09): 첫 준비 관리자를 담당자로 고정하고 전달 완료는
 * 내부 FILE 첨부가 있을 때만 기록한다. 강사 수신 확인은 별도 event/version이다. 외부 메일·문자
 * 발송 성공을 만들지 않는다. 정책 변경 시 DTO/service/Front/DBML/R96/두 수정사항 대조표/portfolio를 함께 고친다.
 */
export class MaterialRequest1767900000000 implements MigrationInterface {
  name = 'MaterialRequest1767900000000';

  async up(q: QueryRunner): Promise<void> {
    // 일부 오래된 설치에는 초기 FILE 종류 CHECK가 없었다. 이름 부재가 전체 업그레이드를 막지 않게 정본 CHECK로 수렴한다.
    await q.query(`ALTER TABLE file DROP CONSTRAINT IF EXISTS file_kind_valid`);
    await q.query(`ALTER TABLE file ADD CONSTRAINT file_kind_valid CHECK (kind IN (
      'cons-contract','cons-item','lib-se','lib-te','expense-receipt','guide-png','report-png','meet-brief','material-request'
    ))`);

    await q.query(`CREATE TABLE material_request (
      id bigserial PRIMARY KEY,
      teacher_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      student_id bigint NOT NULL REFERENCES stu(id) ON DELETE RESTRICT,
      kind varchar(20) NOT NULL,
      needed_on date NOT NULL,
      body varchar(2000) NOT NULL,
      state varchar(16) NOT NULL DEFAULT 'received',
      row_version integer NOT NULL DEFAULT 1,
      request_key uuid NOT NULL,
      assigned_to bigint REFERENCES staff(id) ON DELETE RESTRICT,
      delivered_by bigint REFERENCES staff(id) ON DELETE RESTRICT,
      reject_reason varchar(500),
      delivered_at timestamptz,
      rejected_at timestamptz,
      acknowledged_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT material_request_teacher_key_unique UNIQUE(teacher_id,request_key),
      CONSTRAINT material_request_kind_words CHECK (kind IN ('book_pdf','worksheet','test_paper','other')),
      CONSTRAINT material_request_state_words CHECK (state IN ('received','preparing','delivered','rejected')),
      CONSTRAINT material_request_body_present CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
      CONSTRAINT material_request_version_positive CHECK (row_version >= 1),
      CONSTRAINT material_request_state_shape CHECK (
        (state='received' AND assigned_to IS NULL AND delivered_at IS NULL AND delivered_by IS NULL AND rejected_at IS NULL AND reject_reason IS NULL AND acknowledged_at IS NULL)
        OR (state='preparing' AND assigned_to IS NOT NULL AND delivered_at IS NULL AND delivered_by IS NULL AND rejected_at IS NULL AND reject_reason IS NULL AND acknowledged_at IS NULL)
        OR (state='delivered' AND assigned_to IS NOT NULL AND delivered_at IS NOT NULL AND delivered_by IS NOT NULL AND rejected_at IS NULL AND reject_reason IS NULL)
        OR (state='rejected' AND rejected_at IS NOT NULL AND length(btrim(reject_reason)) >= 2 AND delivered_at IS NULL AND delivered_by IS NULL AND acknowledged_at IS NULL)
      )
    )`);
    await q.query(`CREATE INDEX material_request_state_needed_idx ON material_request(state,needed_on,id)`);
    await q.query(`CREATE INDEX material_request_teacher_created_idx ON material_request(teacher_id,created_at,id)`);

    await q.query(`CREATE TABLE material_request_event (
      id bigserial PRIMARY KEY,
      material_request_id bigint NOT NULL REFERENCES material_request(id) ON DELETE CASCADE,
      action varchar(20) NOT NULL,
      from_state varchar(16),
      to_state varchar(16) NOT NULL,
      reason varchar(500),
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      request_key uuid NOT NULL,
      payload_sha256 char(64) NOT NULL,
      result_version integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT material_request_event_request_key_unique UNIQUE(request_key),
      CONSTRAINT material_request_event_version_unique UNIQUE(material_request_id,result_version),
      CONSTRAINT material_request_event_action_words CHECK (action IN ('created','preparing','delivered','rejected','acknowledged')),
      CONSTRAINT material_request_event_state_words CHECK (
        to_state IN ('received','preparing','delivered','rejected')
        AND (from_state IS NULL OR from_state IN ('received','preparing','delivered','rejected'))
      ),
      CONSTRAINT material_request_event_payload_sha CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT material_request_event_result_version_positive CHECK (result_version >= 1),
      CONSTRAINT material_request_event_shape CHECK (
        (action='created' AND from_state IS NULL AND to_state='received' AND result_version=1 AND reason IS NULL)
        OR (action='preparing' AND from_state='received' AND to_state='preparing' AND reason IS NULL)
        OR (action='delivered' AND from_state='preparing' AND to_state='delivered' AND reason IS NULL)
        OR (action='rejected' AND from_state IN ('received','preparing') AND to_state='rejected' AND length(btrim(reason)) >= 2)
        OR (action='acknowledged' AND from_state='delivered' AND to_state='delivered' AND reason IS NULL)
      )
    )`);
    await q.query(`CREATE INDEX material_request_event_request_idx ON material_request_event(material_request_id,created_at,id)`);

    await q.query(`CREATE TABLE material_request_file (
      id bigserial PRIMARY KEY,
      material_request_id bigint NOT NULL REFERENCES material_request(id) ON DELETE CASCADE,
      event_id bigint NOT NULL REFERENCES material_request_event(id) ON DELETE CASCADE,
      file_id bigint NOT NULL REFERENCES file(id) ON DELETE RESTRICT,
      purpose varchar(12) NOT NULL,
      added_by bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT material_request_file_once UNIQUE(file_id),
      CONSTRAINT material_request_file_purpose_words CHECK (purpose IN ('request','delivery'))
    )`);
    await q.query(`CREATE INDEX material_request_file_request_idx ON material_request_file(material_request_id,purpose,id)`);

    await q.query(`CREATE FUNCTION material_request_file_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE event_action varchar(20); event_request bigint; file_kind varchar(24);
      BEGIN
        SELECT action,material_request_id INTO event_action,event_request FROM material_request_event WHERE id=NEW.event_id;
        SELECT kind INTO file_kind FROM file WHERE id=NEW.file_id;
        IF event_request IS DISTINCT FROM NEW.material_request_id OR file_kind IS DISTINCT FROM 'material-request' THEN
          RAISE EXCEPTION 'material request file must match its request and FILE.kind'
            USING ERRCODE='23514', CONSTRAINT='material_request_file_link';
        END IF;
        IF (NEW.purpose='request' AND event_action<>'created') OR (NEW.purpose='delivery' AND event_action<>'delivered') THEN
          RAISE EXCEPTION 'material request file purpose must match its event'
            USING ERRCODE='23514', CONSTRAINT='material_request_file_event';
        END IF;
        RETURN NEW;
      END
    $$`);
    await q.query(`CREATE TRIGGER material_request_file_guard BEFORE INSERT OR UPDATE ON material_request_file
      FOR EACH ROW EXECUTE FUNCTION material_request_file_guard_fn()`);

    await q.query(`CREATE FUNCTION material_request_row_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='UPDATE' THEN
          IF NEW.teacher_id<>OLD.teacher_id OR NEW.student_id<>OLD.student_id OR NEW.kind<>OLD.kind
             OR NEW.needed_on<>OLD.needed_on OR NEW.body<>OLD.body OR NEW.request_key<>OLD.request_key THEN
            RAISE EXCEPTION 'material request identity is immutable'
              USING ERRCODE='23514', CONSTRAINT='material_request_immutable';
          END IF;
          IF NEW.row_version<>OLD.row_version+1 THEN
            RAISE EXCEPTION 'material request version must advance exactly once'
              USING ERRCODE='23514', CONSTRAINT='material_request_version_step';
          END IF;
          IF OLD.assigned_to IS NOT NULL AND NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
            RAISE EXCEPTION 'material request assignee is immutable after preparing starts'
              USING ERRCODE='23514', CONSTRAINT='material_request_assignee_immutable';
          END IF;
          IF OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN
            RAISE EXCEPTION 'material request acknowledgement is immutable'
              USING ERRCODE='23514', CONSTRAINT='material_request_ack_immutable';
          END IF;
        END IF;
        IF NEW.acknowledged_at IS NOT NULL AND NEW.state<>'delivered' THEN
          RAISE EXCEPTION 'only delivered material can be acknowledged'
            USING ERRCODE='23514', CONSTRAINT='material_request_ack_delivered';
        END IF;
        NEW.updated_at := now();
        RETURN NEW;
      END
    $$`);
    await q.query(`CREATE TRIGGER material_request_row_guard BEFORE INSERT OR UPDATE ON material_request
      FOR EACH ROW EXECUTE FUNCTION material_request_row_guard_fn()`);

    await q.query(`CREATE FUNCTION material_request_event_complete_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM material_request_event e
           WHERE e.material_request_id=NEW.id AND e.result_version=NEW.row_version AND e.to_state=NEW.state
             AND ((NEW.row_version=1 AND e.action='created')
               OR (NEW.row_version>1 AND e.action IN ('preparing','delivered','rejected','acknowledged')))
        ) THEN
          RAISE EXCEPTION 'material request final state must have an event receipt'
            USING ERRCODE='23514', CONSTRAINT='material_request_event_complete';
        END IF;
        IF NEW.state='delivered' AND NOT EXISTS (
          SELECT 1 FROM material_request_file f WHERE f.material_request_id=NEW.id AND f.purpose='delivery'
        ) THEN
          RAISE EXCEPTION 'delivered material request requires an internal file'
            USING ERRCODE='23514', CONSTRAINT='material_request_delivery_file';
        END IF;
        RETURN NULL;
      END
    $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER material_request_event_complete
      AFTER INSERT OR UPDATE ON material_request DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION material_request_event_complete_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM material_request) THEN
        RAISE EXCEPTION 'MaterialRequest down would discard request, file, or acknowledgement history';
      END IF;
    END $$`);
    await q.query(`DROP TRIGGER IF EXISTS material_request_event_complete ON material_request`);
    await q.query(`DROP FUNCTION IF EXISTS material_request_event_complete_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS material_request_row_guard ON material_request`);
    await q.query(`DROP FUNCTION IF EXISTS material_request_row_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS material_request_file_guard ON material_request_file`);
    await q.query(`DROP FUNCTION IF EXISTS material_request_file_guard_fn()`);
    await q.query(`DROP TABLE material_request_file`);
    await q.query(`DROP TABLE material_request_event`);
    await q.query(`DROP TABLE material_request`);
    await q.query(`ALTER TABLE file DROP CONSTRAINT IF EXISTS file_kind_valid`);
    await q.query(`ALTER TABLE file ADD CONSTRAINT file_kind_valid CHECK (kind IN (
      'cons-contract','cons-item','lib-se','lib-te','expense-receipt','guide-png','report-png','meet-brief'
    ))`);
  }
}
