/** @file-guide
 * 목적: BOC-04D-03c 컨설팅 생성·수정과 유형별 기본 항목 설정을 version/idempotency 원장으로 보호한다. (historical)
 * 책임/재사용: 과거 컨설팅은 추정 보정하지 않고 신규 writer부터 작성자·템플릿 snapshot을 남긴다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-04D3C-CONSULTING-WRITER-2026-10-08.md · docs/contracts/db/erd.dbml
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BOC-04D-03c 권고안 채택(2026-10-08): 기본 항목은 관리자 설정의 immutable version이며,
 * 미설정 유형은 시작을 막는다. 신규 CONS는 최초 등록자와 사용한 template/version을 보존한다.
 * 정책 변경 시 DTO/OpenAPI/generated schema, ConsultingStartForm/TemplateSettings, service,
 * DBML, P-BOC04D03C, 두 수정사항 대조표와 portfolio를 같은 청크에서 갱신한다.
 */
export class ConsultingWriter1766700000000 implements MigrationInterface {
  name = 'ConsultingWriter1766700000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE cons_template (
      id bigserial PRIMARY KEY, cons_type varchar(20) NOT NULL, version integer NOT NULL,
      active boolean NOT NULL DEFAULT true, created_by bigint REFERENCES staff(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT cons_template_version_positive CHECK (version >= 1),
      CONSTRAINT cons_template_type_version_uniq UNIQUE (cons_type,version))`);
    await q.query(`CREATE UNIQUE INDEX cons_template_active_type_once ON cons_template(cons_type) WHERE active`);
    await q.query(`CREATE TABLE cons_template_item (
      template_id bigint NOT NULL REFERENCES cons_template(id) ON DELETE RESTRICT,
      seq smallint NOT NULL, label varchar(80) NOT NULL, required boolean NOT NULL DEFAULT true,
      CONSTRAINT cons_template_item_pk PRIMARY KEY (template_id,seq),
      CONSTRAINT cons_template_item_seq_positive CHECK (seq >= 1),
      CONSTRAINT cons_template_item_label_nonempty CHECK (length(btrim(label)) > 0))`);
    await q.query(`INSERT INTO cons_template(cons_type,version,created_by) VALUES ('admissions',1,NULL)`);
    await q.query(`INSERT INTO cons_template_item(template_id,seq,label,required)
      SELECT t.id,x.seq,x.label,true FROM cons_template t
      CROSS JOIN (VALUES (1,'지원서 작성'),(2,'학업 성적 공증'),(3,'추천서 2부'),(4,'자기소개 에세이'),
        (5,'활동 증빙 자료'),(6,'여권 사본'),(7,'재학 증명서')) AS x(seq,label)
      WHERE t.cons_type='admissions' AND t.version=1`);

    await q.query(`ALTER TABLE cons ADD COLUMN created_by bigint REFERENCES staff(id) ON DELETE RESTRICT`);
    await q.query(`ALTER TABLE cons ADD COLUMN template_id bigint REFERENCES cons_template(id) ON DELETE RESTRICT`);
    await q.query(`ALTER TABLE cons ADD COLUMN row_version integer NOT NULL DEFAULT 1`);
    await q.query(`ALTER TABLE cons ADD CONSTRAINT cons_row_version_positive CHECK (row_version >= 1)`);
    await q.query(`CREATE TABLE cons_write_req (
      request_key uuid PRIMARY KEY, action varchar(16) NOT NULL, cons_id bigint NOT NULL REFERENCES cons(id) ON DELETE RESTRICT,
      fingerprint char(64) NOT NULL, result_version integer NOT NULL, actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT cons_write_req_action_check CHECK (action IN ('create','core','share')),
      CONSTRAINT cons_write_req_fingerprint_hex CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT cons_write_req_version_positive CHECK (result_version >= 1))`);
    await q.query(`CREATE INDEX cons_write_req_cons_idx ON cons_write_req(cons_id,created_at DESC,request_key)`);
    await q.query(`CREATE TABLE cons_template_write_req (
      request_key uuid PRIMARY KEY, cons_type varchar(20) NOT NULL,
      template_id bigint NOT NULL REFERENCES cons_template(id) ON DELETE RESTRICT,
      fingerprint char(64) NOT NULL, result_version integer NOT NULL,
      actor_id bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT cons_template_write_req_fingerprint_hex CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT cons_template_write_req_version_positive CHECK (result_version >= 1))`);
    await q.query(`CREATE FUNCTION cons_writer_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='INSERT' AND NEW.created_by IS NOT NULL THEN
          IF NEW.template_id IS NULL THEN RAISE EXCEPTION 'new consulting requires template snapshot'
            USING ERRCODE='23514', CONSTRAINT='cons_writer_template_required'; END IF;
          IF NOT EXISTS (SELECT 1 FROM cons_template t WHERE t.id=NEW.template_id AND t.cons_type=NEW.cons_type) THEN
            RAISE EXCEPTION 'consulting template type mismatch'
              USING ERRCODE='23514', CONSTRAINT='cons_writer_template_type'; END IF;
        END IF;
        IF TG_OP='UPDATE' AND OLD.created_by IS NOT NULL THEN
          IF NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.template_id IS DISTINCT FROM OLD.template_id THEN
            RAISE EXCEPTION 'consulting provenance is immutable'
              USING ERRCODE='23514', CONSTRAINT='cons_writer_provenance_immutable'; END IF;
          IF NEW.requester IS DISTINCT FROM OLD.requester OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
             OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.sessions IS DISTINCT FROM OLD.sessions
             OR NEW.start_on IS DISTINCT FROM OLD.start_on OR NEW.end_on IS DISTINCT FROM OLD.end_on
             OR NEW.share IS DISTINCT FROM OLD.share THEN
            IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'consulting row version must increase by exactly one'
              USING ERRCODE='23514', CONSTRAINT='cons_writer_version_step'; END IF;
          ELSIF NEW.row_version IS DISTINCT FROM OLD.row_version THEN RAISE EXCEPTION 'consulting row version cannot change alone'
            USING ERRCODE='23514', CONSTRAINT='cons_writer_version_without_change'; END IF;
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER cons_writer_guard BEFORE INSERT OR UPDATE ON cons FOR EACH ROW EXECUTE FUNCTION cons_writer_guard_fn()`);
    await q.query(`CREATE FUNCTION cons_writer_receipt_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='INSERT' AND NEW.created_by IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM cons_write_req r WHERE r.cons_id=NEW.id AND r.action='create' AND r.result_version=NEW.row_version
        ) THEN RAISE EXCEPTION 'consulting writer receipt required'
          USING ERRCODE='23514', CONSTRAINT='cons_writer_receipt_required'; END IF;
        IF TG_OP='UPDATE' AND NEW.row_version IS DISTINCT FROM OLD.row_version AND NOT EXISTS (
          SELECT 1 FROM cons_write_req r WHERE r.cons_id=NEW.id AND r.result_version=NEW.row_version
        ) THEN RAISE EXCEPTION 'consulting version receipt required'
          USING ERRCODE='23514', CONSTRAINT='cons_writer_version_receipt'; END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER cons_writer_receipt_guard AFTER INSERT OR UPDATE ON cons
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cons_writer_receipt_guard_fn()`);
    await q.query(`CREATE FUNCTION cons_template_receipt_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE item_count integer; min_seq integer; max_seq integer;
      BEGIN
        SELECT count(*)::integer,min(seq)::integer,max(seq)::integer INTO item_count,min_seq,max_seq
          FROM cons_template_item WHERE template_id=NEW.id;
        IF item_count < 1 OR item_count > 24 OR min_seq <> 1 OR max_seq <> item_count THEN
          RAISE EXCEPTION 'consulting template requires 1 to 24 contiguous items'
            USING ERRCODE='23514', CONSTRAINT='cons_template_items_complete'; END IF;
        IF NEW.created_by IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM cons_template_write_req r WHERE r.template_id=NEW.id AND r.result_version=NEW.version
        ) THEN RAISE EXCEPTION 'consulting template writer receipt required'
          USING ERRCODE='23514', CONSTRAINT='cons_template_receipt_required'; END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER cons_template_receipt_guard AFTER INSERT ON cons_template
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cons_template_receipt_guard_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM cons WHERE created_by IS NOT NULL OR template_id IS NOT NULL)
      OR EXISTS (SELECT 1 FROM cons_write_req)
      OR EXISTS (SELECT 1 FROM cons_template WHERE version > 1 OR cons_type <> 'admissions') THEN
      RAISE EXCEPTION 'ConsultingWriter down would discard writer provenance or configured templates'; END IF; END $$`);
    await q.query(`DROP TRIGGER IF EXISTS cons_template_receipt_guard ON cons_template`); await q.query(`DROP FUNCTION IF EXISTS cons_template_receipt_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS cons_writer_receipt_guard ON cons`); await q.query(`DROP FUNCTION IF EXISTS cons_writer_receipt_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS cons_writer_guard ON cons`); await q.query(`DROP FUNCTION IF EXISTS cons_writer_guard_fn()`);
    await q.query(`DROP TABLE cons_template_write_req`); await q.query(`DROP TABLE cons_write_req`);
    await q.query(`ALTER TABLE cons DROP CONSTRAINT cons_row_version_positive`);
    await q.query(`ALTER TABLE cons DROP COLUMN row_version, DROP COLUMN template_id, DROP COLUMN created_by`);
    await q.query(`DROP TABLE cons_template_item`); await q.query(`DROP INDEX cons_template_active_type_once`);
    await q.query(`DROP TABLE cons_template`);
  }
}
