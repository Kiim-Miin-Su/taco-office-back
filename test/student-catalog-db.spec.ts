/** @file-guide
 * 목적: ST1-b1 국가·시간대·학년·학교 사전의 실제 PostgreSQL 계약 회귀.
 * 책임/재사용: 독립 *_test DB에서 migration→seed 후 직접 제약과 학교 동일성 경합을 검사한다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/contracts/db/student-registration-target.dbml
 */

import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { seedStudentCatalogV1 } from '../src/migrations/data/student-catalog-v1';
import { assertScratch, blockedBy, TEST_URL } from './db';

jest.setTimeout(60_000);

// 새 사전 계약은 빈 테스트 URL을 조용히 skip하지 않는다.
const url = assertScratch(TEST_URL);
function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
}

describe('ST1-b1 공용 국가·학년·학교 사전', () => {
  let ds: DataSource;
  let q: QueryRunner;

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    // GoLive DB fixture도 같은 scratch의 SCHOOL을 사용한다. TRUNCATE와 병렬 거래를 직렬화한다.
    await q.query('SELECT pg_advisory_xact_lock(20260930, 560)');
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('기본 목록은 지정 30개 국가·46개 학년이고, 복수 시간대 국가에 대표가 하나씩 있다', async () => {
    const countries = await q.query('SELECT code FROM country ORDER BY code') as Array<{ code: string }>;
    expect(countries.map((r) => r.code.trim())).toEqual(
      'AE AU BR CA CH CN DE ES FR GB HK ID IE IN IT JP KR MX MY NL NZ PH SA SE SG TH TW US VN ZA'.split(' '),
    );
    const grades = await q.query('SELECT education_system, count(*)::int AS n FROM education_grade GROUP BY education_system ORDER BY education_system') as Array<{ education_system: string; n: number }>;
    expect(grades).toEqual([
      { education_system: 'GB', n: 16 }, { education_system: 'KR', n: 14 },
      { education_system: 'OTHER', n: 1 }, { education_system: 'US', n: 15 },
    ]);
    const reps = await q.query(`SELECT country_code, count(*) FILTER (WHERE active AND is_representative)::int AS n
      FROM country_timezone GROUP BY country_code`) as Array<{ country_code: string; n: number }>;
    expect(reps).toHaveLength(30);
    expect(reps.every((r) => r.n === 1)).toBe(true);
    const [{ n: zones }] = await q.query(`SELECT count(*)::int AS n FROM country_timezone WHERE country_code = 'US'`) as Array<{ n: number }>;
    expect(zones).toBeGreaterThan(1);
    const invalidZones = await q.query(`SELECT ct.timezone FROM country_timezone ct
      LEFT JOIN pg_timezone_names p ON p.name = ct.timezone WHERE p.name IS NULL`) as unknown[];
    expect(invalidZones).toEqual([]);
  });

  it('국가·시간대는 빈 이름/음수 정렬/없는 FK/중복 대표를 DB가 거절한다', async () => {
    expect(await blockedBy(q, `INSERT INTO country(code,name_ko,name_en,sort) VALUES ('K1','x','x',1)`)).toMatch(/country_code_format/);
    expect(await blockedBy(q, `INSERT INTO country(code,name_ko,name_en,sort) VALUES ('ZZ','   ','Z',1)`)).toMatch(/country_name_nonblank/);
    expect(await blockedBy(q, `INSERT INTO country(code,name_ko,name_en,sort) VALUES ('ZZ','Z','Z',-1)`)).toMatch(/country_sort_nonnegative/);
    expect(await blockedBy(q, `INSERT INTO country_timezone(country_code,timezone,label_ko) VALUES ('ZZ','Etc/UTC','x')`)).toMatch(/foreign key/);
    expect(await blockedBy(q, `INSERT INTO country_timezone(country_code,timezone,label_ko) VALUES ('KR','No/Such_Zone','x')`)).toMatch(/country_timezone_iana/);
    expect(await blockedBy(q, `INSERT INTO country_timezone(country_code,timezone,label_ko,is_representative) VALUES ('KR','Etc/UTC','x',true)`)).toMatch(/country_timezone_representative/);
  });

  it('학년은 46개 허용 조합만 받고 정렬 중복과 국가 추정은 허용하지 않는다', async () => {
    expect(await blockedBy(q, `INSERT INTO education_grade(education_system,code,label_ko,sort) VALUES ('US','Yr1','x',99)`)).toMatch(/education_grade_code_allowed/);
    expect(await blockedBy(q, `INSERT INTO education_grade(education_system,code,label_ko,sort) VALUES ('OTHER','repeat','x',-1)`)).toMatch(/education_grade_sort_nonnegative/);
    expect(await blockedBy(q, `INSERT INTO education_grade(education_system,code,label_ko,sort) VALUES ('US','G1','x',99)`)).toMatch(/duplicate key/);
    expect(await blockedBy(q, `INSERT INTO education_grade(education_system,code,label_ko,sort) VALUES ('US','G13','x',1)`)).toMatch(/education_grade_code_allowed/);
    const [{ code }] = await q.query(`SELECT code FROM education_grade WHERE education_system='OTHER'`) as Array<{ code: string }>;
    expect(code).toBe('repeat');
  });

  it('학교는 Unicode NFC·연속 공백·대소문자를 한 identity로 묶고 표시명은 보존한다', async () => {
    const [{ id: actor }] = await q.query(`INSERT INTO staff(name,login_id,role) VALUES ('학교 사전 시험자',$1,'admin') RETURNING id`, [`st1b1-${randomUUID()}`]) as Array<{ id: string }>;
    const [first] = await q.query(`SELECT resolve_school($1,$2,$3,$4,$5) AS id`, ['  Cafe\u0301  School  ', null, null, null, actor]) as Array<{ id: string }>;
    const [same] = await q.query(`SELECT resolve_school($1,$2,$3,$4,$5) AS id`, ['CAFÉ SCHOOL', null, '', '', actor]) as Array<{ id: string }>;
    expect(same.id).toBe(first.id);
    const [row] = await q.query(`SELECT name,name_key,region,campus,created_by FROM school WHERE id=$1`, [first.id]) as Array<{ name: string; name_key: string; region: string | null; campus: string | null; created_by: string }>;
    expect(row).toMatchObject({ name: 'Cafe\u0301 School', name_key: 'café school', region: null, campus: null, created_by: actor });
    const [different] = await q.query(`SELECT resolve_school($1,$2,$3,$4,$5) AS id`, ['CAFÉ SCHOOL', 'US', null, null, actor]) as Array<{ id: string }>;
    expect(different.id).not.toBe(first.id);
  });

  it('학교는 불량 입력·없는 FK·비활성 identity 재사용을 막는다', async () => {
    const [{ id: actor }] = await q.query(`INSERT INTO staff(name,login_id,role) VALUES ('학교 검증 시험자',$1,'admin') RETURNING id`, [`st1b1-${randomUUID()}`]) as Array<{ id: string }>;
    expect(await blockedBy(q, `SELECT resolve_school('',NULL,NULL,NULL,$1)`, [actor])).toMatch(/school_name_nonblank/);
    expect(await blockedBy(q, `SELECT resolve_school($1,NULL,NULL,NULL,$2)`, ['x'.repeat(121), actor])).toMatch(/school_name_length/);
    expect(await blockedBy(q, `SELECT resolve_school('School','ZZ',NULL,NULL,$1)`, [actor])).toMatch(/foreign key/);
    expect(await blockedBy(q, `SELECT resolve_school('School',NULL,NULL,NULL,999999)`)).toMatch(/foreign key/);
    expect(await blockedBy(q, `SELECT resolve_school('School',NULL,NULL,NULL,NULL)`)).toMatch(/school_actor_required/);
    const [created] = await q.query(`SELECT resolve_school('Inactive School',NULL,NULL,NULL,$1) AS id`, [actor]) as Array<{ id: string }>;
    await q.query(`UPDATE school SET active=false WHERE id=$1`, [created.id]);
    expect(await blockedBy(q, `SELECT resolve_school(' inactive  school ',NULL,NULL,NULL,$1)`, [actor])).toMatch(/school_inactive/);
    expect(await blockedBy(q, `DELETE FROM school WHERE id=$1`, [created.id])).toMatch(/catalog_hard_delete_forbidden/);
  });

  it('동시 동일 학교 등록은 두 요청 모두 같은 ID를 반환한다', async () => {
    const name = `ST1-b1-${randomUUID()}`;
    const [{ n: existing }] = await ds.query(`SELECT count(*)::int AS n FROM school`) as Array<{ n: number }>;
    expect(existing).toBe(0); // 이후 TRUNCATE는 이 disposable scratch의 우리 행만 대상으로 한다.
    const [{ id: actor }] = await ds.query(`INSERT INTO staff(name,login_id,role) VALUES ('학교 경합 시험자',$1,'admin') RETURNING id`, [`st1b1-${randomUUID()}`]) as Array<{ id: string }>;
    try {
      const rows = await Promise.all([1, 2].map(() => ds.query(
        `SELECT resolve_school($1,'US','California','Main',$2) AS id`, [name, actor],
      ) as Promise<Array<{ id: string }>>));
      const ids = rows.map(([r]) => r.id);
      expect(ids[0]).toBe(ids[1]);
      const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM school WHERE id=$1`, [ids[0]]) as Array<{ n: number }>;
      expect(n).toBe(1);
    } finally {
      // 제품 hard DELETE guard를 우회하지 않는다. disposable scratch의 유일한 학교만 reset한다.
      await ds.query(`TRUNCATE school RESTART IDENTITY`);
      await ds.query(`DELETE FROM staff WHERE id=$1`, [actor]);
    }
  });

  it('개발 seed 재실행은 운영자가 바꾼 표시명·활성 상태를 덮지 않는다', async () => {
    await q.query(`UPDATE country SET name_ko='현지 이름',active=false WHERE code='US'`);
    await q.query(`UPDATE country_timezone SET label_ko='현지 시간',active=false WHERE country_code='US' AND timezone='America/New_York'`);
    await q.query(`UPDATE education_grade SET label_ko='학교 명칭',active=false WHERE education_system='US' AND code='G1'`);
    expect(await seedStudentCatalogV1(q)).toEqual({ country: 0, countryTimezone: 0, educationGrade: 0 });
    const [country] = await q.query(`SELECT name_ko,active FROM country WHERE code='US'`) as Array<{ name_ko: string; active: boolean }>;
    const [zone] = await q.query(`SELECT label_ko,active FROM country_timezone WHERE country_code='US' AND timezone='America/New_York'`) as Array<{ label_ko: string; active: boolean }>;
    const [grade] = await q.query(`SELECT label_ko,active FROM education_grade WHERE education_system='US' AND code='G1'`) as Array<{ label_ko: string; active: boolean }>;
    expect(country).toEqual({ name_ko: '현지 이름', active: false });
    expect(zone).toEqual({ label_ko: '현지 시간', active: false });
    expect(grade).toEqual({ label_ko: '학교 명칭', active: false });
  });

  it('기존 STU/TZG scalar는 그대로 둔다', async () => {
    const [{ id: stu }] = await q.query(`INSERT INTO stu(name,grade,school) VALUES ('legacy','G3','옛 학교') RETURNING id`) as Array<{ id: string }>;
    const [{ id: tzg }] = await q.query(`INSERT INTO tzg(name,tz) VALUES ('옛 시간대','Asia/Seoul') RETURNING id`) as Array<{ id: string }>;
    const [before] = await q.query(`SELECT grade,school FROM stu WHERE id=$1`, [stu]) as Array<{ grade: string | null; school: string | null }>;
    const [zone] = await q.query(`SELECT tz FROM tzg WHERE id=$1`, [tzg]) as Array<{ tz: string }>;
    const [after] = await q.query(`SELECT grade,school FROM stu WHERE id=$1`, [stu]) as Array<{ grade: string | null; school: string | null }>;
    expect(after).toEqual(before);
    expect(zone.tz).toBe('Asia/Seoul');
  });
});
