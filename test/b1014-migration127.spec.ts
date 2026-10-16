/** @file-guide
 * 목적: B1014 전용 이행 실행기의 대상·선행 원장·단일 실행·실패 원자성을 네트워크 없이 검증한다.
 * 책임/재사용: 실제 TypeORM 원장 writer와 127 up을 fake QueryRunner에 연결하며 DB나 환경 파일을 읽지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import type { DataSourceOptions, MigrationInterface, QueryRunner } from 'typeorm';
import { executeB1014Migration127, migration127Name } from '../scripts/b1014-migration127';
import { StaffTeachingProfile1769600000000 } from '../src/migrations/1769600000000-staff-teaching-profile';

const prerequisiteNames = ['PrivateBookPdf1769200000000', 'BookPdfOneGigabyte1769500000000'];
const fakeUrl = 'postgresql://synthetic:never-print-this@ep-synthetic.example.test/taco_synthetic?sslmode=require';
const args = ['--host', 'ep-synthetic.example.test', '--port', '5432', '--database', 'taco_synthetic'];
type LedgerRow = { name: string; timestamp: string | number };
const row = (name: string): LedgerRow => ({ name, timestamp: name.slice(-13) });

function fixture() {
  const schemaRows = [
    ['column:staff.birth_on', 'date|YES|'],
    ['column:staff.english_only', 'boolean|YES|'],
    ['column:staff_teaching_kind.staff_id', 'bigint|NO|'],
    ['column:staff_teaching_kind.kind_key', 'character varying|NO|16'],
    ['column:staff_education_summary.staff_id', 'bigint|NO|'],
    ['column:staff_education_summary.position', 'smallint|NO|'],
    ['column:staff_education_summary.school', 'character varying|NO|120'],
    ['column:staff_education_summary.major', 'character varying|YES|120'],
    ['column:staff_education_summary.degree', 'character varying|YES|40'],
    ['column:staff_education_summary.status', 'character varying|YES|40'],
    ['constraint:staff_teaching_kind.staff_teaching_kind_pk', 'PRIMARY KEY (staff_id, kind_key)'],
    [
      'constraint:staff_teaching_kind.staff_teaching_kind_staff_fk',
      'FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE',
    ],
    [
      'constraint:staff_teaching_kind.staff_teaching_kind_kind_fk',
      'FOREIGN KEY (kind_key) REFERENCES public.kind(key) ON DELETE RESTRICT',
    ],
    [
      'constraint:staff_teaching_kind.staff_teaching_kind_allowed',
      "CHECK (((kind_key)::text = ANY ((ARRAY['class'::character varying, 'mock'::character varying, 'study'::character varying])::text[])))",
    ],
    ['constraint:staff_education_summary.staff_education_summary_pk', 'PRIMARY KEY (staff_id, "position")'],
    [
      'constraint:staff_education_summary.staff_education_summary_staff_fk',
      'FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE',
    ],
    ['constraint:staff_education_summary.staff_education_summary_position', 'CHECK ((("position" >= 0) AND ("position" <= 4)))'],
    ['constraint:staff_education_summary.staff_education_summary_school', 'CHECK ((char_length(btrim((school)::text)) > 0))'],
    [
      'index:staff_teaching_kind.staff_teaching_kind_kind_idx',
      'CREATE INDEX staff_teaching_kind_kind_idx ON public.staff_teaching_kind USING btree (kind_key)',
    ],
  ].map(([key, definition]) => ({ key, definition, validated: true }));
  const state = {
    ledger: prerequisiteNames.map(row),
    sourceNames: [...prerequisiteNames, migration127Name],
    database: 'taco_synthetic',
    hasLedger: true,
    schemaMatches: true,
    schemaRows,
    active: false,
    ddl: 0,
    failDdl: false,
    failInsert: false,
    onLock: undefined as (() => void) | undefined,
  };
  const events: string[] = [];
  let beforeTransaction: LedgerRow[] = [];
  let inserted: LedgerRow | undefined;
  const insertBuilder = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    execute: jest.fn(async () => {
      events.push('insert');
      if (state.failInsert) {
        throw new Error(`driver may contain ${fakeUrl}`);
      }
      if (!state.active || !inserted) {
        throw new Error('원장 insert는 활성 transaction 안이어야 한다');
      }
      state.ledger.push(inserted);
    }),
  };
  insertBuilder.values.mockImplementation((value: LedgerRow) => {
    inserted = value;
    return insertBuilder;
  });
  const query = jest.fn(async (sql: string) => {
    events.push(sql);
    if (sql.includes('current_database()')) {
      return [{ database: state.database, has_ledger: state.hasLedger }];
    }
    if (sql.includes('FROM public.migrations')) {
      return state.ledger.map((entry) => ({ ...entry }));
    }
    if (sql.includes('FROM information_schema.columns')) {
      return state.schemaMatches ? state.schemaRows : [];
    }
    if (sql.startsWith('LOCK TABLE')) {
      state.onLock?.();
      return [];
    }
    if (/^(ALTER|CREATE) /.test(sql)) {
      if (!state.active) {
        throw new Error('DDL은 활성 transaction 안이어야 한다');
      }
      state.ddl += 1;
      if (state.failDdl) {
        throw new Error(`driver may contain ${fakeUrl}`);
      }
    }
    return [];
  });
  const runner = {
    query,
    manager: { createQueryBuilder: () => insertBuilder },
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
    const dataSource = new DataSource(options);
    jest.spyOn(dataSource, 'initialize').mockImplementation(async () => {
      dataSource.migrations.push(
        ...state.sourceNames.map((name): MigrationInterface => {
          if (name === migration127Name) {
            return new StaffTeachingProfile1769600000000();
          }
          return { name, up: jest.fn(), down: jest.fn() };
        }),
      );
      return dataSource;
    });
    jest.spyOn(dataSource, 'createQueryRunner').mockReturnValue(runner as unknown as QueryRunner);
    jest.spyOn(dataSource, 'destroy').mockResolvedValue(undefined);
    jest.spyOn(dataSource, 'runMigrations').mockRejectedValue(new Error('일괄 이행 호출 금지'));
    return dataSource;
  });
  const execute = (run = false, url = fakeUrl, cli = args) =>
    executeB1014Migration127(run ? [...cli, '--run'] : cli, url, factory);
  return { state, events, runner, factory, execute, insertBuilder };
}

describe('B1014 migration 127 restricted runner', () => {
  test('기본 모드는 SELECT만 실행하고 선행126이 source에 없어도 실제 원장을 요구한다', async () => {
    const f = fixture();
    f.state.sourceNames = [prerequisiteNames[0], migration127Name];
    await expect(f.execute()).resolves.toEqual({ status: 'ready', migration: migration127Name });
    expect(f.events.every((event) => event.startsWith('SELECT'))).toBe(true);
    expect(f.runner.startTransaction).not.toHaveBeenCalled();
    expect(f.insertBuilder.execute).not.toHaveBeenCalled();
    expect(f.factory.mock.calls[0][0]).toMatchObject({ synchronize: false, migrationsRun: false, logging: false });
  });

  test.each([
    ['명시 target 없음', [], fakeUrl],
    ['명시 port 없음', args.filter((value) => !['--port', '5432'].includes(value)), fakeUrl],
    ['host 불일치', args, fakeUrl.replace('ep-synthetic', 'ep-other')],
    ['port 불일치', args, fakeUrl.replace('.test/', '.test:55494/')],
    ['URL 기본 port 불일치', args.map((value) => (value === '5432' ? '55494' : value)), fakeUrl],
    ['database 불일치', args, fakeUrl.replace('/taco_synthetic', '/other')],
    ['query target 우회', args, `${fakeUrl}&host=ep-other.example.test`],
    ['URL 없음', args, undefined],
    ['알 수 없는 flag', [...args, '--apply-all'], fakeUrl],
    ['중복 flag', [...args, '--host', 'ep-synthetic.example.test'], fakeUrl],
  ])('%s는 연결 전에 거절한다', async (_label, cli, url) => {
    const f = fixture();
    await expect(executeB1014Migration127(cli as string[], url, f.factory)).rejects.toThrow();
    expect(f.factory).not.toHaveBeenCalled();
  });

  test.each(['0', '65536', '-1', '1.5', '1e3', '+5432', '5432x'])('허용 범위 밖 port %s는 연결 전에 거절한다', async (port) => {
    const f = fixture();
    const cli = args.map((value) => (value === '5432' ? port : value));
    await expect(f.execute(false, fakeUrl, cli)).rejects.toThrow();
    expect(f.factory).not.toHaveBeenCalled();
  });

  test.each([1, 5432, 55494, 65535])('일치하는 명시 port %s를 URL과 TypeORM 연결에 고정한다', async (port) => {
    const f = fixture();
    const cli = args.map((value) => (value === '5432' ? String(port) : value));
    const url = fakeUrl.replace('.test/', `.test:${port}/`);
    await expect(f.execute(false, url, cli)).resolves.toMatchObject({ status: 'ready' });
    expect(f.factory.mock.calls[0][0]).toMatchObject({ url, port });
  });

  test('URL에 생략된 port는5432로 정규화하며 pg가 PGPORT를 상속하지 않는다', async () => {
    const f = fixture();
    await expect(f.execute(false, fakeUrl.replace('sslmode=require', 'sslmode=verify-full'))).resolves.toMatchObject({
      status: 'ready',
    });
    const options = f.factory.mock.calls[0][0];
    if (options.type !== 'postgres' || !options.url) {
      throw new Error('Postgres URL을 명시해야 한다');
    }
    expect(new URL(options.url).port).toBe('5432');
    expect(options.port).toBe(5432);
    // pg Client의 설정 생성만 실행하며 connect는 호출하지 않는다. 실제 driver의 환경변수 우회를 회귀 검증한다.
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        [
          "const client = new (require('pg').Client)({connectionString:process.argv[1],port:Number(process.argv[2])});",
          'process.stdout.write(String(client.connectionParameters.port));',
        ].join(' '),
        options.url,
        String(options.port),
      ],
      { cwd: join(__dirname, '..'), env: { PGPORT: '55495' }, encoding: 'utf8', timeout: 10000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('5432');
  });

  test('pooler URL은 check에는 허용하되 --run 연결 전 거절한다', async () => {
    const f = fixture();
    const poolerUrl = fakeUrl.replace('ep-synthetic.', 'ep-synthetic-pooler.');
    const poolerArgs = args.map((value) => value.replace('ep-synthetic.', 'ep-synthetic-pooler.'));
    await expect(f.execute(false, poolerUrl, poolerArgs)).resolves.toMatchObject({ status: 'ready' });
    f.factory.mockClear();
    await expect(f.execute(true, poolerUrl, poolerArgs)).rejects.toThrow('DIRECT_HOST_REQUIRED');
    expect(f.factory).not.toHaveBeenCalled();
  });

  test('실제 CLI도 잘못된 host를 접속 전에 exit1로 거절하고 URL을 출력하지 않는다', () => {
    const result = spawnSync(
      process.execPath,
      ['-r', require.resolve('ts-node/register'), 'scripts/b1014-migration127.ts', ...args],
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
    expect(result.stderr.trim()).toBe('B1014_TARGET_MISMATCH');
    expect(result.stderr).not.toContain('never-print-this');
  });

  test.each(['database', 'hasLedger'] as const)('실제 %s 불일치는 원장 생성·DDL 없이 거절한다', async (key) => {
    const f = fixture();
    if (key === 'database') {
      f.state.database = 'wrong_database';
    } else {
      f.state.hasLedger = false;
    }
    await expect(f.execute(true)).rejects.toThrow();
    expect(f.runner.startTransaction).not.toHaveBeenCalled();
    expect(f.state.ddl).toBe(0);
  });

  test.each(['missing125', 'missing126', 'timestamp', 'duplicate', 'extraPending', 'future', 'unknown'])(
    '%s 원장은 fail closed로 DDL 전에 중단한다',
    async (condition) => {
      const f = fixture();
      if (condition === 'missing125' || condition === 'missing126') {
        f.state.ledger.splice(condition === 'missing125' ? 0 : 1, 1);
      } else if (condition === 'timestamp') {
        f.state.ledger[0].timestamp = 1;
      } else if (condition === 'duplicate') {
        f.state.ledger.push(row(prerequisiteNames[0]));
      } else if (condition === 'extraPending') {
        f.state.sourceNames.push('Unapproved1769700000000');
      } else if (condition === 'future') {
        f.state.sourceNames.push('Future1769700000000');
        f.state.ledger.push(row('Future1769700000000'));
      } else {
        f.state.ledger.push(row('Unknown1769100000000'));
      }
      await expect(f.execute(true)).rejects.toThrow();
      expect(f.state.ddl).toBe(0);
      expect(f.insertBuilder.execute).not.toHaveBeenCalled();
    },
  );

  test('정확한127 up과 TypeORM 원장 insert만 같은 transaction으로 실행한다', async () => {
    const f = fixture();
    await expect(f.execute(true)).resolves.toEqual({ status: 'applied', migration: migration127Name });
    expect(f.state.ddl).toBe(4);
    expect(f.state.ledger.at(-1)).toEqual({ name: migration127Name, timestamp: 1769600000000 });
    expect(f.insertBuilder.into).toHaveBeenCalledWith('public.migrations');
    expect(f.events.indexOf('begin')).toBeLessThan(f.events.findIndex((event) => event.startsWith('ALTER')));
    expect(f.events.some((event) => event === 'SET LOCAL search_path = public')).toBe(true);
    expect(f.events.indexOf('insert')).toBeLessThan(f.events.indexOf('commit'));
    expect(f.runner.rollbackTransaction).not.toHaveBeenCalled();
    expect(f.factory.mock.results[0].value.runMigrations).not.toHaveBeenCalled();
  });

  test.each([false, true])('127 완료면 원장과 schema를 확인하고 명확한 noop(run=%s)', async (run) => {
    const f = fixture();
    f.state.ledger.push(row(migration127Name));
    await expect(f.execute(run)).resolves.toEqual({ status: 'noop', migration: migration127Name });
    expect(f.state.ddl).toBe(0);
    expect(f.insertBuilder.execute).not.toHaveBeenCalled();
  });

  test('127 완료 원장만 있고 schema가 없으면 noop하지 않는다', async () => {
    const f = fixture();
    f.state.ledger.push(row(migration127Name));
    f.state.schemaMatches = false;
    await expect(f.execute()).rejects.toThrow('SCHEMA_MISMATCH');
  });

  test.each([
    ['column:staff_education_summary.school', 'character varying|NO|999'],
    [
      'constraint:staff_teaching_kind.staff_teaching_kind_allowed',
      "CHECK (kind_key = ANY (ARRAY['class::text', 'mock', 'study']))",
    ],
    [
      'constraint:staff_teaching_kind.staff_teaching_kind_staff_fk',
      'FOREIGN KEY (staff_id) REFERENCES other(id) ON DELETE CASCADE',
    ],
    [
      'constraint:staff_teaching_kind.staff_teaching_kind_kind_fk',
      'FOREIGN KEY (kind_key) REFERENCES kind(key) ON DELETE CASCADE',
    ],
    ['constraint:staff_education_summary.staff_education_summary_school', 'CHECK (true)'],
    ['constraint:staff_education_summary.staff_education_summary_pk', 'PRIMARY KEY (position)'],
    [
      'index:staff_teaching_kind.staff_teaching_kind_kind_idx',
      'CREATE INDEX staff_teaching_kind_kind_idx ON staff_teaching_kind USING btree (staff_id)',
    ],
  ])('같은 이름의 schema라도 정의가 바뀌면 noop 거절: %s', async (key, definition) => {
    const f = fixture();
    f.state.ledger.push(row(migration127Name));
    f.state.schemaRows = f.state.schemaRows.map((entry) => (entry.key === key ? { ...entry, definition } : entry));
    await expect(f.execute()).rejects.toThrow('SCHEMA_MISMATCH');
  });

  test('lock 대기 중 다른 실행이127을 끝내면 원장을 재조회하고 noop한다', async () => {
    const f = fixture();
    f.state.onLock = () => f.state.ledger.push(row(migration127Name));
    await expect(f.execute(true)).resolves.toMatchObject({ status: 'noop' });
    expect(f.state.ddl).toBe(0);
    expect(f.insertBuilder.execute).not.toHaveBeenCalled();
  });

  test('lock 대기 중 예상 밖 원장이 생기면 재조회에서 거절한다', async () => {
    const f = fixture();
    f.state.onLock = () => f.state.ledger.push(row('Unexpected1769700000000'));
    await expect(f.execute(true)).rejects.toThrow('LEDGER_MISMATCH');
    expect(f.state.ddl).toBe(0);
    expect(f.runner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  test.each(['failDdl', 'failInsert', 'schemaMatches'] as const)(
    '%s 실패는 rollback하며 접속값을 노출하지 않는다',
    async (key) => {
      const f = fixture();
      f.state[key] = key !== 'schemaMatches';
      const error = await f.execute(true).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('never-print-this');
      expect(String(error)).not.toContain('postgresql:');
      expect(f.runner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(f.runner.commitTransaction).not.toHaveBeenCalled();
      expect(f.state.ledger).toEqual(prerequisiteNames.map(row));
      expect(f.runner.release).toHaveBeenCalledTimes(1);
    },
  );
});
