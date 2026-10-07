/** @file-guide
 * 목적: BO-09D-02 학생 Kinder 명시 표식의 append-only 효력 이력과 계산 조회 정본을 추가한다.
 * 책임/재사용: 학년·나이 파생을 금지하고 실제 수업 시작 시각에 유효한 마지막 event만 공유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-09D2-PAYOUT-CALCULATOR-2026-10-08.md · docs/contracts/db/erd.dbml
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 권고안 채택(2026-10-08): Kinder 여부는 STU.grade가 아니라 별도 version event다. 과거 event는 수정/삭제하지 않고
 * 미래 effective_from event를 추가한다. 계산·명단·리포트 계약이 바뀌면 서비스/DTO/OpenAPI/generated type,
 * current+snapshot DBML, 두 수정사항 대조표, scenario, portfolio를 같은 청크에서 갱신한다.
 */
export class StudentKinderMarker1767100000000 implements MigrationInterface {
  name = 'StudentKinderMarker1767100000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE stu_kinder_marker (
      id bigserial PRIMARY KEY,
      student_id bigint NOT NULL REFERENCES stu(id) ON DELETE RESTRICT,
      version integer NOT NULL,
      marked boolean NOT NULL,
      effective_from timestamptz NOT NULL,
      reason text,
      set_by bigint NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT stu_kinder_marker_version_positive CHECK (version >= 1),
      CONSTRAINT stu_kinder_marker_reason CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
      CONSTRAINT stu_kinder_marker_student_version_uniq UNIQUE (student_id, version),
      CONSTRAINT stu_kinder_marker_student_effective_uniq UNIQUE (student_id, effective_from)
    )`);
    await q.query(`CREATE INDEX stu_kinder_marker_effective_lookup
      ON stu_kinder_marker(student_id,effective_from DESC,version DESC)`);
    await q.query(`CREATE FUNCTION stu_kinder_marker_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE next_version integer;
      BEGIN
        PERFORM 1 FROM stu WHERE id=NEW.student_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'kinder marker student missing'
            USING ERRCODE='23503', CONSTRAINT='stu_kinder_marker_student_fk';
        END IF;
        SELECT COALESCE(max(version),0)+1 INTO next_version FROM stu_kinder_marker WHERE student_id=NEW.student_id;
        IF NEW.version <> next_version THEN
          RAISE EXCEPTION 'kinder marker version must advance by one'
            USING ERRCODE='23514', CONSTRAINT='stu_kinder_marker_version_step';
        END IF;
        IF NEW.effective_from < current_timestamp THEN
          RAISE EXCEPTION 'kinder marker can only affect future actual starts'
            USING ERRCODE='23514', CONSTRAINT='stu_kinder_marker_future_only';
        END IF;
        NEW.created_at := clock_timestamp();
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER stu_kinder_marker_insert_guard BEFORE INSERT ON stu_kinder_marker
      FOR EACH ROW EXECUTE FUNCTION stu_kinder_marker_insert_guard_fn()`);
    await q.query(`CREATE FUNCTION stu_kinder_marker_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'kinder marker history is immutable'
          USING ERRCODE='23514', CONSTRAINT='stu_kinder_marker_immutable';
      END $$`);
    await q.query(`CREATE TRIGGER stu_kinder_marker_no_change BEFORE UPDATE OR DELETE ON stu_kinder_marker
      FOR EACH ROW EXECUTE FUNCTION stu_kinder_marker_immutable_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM stu_kinder_marker) THEN
        RAISE EXCEPTION 'StudentKinderMarker down would discard marker history';
      END IF;
    END $$`);
    await q.query(`DROP TRIGGER stu_kinder_marker_no_change ON stu_kinder_marker`);
    await q.query(`DROP FUNCTION stu_kinder_marker_immutable_fn()`);
    await q.query(`DROP TRIGGER stu_kinder_marker_insert_guard ON stu_kinder_marker`);
    await q.query(`DROP FUNCTION stu_kinder_marker_insert_guard_fn()`);
    await q.query(`DROP TABLE stu_kinder_marker`);
  }
}
