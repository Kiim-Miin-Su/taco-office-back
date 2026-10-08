/** @file-guide
 * 목적: BOC-04E-01 학생 허브 aggregate가 참조하는 관계·기간·cursor 인덱스의 실제 PostgreSQL 회귀.
 * 책임/재사용: 격리 TEST_URL 트랜잭션에서 catalog와 직접 쓰기 차단을 검증한다. 서비스 응답 회귀는 student-hub-db.spec.ts가 소유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-04-SCENARIOS-2026-10-06.md · docs/contracts/db/erd.dbml
 */

import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { assertScratch, blockedBy, TEST_URL } from './db';

jest.setTimeout(60_000);
const url = assertScratch(TEST_URL);

describe('BOC-04E-01 student hub relation persistence', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let studentA: string;
  let studentB: string;
  let enrollmentA: string;
  let kindKey: string;
  let subKey: string;

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
  });

  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query('SELECT pg_advisory_xact_lock(20261008, 690)');

    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    kindKey = `hub_${suffix}`;
    subKey = `hub_${suffix}`;
    await q.query(`INSERT INTO kind(key,name,color,cap,grp,rep)
      VALUES ($1,'허브 관계 시험','#345678',4,'lesson',true)`, [kindKey]);
    await q.query(`INSERT INTO sub(key,name,color,kind_key) VALUES ($1,'허브 관계 시험','#A85764',$2)`, [subKey, kindKey]);
    const students = await q.query(`INSERT INTO stu(name) VALUES ('허브 관계 A'),('허브 관계 B') RETURNING id`) as Array<{ id: string }>;
    [studentA, studentB] = students.map(row => row.id);
    const [enrollment] = await q.query(`INSERT INTO enr(student_id,kind_key,sub_key,started_on)
      VALUES ($1,$2,$3,'2026-10-01') RETURNING id`, [studentA, kindKey, subKey]) as Array<{ id: string }>;
    enrollmentA = enrollment.id;
  });

  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('학생 허브 관계 FK가 모두 검증된 상태이고 enrollment 소유 학생을 함께 고정한다', async () => {
    const expected = [
      'enr_kind_fk',
      'enr_student_fk',
      'enr_sub_fk',
      'inv_cs_fk',
      'inv_enrollment_student_fk',
      'inv_student_fk',
      'lead_student_fk',
      'rep_stu_rep_fk',
      'rep_stu_student_fk',
    ];
    const rows = await q.query(`SELECT conname,convalidated
      FROM pg_constraint
      WHERE conname = ANY($1::text[])
      ORDER BY conname`, [expected]) as Array<{ conname: string; convalidated: boolean }>;
    expect(rows).toEqual(expected.map(conname => ({ conname, convalidated: true })));

    expect(await blockedBy(q, `INSERT INTO enr(student_id,kind_key,sub_key)
      VALUES (9223372036854775000,$1,$2)`, [kindKey, subKey])).toMatch(/enr_student_fk/);
    expect(await blockedBy(q, `INSERT INTO enr(student_id,kind_key,sub_key)
      VALUES ($1,'missing_kind',$2)`, [studentA, subKey])).toMatch(/enr_kind_fk/);
    expect(await blockedBy(q, `INSERT INTO enr(student_id,kind_key,sub_key)
      VALUES ($1,$2,'missing_subject')`, [studentA, kindKey])).toMatch(/enr_sub_fk/);
    expect(await blockedBy(q, `INSERT INTO rep_stu(rep_id,student_id)
      VALUES (9223372036854775000,$1)`, [studentA])).toMatch(/rep_stu_rep_fk/);
    expect(await blockedBy(q, `INSERT INTO rep_stu(rep_id,student_id)
      VALUES (9223372036854775000,9223372036854775000)`)).toMatch(/rep_stu_(rep|student)_fk/);
    expect(await blockedBy(q, `INSERT INTO inv(student_id,enr_id,year_month,inv_type,title,amount)
      VALUES ($1,$2,'2026-10','tuition','교차 학생 청구',10000)`, [studentB, enrollmentA])).toMatch(/inv_enrollment_student_fk/);
  });

  it('aggregate의 학생 역방향·기간·keyset 경로가 명시 인덱스로 고정된다', async () => {
    const expected = [
      'cons_stu_student_cons_idx',
      'enr_student_hub_idx',
      'guide_student_state_idx',
      'inv_student_hub_idx',
      'issue_student_state_idx',
      'lead_student_idx',
      'note_student_hub_idx',
      'rep_stu_student_report_idx',
      'ser_stu_student_period_idx',
      'stu_profile_period_current_lookup',
    ];
    const rows = await q.query(`SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND indexname = ANY($1::text[])
      ORDER BY indexname`, [expected]) as Array<{ indexname: string }>;
    expect(rows.map(row => row.indexname)).toEqual(expected);

    const [periodIndex] = await q.query(`SELECT indexdef FROM pg_indexes
      WHERE schemaname='public' AND indexname='stu_profile_period_current_lookup'`) as Array<{ indexdef: string }>;
    expect(periodIndex.indexdef).toContain('(student_id, field, valid_from DESC, valid_to, id DESC)');
    expect(periodIndex.indexdef).toContain('WHERE (superseded_at IS NULL)');
  });
});
