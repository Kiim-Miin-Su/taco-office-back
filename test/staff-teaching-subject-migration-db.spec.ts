/** @file-guide
 * 목적: 강사 가능 과목 migration(1769800000000)의 down 보호와 빈 schema down/up 회귀.
 * 책임/재사용: 격리 스크래치 DB에서 트랜잭션으로 DDL을 시험하고 반드시 rollback한다. migration 127 행은 건드리지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { DataSource, QueryRunner } from 'typeorm';
import { StaffTeachingSubject1769800000000 } from '../src/migrations/1769800000000-staff-teaching-subject';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(30_000);

d('p8 결정 — 강사 가능 과목 migration rollback 보호', () => {
  let ds: DataSource;
  let runner: QueryRunner;
  const migration = new StaffTeachingSubject1769800000000();

  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', url: assertScratch(TEST_URL!), entities: [], synchronize: false, logging: false });
    await ds.initialize();
  });
  afterEach(async () => {
    if (runner?.isTransactionActive) await runner.rollbackTransaction();
    if (runner && !runner.isReleased) await runner.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const exists = async () => {
    const [row] = await runner.query(`SELECT to_regclass('staff_teaching_subject') IS NOT NULL AS table_exists,
      EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'staff_teaching_subject_guard') AS guard_exists`) as Array<{ table_exists: boolean; guard_exists: boolean }>;
    return row;
  };

  it('과목 행이 있으면 down은 DROP 전에 실패하고 표를 보존한다', async () => {
    runner = ds.createQueryRunner();
    await runner.startTransaction();
    const [staff] = await runner.query(`INSERT INTO staff(name,login_id,role,password_hash,active)
      VALUES('과목 롤백 검증','s5b-subject-rollback','teacher','transaction-only',true) RETURNING id`) as Array<{ id: string }>;
    await runner.query(`INSERT INTO kind(key,name,color,cap,grp,rep,sort) VALUES('class','수업','#4A7FB5',4,'lesson',true,1) ON CONFLICT (key) DO NOTHING`);
    await runner.query(`INSERT INTO sub(key,name,color,active,sort,kind_key) VALUES('s5bm-cls','S5B 롤백 과목','#4A7FB5',true,990,'class')`);
    await runner.query(`INSERT INTO staff_teaching_subject(staff_id, sub_key) VALUES ($1,'s5bm-cls')`, [staff.id]);
    await expect(migration.down(runner)).rejects.toThrow('강사 가능 과목 데이터가 남아 있어');
    expect(await exists()).toEqual({ table_exists: true, guard_exists: true });
  });

  it('빈 표는 down/up을 통과하고 rollback 뒤 원래 schema가 유지된다 · migration 127 표는 그대로다', async () => {
    runner = ds.createQueryRunner();
    await runner.startTransaction();
    const [empty] = await runner.query(`SELECT NOT EXISTS(SELECT 1 FROM staff_teaching_subject) AS empty`) as Array<{ empty: boolean }>;
    expect(empty.empty).toBe(true);
    await migration.down(runner);
    expect(await exists()).toEqual({ table_exists: false, guard_exists: false });
    const [kept] = await runner.query(`SELECT to_regclass('staff_teaching_kind') IS NOT NULL AS kinds,
      to_regclass('staff_education_summary') IS NOT NULL AS education`) as Array<{ kinds: boolean; education: boolean }>;
    expect(kept).toEqual({ kinds: true, education: true });
    await migration.up(runner);
    expect(await exists()).toEqual({ table_exists: true, guard_exists: true });
  });
});
