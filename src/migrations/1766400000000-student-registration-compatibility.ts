/** @file-guide
 * 목적: BOC-03D-04c 전수 회귀에서 확인한 학교 Unicode identity와 legacy 보호자 직접 쓰기 호환성을 복구한다.
 * 책임/재사용: 학교 identity는 DB 기본 locale과 무관하게 ICU 소문자 규칙을 쓰고, contract=0 보호자는 기존 scalar 연락처 제약을 유지한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-03D4C-STUDENT-REGISTRATION-BROWSER-2026-10-07.md · docs/contracts/db/student-registration-target.dbml
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class StudentRegistrationCompatibility1766400000000 implements MigrationInterface {
  name = 'StudentRegistrationCompatibility1766400000000';

  public async up(q: QueryRunner): Promise<void> {
    /*
     * BOC-03D-04c 권고안 채택(2026-10-07): school identity의 대소문자 규칙을 DB 생성 locale에
     * 맡기지 않는다. C locale에서도 CAFÉ와 Café가 같은 key가 되도록 명시적 ICU collation을 쓴다.
     */
    await q.query(`CREATE OR REPLACE FUNCTION normalize_school_identity(raw text) RETURNS text
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
        SELECT normalize(lower(btrim(regexp_replace(normalize(raw, NFC), '[[:space:]]+', ' ', 'g')) COLLATE "und-x-icu"), NFC)
      $$`);
    // stored generated column과 그 unique index도 새 함수 값으로 다시 계산한다. 충돌이 있으면 migration 전체가 원자적으로 실패한다.
    await q.query(`UPDATE school SET name=name, region=region, campus=campus`);

    /*
     * BOC-03D-04c 권고안 채택: contract=1 writer는 guardian_contact를 같은 transaction에서 쓰므로
     * scalar email/phone 없이 시작할 수 있다. 기존 contract=0 API·직접 쓰기는 종전 즉시 제약을 유지한다.
     */
    await q.query(`CREATE FUNCTION guardian_legacy_contact_required() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.email IS NULL AND NEW.phone IS NULL
          AND NOT is_registration_student(NEW.student_id) THEN
          RAISE EXCEPTION 'guardian_contact_present' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER guardian_legacy_contact_required
      BEFORE INSERT OR UPDATE OF student_id,email,phone ON guardian
      FOR EACH ROW EXECUTE FUNCTION guardian_legacy_contact_required()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER guardian_legacy_contact_required ON guardian`);
    await q.query(`DROP FUNCTION guardian_legacy_contact_required()`);
    await q.query(`CREATE OR REPLACE FUNCTION normalize_school_identity(raw text) RETURNS text
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
        SELECT normalize(lower(btrim(regexp_replace(normalize(raw, NFC), '[[:space:]]+', ' ', 'g'))), NFC)
      $$`);
    await q.query(`UPDATE school SET name=name, region=region, campus=campus`);
  }
}
