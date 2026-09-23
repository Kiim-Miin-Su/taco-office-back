/** @file-guide
 * 목적: deploy-check.spec.ts — 잘못된 배포 설정에서 DB에 닿지 않는지 검증한다.
 * 책임/재사용: CLI와 실제 쿠키 검사·TypeORM 조회를 실행하되 dotenv와 DataSource 경계를 mock한다.
 * 검증/작업 지침: docs/AGENT.md · docs/CLAUDE.md · docs/contracts/FILE-GUIDE.md
 */

const KEYS = [
  'NODE_ENV', 'DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET',
  'CORS_ORIGIN', 'COOKIE_DOMAIN', 'COOKIE_CROSS_SITE',
] as const;
const MIGRATION = 'DeployProbe1760000000000';

function fakeDatabase() {
  const runner = {
    hasTable: jest.fn().mockResolvedValue(false),
    createTable: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const db = {
    options: { type: 'postgres' },
    driver: { options: { type: 'postgres' }, database: 'mock_only', buildTableName: (name: string) => name },
    migrations: [{ name: MIGRATION }],
    initialize: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    showMigrations: jest.fn().mockResolvedValue(true),
    runMigrations: jest.fn().mockResolvedValue([{ name: MIGRATION }]),
    createQueryRunner: jest.fn(() => runner),
  };
  return { db, runner };
}

let saved: Partial<Record<(typeof KEYS)[number], string | undefined>>;
let argv: string[];
let exitCode: typeof process.exitCode;
let fixture: ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  argv = process.argv;
  exitCode = process.exitCode;
  KEYS.forEach((key) => delete process.env[key]);
  Object.assign(process.env, {
    NODE_ENV: 'production', DATABASE_URL: 'postgresql://mock@127.0.0.1:1/mock_only',
    JWT_SECRET: 'mock-access', JWT_REFRESH_SECRET: 'mock-refresh',
    CORS_ORIGIN: 'https://app.example.test', COOKIE_DOMAIN: '.example.test',
  });
  process.argv = ['node', 'deploy-check.ts', '--run'];
  process.exitCode = undefined;
  fixture = fakeDatabase();
  jest.doMock('../src/data-source', () => ({ __esModule: true, default: fixture.db }));
  // 절대 .env/.env.local을 읽지 않는다. 실제 DataSource를 만들거나 연결하지 않는다.
  jest.doMock('dotenv', () => ({ config: jest.fn() }));
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  KEYS.forEach((key) => {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  });
  process.argv = argv;
  process.exitCode = exitCode;
  jest.restoreAllMocks();
  jest.dontMock('../src/data-source');
  jest.dontMock('dotenv');
});

async function runCli() {
  await jest.isolateModulesAsync(async () => {
    await import('../scripts/deploy-check');
    // CLI main의 모든 mock Promise와 catch/finally가 끝난 뒤 부수효과를 검사한다.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

function expectNoDatabaseWork() {
  expect(process.exitCode).toBe(1);
  expect(fixture.db.initialize).not.toHaveBeenCalled();
  expect(fixture.db.showMigrations).not.toHaveBeenCalled();
  expect(fixture.db.createQueryRunner).not.toHaveBeenCalled();
  expect(fixture.db.runMigrations).not.toHaveBeenCalled();
  expect(fixture.db.destroy).not.toHaveBeenCalled();
}

describe('배포 CLI — 설정 실패는 DB 연결 전에 끝난다', () => {
  it.each(['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'CORS_ORIGIN'] as const)(
    '--run이어도 필수 %s가 공백이면 연결·마이그레이션 0', async (key) => {
      process.env[key] = '   ';
      await runCli();
      expectNoDatabaseWork();
    },
  );

  it('조회 명령도 필수 키가 없으면 연결하지 않는다', async () => {
    process.argv = ['node', 'deploy-check.ts'];
    delete process.env.JWT_SECRET;
    await runCli();
    expectNoDatabaseWork();
  });

  it.each([false, true])('쿠키 도메인이 프론트를 덮지 못하면 중단한다 (run=%s)', async (run) => {
    process.argv = ['node', 'deploy-check.ts', ...(run ? ['--run'] : [])];
    process.env.COOKIE_DOMAIN = '.other.test';
    await runCli();
    expectNoDatabaseWork();
  });

  it('기존 운영 필수 키 검사를 통과하지 못하면 연결하지 않는다', async () => {
    delete process.env.COOKIE_DOMAIN;
    process.env.COOKIE_CROSS_SITE = 'true';
    await runCli();
    expectNoDatabaseWork();
  });
});

describe('배포 CLI — 정상 조회/적용의 경계', () => {
  it('이력표 없는 조회는 표를 만들거나 마이그레이션을 실행하지 않는다', async () => {
    process.argv = ['node', 'deploy-check.ts'];
    await runCli();
    expect(process.exit).not.toHaveBeenCalled();
    expect(fixture.db.initialize).toHaveBeenCalledTimes(1);
    expect(fixture.runner.hasTable).toHaveBeenCalledWith('migrations');
    expect(fixture.runner.createTable).not.toHaveBeenCalled();
    expect(fixture.db.showMigrations).not.toHaveBeenCalled();
    expect(fixture.db.runMigrations).not.toHaveBeenCalled();
    expect(fixture.runner.release).toHaveBeenCalledTimes(1);
    expect(fixture.db.destroy).toHaveBeenCalledTimes(1);
  });

  it('설정이 정상이고 --run이며 미적용 항목이 있을 때만 적용한다', async () => {
    await runCli();
    expect(process.exit).not.toHaveBeenCalled();
    expect(fixture.db.initialize).toHaveBeenCalledTimes(1);
    expect(fixture.db.runMigrations).toHaveBeenCalledTimes(1);
    expect(fixture.db.destroy).toHaveBeenCalledTimes(1);
  });

  it('--run이라도 마이그레이션 목록이 비었으면 적용하지 않는다', async () => {
    fixture.db.migrations = [];
    fixture.db.showMigrations.mockResolvedValue(false);
    await runCli();
    expect(process.exit).not.toHaveBeenCalled();
    expect(fixture.db.runMigrations).not.toHaveBeenCalled();
    expect(fixture.db.destroy).toHaveBeenCalledTimes(1);
  });
});
