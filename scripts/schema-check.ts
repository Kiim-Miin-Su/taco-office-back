/**
 * 엔티티 ↔ 실제 DB 대조.
 *
 * 엔티티는 `erd.dbml` 에서 생성되고, 마이그레이션은 손으로 쓴다.
 * 둘이 갈라지면 **런타임에야** 「column does not exist」로 터진다 —
 * TBO-26 에서 `zacc.login_secret` 이 실제로 그랬다.
 *
 * 여기서 세 가지를 본다.
 *   ① 엔티티에 있는데 DB 에 없는 컬럼   → 쿼리가 터진다
 *   ② DB 에 있는데 엔티티에 없는 컬럼   → 값을 못 읽는다 (조용하다 · 더 나쁘다)
 *   ③ nullable · 타입이 어긋나는 컬럼   → 타입이 거짓말을 한다
 *
 *   npm run schema:check
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';

type Col = { table: string; name: string; type: string; nullable: boolean };

/** TypeORM 타입 → Postgres udt_name. 같은 것을 다르게 부르는 자리만 적는다. */
const ALIAS: Record<string, string[]> = {
  varchar: ['varchar'], text: ['text'], int: ['int4'], integer: ['int4'],
  smallint: ['int2'], bigint: ['int8'], boolean: ['bool'], date: ['date'],
  timestamptz: ['timestamptz'], 'timestamp with time zone': ['timestamptz'],
  jsonb: ['jsonb'], bytea: ['bytea'], tstzrange: ['tstzrange'], numeric: ['numeric'],
  // Postgres 는 char(n) 을 bpchar 로 부른다. 다른 타입이 아니라 다른 이름이다.
  char: ['bpchar'], character: ['bpchar'],
};

/**
 * enum 은 이름으로 맞춘다.
 * TypeORM 은 컬럼 타입을 'enum' 이라고만 하고 실제 이름은 `enumName` 에 둔다.
 * 그래서 타입 문자열만 비교하면 13개가 전부 「어긋남」으로 뜬다 — 실제로는 맞는데 오탐이다.
 */
function norm(t: string, enumName?: string): string[] {
  const k = String(t).toLowerCase();
  if (k === 'enum') return enumName ? [enumName.toLowerCase()] : ['__enum__'];
  return ALIAS[k] ?? [k];
}

async function main() {
  const ds = new DataSource({ ...dataSourceOptions, logging: false });
  await ds.initialize();

  const rows = (await ds.query(
    `SELECT table_name, column_name, udt_name, is_nullable
       FROM information_schema.columns WHERE table_schema = 'public'`,
  )) as Array<{ table_name: string; column_name: string; udt_name: string; is_nullable: string }>;

  const db = new Map<string, Col>();
  const dbTables = new Set<string>();
  for (const r of rows) {
    dbTables.add(r.table_name);
    db.set(`${r.table_name}.${r.column_name}`, {
      table: r.table_name, name: r.column_name, type: r.udt_name, nullable: r.is_nullable === 'YES',
    });
  }

  const missingInDb: string[] = [];
  const missingInEntity: string[] = [];
  const typeMismatch: string[] = [];
  const nullMismatch: string[] = [];
  const noTable: string[] = [];

  const seen = new Set<string>();

  for (const meta of ds.entityMetadatas) {
    const table = meta.tableName;
    if (!dbTables.has(table)) { noTable.push(table); continue; }
    for (const c of meta.columns) {
      const key = `${table}.${c.databaseName}`;
      seen.add(key);
      const d = db.get(key);
      if (!d) { missingInDb.push(key); continue; }
      const want = norm(String(c.type), c.enumName);
      // enumName 이 없는 enum 컬럼은 이름을 대조할 수 없다 — 그 사실 자체를 지적한다
      if (want[0] === '__enum__') {
        typeMismatch.push(`${key}: enum 인데 enumName 이 없다 — DB 는 ${d.type}`);
      } else if (!want.includes(d.type)) {
        typeMismatch.push(`${key}: 엔티티 ${String(c.type)}${c.enumName ? `(${c.enumName})` : ''} ↔ DB ${d.type}`);
      }
      if (c.isNullable !== d.nullable) {
        nullMismatch.push(`${key}: 엔티티 ${c.isNullable ? 'nullable' : 'NOT NULL'} ↔ DB ${d.nullable ? 'nullable' : 'NOT NULL'}`);
      }
    }
  }

  const entityTables = new Set(ds.entityMetadatas.map((m) => m.tableName));
  for (const [key, d] of db) {
    if (d.table === 'migrations') continue;
    if (!entityTables.has(d.table)) continue; // 엔티티가 없는 표는 ②로 세지 않는다
    if (!seen.has(key)) missingInEntity.push(key);
  }

  await ds.destroy();

  const say = (t: string, xs: string[]) => {
    if (!xs.length) { console.log(`  ✓ ${t} 0건`); return 0; }
    console.log(`  ✗ ${t} ${xs.length}건`);
    xs.slice(0, 20).forEach((x) => console.log(`      ${x}`));
    if (xs.length > 20) console.log(`      … ${xs.length - 20}건 더`);
    return xs.length;
  };

  console.log(`\n▶ 엔티티 ↔ DB 대조 — 엔티티 ${ds.entityMetadatas.length} · DB 표 ${dbTables.size}\n`);
  let bad = 0;
  bad += say('엔티티에 있는데 DB 에 없는 표', noTable);
  bad += say('엔티티에 있는데 DB 에 없는 컬럼 (쿼리가 터진다)', missingInDb);
  bad += say('DB 에 있는데 엔티티에 없는 컬럼 (조용히 못 읽는다)', missingInEntity);
  bad += say('타입이 어긋나는 컬럼', typeMismatch);
  bad += say('nullable 이 어긋나는 컬럼', nullMismatch);

  console.log(bad ? `\n✗ ${bad}건 — 엔티티와 DB 가 갈라져 있습니다\n` : '\n✓ 엔티티와 DB 가 일치합니다\n');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
