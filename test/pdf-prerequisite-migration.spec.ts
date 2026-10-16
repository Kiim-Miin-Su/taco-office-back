/** @file-guide
 * 목적: PDF125·126 제한 실행기의 대상·원장·원자성을 네트워크 없이 검증한다.
 * 책임/재사용: 실제 migration up과 TypeORM 원장 writer를 fake QueryRunner로 실행한다. PostgreSQL 검증을 대체하지 않는다.
 * 검증/작업 지침: test/AGENTS.md · docs/contracts/FILE-GUIDE.md · docs/AGENT.md
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import type { DataSourceOptions, MigrationInterface, QueryRunner } from 'typeorm';
import { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver';
import { executePdfPrerequisiteMigration } from '../scripts/pdf-prerequisite-migration';
import { PrivateBookPdf1769200000000 } from '../src/migrations/1769200000000-private-book-pdf';
import { BookPdfOneGigabyte1769500000000 } from '../src/migrations/1769500000000-book-pdf-one-gb';

const pdfNames = ['PrivateBookPdf1769200000000', 'BookPdfOneGigabyte1769500000000'];
const sourceNames = [...Array.from({ length: 124 }, (_, index) => `Baseline${1700000000000 + index}`), ...pdfNames];
const fakeUrl = 'postgresql://synthetic:never-print-this@ep-synthetic.example.test/pdf_synthetic?sslmode=verify-full';
const args = ['--host', 'ep-synthetic.example.test', '--port', '5432', '--database', 'pdf_synthetic'];
type LedgerRow = { name: string; timestamp: number | string };
const row = (name: string): LedgerRow => ({ name, timestamp: name.slice(-13) });

function fixture(from: 124 | 125 = 125) {
  const state = {
    ledger: sourceNames.slice(0, from).map(row),
    sourceNames: [...sourceNames],
    database: 'pdf_synthetic',
    hasLedger: true,
    active: false,
    ddl: 0,
    failDdlAt: 0,
    failInsertAt: 0,
    onLock: undefined as (() => void) | undefined,
    schemaRows: [
      {
        table_name: 'file',
        name: 'file_size_cap',
        definition:
          'CHECK ((((blob_path IS NULL) AND (bytes > 0) AND (bytes <= 3000000)) OR ((blob_path IS NOT NULL) AND (bytes > 0) AND (bytes <= 1000000000))))',
        validated: true,
      },
      {
        table_name: 'book_pdf_upload',
        name: 'book_pdf_upload_expected_bytes_check',
        definition: 'CHECK (((expected_bytes > 0) AND (expected_bytes <= 1000000000)))',
        validated: true,
      },
    ],
  };
  const events: string[] = [];
  let beforeTransaction: LedgerRow[] = [];
  let inserted: LedgerRow | undefined;
  let insertCount = 0;
  const builder = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    execute: jest.fn(async () => {
      insertCount += 1;
      if (insertCount === state.failInsertAt) {
        throw new Error(`driver contains ${fakeUrl}`);
      }
      if (!state.active || !inserted) {
        throw new Error('원장 기록은 활성 transaction 안이어야 한다');
      }
      events.push(`insert:${inserted.name}`);
      state.ledger.push(inserted);
    }),
  };
  builder.values.mockImplementation((value: LedgerRow) => {
    inserted = value;
    return builder;
  });
  const runner = {
    query: jest.fn(async (sql: string) => {
      events.push(sql);
      if (sql.includes('current_database()')) {
        return [{ database: state.database, has_ledger: state.hasLedger }];
      }
      if (sql.includes('FROM public.migrations')) {
        return state.ledger.map((entry) => ({ ...entry }));
      }
      if (sql.includes('FROM pg_constraint')) {
        return state.schemaRows;
      }
      if (sql.startsWith('LOCK TABLE')) {
        state.onLock?.();
      }
      if (/^(ALTER|CREATE) /.test(sql)) {
        if (!state.active) {
          throw new Error('DDL은 활성 transaction 안이어야 한다');
        }
        state.ddl += 1;
        if (state.ddl === state.failDdlAt) {
          throw new Error(`driver contains ${fakeUrl}`);
        }
      }
      return [];
    }),
    manager: { createQueryBuilder: () => builder },
    startTransaction: jest.fn(async () => {
      events.push('begin');
      beforeTransaction = state.ledger.map((entry) => ({ ...entry }));
      state.active = true;
    }),
    commitTransaction: jest.fn(async () => {
      events.push('commit');
      state.active = false;
    }),
    rollbackTransaction: jest.fn(async () => {
      events.push('rollback');
      state.ledger = beforeTransaction;
      state.active = false;
    }),
    release: jest.fn(async () => undefined),
    get isTransactionActive() {
      return state.active;
    },
  };
  const factory = jest.fn((options: DataSourceOptions) => {
    const ds = new DataSource(options);
    jest.spyOn(ds, 'initialize').mockImplementation(async () => {
      ds.migrations.push(
        ...state.sourceNames.map((name): MigrationInterface => {
          if (name === pdfNames[0]) {
            return new PrivateBookPdf1769200000000();
          }
          if (name === pdfNames[1]) {
            return new BookPdfOneGigabyte1769500000000();
          }
          return { name, up: jest.fn(), down: jest.fn() };
        }),
      );
      return ds;
    });
    jest.spyOn(ds, 'createQueryRunner').mockReturnValue(runner as unknown as QueryRunner);
    jest.spyOn(ds, 'destroy').mockResolvedValue(undefined);
    jest.spyOn(ds, 'runMigrations').mockRejectedValue(new Error('범용 migration 실행 금지'));
    return ds;
  });
  const execute = (run = false) =>
    executePdfPrerequisiteMigration([...args, '--from', String(from), ...(run ? ['--run'] : [])], fakeUrl, factory);
  return { state, events, runner, factory, builder, execute };
}

describe('PDF prerequisite restricted runner', () => {
  test('URL port 생략에도 승인5432를 고정해 상속 PGPORT를 차단한다', async () => {
    const environment = jest.replaceProperty(process, 'env', { PGPORT: '55487' });
    try {
      const f = fixture();
      await f.execute();
      const options = f.factory.mock.calls[0][0];
      if (options.type !== 'postgres' || typeof options.url !== 'string') {
        throw new Error('Postgres 연결 설정 필요');
      }
      expect(new URL(options.url).port).toBe('5432');
      expect(options.port).toBe(5432);
      // 설치된 pg Client 생성만 사용한다. connect를 호출하지 않아 네트워크가 없다.
      const driver = f.factory.mock.results[0].value.driver;
      if (!(driver instanceof PostgresDriver)) {
        throw new Error('Postgres driver 필요');
      }
      const { Client } = driver.postgres as {
        Client: new (config: { connectionString: string; port?: number }) => { connectionParameters: { port: number } };
      };
      const client = new Client({ connectionString: options.url, port: options.port });
      expect(client.connectionParameters.port).toBe(5432);
    } finally {
      environment.restore();
    }
  });

  test.each([124, 125] as const)('from %s 기본 검사는 SELECT만 한다', async (from) => {
    const f = fixture(from);
    await expect(f.execute()).resolves.toEqual({ status: 'ready', from, migrations: pdfNames.slice(from - 124) });
    expect(f.events.every((event) => event.startsWith('SELECT'))).toBe(true);
    expect(f.runner.startTransaction).not.toHaveBeenCalled();
    expect(f.builder.execute).not.toHaveBeenCalled();
    expect(f.factory.mock.calls[0][0]).toMatchObject({
      entities: [],
      synchronize: false,
      migrationsRun: false,
      installExtensions: false,
      logging: false,
    });
  });

  test.each([
    ['target 없음', ['--from', '125'], fakeUrl],
    ['port 없음', [...args.filter((value) => value !== '--port' && value !== '5432'), '--from', '125'], fakeUrl],
    ['URL port 불일치', [...args, '--from', '125'], fakeUrl.replace('.test/', '.test:55487/')],
    [
      'URL port 생략과 승인55486 불일치',
      [...args.map((value) => (value === '5432' ? '55486' : value)), '--from', '125'],
      fakeUrl,
    ],
    ['from 없음', args, fakeUrl],
    ['from127', [...args, '--from', '127'], fakeUrl],
    ['host 불일치', [...args, '--from', '125'], fakeUrl.replace('ep-synthetic', 'ep-other')],
    ['database 불일치', [...args, '--from', '125'], fakeUrl.replace('/pdf_synthetic', '/other')],
    ['query target 우회', [...args, '--from', '125'], `${fakeUrl}&host=other.example.test`],
    ['URL 없음', [...args, '--from', '125'], undefined],
    ['알 수 없는 flag', [...args, '--from', '125', '--all'], fakeUrl],
    ['중복 flag', [...args, '--from', '125', '--from', '124'], fakeUrl],
    [
      'pooler',
      [...args.map((value) => value.replace('ep-synthetic.', 'ep-synthetic-pooler.')), '--from', '125', '--run'],
      fakeUrl.replace('ep-synthetic.', 'ep-synthetic-pooler.'),
    ],
  ])('%s는 연결 전에 거절한다', async (_label, cli, url) => {
    const f = fixture();
    await expect(executePdfPrerequisiteMigration(cli as string[], url, f.factory)).rejects.toThrow();
    expect(f.factory).not.toHaveBeenCalled();
  });

  test.each(['0', '-1', '65536', '5432.5', '5e3', 'invalid'])('잘못된 port %s는 연결 전에 거절한다', async (port) => {
    const f = fixture();
    await expect(
      executePdfPrerequisiteMigration(
        [...args.map((value) => (value === '5432' ? port : value)), '--from', '125'],
        fakeUrl,
        f.factory,
      ),
    ).rejects.toThrow('INVALID_PORT');
    expect(f.factory).not.toHaveBeenCalled();
  });

  test.each(['5432', '55486'])('승인 port %s와 URL이 같으면 DataSource에도 고정한다', async (port) => {
    const f = fixture();
    await expect(
      executePdfPrerequisiteMigration(
        [...args.map((value) => (value === '5432' ? port : value)), '--from', '125'],
        fakeUrl.replace('.test/', `.test:${port}/`),
        f.factory,
      ),
    ).resolves.toMatchObject({ status: 'ready' });
    const options = f.factory.mock.calls[0][0];
    expect(options).toMatchObject({ port: Number(port) });
    if (options.type !== 'postgres' || typeof options.url !== 'string') {
      throw new Error('Postgres 연결 설정 필요');
    }
    expect(new URL(options.url).port).toBe(port);
  });

  test.each(['database', 'hasLedger'] as const)('연결 후 %s 불일치는 원장 생성 없이 거절한다', async (key) => {
    const f = fixture();
    if (key === 'database') {
      f.state.database = 'other';
    } else {
      f.state.hasLedger = false;
    }
    await expect(f.execute(true)).rejects.toThrow('IDENTITY_MISMATCH');
    expect(f.runner.startTransaction).not.toHaveBeenCalled();
    expect(f.state.ddl).toBe(0);
  });

  test.each([
    'missing',
    'timestamp',
    'duplicate',
    'unknown',
    'future',
    'already126',
    'source127',
    'sourceMissing',
    'sourceDuplicate',
  ])('%s 원장/source는 fail closed한다', async (condition) => {
    const f = fixture();
    if (condition === 'missing') {
      f.state.ledger.shift();
    } else if (condition === 'timestamp') {
      f.state.ledger[0].timestamp = 1;
    } else if (condition === 'duplicate') {
      f.state.ledger.push(row(sourceNames[0]));
    } else if (condition === 'unknown') {
      f.state.ledger[0] = row('Unknown1700000000000');
    } else if (condition === 'future') {
      f.state.ledger.push(row('Future1769600000000'));
    } else if (condition === 'already126') {
      f.state.ledger.push(row(pdfNames[1]));
    } else if (condition === 'source127') {
      f.state.sourceNames.push('StaffTeachingProfile1769600000000');
    } else if (condition === 'sourceMissing') {
      f.state.sourceNames.pop();
    } else {
      f.state.sourceNames[0] = f.state.sourceNames[1];
    }
    await expect(f.execute(true)).rejects.toThrow();
    expect(f.state.ddl).toBe(0);
    expect(f.builder.execute).not.toHaveBeenCalled();
  });

  test.each([124, 125] as const)('from %s는 정확한 원본 up과 TypeORM 원장을 같은 transaction으로 실행한다', async (from) => {
    const f = fixture(from);
    await expect(f.execute(true)).resolves.toEqual({ status: 'applied', from, migrations: pdfNames.slice(from - 124) });
    expect(f.state.ddl).toBe(from === 124 ? 15 : 4);
    expect(f.state.ledger.map((entry) => entry.name)).toEqual(sourceNames);
    expect(f.builder.into).toHaveBeenCalledWith('public.migrations');
    expect(f.runner.startTransaction).toHaveBeenCalledWith('READ COMMITTED');
    expect(f.events).toContain('SET LOCAL search_path = public');
    expect(f.events.indexOf('begin')).toBeLessThan(f.events.findIndex((event) => event.startsWith('ALTER')));
    expect(f.events.indexOf(`insert:${pdfNames[1]}`)).toBeLessThan(f.events.indexOf('commit'));
    expect(f.factory.mock.results[0].value.runMigrations).not.toHaveBeenCalled();
  });

  test('lock 뒤 원장을 재조회해 다른 적용이 끝났으면 추가 DDL 없이 중단한다', async () => {
    const f = fixture();
    f.state.onLock = () => f.state.ledger.push(row(pdfNames[1]));
    await expect(f.execute(true)).rejects.toThrow('BASELINE_MISMATCH');
    expect(f.state.ddl).toBe(0);
    expect(f.runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    const locked = f.events.findIndex((event) => event.startsWith('LOCK TABLE'));
    expect(f.events.slice(locked + 1).some((event) => event.includes('FROM public.migrations'))).toBe(true);
  });

  test.each(['ddl126', 'insert126', 'schema'])('%s 실패는125도 포함해 rollback하고 비밀값을 숨긴다', async (condition) => {
    const f = fixture(124);
    if (condition === 'ddl126') {
      f.state.failDdlAt = 14;
    } else if (condition === 'insert126') {
      f.state.failInsertAt = 2;
    } else {
      f.state.schemaRows[0].definition = 'CHECK (true)';
    }
    const error: unknown = await f.execute(true).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('never-print-this');
    expect(String(error)).not.toContain('postgresql:');
    expect(f.state.ledger).toEqual(sourceNames.slice(0, 124).map(row));
    expect(f.runner.commitTransaction).not.toHaveBeenCalled();
    expect(f.runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(f.runner.release).toHaveBeenCalledTimes(1);
  });

  test.each(['wrongTable', 'unvalidated', 'wrongByteaCap', 'missingIntent', 'wrongGrouping'])(
    '%s 제약 drift는 commit하지 않는다',
    async (condition) => {
      const f = fixture();
      if (condition === 'wrongTable') {
        f.state.schemaRows[0].table_name = 'other';
      } else if (condition === 'unvalidated') {
        f.state.schemaRows[0].validated = false;
      } else if (condition === 'wrongByteaCap') {
        f.state.schemaRows[0].definition = f.state.schemaRows[0].definition.replace('3000000', '1000000000');
      } else if (condition === 'missingIntent') {
        f.state.schemaRows.pop();
      } else {
        f.state.schemaRows[0].definition = f.state.schemaRows[0].definition.replace(')) OR ((', ') OR (((');
      }
      await expect(f.execute(true)).rejects.toThrow('SCHEMA_MISMATCH');
      expect(f.runner.commitTransaction).not.toHaveBeenCalled();
      expect(f.runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    },
  );

  test('실제 CLI의 잘못된 host는 접속 전 exit1이며 자격값을 출력하지 않는다', () => {
    const result = spawnSync(
      process.execPath,
      ['-r', require.resolve('ts-node/register'), 'scripts/pdf-prerequisite-migration.ts', ...args, '--from', '125'],
      {
        cwd: join(__dirname, '..'),
        env: { DATABASE_URL: fakeUrl.replace('ep-synthetic', 'ep-other') },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('PDF_PREREQ_TARGET_MISMATCH');
    expect(result.stderr).not.toContain('never-print-this');
  });
});
