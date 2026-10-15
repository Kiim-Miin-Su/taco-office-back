/** @file-guide
 * 목적: 초기 계정 발급의 기존 자격 보존·동시 요청·실패 원자성을 격리 PostgreSQL에서 검증한다.
 * 책임/재사용: 운영/공유 seed와 같은 고정 ID를 쓰지 않도록 별도 명시 DB에서만 실행한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import 'reflect-metadata';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { provisionInitialAccounts } from '../src/lib/provision-initial-accounts';

// 이 기능은 실제 초기 로그인 ID를 다루므로 다른 suite의 seed가 있는 DB에서는 건너뛴다.
const rawUrl = process.env.TEST_DATABASE_URL;
const url = rawUrl ? new URL(rawUrl) : null;
const isolated = url && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  && url.pathname === '/taco_r118_provision_test';
const run = isolated ? describe : describe.skip;
const PASSWORD = 'provision-fixture-1234!';
const APPLY = { apply: true, confirm: 'taco_r118_provision_test', initialPassword: PASSWORD };

run('초기 계정 provisioning — 전용 migration DB', () => {
  let ds: DataSource;
  let oldHash: string;
  const insert = async (loginId: string, role = 'ceo', active = true) => {
    const [row] = await ds.query(
      `INSERT INTO staff(name,login_id,role,password_hash,active,must_change_credentials,credentials_changed_at)
        VALUES('provision 시험',$1,$2::role_t,$3,$4,true,'2026-01-02T03:04:05Z') RETURNING id`,
      [loginId, role, oldHash, active],
    ) as Array<{ id: string }>;
    return row.id;
  };
  const snapshot = async () => JSON.stringify(await ds.query('SELECT * FROM staff ORDER BY id'));
  const receipts = async () => {
    const [{ count }] = await ds.query(
      `SELECT count(*)::int AS count FROM log WHERE action='account_provision'`,
    ) as Array<{ count: number }>;
    return count;
  };

  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', url: rawUrl, logging: false, synchronize: false });
    await ds.initialize();
    const [{ database, count }] = await ds.query(
      `SELECT current_database() AS database,(SELECT count(*)::int FROM migrations) AS count`,
    ) as Array<{ database: string; count: number }>;
    expect(database).toBe('taco_r118_provision_test');
    expect(count).toBeGreaterThanOrEqual(124);
    oldHash = await bcrypt.hash('changed-fixture-password-123!', 4);
  });
  beforeEach(async () => {
    await ds.query(`DELETE FROM log WHERE action='account_provision'`);
    await ds.query('DELETE FROM staff');
  });
  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DELETE FROM log WHERE action='account_provision'`);
      await ds.query('DELETE FROM staff');
      await ds.destroy();
    }
  });

  it('미리 보기는 CEO 개명·신규 두 계정을 계획하지만 자격과 감사는 바꾸지 않는다', async () => {
    await insert('provision-ceo-before');
    const before = await snapshot();
    expect(await provisionInitialAccounts(ds, { ...APPLY, apply: false, confirm: null }))
      .toMatchObject({ apply: false, renamed: 1, created: 2, preserved: 0 });
    expect(await snapshot()).toBe(before);
    expect(await receipts()).toBe(0);
  });

  it('최초 발급은 지정 ID·역할·bcrypt와 감사 한 건으로 같은 transaction에 저장한다', async () => {
    const id = await insert('provision-ceo-before');
    expect(await provisionInitialAccounts(ds, APPLY)).toMatchObject({ renamed: 1, created: 2, preserved: 0 });
    const rows = await ds.query(
      'SELECT id,login_id,role,password_hash,active,must_change_credentials FROM staff ORDER BY id',
    ) as Array<{ id: string; login_id: string; role: string; password_hash: string; active: boolean; must_change_credentials: boolean }>;
    expect(rows.map((row) => [row.login_id, row.role])).toEqual([
      ['minsun1234', 'ceo'], ['bj1234', 'manager'], ['admin1234', 'admin'],
    ]);
    expect(rows[0].id).toBe(id);
    for (const row of rows) {
      expect(await bcrypt.compare(PASSWORD, row.password_hash)).toBe(true);
      expect(row.active).toBe(true);
      // AUTH-INIT-02(2026-10-16): 초기 발급(개명 포함)은 공통 초기 비밀번호를 쓰므로 첫 로그인에서 필수 설정을 거친다
      expect(row.must_change_credentials).toBe(true);
    }
    expect(await receipts()).toBe(1);
  });

  it('반복 apply는 변경 암호·중지·첫 설정·세션 시각과 감사 수를 전부 보존한다', async () => {
    await insert('provision-ceo-before');
    await provisionInitialAccounts(ds, APPLY);
    await ds.query(`UPDATE staff SET password_hash=$1,active=false,must_change_credentials=true,
      credentials_changed_at='2026-02-03T04:05:06Z'`, [oldHash]);
    const before = await snapshot();
    expect(await provisionInitialAccounts(ds, APPLY)).toMatchObject({ renamed: 0, created: 0, preserved: 3 });
    expect(await snapshot()).toBe(before);
    expect(await receipts()).toBe(1);
  });

  it('처음부터 존재한 같은 역할의 비활성 계정도 되살리지 않고 누락한 계정만 만든다', async () => {
    await insert('minsun1234');
    const managerId = await insert('BJ1234', 'manager', false);
    const before = await ds.query('SELECT * FROM staff WHERE id=$1', [managerId]);
    expect(await provisionInitialAccounts(ds, APPLY)).toMatchObject({ renamed: 0, created: 1, preserved: 2 });
    expect(await ds.query('SELECT * FROM staff WHERE id=$1', [managerId])).toEqual(before);
  });

  it.each(['minsun1234', 'bj1234', 'admin1234'])('비활성 %s도 다른 역할이면 쓰기 전에 거절한다', async (loginId) => {
    await insert('provision-ceo-before');
    await insert(loginId, 'teacher', false);
    const before = await snapshot();
    await expect(provisionInitialAccounts(ds, APPLY)).rejects.toMatchObject({ code: 'ROLE_CONFLICT' });
    expect(await snapshot()).toBe(before);
    expect(await receipts()).toBe(0);
  });

  it('이미 발급한 CEO의 ID가 바뀌면 초기 ID로 다시 개명하지 않는다', async () => {
    await insert('provision-ceo-before');
    await provisionInitialAccounts(ds, APPLY);
    await ds.query(`UPDATE staff SET login_id='provision-ceo-renamed' WHERE login_id='minsun1234'`);
    const before = await snapshot();
    await expect(provisionInitialAccounts(ds, APPLY)).rejects.toMatchObject({ code: 'ALREADY_PROVISIONED' });
    expect(await snapshot()).toBe(before);
    expect(await receipts()).toBe(1);
  });

  it('대상 확인이 다르면 기존 상태를 읽어 수정하기 전에 거절한다', async () => {
    await insert('provision-ceo-before');
    const before = await snapshot();
    await expect(provisionInitialAccounts(ds, { ...APPLY, confirm: 'another-db' }))
      .rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(await snapshot()).toBe(before);
  });

  it('CEO가 없거나 두 활성 CEO이거나 기존 고정 CEO가 비활성이면 누락 계정 발급을 거절한다', async () => {
    await expect(provisionInitialAccounts(ds, APPLY)).rejects.toMatchObject({ code: 'CEO_REQUIRED' });
    await insert('provision-ceo-before');
    const second = await insert('provision-ceo-second');
    await expect(provisionInitialAccounts(ds, APPLY)).rejects.toMatchObject({ code: 'CEO_REQUIRED' });
    await ds.query(`UPDATE staff SET login_id='minsun1234',active=false WHERE id=$1`, [second]);
    const before = await snapshot();
    await expect(provisionInitialAccounts(ds, APPLY)).rejects.toMatchObject({ code: 'CEO_REQUIRED' });
    expect(await snapshot()).toBe(before);
  });

  it('두 apply가 겹쳐도 한 번만 발급하고 다른 요청은 no-op으로 수렴한다', async () => {
    await insert('provision-ceo-before');
    const results = await Promise.all([provisionInitialAccounts(ds, APPLY), provisionInitialAccounts(ds, APPLY)]);
    expect(results.map((row) => row.created + row.renamed).sort()).toEqual([0, 3]);
    expect(await receipts()).toBe(1);
    expect(await ds.query('SELECT id FROM staff')).toHaveLength(3);
  });

  it('CEO 비활성화가 먼저 잠그면 발급은 기다린 뒤 최신 상태로 거절한다', async () => {
    const id = await insert('provision-ceo-before');
    const q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const [{ pid }] = await q.query('SELECT pg_backend_pid() AS pid') as Array<{ pid: number }>;
    let request: Promise<unknown> | undefined;
    try {
      await q.query('UPDATE staff SET active=false WHERE id=$1', [id]);
      // 거절 Promise를 즉시 소비하면서 PostgreSQL이 실제 행 잠금에서 대기하는지 확인한다.
      request = provisionInitialAccounts(ds, APPLY).then((value) => value, (error: unknown) => error);
      const deadline = Date.now() + 3_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const [{ waiting }] = await ds.query(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting`, [pid],
        ) as Array<{ waiting: boolean }>;
        if (waiting) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await q.commitTransaction();
      expect(await request).toMatchObject({ code: 'CEO_REQUIRED' });
      expect(await receipts()).toBe(0);
      expect(await ds.query('SELECT login_id,active FROM staff')).toEqual([
        { login_id: 'provision-ceo-before', active: false },
      ]);
    } finally {
      if (q.isTransactionActive) {
        await q.rollbackTransaction();
      }
      await q.release();
      await request;
    }
  });

  it('감사 저장이 실패하면 최초 CEO 자격 변경과 두 신규 계정도 rollback한다', async () => {
    await insert('provision-ceo-before');
    const before = await snapshot();
    await ds.query(`CREATE FUNCTION provision_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'provision fixture failure'; END $$`);
    await ds.query(`CREATE TRIGGER provision_test_fail BEFORE INSERT ON log
      FOR EACH ROW WHEN (NEW.action='account_provision') EXECUTE FUNCTION provision_test_fail()`);
    try {
      await expect(provisionInitialAccounts(ds, APPLY)).rejects.toThrow('provision fixture failure');
      expect(await snapshot()).toBe(before);
      expect(await receipts()).toBe(0);
    } finally {
      await ds.query('DROP TRIGGER provision_test_fail ON log');
      await ds.query('DROP FUNCTION provision_test_fail()');
    }
  });
});
