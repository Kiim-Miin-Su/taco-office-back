/** @file-guide
 * 목적: BOC-03D-04a 학생 선택 정적 칸·본인 연락처의 additive PostgreSQL 계약 회귀.
 * 책임/재사용: 격리 *_test DB에서 기존 학생/등록 writer 호환·제약·원자 rollback을 확인한다. 신규 15절 API/화면 완료 시험이 아니다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/contracts/db/student-registration-target.dbml
 */

import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { StudentStaticContact1766000000000 } from '../src/migrations/1766000000000-student-static-contact';
import { assertScratch, blockedBy, TEST_URL } from './db';

const url = assertScratch(TEST_URL);
jest.setTimeout(60_000);

describe('BOC-03D-04a 학생 선택 정적 칸·본인 연락처', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let actor: string;
  let student: string;

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query('SELECT pg_advisory_xact_lock(20261001, 600)');
    const [staff] = await q.query(`INSERT INTO staff(name,login_id,role)
      VALUES ('학생 연락처 시험자',$1,'admin') RETURNING id`, [`st1b3c1-${randomUUID()}`]) as Array<{ id: string }>;
    actor = staff.id;
    const [stu] = await q.query(`INSERT INTO stu(name,grade,school)
      VALUES ('기존 등록 학생','G8','기존 학교') RETURNING id`) as Array<{ id: string }>;
    student = stu.id;
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('기존 학생과 기존 INSERT는 새 칸 NULL·연락처 0개로 보존된다', async () => {
    const [row] = await q.query(`SELECT name,grade,school,gender,profile_version,
      english_name,birth_date,has_citizenship,source FROM stu WHERE id=$1`, [student]) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ name: '기존 등록 학생', grade: 'G8', school: '기존 학교', gender: null,
      profile_version: '0', english_name: null, birth_date: null, has_citizenship: null, source: null });
    const [{ n }] = await q.query(`SELECT count(*)::int AS n FROM stu_contact WHERE student_id=$1`, [student]) as Array<{ n: number }>;
    expect(n).toBe(0);
  });

  it('선택 정적 값만 갱신하며 잘못된 영문명·유입·미래 생일은 DB가 거절한다', async () => {
    await q.query(`UPDATE stu SET english_name='Alex Kim',birth_date='2008-02-29',has_citizenship=false,source='referral' WHERE id=$1`, [student]);
    const [row] = await q.query(`SELECT english_name,to_char(birth_date,'YYYY-MM-DD') AS birth_date,
      has_citizenship,source,grade,school FROM stu WHERE id=$1`, [student]);
    expect(row).toMatchObject({ english_name: 'Alex Kim', birth_date: '2008-02-29', has_citizenship: false,
      source: 'referral', grade: 'G8', school: '기존 학교' });
    expect(await blockedBy(q, `UPDATE stu SET english_name='   ' WHERE id=$1`, [student])).toMatch(/stu_english_name_present/);
    expect(await blockedBy(q, `UPDATE stu SET source='unknown' WHERE id=$1`, [student])).toMatch(/stu_source_words/);
    expect(await blockedBy(q, `UPDATE stu SET birth_date=((clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date + 1) WHERE id=$1`, [student]))
      .toMatch(/stu_birth_date_future/);
  });

  it('학생 연락처는 종류별 여러 행·카카오만·0행을 허용하고 다른 학생과 전역 중복을 허용한다', async () => {
    const [another] = await q.query(`INSERT INTO stu(name) VALUES ('다른 학생') RETURNING id`) as Array<{ id: string }>;
    await q.query(`INSERT INTO stu_contact(student_id,kind,value,created_by) VALUES
      ($1,'phone','01012345678',$2),($1,'kakao','student-id',$2),($1,'email','STUDENT@example.com',$2)`, [student, actor]);
    await q.query(`INSERT INTO stu_contact(student_id,kind,value,label,created_by)
      VALUES ($1,'other','guardian-wechat','WeChat',$2)`, [student, actor]);
    await q.query(`INSERT INTO stu_contact(student_id,kind,value,created_by)
      VALUES ($1,'kakao','student-id-secondary',$2)`, [student, actor]);
    await q.query(`INSERT INTO stu_contact(student_id,kind,value,created_by)
      VALUES ($1,'phone','01012345678',$2)`, [another.id, actor]);
    const counts = await q.query(`SELECT student_id,count(*)::int AS n FROM stu_contact
      WHERE student_id=ANY($1::bigint[]) GROUP BY student_id ORDER BY student_id`, [[student, another.id]]) as Array<{ student_id: string; n: number }>;
    expect(counts).toEqual([{ student_id: student, n: 5 }, { student_id: another.id, n: 1 }]);
  });

  it('연락처의 소유자·actor·kind·형식·other label·활성 중복을 DB가 방어한다', async () => {
    await q.query(`INSERT INTO stu_contact(student_id,kind,value,created_by)
      VALUES ($1,'email','STUDENT@example.com',$2)`, [student, actor]);
    expect(await blockedBy(q, `INSERT INTO stu_contact(student_id,kind,value,created_by)
      VALUES ($1,'email','student@example.com',$2)`, [student, actor])).toMatch(/stu_contact_active_identity/);
    expect(await blockedBy(q, `INSERT INTO stu_contact(student_id,kind,value,created_by)
      VALUES ($1,'phone','not-phone',$2)`, [student, actor])).toMatch(/stu_contact_phone_shape/);
    expect(await blockedBy(q, `INSERT INTO stu_contact(student_id,kind,value,created_by)
      VALUES ($1,'other','we-chat',$2)`, [student, actor])).toMatch(/stu_contact_label/);
    expect(await blockedBy(q, `INSERT INTO stu_contact(student_id,kind,value,label,created_by)
      VALUES ($1,'kakao','student-id','   ',$2)`, [student, actor])).toMatch(/stu_contact_label/);
    expect(await blockedBy(q, `INSERT INTO stu_contact(student_id,kind,value,label,created_by)
      VALUES ($1,'kakao','student-id','학생 카카오',$2)`, [student, actor])).toMatch(/stu_contact_label/);
    expect(await blockedBy(q, `INSERT INTO stu_contact(student_id,kind,value,created_by)
      VALUES ($1,'sms','01012345678',$2)`, [student, actor])).toMatch(/stu_contact_kind/);
    expect(await blockedBy(q, `INSERT INTO stu_contact(student_id,kind,value,created_by)
      VALUES ($1,'kakao','   ',$2)`, [student, actor])).toMatch(/stu_contact_value/);
    expect(await blockedBy(q, `INSERT INTO stu_contact(student_id,kind,value,created_by)
      VALUES ($1,'kakao','student-id',NULL)`, [student])).toMatch(/created_by/);
    expect(await blockedBy(q, `INSERT INTO stu_contact(student_id,kind,value,created_by)
      VALUES (999999999,'kakao','student-id',$1)`, [actor])).toMatch(/foreign key/);
    await q.query(`UPDATE stu_contact SET active=false WHERE student_id=$1 AND kind='email'`, [student]);
    await q.query(`INSERT INTO stu_contact(student_id,kind,value,created_by)
      VALUES ($1,'email','student@example.com',$2)`, [student, actor]);
  });

  it('migration up은 옛 행을 건드리지 않고, down은 새 값·연락처가 있으면 거절하며 비어야 되돌린다', async () => {
    const schema = `st1b3c1_${randomUUID().replaceAll('-', '')}`;
    await q.query(`CREATE SCHEMA "${schema}"`);
    await q.query(`CREATE TABLE "${schema}".stu (id bigint PRIMARY KEY, name varchar(40) NOT NULL)`);
    await q.query(`CREATE TABLE "${schema}".staff (id bigint PRIMARY KEY)`);
    await q.query(`INSERT INTO "${schema}".stu(id,name) VALUES (1,'옛 학생')`);
    await q.query(`INSERT INTO "${schema}".staff(id) VALUES (1)`);
    await q.query(`SET LOCAL search_path TO "${schema}"`);
    const migration = new StudentStaticContact1766000000000();
    await migration.up(q);
    const [old] = await q.query(`SELECT name,english_name,birth_date,has_citizenship,source FROM stu WHERE id=1`);
    expect(old).toMatchObject({ name: '옛 학생', english_name: null, birth_date: null, has_citizenship: null, source: null });
    await q.query(`UPDATE stu SET english_name='Alex' WHERE id=1`);
    await expect(migration.down(q)).rejects.toThrow('would discard stored data');
    await q.query(`UPDATE stu SET english_name=NULL WHERE id=1`);
    await q.query(`INSERT INTO stu_contact(student_id,kind,value,created_by) VALUES (1,'kakao','alex-id',1)`);
    await expect(migration.down(q)).rejects.toThrow('would discard stored data');
    await q.query(`DELETE FROM stu_contact`);
    await migration.down(q);
    const [{ n: columns }] = await q.query(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='stu' AND column_name IN ('english_name','birth_date','has_citizenship','source')`, [schema]) as Array<{ n: number }>;
    expect(columns).toBe(0);
    const [{ n: contacts }] = await q.query(`SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema=$1 AND table_name='stu_contact'`, [schema]) as Array<{ n: number }>;
    expect(contacts).toBe(0);
    const [preserved] = await q.query(`SELECT id,name FROM stu WHERE id=1`);
    expect(preserved).toEqual({ id: '1', name: '옛 학생' });
  });
});
