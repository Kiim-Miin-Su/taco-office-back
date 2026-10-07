/** @file-guide
 * 목적: BOC-04D-03d 컨설팅 청구 전환을 versioned/idempotent writer로 만든다.
 * 책임/재사용: 기존 CONS_WRITE_REQ와 CONS row_version을 aggregate 계약으로 확장한다.
 * 검증/작업 지침: DTO/OpenAPI/generated schema/Front useRequestKey/DBML/P-BOC04D03D를 함께 대조한다.
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConsultingInvoiceWriter1766800000000 implements MigrationInterface {
  name = 'ConsultingInvoiceWriter1766800000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE cons_write_req ADD COLUMN result_ref_id bigint REFERENCES inv(id) ON DELETE RESTRICT`);
    await q.query(`ALTER TABLE cons_write_req DROP CONSTRAINT cons_write_req_action_check`);
    await q.query(`ALTER TABLE cons_write_req ADD CONSTRAINT cons_write_req_action_check CHECK (action IN ('create','core','share','invoice'))`);
    await q.query(`CREATE OR REPLACE FUNCTION cons_writer_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
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
          ELSIF NEW.row_version IS DISTINCT FROM OLD.row_version THEN
            IF NEW.row_version <> OLD.row_version + 1 OR NOT EXISTS (
              SELECT 1 FROM cons_write_req r WHERE r.cons_id=NEW.id AND r.action='invoice' AND r.result_version=NEW.row_version
            ) THEN RAISE EXCEPTION 'consulting row version cannot change alone'
              USING ERRCODE='23514', CONSTRAINT='cons_writer_version_without_change'; END IF;
          END IF;
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE FUNCTION cons_invoice_receipt_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.cs_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.cs_id IS DISTINCT FROM OLD.cs_id) AND NOT EXISTS (
          SELECT 1 FROM cons_write_req r
           WHERE r.cons_id=NEW.cs_id AND r.action='invoice' AND r.result_ref_id=NEW.id
        ) THEN RAISE EXCEPTION 'consulting invoice writer receipt required'
          USING ERRCODE='23514', CONSTRAINT='cons_invoice_receipt_required'; END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER cons_invoice_receipt_guard AFTER INSERT OR UPDATE OF cs_id ON inv
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cons_invoice_receipt_guard_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM cons_write_req WHERE action='invoice') THEN
      RAISE EXCEPTION 'ConsultingInvoiceWriter down would discard invoice writer receipts'; END IF; END $$`);
    await q.query(`DROP TRIGGER IF EXISTS cons_invoice_receipt_guard ON inv`);
    await q.query(`DROP FUNCTION IF EXISTS cons_invoice_receipt_guard_fn()`);
    await q.query(`CREATE OR REPLACE FUNCTION cons_writer_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
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
    await q.query(`ALTER TABLE cons_write_req DROP CONSTRAINT cons_write_req_action_check`);
    await q.query(`ALTER TABLE cons_write_req ADD CONSTRAINT cons_write_req_action_check CHECK (action IN ('create','core','share'))`);
    await q.query(`ALTER TABLE cons_write_req DROP COLUMN result_ref_id`);
  }
}
