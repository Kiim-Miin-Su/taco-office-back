/** @file-guide
 * 목적: 승인된 B1014 출하에서 선행125·126을 확인하고127 한 건만 검사하거나 적용한다.
 * 책임/재사용: 기존 deploy-check와 독립적이다. .env를 읽지 않으며 기본 모드는 SELECT만 실행한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { DataSource, Migration, MigrationExecutor } from 'typeorm';
import type { DataSourceOptions, QueryRunner } from 'typeorm';
import { StaffTeachingProfile1769600000000 } from '../src/migrations/1769600000000-staff-teaching-profile';

export const migration127Name = 'StaffTeachingProfile1769600000000';
const migration127Timestamp = 1769600000000;
const prerequisites = ['PrivateBookPdf1769200000000', 'BookPdfOneGigabyte1769500000000'];
type Result = { status: 'ready' | 'noop' | 'applied'; migration: typeof migration127Name };
type Options = { host: string; port: number; database: string; run: boolean };

class Migration127Error extends Error {
  constructor(code: string) {
    super(`B1014_${code}`);
  }
}

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  let run = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--run' && !run) {
      run = true;
    } else if (['--host', '--port', '--database'].includes(flag) && !values.has(flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--') || value.trim() !== value) {
        throw new Migration127Error('INVALID_ARGUMENTS');
      }
      values.set(flag, value);
    } else {
      throw new Migration127Error('INVALID_ARGUMENTS');
    }
  }
  const host = values.get('--host');
  const port = values.get('--port');
  const database = values.get('--database');
  if (!host || !port || !database) {
    throw new Migration127Error('EXPLICIT_TARGET_REQUIRED');
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Migration127Error('INVALID_PORT');
  }
  return { host, port: Number(port), database, run };
}

function validateTarget(options: Options, databaseUrl: string | undefined): string {
  if (!databaseUrl) {
    throw new Migration127Error('DATABASE_URL_REQUIRED');
  }
  let url: URL;
  let database: string;
  try {
    url = new URL(databaseUrl);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Migration127Error('INVALID_DATABASE_URL');
  }
  // pg의 query parameter로 host/database/options가 URL 경계를 덮어쓰지 못하게 한다.
  const allowedParameters = new Set(['sslmode', 'channel_binding']);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== options.host.toLowerCase() ||
    Number(url.port || '5432') !== options.port ||
    database !== options.database ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => !allowedParameters.has(key))
  ) {
    throw new Migration127Error('TARGET_MISMATCH');
  }
  if (options.run && /-pooler(?:\.|$)/i.test(url.hostname)) {
    throw new Migration127Error('DIRECT_HOST_REQUIRED');
  }
  // URL에 port가 없으면 pg는 PGPORT를 상속한다. 승인된 기본 port도 URL에 명시해 우회를 막는다.
  url.port = String(options.port);
  return url.toString();
}

async function checkIdentity(queryRunner: QueryRunner, database: string): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT current_database() AS database, to_regclass('public.migrations') IS NOT NULL AS has_ledger`,
  );
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.database !== database || rows[0]?.has_ledger !== true) {
    throw new Migration127Error('DATABASE_OR_LEDGER_MISMATCH');
  }
}

async function checkLedger(queryRunner: QueryRunner, dataSource: DataSource): Promise<'ready' | 'noop'> {
  const registeredNames = dataSource.migrations.map((migration) => migration.name ?? migration.constructor.name);
  if (
    new Set(registeredNames).size !== registeredNames.length ||
    dataSource.migrations.filter((migration) => migration instanceof StaffTeachingProfile1769600000000).length !== 1 ||
    !registeredNames.includes(migration127Name)
  ) {
    throw new Migration127Error('MIGRATION_SOURCE_MISMATCH');
  }
  const rows: unknown = await queryRunner.query('SELECT name, timestamp FROM public.migrations ORDER BY id');
  if (!Array.isArray(rows)) {
    throw new Migration127Error('LEDGER_MISMATCH');
  }
  // 격리 출하 사본에126 source가 없어도 실제 DB 원장의126은 반드시 있어야 한다.
  const knownNames = new Set([...registeredNames, ...prerequisites]);
  const executedNames = new Set<string>();
  for (const entry of rows) {
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      !/\d{13}$/.test(entry.name) ||
      !knownNames.has(entry.name) ||
      executedNames.has(entry.name) ||
      !['number', 'string'].includes(typeof entry.timestamp) ||
      Number(entry.timestamp) !== Number(entry.name.slice(-13)) ||
      Number(entry.timestamp) > migration127Timestamp
    ) {
      throw new Migration127Error('LEDGER_MISMATCH');
    }
    executedNames.add(entry.name);
  }
  if (prerequisites.some((name) => !executedNames.has(name))) {
    throw new Migration127Error('PREREQUISITE_MISSING');
  }
  const pending = registeredNames.filter((name) => !executedNames.has(name));
  const complete = executedNames.has(migration127Name);
  if ((complete && pending.length !== 0) || (!complete && (pending.length !== 1 || pending[0] !== migration127Name))) {
    throw new Migration127Error('PENDING_MISMATCH');
  }
  return complete ? 'noop' : 'ready';
}

async function checkAppliedSchema(queryRunner: QueryRunner): Promise<void> {
  const expected = new Map([
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
      'FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE',
    ],
    [
      'constraint:staff_teaching_kind.staff_teaching_kind_kind_fk',
      'FOREIGN KEY (kind_key) REFERENCES kind(key) ON DELETE RESTRICT',
    ],
    ['constraint:staff_teaching_kind.staff_teaching_kind_allowed', "CHECK (kind_key = ANY (ARRAY['class', 'mock', 'study']))"],
    ['constraint:staff_education_summary.staff_education_summary_pk', 'PRIMARY KEY (staff_id, "position")'],
    [
      'constraint:staff_education_summary.staff_education_summary_staff_fk',
      'FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE',
    ],
    // position은 pg_get_constraintdef가 인용하는 식별자다. 실제 catalog 표현 그대로 비교한다.
    ['constraint:staff_education_summary.staff_education_summary_position', 'CHECK ("position" >= 0 AND "position" <= 4)'],
    ['constraint:staff_education_summary.staff_education_summary_school', 'CHECK (char_length(btrim(school)) > 0)'],
    [
      'index:staff_teaching_kind.staff_teaching_kind_kind_idx',
      'CREATE INDEX staff_teaching_kind_kind_idx ON staff_teaching_kind USING btree (kind_key)',
    ],
  ]);
  const rows: unknown = await queryRunner.query(`SELECT
      'column:' || table_name || '.' || column_name AS key,
      data_type || '|' || is_nullable || '|' || coalesce(character_maximum_length::text, '') AS definition,
      true AS validated
    FROM information_schema.columns
    WHERE table_schema = 'public' AND (
      (table_name = 'staff' AND column_name IN ('birth_on', 'english_only'))
      OR table_name IN ('staff_teaching_kind', 'staff_education_summary')
    )
    UNION ALL SELECT 'constraint:' || t.relname || '.' || c.conname, pg_get_constraintdef(c.oid), c.convalidated
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname IN ('staff_teaching_kind', 'staff_education_summary') AND c.contype IN ('p', 'f', 'c')
    UNION ALL SELECT 'index:' || t.relname || '.' || i.relname, pg_get_indexdef(x.indexrelid), x.indisvalid
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND i.relname = 'staff_teaching_kind_kind_idx'`);
  // PostgreSQL이 추가하는 cast·괄호·public 수식만 정규화한다. 제약 대상/동작/조건·열 길이는 모두 비교한다.
  const normalize = (value: string): string =>
    value
      .split(/('(?:[^']|'')*')/g)
      .map((part, index) =>
        index % 2 === 1
          ? part
          : part
              .replace(/::(?:character varying|text|smallint|integer)(?:\[\])?/g, '')
              .replace(/\bpublic\./g, '')
              .replace(/[\s()]/g, ''),
      )
      .join('');
  if (!Array.isArray(rows) || rows.length !== expected.size) {
    throw new Migration127Error('SCHEMA_MISMATCH');
  }
  for (const entry of rows) {
    const definition = entry && typeof entry.key === 'string' ? expected.get(entry.key) : undefined;
    if (
      !definition ||
      typeof entry.definition !== 'string' ||
      entry.validated !== true ||
      normalize(entry.definition) !== normalize(definition)
    ) {
      throw new Migration127Error('SCHEMA_MISMATCH');
    }
    expected.delete(entry.key);
  }
}

/** hostname은 endpoint 고정일 뿐 branch API 확인·백업·출하 승인을 대체하지 않는다. */
export async function executeB1014Migration127(
  args: string[],
  databaseUrl: string | undefined,
  createDataSource: (options: DataSourceOptions) => DataSource = (options) => new DataSource(options),
): Promise<Result> {
  const options = parseArgs(args);
  const url = validateTarget(options, databaseUrl);
  const dataSource = createDataSource({
    type: 'postgres',
    url,
    port: options.port,
    schema: 'public',
    entities: [],
    migrations: [join(__dirname, '../src/migrations/*{.ts,.js}')],
    migrationsTableName: 'migrations',
    synchronize: false,
    migrationsRun: false,
    installExtensions: false,
    logging: false,
    extra: { connectionTimeoutMillis: 10000, application_name: 'taco-b1014-migration127' },
  });
  let initialized = false;
  let queryRunner: QueryRunner | undefined;
  try {
    try {
      await dataSource.initialize();
      initialized = true;
      queryRunner = dataSource.createQueryRunner();
      await checkIdentity(queryRunner, options.database);
      const status = await checkLedger(queryRunner, dataSource);
      if (status === 'noop') {
        await checkAppliedSchema(queryRunner);
        return { status, migration: migration127Name };
      }
      if (!options.run) {
        return { status, migration: migration127Name };
      }

      await queryRunner.startTransaction('READ COMMITTED');
      await queryRunner.query("SET LOCAL lock_timeout = '5s'");
      await queryRunner.query("SET LOCAL statement_timeout = '60s'");
      await queryRunner.query('SET LOCAL search_path = public');
      // 동일 실행기는 advisory lock으로 직렬화한다. 원장 lock 뒤 READ COMMITTED 재조회로 TOCTOU를 닫는다.
      // 기존 generic runner/수동 DDL은 같은 advisory lock을 쓰지 않으므로 별도 배포의 동시 실행 금지가 전제다.
      await queryRunner.query('SELECT pg_advisory_xact_lock(1014, 127)');
      await queryRunner.query('LOCK TABLE public.migrations IN SHARE ROW EXCLUSIVE MODE');
      await checkIdentity(queryRunner, options.database);
      if ((await checkLedger(queryRunner, dataSource)) === 'noop') {
        await checkAppliedSchema(queryRunner);
        await queryRunner.commitTransaction();
        return { status: 'noop', migration: migration127Name };
      }

      // executeMigration도 원장/metadata 생성 부작용이 있다. 정확한127 up과 공개 원장 writer만 같은 runner로 호출한다.
      const migration = new StaffTeachingProfile1769600000000();
      await migration.up(queryRunner);
      await new MigrationExecutor(dataSource, queryRunner).insertMigration(
        new Migration(undefined, migration127Timestamp, migration127Name, migration),
      );
      if ((await checkLedger(queryRunner, dataSource)) !== 'noop') {
        throw new Migration127Error('POSTCONDITION_FAILED');
      }
      await checkAppliedSchema(queryRunner);
      await queryRunner.commitTransaction();
      return { status: 'applied', migration: migration127Name };
    } catch (error: unknown) {
      if (queryRunner?.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      try {
        if (queryRunner) {
          await queryRunner.release();
        }
      } finally {
        if (initialized) {
          await dataSource.destroy();
        }
      }
    }
  } catch (error: unknown) {
    // pg/TypeORM 원문에는 접속 문자열·사용자·SQL이 포함될 수 있다. 허용된 고정 오류 코드만 밖으로 보낸다.
    throw error instanceof Migration127Error ? error : new Migration127Error('EXECUTION_FAILED');
  }
}

if (require.main === module) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
    console.log('Usage: npm run migration:b1014 -- --host <expected-host> --port <1..65535> --database <expected-db> [--run]');
    console.log('Default: SELECT only. --run: direct host required; only migration127 after ledger125/126. No .env loading.');
    console.log('Endpoint matching does not replace branch verification, backup, or separate deployment approval.');
  } else {
    void executeB1014Migration127(process.argv.slice(2), process.env.DATABASE_URL)
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error: unknown) => {
        console.error(error instanceof Migration127Error ? error.message : 'B1014_EXECUTION_FAILED');
        process.exitCode = 1;
      });
  }
}
