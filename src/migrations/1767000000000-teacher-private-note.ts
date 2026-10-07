/** @file-guide
 * 목적: BOC-09D-03 강사 작성·관리자 전용 특이사항 원장과 멱등 쓰기 영수증을 추가한다. (historical)
 * 책임/재사용: 기존 NOTE를 재사용하지 않고 회차·학생·작성자·version·requestKey·직접쓰기 방어를 소유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-09-SCENARIOS-2026-10-07.md · docs/contracts/db/erd.dbml
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 권고안 채택(BOC-09D-03, 2026-10-08): 기존 NOTE는 관리자→강사 인계이므로 재사용하지 않는다.
 * 정책 변경 시 전용 DTO/service, TeacherPrivateNoteDraft, 관리자 학생 모음, 두 DBML, 두 수정사항
 * 대조표와 portfolio를 같은 청크에서 고친다.
 */
export class TeacherPrivateNote1767000000000 implements MigrationInterface {
  name = 'TeacherPrivateNote1767000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE teacher_private_note (
      id bigserial PRIMARY KEY,
      student_id bigint NOT NULL,
      ser_id bigint NOT NULL,
      on_date date NOT NULL,
      author_id bigint NOT NULL,
      body text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT teacher_private_note_student_fk FOREIGN KEY(student_id) REFERENCES stu(id) ON DELETE RESTRICT,
      CONSTRAINT teacher_private_note_ser_fk FOREIGN KEY(ser_id) REFERENCES ser(id) ON DELETE RESTRICT,
      CONSTRAINT teacher_private_note_author_fk FOREIGN KEY(author_id) REFERENCES staff(id) ON DELETE RESTRICT,
      CONSTRAINT teacher_private_note_target_unique UNIQUE(author_id,ser_id,on_date,student_id),
      CONSTRAINT teacher_private_note_body_len CHECK(char_length(btrim(body)) BETWEEN 1 AND 2000),
      CONSTRAINT teacher_private_note_version_positive CHECK(version >= 1)
    )`);
    await q.query(`CREATE INDEX teacher_private_note_student_idx ON teacher_private_note(student_id,updated_at DESC,id DESC)`);
    await q.query(`CREATE INDEX teacher_private_note_author_idx ON teacher_private_note(author_id,updated_at DESC,id DESC)`);
    await q.query(`CREATE TABLE teacher_private_note_write_req (
      request_key uuid PRIMARY KEY,
      note_id bigint NOT NULL,
      fingerprint char(64) NOT NULL,
      result_version integer NOT NULL,
      actor_id bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT teacher_private_note_write_req_note_fk FOREIGN KEY(note_id) REFERENCES teacher_private_note(id) ON DELETE CASCADE,
      CONSTRAINT teacher_private_note_write_req_actor_fk FOREIGN KEY(actor_id) REFERENCES staff(id) ON DELETE RESTRICT,
      CONSTRAINT teacher_private_note_write_req_fingerprint_hex CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT teacher_private_note_write_req_version_positive CHECK(result_version >= 1)
    )`);
    await q.query(`CREATE INDEX teacher_private_note_write_req_note_idx ON teacher_private_note_write_req(note_id,created_at DESC)`);
    await q.query(`CREATE FUNCTION teacher_private_note_version_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.body IS DISTINCT FROM OLD.body THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'teacher private note version must increase by exactly one'
              USING ERRCODE='23514', CONSTRAINT='teacher_private_note_version_step';
          END IF;
          NEW.updated_at := now();
        ELSIF NEW.version IS DISTINCT FROM OLD.version THEN
          RAISE EXCEPTION 'teacher private note version cannot change without body'
            USING ERRCODE='23514', CONSTRAINT='teacher_private_note_version_without_change';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER teacher_private_note_version_guard
      BEFORE UPDATE OF body,version ON teacher_private_note
      FOR EACH ROW EXECUTE FUNCTION teacher_private_note_version_guard_fn()`);
    await q.query(`CREATE FUNCTION teacher_private_note_receipt_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM teacher_private_note_write_req r
           WHERE r.note_id=NEW.id AND r.actor_id=NEW.author_id AND r.result_version=NEW.version
        ) THEN
          RAISE EXCEPTION 'teacher private note write receipt is required'
            USING ERRCODE='23514', CONSTRAINT='teacher_private_note_receipt_required';
        END IF;
        RETURN NULL;
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER teacher_private_note_receipt_guard
      AFTER INSERT OR UPDATE OF body,version ON teacher_private_note
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION teacher_private_note_receipt_guard_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS teacher_private_note_receipt_guard ON teacher_private_note`);
    await q.query(`DROP FUNCTION IF EXISTS teacher_private_note_receipt_guard_fn()`);
    await q.query(`DROP TRIGGER IF EXISTS teacher_private_note_version_guard ON teacher_private_note`);
    await q.query(`DROP FUNCTION IF EXISTS teacher_private_note_version_guard_fn()`);
    await q.query(`DROP TABLE IF EXISTS teacher_private_note_write_req`);
    await q.query(`DROP TABLE IF EXISTS teacher_private_note`);
  }
}
