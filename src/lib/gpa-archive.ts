/** @file-guide
 * 목적: GPA 역사 원장의 결정적 JSON export·검증·빈 대상 restore를 소유한다. (lib)
 * 책임/재사용: 네 표의 순서·컬럼·해시·복원 우회 키를 한 곳에 두며 운영 파일 I/O와 CLI 확인은 scripts/gpa-archive.ts가 맡는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { createHash } from 'node:crypto';

export const GPA_ARCHIVE_SCHEMA = 'taco.gpa-archive.v1' as const;
export const GPA_ARCHIVE_TABLES = ['gpasvc', 'gpa_cycle', 'gpa_alloc', 'gpa_use'] as const;
export type GpaArchiveTable = typeof GPA_ARCHIVE_TABLES[number];

type Row = Record<string, unknown>;
type Queryable = { query(sql: string, params?: unknown[]): Promise<unknown> };

const COLUMNS: Record<GpaArchiveTable, readonly string[]> = {
  gpasvc: ['key', 'name', 'point', 'color', 'sort'],
  gpa_cycle: ['id', 'no', 'from_date', 'to_date', 'closed', 'closed_at', 'closed_by'],
  gpa_alloc: ['id', 'cycle_id', 'student_id', 'coord_id', 'points'],
  gpa_use: ['id', 'cycle_id', 'student_id', 'ser_id', 'svc_key', 'points', 'on_date', 'start_min', 'coord_id', 'note_url', 'state', 'approved_by', 'approved_at'],
};

const ORDER: Record<GpaArchiveTable, string> = {
  gpasvc: 'key',
  gpa_cycle: 'id',
  gpa_alloc: 'id',
  gpa_use: 'id',
};
const DATE_COLUMNS = new Set(['from_date', 'to_date', 'on_date']);
const TIMESTAMP_COLUMNS = new Set(['closed_at', 'approved_at']);

export interface GpaArchiveSnapshot {
  schemaVersion: typeof GPA_ARCHIVE_SCHEMA;
  exportedAt: string;
  sourceDatabase: string;
  rowCounts: Record<GpaArchiveTable, number>;
  dataSha256: string;
  tables: Record<GpaArchiveTable, Row[]>;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const tablePayload = (tables: GpaArchiveSnapshot['tables']): string => JSON.stringify(tables);
const selectColumn = (column: string): string => {
  if (DATE_COLUMNS.has(column)) return `${column}::text AS ${column}`;
  if (TIMESTAMP_COLUMNS.has(column)) {
    return `CASE WHEN ${column} IS NULL THEN NULL ELSE to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS ${column}`;
  }
  return column;
};

export async function exportGpaArchive(q: Queryable, at = new Date()): Promise<GpaArchiveSnapshot> {
  const [{ db }] = await q.query(`SELECT current_database() AS db`) as Array<{ db: string }>;
  const tables = {} as GpaArchiveSnapshot['tables'];
  const rowCounts = {} as GpaArchiveSnapshot['rowCounts'];
  for (const table of GPA_ARCHIVE_TABLES) {
    const columns = COLUMNS[table].map(selectColumn).join(', ');
    const rows = await q.query(`SELECT ${columns} FROM ${table} ORDER BY ${ORDER[table]}`) as Row[];
    tables[table] = rows;
    rowCounts[table] = tables[table].length;
  }
  return {
    schemaVersion: GPA_ARCHIVE_SCHEMA,
    exportedAt: at.toISOString(),
    sourceDatabase: db,
    rowCounts,
    dataSha256: sha256(tablePayload(tables)),
    tables,
  };
}

export function validateGpaArchive(value: unknown): asserts value is GpaArchiveSnapshot {
  if (!value || typeof value !== 'object') throw new Error('GPA_ARCHIVE_INVALID: object required');
  const snapshot = value as Partial<GpaArchiveSnapshot>;
  if (snapshot.schemaVersion !== GPA_ARCHIVE_SCHEMA) throw new Error('GPA_ARCHIVE_VERSION_MISMATCH');
  if (!snapshot.tables || !snapshot.rowCounts) throw new Error('GPA_ARCHIVE_INVALID: tables and rowCounts required');
  for (const table of GPA_ARCHIVE_TABLES) {
    const rows = snapshot.tables[table];
    if (!Array.isArray(rows)) throw new Error(`GPA_ARCHIVE_INVALID: ${table} rows required`);
    if (snapshot.rowCounts[table] !== rows.length) throw new Error(`GPA_ARCHIVE_COUNT_MISMATCH: ${table}`);
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw new Error(`GPA_ARCHIVE_INVALID: ${table} row`);
      const keys = Object.keys(row).sort();
      const expected = [...COLUMNS[table]].sort();
      if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error(`GPA_ARCHIVE_COLUMNS_MISMATCH: ${table}`);
    }
  }
  if (snapshot.dataSha256 !== sha256(tablePayload(snapshot.tables as GpaArchiveSnapshot['tables']))) {
    throw new Error('GPA_ARCHIVE_HASH_MISMATCH');
  }
}

async function insertRows(q: Queryable, table: GpaArchiveTable, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const columns = COLUMNS[table];
  const params: unknown[] = [];
  const values = rows.map((row) => `(${columns.map((column) => {
    params.push(row[column]);
    return `$${params.length}`;
  }).join(', ')})`);
  await q.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values.join(', ')}`, params);
}

export async function restoreGpaArchive(q: Queryable, value: unknown): Promise<GpaArchiveSnapshot> {
  validateGpaArchive(value);
  const snapshot = value;
  const counts: Array<readonly [GpaArchiveTable, number]> = [];
  for (const table of GPA_ARCHIVE_TABLES) {
    const [{ n }] = await q.query(`SELECT count(*)::int AS n FROM ${table}`) as Array<{ n: number }>;
    counts.push([table, Number(n)] as const);
  }
  const occupied = counts.filter(([, n]) => n !== 0);
  if (occupied.length) throw new Error(`GPA_ARCHIVE_TARGET_NOT_EMPTY: ${occupied.map(([t, n]) => `${t}=${n}`).join(',')}`);

  await q.query(`SET LOCAL taco.gpa_archive_restore = 'on'`);
  for (const table of GPA_ARCHIVE_TABLES) await insertRows(q, table, snapshot.tables[table]);
  for (const table of ['gpa_cycle', 'gpa_alloc', 'gpa_use'] as const) {
    await q.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST(COALESCE((SELECT max(id) FROM ${table}), 1), 1), EXISTS(SELECT 1 FROM ${table}))`, [table]);
  }
  const restored = await exportGpaArchive(q, new Date(snapshot.exportedAt));
  if (restored.dataSha256 !== snapshot.dataSha256) {
    const mismatched: string[] = [];
    for (const table of GPA_ARCHIVE_TABLES) {
      const expected = snapshot.tables[table];
      const actual = restored.tables[table];
      if (expected.length !== actual.length) mismatched.push(`${table}.length`);
      for (let i = 0; i < Math.min(expected.length, actual.length); i += 1) {
        for (const column of COLUMNS[table]) {
          if (JSON.stringify(expected[i][column]) !== JSON.stringify(actual[i][column])) {
            mismatched.push(`${table}[${i}].${column}`);
          }
        }
      }
    }
    throw new Error(`GPA_ARCHIVE_RESTORE_MISMATCH: ${mismatched.join(',')}`);
  }
  return restored;
}
