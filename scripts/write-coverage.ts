/** @file-guide
 * 목적: write-coverage.ts — SEEDED_TABLES, TableCoverage, ColumnGap (script)
 * 책임/재사용: 검사/생성/실행 도구의 책임만 소유한다. 대상 경로와 실행 권한을 확인하고 실패를 성공으로 기록하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * **표와 컬럼에 닿는 쓰기가 있는가.**
 *
 *   npm run write:coverage
 *
 * `schema:check` 는 엔티티와 DB 가 같은 모양인지 본다. 이건 다른 질문이다 —
 * 모양은 맞는데 **아무도 안 쓰는 표**가 있다. 시드가 넣어 둔 행을 화면이 읽기만 하면
 * 데모에서는 멀쩡해 보이고, 대표가 실제로 쓰려는 순간 「넣는 자리가 없다」가 된다.
 *
 * 세 갈래로 가른다.
 *   ① 앱이 쓴다            — 쓰기 경로가 있다
 *   ② 시드만 넣는다        — 데모 데이터는 있는데 제품에 넣는 자리가 없다
 *   ③ 아무도 안 넣는다     — 빈 표. 마이그레이션만 있고 기능이 통째로 없다
 *
 * 컬럼도 같은 눈으로 본다. 표는 쓰는데 **그 안의 칸 하나**만 아무도 안 채우는 경우가 있고,
 * 그 칸이 NOT NULL 이면 그 표는 사실상 못 쓴다.
 *
 * 세는 법 — 앱 소스의 `INSERT INTO t` · `UPDATE t SET` · `DELETE FROM t` 를 찾는다.
 * 시드는 표 이름을 변수로 만들어 정규식으로는 안 보이므로 **시드가 가진 `SEEDED_TABLES` 목록**을
 * 그대로 읽는다 — 목록을 여기 다시 적으면 그 순간 두 벌이 된다 (D-R18).
 * 컬럼은 snake_case 와 camelCase 두 이름으로 찾는다(엔티티가 이름을 바꿔 부른다).
 *
 * **이 명령은 판정이 아니라 지도다.** 「안 쓴다」가 곧 「버그」는 아니다 —
 * 아직 안 만든 화면일 수도 있다. 어느 쪽인지는 원문이 말한다 (D-R44).
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { describeTarget } from '../src/lib/target';

dotenv.config({ path: '.env.local' });
dotenv.config();

const JSON_OUT = process.argv.includes('--json');

function sources(dir = 'src'): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const f = join(d, e);
      if (statSync(f).isDirectory()) walk(f);
      else if (f.endsWith('.ts') && !f.includes('.spec.')) out.push(f);
    }
  };
  walk(dir);
  return out;
}

/** 시드가 건드리는 표 — 시드가 가진 목록이 정본이다 */
function seededTables(): Set<string> {
  const src = readFileSync('src/seed/index.ts', 'utf8');
  const body = /export const SEEDED_TABLES = \[([\s\S]*?)\]/.exec(src)?.[1] ?? '';
  return new Set(body.split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean));
}

export interface TableCoverage { table: string; appWrites: boolean; seeded: boolean; rows: number }
export interface ColumnGap { table: string; column: string; notNull: boolean; seededOnly: boolean }

async function main(): Promise<void> {
  const files = sources();
  const appCode = files
    .filter((f) => !/[\\/](migrations|entities|seed)[\\/]/.test(f))
    .map((f) => readFileSync(f, 'utf8')).join('\n');
  const seedCode = files
    .filter((f) => /[\\/]seed[\\/]/.test(f))
    .map((f) => readFileSync(f, 'utf8')).join('\n');
  const seeded = seededTables();

  const ds = new DataSource({ ...dataSourceOptions, logging: false });
  await ds.initialize();
  try {
    const tables = (await ds.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> 'migrations'
       ORDER BY 1`,
    )) as Array<{ table_name: string }>;

    const cov: TableCoverage[] = [];
    for (const { table_name: t } of tables) {
      const re = new RegExp(`(INSERT\\s+INTO\\s+"?${t}"?|UPDATE\\s+"?${t}"?\\s+SET|DELETE\\s+FROM\\s+"?${t}"?)`, 'i');
      const n = (await ds.query(`SELECT count(*)::int AS n FROM "${t}"`)) as Array<{ n: number }>;
      cov.push({ table: t, appWrites: re.test(appCode), seeded: seeded.has(t), rows: n[0].n });
    }

    const cols = (await ds.query(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name <> 'migrations' ORDER BY 1, ordinal_position`,
    )) as Array<{ table_name: string; column_name: string; is_nullable: string }>;

    const gaps: ColumnGap[] = [];
    for (const c of cols) {
      if (c.column_name === 'id') continue;
      const camel = c.column_name.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
      const re = new RegExp(`\\b(${c.column_name}|${camel})\\b`);
      if (re.test(appCode)) continue;
      gaps.push({
        table: c.table_name, column: c.column_name,
        notNull: c.is_nullable === 'NO', seededOnly: re.test(seedCode),
      });
    }

    const noApp = cov.filter((x) => !x.appWrites);
    const empty = noApp.filter((x) => !x.seeded);

    if (JSON_OUT) {
      console.log(JSON.stringify({ tables: cov, columnGaps: gaps }, null, 2));
      return;
    }

    console.log(`\n── 쓰기가 닿는 범위 ───────────────────────────`);
    console.log(`  DB        ${describeTarget(process.env.DATABASE_URL).label}`);
    console.log(`  표        ${cov.length}개 · 앱이 쓰는 표 ${cov.length - noApp.length}개`);
    console.log(`\n  앱이 한 번도 쓰지 않는 표 ${noApp.length}개`);
    for (const x of noApp) {
      console.log(`    ${x.seeded ? '시드만 넣음' : '아무도 안 넣음'} · 행 ${String(x.rows).padStart(4)} · ${x.table}`);
    }
    console.log(`\n  그 중 빈 표(시드도 없음) ${empty.length}개 — 기능이 통째로 없다`);
    console.log(`    ${empty.map((x) => x.table).join(' · ') || '없음'}`);
    console.log(`\n  앱이 안 채우는 컬럼 ${gaps.length}개 (NOT NULL 은 표 자체를 못 쓰게 만든다)`);
    for (const g of gaps) {
      console.log(`    ${g.notNull ? 'NOT NULL' : '        '} ${g.seededOnly ? '시드O' : '시드X'} · ${g.table}.${g.column}`);
    }
    console.log('');
  } finally {
    await ds.destroy();
  }
}

main().catch((e: unknown) => { console.error(`\n✗ ${(e as Error).message}\n`); process.exit(1); });
