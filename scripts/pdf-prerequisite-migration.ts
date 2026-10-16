/** @file-guide
 * 목적: 승인된 PDF 선행 출하에서125·126만 정확한 시작 원장부터 검사하거나 원자적으로 적용한다.
 * 책임/재사용: PDF 전용126 source 사본에서만 실행한다. process env만 사용하며 기본 모드는 SELECT 전용이다.
 * 검증/작업 지침: test/pdf-prerequisite-migration.spec.ts · docs/AGENT.md · docs/contracts/FILE-GUIDE.md
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { DataSource, Migration, MigrationExecutor } from 'typeorm';
import type { DataSourceOptions, QueryRunner } from 'typeorm';
import { PrivateBookPdf1769200000000 } from '../src/migrations/1769200000000-private-book-pdf';
import { BookPdfOneGigabyte1769500000000 } from '../src/migrations/1769500000000-book-pdf-one-gb';

const pdfNames = ['PrivateBookPdf1769200000000', 'BookPdfOneGigabyte1769500000000'];
type Options = { host: string; port: number; database: string; from: 124 | 125; run: boolean };
type Result = { status: 'ready' | 'applied'; from: 124 | 125; migrations: string[] };

class PdfMigrationError extends Error {
  constructor(code: string) {
    super(`PDF_PREREQ_${code}`);
  }
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  let run = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--run' && !run) {
      run = true;
    } else if (['--host', '--port', '--database', '--from'].includes(flag) && !values.has(flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--') || value.trim() !== value) {
        throw new PdfMigrationError('INVALID_ARGUMENTS');
      }
      values.set(flag, value);
    } else {
      throw new PdfMigrationError('INVALID_ARGUMENTS');
    }
  }
  const host = values.get('--host');
  const port = values.get('--port');
  const database = values.get('--database');
  const from = values.get('--from');
  if (!host || !port || !database || (from !== '124' && from !== '125')) {
    throw new PdfMigrationError('EXPLICIT_TARGET_AND_BASELINE_REQUIRED');
  }
  if (!/^\d+$/.test(port) || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new PdfMigrationError('INVALID_PORT');
  }
  return { host, port: Number(port), database, from: from === '124' ? 124 : 125, run };
}

function validateTarget(options: Options, databaseUrl: string | undefined): string {
  if (!databaseUrl) {
    throw new PdfMigrationError('DATABASE_URL_REQUIRED');
  }
  let url: URL;
  let database: string;
  try {
    url = new URL(databaseUrl);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new PdfMigrationError('INVALID_DATABASE_URL');
  }
  // URL의 query parameter가 연결 대상을 덮어쓰지 못하게 한다. SSL 관련 지정만 허용한다.
  const allowedParameters = new Set(['sslmode', 'channel_binding']);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== options.host.toLowerCase() ||
    Number(url.port || '5432') !== options.port ||
    database !== options.database ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => !allowedParameters.has(key))
  ) {
    throw new PdfMigrationError('TARGET_MISMATCH');
  }
  if (/-pooler(?:\.|$)/i.test(url.hostname)) {
    throw new PdfMigrationError('DIRECT_HOST_REQUIRED');
  }
  // pg는 connectionString을 개별 options보다 우선한다. 빈 URL port는 PGPORT를 상속하므로 양쪽을 명시한다.
  url.port = String(options.port);
  return url.toString();
}

function checkSource(dataSource: DataSource): string[] {
  const names = dataSource.migrations.map((migration) => migration.name ?? migration.constructor.name);
  const timestamps = names.map((name) => Number(name.slice(-13)));
  if (
    names.length !== 126 ||
    new Set(names).size !== 126 ||
    new Set(timestamps).size !== 126 ||
    names.some((name) => !/\d{13}$/.test(name)) ||
    timestamps.some((timestamp) => timestamp > 1769500000000) ||
    dataSource.migrations.filter((migration) => migration instanceof PrivateBookPdf1769200000000).length !== 1 ||
    dataSource.migrations.filter((migration) => migration instanceof BookPdfOneGigabyte1769500000000).length !== 1
  ) {
    // 원본 작업 폴더의127을 포함한 채 출하할 수 없다. 검증된 PDF 전용 사본이 실행 경계다.
    throw new PdfMigrationError('PDF_SOURCE_126_ONLY_REQUIRED');
  }
  const sorted = names.sort((left, right) => Number(left.slice(-13)) - Number(right.slice(-13)));
  if (sorted[124] !== pdfNames[0] || sorted[125] !== pdfNames[1]) {
    throw new PdfMigrationError('PDF_SOURCE_126_ONLY_REQUIRED');
  }
  return sorted;
}

async function checkIdentity(queryRunner: QueryRunner, database: string): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT current_database() AS database, to_regclass('public.migrations') IS NOT NULL AS has_ledger`,
  );
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.database !== database || rows[0]?.has_ledger !== true) {
    throw new PdfMigrationError('IDENTITY_MISMATCH');
  }
}

async function checkLedger(queryRunner: QueryRunner, sourceNames: string[], expectedCount: 124 | 125 | 126): Promise<void> {
  const rows: unknown = await queryRunner.query('SELECT name, timestamp FROM public.migrations ORDER BY timestamp, id');
  if (!Array.isArray(rows)) {
    throw new PdfMigrationError('LEDGER_MISMATCH');
  }
  const executed = new Set<string>();
  for (const entry of rows) {
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      !sourceNames.includes(entry.name) ||
      executed.has(entry.name) ||
      !['string', 'number'].includes(typeof entry.timestamp) ||
      Number(entry.timestamp) !== Number(entry.name.slice(-13))
    ) {
      throw new PdfMigrationError('LEDGER_MISMATCH');
    }
    executed.add(entry.name);
  }
  const expectedPending = sourceNames.slice(expectedCount);
  const actualPending = sourceNames.filter((name) => !executed.has(name));
  if (
    executed.size !== expectedCount ||
    actualPending.length !== expectedPending.length ||
    actualPending.some((name, index) => name !== expectedPending[index])
  ) {
    throw new PdfMigrationError('BASELINE_MISMATCH');
  }
}

async function checkAppliedSchema(queryRunner: QueryRunner): Promise<void> {
  const expected = new Map([
    [
      'file.file_size_cap',
      'CHECK ((((blob_path IS NULL) AND (bytes > 0) AND (bytes <= 3000000)) OR ((blob_path IS NOT NULL) AND (bytes > 0) AND (bytes <= 1000000000))))',
    ],
    [
      'book_pdf_upload.book_pdf_upload_expected_bytes_check',
      'CHECK (((expected_bytes > 0) AND (expected_bytes <= 1000000000)))',
    ],
  ]);
  const rows: unknown = await queryRunner.query(`SELECT t.relname AS table_name, c.conname AS name,
      pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND c.contype = 'c' AND (
      (t.relname = 'file' AND c.conname = 'file_size_cap') OR
      (t.relname = 'book_pdf_upload' AND c.conname = 'book_pdf_upload_expected_bytes_check')
    )`);
  if (!Array.isArray(rows) || rows.length !== expected.size) {
    throw new PdfMigrationError('SCHEMA_MISMATCH');
  }
  // 논리 괄호를 지우면 다른 조건도 같다고 오인할 수 있다. PG18 catalog 표현의 공백만 제거해 비교한다.
  for (const entry of rows) {
    const key = `${entry?.table_name}.${entry?.name}`;
    const definition = expected.get(key);
    if (
      !definition ||
      typeof entry?.definition !== 'string' ||
      entry.validated !== true ||
      entry.definition.replace(/\s+/g, '') !== definition.replace(/\s+/g, '')
    ) {
      throw new PdfMigrationError('SCHEMA_MISMATCH');
    }
    expected.delete(key);
  }
}

/** endpoint 고정은 branch API 확인·백업/복원 검증·각 환경의 별도 출하 승인을 대체하지 않는다. */
export async function executePdfPrerequisiteMigration(
  args: string[],
  databaseUrl: string | undefined,
  createDataSource: (options: DataSourceOptions) => DataSource = (options) => new DataSource(options),
): Promise<Result> {
  const options = parseOptions(args);
  const url = validateTarget(options, databaseUrl);
  let dataSource: DataSource | undefined;
  let queryRunner: QueryRunner | undefined;
  let initialized = false;
  try {
    try {
      dataSource = createDataSource({
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
        extra: { connectionTimeoutMillis: 10000, application_name: 'taco-pdf-prerequisite-migration' },
      });
      await dataSource.initialize();
      initialized = true;
      const sourceNames = checkSource(dataSource);
      queryRunner = dataSource.createQueryRunner();
      await checkIdentity(queryRunner, options.database);
      await checkLedger(queryRunner, sourceNames, options.from);
      const migrations = pdfNames.slice(options.from - 124);
      if (!options.run) {
        return { status: 'ready', from: options.from, migrations };
      }
      await queryRunner.startTransaction('READ COMMITTED');
      await queryRunner.query("SET LOCAL lock_timeout = '5s'");
      await queryRunner.query("SET LOCAL statement_timeout = '60s'");
      await queryRunner.query('SET LOCAL search_path = public');
      // 같은 실행기를 직렬화하고 원장 lock 뒤 시작 상태를 재조회한다. 다른 수동 DDL과의 동시 실행은 금지한다.
      await queryRunner.query('SELECT pg_advisory_xact_lock(1013, 126)');
      await queryRunner.query('LOCK TABLE public.migrations IN SHARE ROW EXCLUSIVE MODE');
      await checkIdentity(queryRunner, options.database);
      await checkLedger(queryRunner, sourceNames, options.from);
      const approved = [new PrivateBookPdf1769200000000(), new BookPdfOneGigabyte1769500000000()].slice(options.from - 124);
      for (const migration of approved) {
        // executeMigration은 원장/metadata 생성을 수행한다. 정확한 up과 기존 원장 insert만 같은 runner로 호출한다.
        await migration.up(queryRunner);
        await new MigrationExecutor(dataSource, queryRunner).insertMigration(
          new Migration(undefined, Number(migration.name.slice(-13)), migration.name, migration),
        );
      }
      await checkLedger(queryRunner, sourceNames, 126);
      await checkAppliedSchema(queryRunner);
      await queryRunner.commitTransaction();
      return { status: 'applied', from: options.from, migrations };
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
        if (initialized && dataSource) {
          await dataSource.destroy();
        }
      }
    }
  } catch (error: unknown) {
    // driver 오류의 URL·role·SQL 원문 대신 이 실행기 소유의 고정 코드만 반환한다.
    throw error instanceof PdfMigrationError ? error : new PdfMigrationError('EXECUTION_FAILED');
  }
}

if (require.main === module) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log(
      'Usage: npm run migration:pdf-prereq -- --host <direct-host> --port <1..65535> --database <db> --from 124|125 [--run]',
    );
    console.log('Default: SELECT only. --run: 124 applies125+126;125 applies126. PDF126 source only. No .env loading.');
    console.log('Endpoint matching does not replace branch verification, backup/restore, or separate deployment approval.');
  } else {
    void executePdfPrerequisiteMigration(process.argv.slice(2), process.env.DATABASE_URL)
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error: unknown) => {
        console.error(error instanceof PdfMigrationError ? error.message : 'PDF_PREREQ_EXECUTION_FAILED');
        process.exitCode = 1;
      });
  }
}
