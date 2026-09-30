/** @file-guide
 * 목적: ST1-b1 공유 COUNTRY/COUNTRY_TIMEZONE/EDUCATION_GRADE/SCHOOL 사전과 학교 identity 계약.
 * 책임/재사용: legacy STU/TZG/전화국가 계약은 그대로 두고 새 표만 더한다. seed 값은 버전 고정 소스와 공유한다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/contracts/db/student-registration-target.dbml
 */

import { MigrationInterface, QueryRunner } from 'typeorm';
import { GRADE_CODES_V1, seedStudentCatalogV1 } from './data/student-catalog-v1';

/** CHECK의 명시 허용 조합과 seed 조합은 같은 버전 고정 값에서 낸다. */
const gradeAllowedSql = Object.entries(GRADE_CODES_V1).map(([system, codes]) =>
  `(education_system='${system}' AND code IN (${codes.map((code) => `'${code}'`).join(',')}))`,
).join(' OR ');

export class StudentCatalog1765600000000 implements MigrationInterface {
  name = 'StudentCatalog1765600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE country (
      code char(2) PRIMARY KEY,
      name_ko varchar(60) NOT NULL,
      name_en varchar(80) NOT NULL,
      sort smallint NOT NULL,
      active boolean NOT NULL DEFAULT true,
      CONSTRAINT country_code_format CHECK (code ~ '^[A-Z]{2}$'),
      CONSTRAINT country_name_nonblank CHECK (length(btrim(name_ko)) > 0 AND length(btrim(name_en)) > 0),
      CONSTRAINT country_sort_nonnegative CHECK (sort >= 0)
    )`);

    await q.query(`CREATE TABLE country_timezone (
      country_code char(2) NOT NULL REFERENCES country(code),
      timezone varchar(64) NOT NULL,
      label_ko varchar(80) NOT NULL,
      is_representative boolean NOT NULL DEFAULT false,
      active boolean NOT NULL DEFAULT true,
      CONSTRAINT country_timezone_pk PRIMARY KEY (country_code, timezone),
      CONSTRAINT country_timezone_nonblank CHECK (length(btrim(timezone)) > 0 AND length(btrim(label_ko)) > 0)
    )`);
    await q.query(`CREATE UNIQUE INDEX country_timezone_representative
      ON country_timezone(country_code) WHERE active AND is_representative`);
    // pg_timezone_names는 현재 PostgreSQL의 IANA zone 목록이다. seed와 직접 SQL을 같은 DB guard로 검사한다.
    await q.query(`CREATE FUNCTION check_country_timezone_iana() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.timezone !~ '^[A-Za-z_]+(/[A-Za-z0-9_+\\-]+)+$'
           OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone) THEN
          RAISE EXCEPTION 'country_timezone_iana: invalid zone %', NEW.timezone USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER country_timezone_iana
      BEFORE INSERT OR UPDATE OF timezone ON country_timezone
      FOR EACH ROW EXECUTE FUNCTION check_country_timezone_iana()`);

    await q.query(`CREATE TABLE education_grade (
      education_system varchar(5) NOT NULL,
      code varchar(16) NOT NULL,
      label_ko varchar(30) NOT NULL,
      sort smallint NOT NULL,
      active boolean NOT NULL DEFAULT true,
      CONSTRAINT education_grade_pk PRIMARY KEY (education_system,code),
      CONSTRAINT education_grade_sort_unique UNIQUE (education_system,sort),
      CONSTRAINT education_grade_sort_nonnegative CHECK (sort >= 0),
      CONSTRAINT education_grade_label_nonblank CHECK (length(btrim(label_ko)) > 0),
      CONSTRAINT education_grade_code_allowed CHECK (${gradeAllowedSql})
    )`);

    // 한 함수가 generated key와 조회 경로를 함께 소유한다. NFC는 표시 문자열을 재작성하지 않는다.
    await q.query(`CREATE FUNCTION normalize_school_identity(raw text) RETURNS text
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
        SELECT normalize(lower(btrim(regexp_replace(normalize(raw, NFC), '[[:space:]]+', ' ', 'g'))), NFC)
      $$`);
    await q.query(`CREATE FUNCTION school_display_text(raw text) RETURNS text
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
        SELECT btrim(regexp_replace(raw, '[[:space:]]+', ' ', 'g'))
      $$`);
    await q.query(`CREATE TABLE school (
      id bigserial PRIMARY KEY,
      name varchar(120) NOT NULL,
      country_code char(2) REFERENCES country(code),
      region varchar(80),
      campus varchar(120),
      name_key text GENERATED ALWAYS AS (normalize_school_identity(name)) STORED NOT NULL,
      region_key text GENERATED ALWAYS AS (normalize_school_identity(coalesce(region,''))) STORED NOT NULL,
      campus_key text GENERATED ALWAYS AS (normalize_school_identity(coalesce(campus,''))) STORED NOT NULL,
      active boolean NOT NULL DEFAULT true,
      created_by bigint REFERENCES staff(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT school_name_nonblank CHECK (length(name_key) > 0),
      CONSTRAINT school_normalized_key_length CHECK (
        length(name_key) <= 120 AND length(region_key) <= 80 AND length(campus_key) <= 120
      )
    )`);
    await q.query(`CREATE UNIQUE INDEX school_identity
      ON school(name_key, (coalesce(country_code::text,'')), region_key, campus_key)`);
    await q.query(`CREATE INDEX school_name_search ON school(name_key)`);
    await q.query(`CREATE INDEX school_country ON school(country_code)`);
    await q.query(`CREATE FUNCTION normalize_school_display() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        NEW.name := school_display_text(NEW.name);
        NEW.region := nullif(school_display_text(NEW.region),'');
        NEW.campus := nullif(school_display_text(NEW.campus),'');
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER school_display_normalize
      BEFORE INSERT OR UPDATE OF name,region,campus ON school
      FOR EACH ROW EXECUTE FUNCTION normalize_school_display()`);

    // INSERT ON CONFLICT는 경합 승자를 기다린다. 그 뒤 별도 SELECT가 확정된 행을 본다.
    // 삭제/재시도 경합에도 무한 루프가 생기지 않게 시도 수를 제한한다.
    await q.query(`CREATE FUNCTION resolve_school(
      p_name text, p_country text, p_region text, p_campus text, p_actor bigint
    ) RETURNS bigint LANGUAGE plpgsql VOLATILE AS $$
    DECLARE
      v_name text := school_display_text(p_name);
      v_region text := nullif(school_display_text(p_region),'');
      v_campus text := nullif(school_display_text(p_campus),'');
      v_id bigint;
      v_active boolean;
      v_attempt smallint;
    BEGIN
      IF p_actor IS NULL THEN RAISE EXCEPTION 'school_actor_required' USING ERRCODE='23502'; END IF;
      IF v_name IS NULL OR length(v_name)=0 THEN RAISE EXCEPTION 'school_name_nonblank' USING ERRCODE='23514'; END IF;
      IF length(v_name)>120 THEN RAISE EXCEPTION 'school_name_length' USING ERRCODE='22001'; END IF;
      IF length(v_region)>80 THEN RAISE EXCEPTION 'school_region_length' USING ERRCODE='22001'; END IF;
      IF length(v_campus)>120 THEN RAISE EXCEPTION 'school_campus_length' USING ERRCODE='22001'; END IF;
      IF p_country IS NOT NULL AND p_country !~ '^[A-Z]{2}$' THEN
        RAISE EXCEPTION 'school_country_code_format' USING ERRCODE='23514';
      END IF;
      FOR v_attempt IN 1..3 LOOP
        v_id := NULL;
        INSERT INTO school(name,country_code,region,campus,created_by)
        VALUES (v_name,p_country,v_region,v_campus,p_actor)
        ON CONFLICT DO NOTHING RETURNING id INTO v_id;
        IF v_id IS NOT NULL THEN RETURN v_id; END IF;

        SELECT id,active INTO v_id,v_active FROM school
         WHERE name_key=normalize_school_identity(v_name)
           AND coalesce(country_code::text,'')=coalesce(p_country,'')
           AND region_key=normalize_school_identity(coalesce(v_region,''))
           AND campus_key=normalize_school_identity(coalesce(v_campus,''))
         FOR SHARE;
        IF FOUND THEN
          IF NOT v_active THEN
            RAISE EXCEPTION 'school_inactive: existing id %', v_id USING ERRCODE='23514';
          END IF;
          RETURN v_id;
        END IF;
      END LOOP;
      RAISE EXCEPTION 'school_identity_retry_exhausted' USING ERRCODE='40001';
    END $$`);

    await q.query(`CREATE FUNCTION reject_student_catalog_delete() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'catalog_hard_delete_forbidden: %', TG_TABLE_NAME USING ERRCODE='23514'; END $$`);
    for (const table of ['country', 'country_timezone', 'education_grade', 'school']) {
      await q.query(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION reject_student_catalog_delete()`);
    }

    await seedStudentCatalogV1(q);
  }

  public async down(q: QueryRunner): Promise<void> {
    // 참조·표시명·비활성 기록이 생긴 사전을 DROP하면 운영 데이터가 사라진다. 기본 복구는 roll-forward.
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM country) OR EXISTS (SELECT 1 FROM country_timezone)
        OR EXISTS (SELECT 1 FROM education_grade) OR EXISTS (SELECT 1 FROM school) THEN
        RAISE EXCEPTION 'StudentCatalog down would discard catalog data; roll forward instead';
      END IF;
    END $$`);
    await q.query(`DROP TABLE school`);
    await q.query(`DROP TABLE education_grade`);
    await q.query(`DROP TABLE country_timezone`);
    await q.query(`DROP TABLE country`);
    await q.query(`DROP FUNCTION resolve_school(text,text,text,text,bigint)`);
    await q.query(`DROP FUNCTION normalize_school_display()`);
    await q.query(`DROP FUNCTION school_display_text(text)`);
    await q.query(`DROP FUNCTION normalize_school_identity(text)`);
    await q.query(`DROP FUNCTION check_country_timezone_iana()`);
    await q.query(`DROP FUNCTION reject_student_catalog_delete()`);
  }
}
