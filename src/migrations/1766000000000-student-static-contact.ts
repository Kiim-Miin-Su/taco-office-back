/** @file-guide
 * 목적: BOC-03D-04a 학생 선택 정적 칸과 학생 본인 연락처의 additive DB 형상.
 * 책임/재사용: 기존 STU/보호자 writer와 옛 행을 보존한다. 신규 15절 필수·연락처 API/감사 writer는 후속이다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/contracts/db/student-registration-target.dbml
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class StudentStaticContact1766000000000 implements MigrationInterface {
  name = 'StudentStaticContact1766000000000';

  public async up(q: QueryRunner): Promise<void> {
    // BOC-03D-04a 권고안 채택(2026-10-07): legacy 행은 NULL/0행으로 보존하고 신규 writer만 이 형상을 사용한다.
    // 정책 변경 시 StudentCreateDto, Stu/StuContact, P-STU15, BOC-03 시나리오와 target/current DBML을 함께 수정한다.
    // 기존 학생과 옛 Back의 INSERT는 새 선택 칸을 모두 NULL로 둔다. 신규 필수 계약은 아직 켜지 않는다.
    await q.query(`ALTER TABLE stu
      ADD COLUMN english_name varchar(80),
      ADD COLUMN birth_date date,
      ADD COLUMN has_citizenship boolean,
      ADD COLUMN source varchar(10)`);
    await q.query(`ALTER TABLE stu ADD CONSTRAINT stu_english_name_present CHECK (
      english_name IS NULL OR (english_name = btrim(english_name) AND length(english_name) > 0))`);
    await q.query(`ALTER TABLE stu ADD CONSTRAINT stu_source_words CHECK (
      source IS NULL OR source IN ('kakao','phone','blog','instagram','referral','walkin'))`);
    // 오늘이라는 변하는 값은 영구 CHECK에 둘 수 없다. 실제 birth_date 쓰기 때만 KST 기준으로 검사한다.
    await q.query(`CREATE FUNCTION student_birth_date_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.birth_date IS NOT NULL AND NEW.birth_date > (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date THEN
          RAISE EXCEPTION 'stu_birth_date_future' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER stu_birth_date_guard
      BEFORE INSERT OR UPDATE OF birth_date ON stu
      FOR EACH ROW EXECUTE FUNCTION student_birth_date_guard()`);

    // 저장 형식이 정규화된 phone/kakao/other는 대소문자를 바꾸지 않는다. email만 대소문자 무시 identity다.
    await q.query(`CREATE FUNCTION canonical_contact_value(p_kind text, p_value text)
      RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
        SELECT CASE WHEN p_kind = 'email' THEN lower(p_value) ELSE p_value END
      $$`);
    await q.query(`CREATE TABLE stu_contact (
      id bigserial PRIMARY KEY,
      student_id bigint NOT NULL REFERENCES stu(id),
      kind varchar(5) NOT NULL,
      value varchar(254) NOT NULL,
      label varchar(80),
      active boolean NOT NULL DEFAULT true,
      created_by bigint NOT NULL REFERENCES staff(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT stu_contact_kind CHECK (kind IN ('phone','kakao','email','other')),
      CONSTRAINT stu_contact_value CHECK (value = btrim(value) AND length(value) > 0),
      CONSTRAINT stu_contact_label CHECK (
        (kind = 'other' AND label IS NOT NULL AND label = btrim(label) AND length(label) > 0)
        OR (kind <> 'other' AND label IS NULL)
      ),
      CONSTRAINT stu_contact_email_shape CHECK (
        kind <> 'email' OR value ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]{2,}$'
      ),
      CONSTRAINT stu_contact_phone_shape CHECK (
        kind <> 'phone' OR value ~ '^0[0-9]{9,10}$' OR value ~ '^\\+[1-9][0-9]{7,14}$'
      )
    )`);
    await q.query(`CREATE INDEX stu_contact_owner_active ON stu_contact(student_id, active)`);
    await q.query(`CREATE UNIQUE INDEX stu_contact_active_identity ON stu_contact(
      student_id, kind, canonical_contact_value(kind, value), (coalesce(label,''))) WHERE active`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // 연락처/새 정적 값이 하나라도 있으면 이전 형상은 이를 표현할 수 없다. 파괴적 down 대신 거절한다.
    const [row] = await q.query(`SELECT
      EXISTS (SELECT 1 FROM stu_contact) AS contacts,
      EXISTS (SELECT 1 FROM stu WHERE english_name IS NOT NULL OR birth_date IS NOT NULL
        OR has_citizenship IS NOT NULL OR source IS NOT NULL) AS static_values`) as Array<{ contacts: boolean; static_values: boolean }>;
    if (row.contacts || row.static_values) throw new Error('student static/contact down would discard stored data');
    await q.query(`DROP TABLE stu_contact`);
    await q.query(`DROP FUNCTION canonical_contact_value(text,text)`);
    await q.query(`DROP TRIGGER stu_birth_date_guard ON stu`);
    await q.query(`DROP FUNCTION student_birth_date_guard()`);
    await q.query(`ALTER TABLE stu DROP CONSTRAINT stu_source_words`);
    await q.query(`ALTER TABLE stu DROP CONSTRAINT stu_english_name_present`);
    await q.query(`ALTER TABLE stu DROP COLUMN source, DROP COLUMN has_citizenship,
      DROP COLUMN birth_date, DROP COLUMN english_name`);
  }
}
