/** @file-guide
 * 목적: BO-1014-STAFF migration down의 개인정보 보존과 빈 schema down/up 회귀.
 * 책임/재사용: 승인된 로컬 스크래치에서 트랜잭션으로 DDL을 시험하고 반드시 rollback한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { DataSource, QueryRunner } from 'typeorm';
import { StaffTeachingProfile1769600000000 } from '../src/migrations/1769600000000-staff-teaching-profile';
import { assertScratch, DEV_URL, TEST_URL } from './db';

const d = process.env.BO1014_MIGRATION_DB_TEST === '1' ? describe : describe.skip;
jest.setTimeout(30_000);

d('BO-1014-STAFF migration rollback 보호', () => {
  let ds: DataSource;
  let runner: QueryRunner;
  const migration = new StaffTeachingProfile1769600000000();

  beforeAll(async () => {
    const scratch = assertScratch(TEST_URL);
    const url = new URL(scratch);
    if (DEV_URL !== TEST_URL || !['localhost', '127.0.0.1'].includes(url.hostname)
      || url.port !== '55494' || url.pathname !== '/taco_dev_test') {
      throw new Error('BO-1014-STAFF migration 시험 대상이 승인된 localhost:55494/taco_dev_test와 다릅니다');
    }
    ds = new DataSource({ type: 'postgres', url: scratch, entities: [], synchronize: false, logging: false });
    await ds.initialize();
    const [identity] = await ds.query('SELECT current_database() AS db, inet_server_port() AS port') as Array<{ db: string; port: number }>;
    expect(identity).toEqual({ db: 'taco_dev_test', port: 55494 });
  });

  afterEach(async () => {
    if (runner?.isTransactionActive) await runner.rollbackTransaction();
    if (runner && !runner.isReleased) await runner.release();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('강사 생년월일이 있으면 down은 첫 DROP 전에 실패하고 테이블을 보존한다', async () => {
    runner = ds.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`INSERT INTO staff(name,login_id,role,password_hash,active,birth_on)
      VALUES('BO-1014 롤백 검증','bo1014-rollback-guard','teacher','transaction-only',true,'1990-01-01')`);
    await expect(migration.down(runner)).rejects.toThrow('강사 프로필 데이터가 남아 있어');
    const [row] = await runner.query(`SELECT
      to_regclass('staff_teaching_kind') IS NOT NULL AS kinds_exists,
      to_regclass('staff_education_summary') IS NOT NULL AS education_exists`) as Array<{ kinds_exists: boolean; education_exists: boolean }>;
    expect(row).toEqual({ kinds_exists: true, education_exists: true });
    const writer = ds.createQueryRunner();
    await writer.startTransaction();
    try {
      // down의 검사와 DROP 사이에 새 STAFF/프로필 쓰기가 끼어들 수 없어야 한다.
      await expect(writer.query('LOCK TABLE staff IN ROW EXCLUSIVE MODE NOWAIT'))
        .rejects.toMatchObject({ driverError: { code: '55P03' } });
    } finally {
      await writer.rollbackTransaction();
      await writer.release();
    }
  });

  it('빈 schema는 down/up을 통과하고 트랜잭션 rollback 뒤 원래 schema가 유지된다', async () => {
    runner = ds.createQueryRunner();
    await runner.startTransaction();
    const [empty] = await runner.query(`SELECT NOT (
      EXISTS(SELECT 1 FROM staff WHERE birth_on IS NOT NULL OR english_only IS NOT NULL)
      OR EXISTS(SELECT 1 FROM staff_teaching_kind)
      OR EXISTS(SELECT 1 FROM staff_education_summary)) AS empty`) as Array<{ empty: boolean }>;
    expect(empty.empty).toBe(true);

    await migration.down(runner);
    const [gone] = await runner.query(`SELECT
      to_regclass('staff_teaching_kind') IS NULL AS kinds_gone,
      to_regclass('staff_education_summary') IS NULL AS education_gone,
      NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='staff' AND column_name='birth_on') AS birth_gone`) as Array<{
        kinds_gone: boolean; education_gone: boolean; birth_gone: boolean;
      }>;
    expect(gone).toEqual({ kinds_gone: true, education_gone: true, birth_gone: true });

    await migration.up(runner);
    const [restored] = await runner.query(`SELECT
      to_regclass('staff_teaching_kind') IS NOT NULL AS kinds_exists,
      to_regclass('staff_education_summary') IS NOT NULL AS education_exists,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='staff' AND column_name='birth_on') AS birth_exists`) as Array<{
        kinds_exists: boolean; education_exists: boolean; birth_exists: boolean;
      }>;
    expect(restored).toEqual({ kinds_exists: true, education_exists: true, birth_exists: true });
  });
});
