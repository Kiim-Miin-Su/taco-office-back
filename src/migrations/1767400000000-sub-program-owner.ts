/** @file-guide
 * 목적: 최종 관리자 수정사항 p6·p26의 과목당 단일 프로그램, 이름 중복 방지와 신규 8색을 DB에 고정한다. (migration)
 * 책임/재사용: 기존 21종은 명세의 대응표로 이관하고 custom legacy는 단일 실제 사용만 연결한다. 미연결·불일치는 읽기 보존한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-01D1-SUBJECT-PROGRAM-CONTRACT-2026-10-08.md · docs/contracts/db/erd.dbml
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

const CANONICAL = [
  ['map-read', 'class'], ['map-math', 'class'], ['sat-read', 'class'], ['sat-math', 'class'],
  ['writing', 'class'], ['vocab', 'class'], ['ap-chem', 'class'], ['interview', 'class'], ['read-lab', 'class'],
  ['study-room', 'study'], ['gpa-care', 'gpa'], ['mock-sat', 'mock'], ['mock-map', 'mock'],
  ['diag', 'diagx'], ['intake', 'consult'], ['admissions', 'consulting'],
  ['mt-pl', 'meeting'], ['mt-cs', 'meeting'], ['mt-mk', 'meeting'], ['mt-dv', 'meeting'], ['mt-pg', 'meeting'],
] as const;

const CANONICAL_VALUES = CANONICAL.map(([key, kind]) => `('${key}','${kind}')`).join(',');

/**
 * BOC-01D-01 권고안 채택(2026-10-08): 과목은 KIND 하나를 소유한다. 명세서 v2의 21종은 고정 대응표로
 * 이관하고, 그 밖의 legacy는 실제 참조가 정확히 한 KIND일 때만 연결한다. 불명확한 행을 추정하지 않는다.
 * 정책 변경 시 catalog DTO/service, Meta/OpenAPI/generated Front, seed/entity, 두 DBML, PPTX 교차표와 portfolio를 함께 갱신한다.
 */
export class SubProgramOwner1767400000000 implements MigrationInterface {
  name = 'SubProgramOwner1767400000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE sub ADD COLUMN kind_key varchar(16)`);
    await q.query(`ALTER TABLE sub ADD CONSTRAINT sub_kind_fk FOREIGN KEY (kind_key) REFERENCES kind(key) ON DELETE RESTRICT`);

    // 명세서 v2 §88~89와 최종 관리자 p6·p26의 확정 대응. 실제 사용이 오염돼도 역사 회차를 자동 수정하지 않는다.
    await q.query(`UPDATE sub s SET kind_key=v.kind_key
      FROM (VALUES ${CANONICAL_VALUES}) AS v(key,kind_key)
      WHERE s.key=v.key`);

    // 확정표 밖 custom legacy는 SER/ENR/RATE/LEAD_PLAN의 실제 KIND가 정확히 하나일 때만 안전하게 연결한다.
    await q.query(`WITH uses AS (
        SELECT sub_key,kind_key FROM ser WHERE sub_key IS NOT NULL
        UNION ALL SELECT sub_key,kind_key FROM enr WHERE sub_key IS NOT NULL
        UNION ALL SELECT sub_key,kind_key FROM rate WHERE sub_key IS NOT NULL
        UNION ALL SELECT sub_key,kind_key FROM lead_plan WHERE sub_key IS NOT NULL
      ), one_kind AS (
        SELECT sub_key,min(kind_key) AS kind_key FROM uses GROUP BY sub_key HAVING count(DISTINCT kind_key)=1
      )
      UPDATE sub s SET kind_key=o.kind_key FROM one_kind o
      WHERE s.key=o.sub_key AND s.kind_key IS NULL`);

    await q.query(`CREATE INDEX sub_kind_lookup ON sub(kind_key,active,sort,key)`);
    await q.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM sub GROUP BY lower(btrim(name)) HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'SubProgramOwner requires normalized subject names to be unique';
      END IF;
    END $$`);
    await q.query(`CREATE UNIQUE INDEX sub_name_normalized_uniq ON sub(lower(btrim(name)))`);

    await q.query(`CREATE FUNCTION sub_program_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        allowed_colors constant text[] := ARRAY['#A85764','#B57046','#4A7FB5','#3E8E5E','#7C5CB5','#C08A2E','#2F8F8A','#8B6B5A'];
        canonical_pair boolean;
      BEGIN
        SELECT EXISTS (
          SELECT 1 FROM (VALUES ${CANONICAL_VALUES}) AS v(key,kind_key)
          WHERE v.key=NEW.key AND v.kind_key=NEW.kind_key
        ) INTO canonical_pair;

        IF TG_OP='INSERT' AND NEW.kind_key IS NULL THEN
          RAISE EXCEPTION 'SUB_PROGRAM_REQUIRED' USING ERRCODE='23514', CONSTRAINT='sub_program_required';
        END IF;
        IF TG_OP='UPDATE' AND OLD.kind_key IS NOT NULL AND NEW.kind_key IS NULL THEN
          RAISE EXCEPTION 'SUB_PROGRAM_REQUIRED' USING ERRCODE='23514', CONSTRAINT='sub_program_required';
        END IF;
        IF NEW.kind_key='gpa' AND NOT canonical_pair
           AND (TG_OP='INSERT' OR NEW.kind_key IS DISTINCT FROM OLD.kind_key) THEN
          RAISE EXCEPTION 'SUB_PROGRAM_RETIRED' USING ERRCODE='23514', CONSTRAINT='sub_program_retired';
        END IF;
        IF TG_OP='INSERT' AND NOT canonical_pair AND upper(btrim(NEW.color::text)) <> ALL(allowed_colors) THEN
          RAISE EXCEPTION 'SUB_COLOR_INVALID' USING ERRCODE='23514', CONSTRAINT='sub_color_palette';
        END IF;
        IF TG_OP='UPDATE' AND NEW.color IS DISTINCT FROM OLD.color
           AND upper(btrim(NEW.color::text)) <> ALL(allowed_colors) THEN
          RAISE EXCEPTION 'SUB_COLOR_INVALID' USING ERRCODE='23514', CONSTRAINT='sub_color_palette';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER sub_program_guard BEFORE INSERT OR UPDATE ON sub
      FOR EACH ROW EXECUTE FUNCTION sub_program_guard_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    // 새/custom 연결을 조용히 잃는 rollback은 거절한다. 고정 21종만 있으면 재적용 때 같은 대응으로 복원된다.
    await q.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM sub s
        LEFT JOIN (VALUES ${CANONICAL_VALUES}) AS v(key,kind_key) ON v.key=s.key
        WHERE v.key IS NULL AND s.kind_key IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'SubProgramOwner down would discard custom subject ownership';
      END IF;
    END $$`);
    await q.query(`DROP TRIGGER IF EXISTS sub_program_guard ON sub`);
    await q.query(`DROP FUNCTION IF EXISTS sub_program_guard_fn()`);
    await q.query(`DROP INDEX IF EXISTS sub_name_normalized_uniq`);
    await q.query(`DROP INDEX IF EXISTS sub_kind_lookup`);
    await q.query(`ALTER TABLE sub DROP CONSTRAINT IF EXISTS sub_kind_fk`);
    await q.query(`ALTER TABLE sub DROP COLUMN kind_key`);
  }
}
