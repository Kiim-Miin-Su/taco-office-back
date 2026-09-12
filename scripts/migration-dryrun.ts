/** @file-guide
 * 목적: migration-dryrun.ts (script)
 * 책임/재사용: 검사/생성/실행 도구의 책임만 소유한다. 대상 경로와 실행 권한을 확인하고 실패를 성공으로 기록하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 밀린 마이그레이션을 **한 트랜잭션 안에서 돌려 보고 통째로 되돌린다.**
 *
 *   npm run migration:dryrun
 *
 * 왜 필요한가 — 밀린 것 중에는 **기존 행을 검사하는 제약**이 있다. 내 컴퓨터의 시드는
 * 통과해도 대표님 DB 의 실제 행은 걸릴 수 있고, 그때는 `migration:run` 이 중간에서 멈춘다.
 * 멈춘 자리가 어디였는지 알려면 돌려 보는 수밖에 없는데, 진짜로 돌리면 되돌리기가 일이다.
 *
 * Postgres 는 DDL 도 트랜잭션 안에서 되돌릴 수 있다. 그래서 전부 돌린 뒤 **반드시 ROLLBACK** 한다 —
 * 성공하든 실패하든 DB 는 시작할 때 그대로다. `migrations` 이력에도 아무것도 적지 않는다.
 * (마이그레이션에 `CREATE INDEX CONCURRENTLY` 가 생기면 이 방법이 깨진다. 지금은 없다.)
 *
 * 이 명령이 통과했다고 **운영 데이터가 안전하다는 뜻은 아니다** — 스키마 전이가
 * 에러 없이 끝난다는 뜻이다. 무엇이 바뀌는지는 각 마이그레이션 주석이 말한다.
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import ds from '../src/data-source';
import { describeTarget } from '../src/lib/target';
import { parseCheckConstraint } from '../src/lib/sql';

dotenv.config({ path: '.env.local' });
dotenv.config();

interface Step { name: string; ms: number }

/**
 * 걸린 행을 **세어서** 보여 준다. 고치지는 않는다.
 *
 * 실패한 `ALTER TABLE … ADD CONSTRAINT … CHECK (식)` 문장에서 표 이름과 식을 꺼내
 * `WHERE NOT (식)` 으로 뒤집는다 — 제약이 거절한 바로 그 행이 나온다.
 * 되돌린 트랜잭션은 이미 죽었으므로 **새 연결**로 묻는다(여기서도 읽기만 한다).
 */
async function showOffenders(sql: string): Promise<void> {
  const parsed = parseCheckConstraint(sql);
  if (!parsed) {
    console.log('    (문장에서 CHECK 식을 못 읽었습니다 — 마이그레이션 주석을 보세요)');
    return;
  }
  const { table, name, expr } = parsed;
  const probe = new (ds.constructor as new (o: object) => typeof ds)({
    ...(ds.options as object), name: `dryrun-probe-${Date.now()}`,
  });
  try {
    await probe.initialize();
    const rows = (await probe.query(
      `SELECT count(*)::text AS n FROM ${table} WHERE NOT (${expr})`,
    )) as Array<{ n: string }>;
    const ids = (await probe.query(
      `SELECT id::text AS id FROM ${table} WHERE NOT (${expr}) ORDER BY id LIMIT 10`,
    )) as Array<{ id: string }>;
    console.log(`    ${table} · ${name} — 걸리는 행 ${rows[0]?.n ?? '?'}개`);
    if (ids.length) console.log(`    id: ${ids.map((r) => r.id).join(', ')}${ids.length === 10 ? ' …' : ''}`);
    console.log(`    직접 보려면:  SELECT * FROM ${table} WHERE NOT (${expr});`);
  } catch (e) {
    console.log(`    (세어 보지 못했습니다: ${(e as Error).message.split('\n')[0]})`);
  } finally {
    if (probe.isInitialized) await probe.destroy();
  }
}

async function main(): Promise<void> {
  const t = describeTarget(process.env.DATABASE_URL);
  console.log('\n── 마이그레이션 예행 ─────────────────────────');
  console.log(`  DB        ${t.label}`);
  console.log('  방식      전부 돌린 뒤 통째로 되돌립니다 (쓰기 0)');

  await ds.initialize();
  const runner = ds.createQueryRunner();
  await runner.connect();

  // 이미 적용된 것을 다시 돌리면 안 되므로, DB 의 이력을 그대로 읽는다
  const applied = new Set<string>();
  const hasLedger = await runner.hasTable('migrations');
  if (hasLedger) {
    const rows = (await runner.query(`SELECT name FROM migrations`)) as Array<{ name: string }>;
    rows.forEach((r) => applied.add(r.name));
  }

  /*
   * **차례가 중요하다.** `ds.migrations` 는 정렬돼 있지 않다 — 그대로 돌리면 나중 것이 먼저 돌아
   * 앞의 것이 만들 표가 없는 채로 통과하거나, 반대로 멀쩡한 것이 걸린다.
   * TypeORM 이 실제로 돌리는 차례와 같게 **timestamp 오름차순**으로 맞춘다.
   */
  const stamp = (m: { name?: string }): number => Number(/(\d{10,})$/.exec(m.name ?? '')?.[1] ?? 0);
  const pending = ds.migrations
    .filter((m) => !applied.has(m.name ?? m.constructor.name))
    .sort((a, b) => stamp(a) - stamp(b));
  console.log(`  밀린 것    ${pending.length}건${pending.length ? '' : ' — 아무것도 하지 않습니다'}`);
  if (pending.length === 0) {
    console.log('──────────────────────────────────────────────\n');
    await runner.release(); await ds.destroy();
    return;
  }

  const done: Step[] = [];
  // 되돌리기(ROLLBACK)도 문장이라 lastSql 을 덮어쓴다 — 걸린 문장은 **그 자리에서** 챙긴다
  let failed: { name: string; error: Error; sql: string } | null = null;
  // 실패한 문장을 알아야 어느 행이 걸리는지 되물을 수 있다 — 에러 객체는 문장을 안 들고 온다
  let lastSql = '';
  const rawQuery = runner.query.bind(runner);
  runner.query = ((sql: string, params?: unknown[]) => {
    lastSql = sql;
    return rawQuery(sql, params as never[]);
  }) as typeof runner.query;

  await runner.startTransaction();
  try {
    for (const m of pending) {
      const name = m.name ?? m.constructor.name;
      const at = Date.now();
      try {
        await m.up(runner);
        done.push({ name, ms: Date.now() - at });
      } catch (e) {
        failed = { name, error: e as Error, sql: lastSql };
        break;
      }
    }
  } finally {
    // 성공했어도 되돌린다 — 이 명령은 보기만 하는 명령이다
    await runner.rollbackTransaction();
    await runner.release();
    await ds.destroy();
  }

  console.log('');
  done.forEach((s) => console.log(`    ✓ ${s.name}  ${s.ms}ms`));

  if (failed) {
    const f: { name: string; error: Error; sql: string } = failed;
    console.log(`    ✗ ${f.name}`);
    console.log(`\n  여기서 멈춥니다. 이유:\n    ${f.error.message.split('\n')[0]}`);
    const code = (f.error as unknown as { code?: string }).code;
    const detail = (f.error as unknown as { detail?: string }).detail;
    if (detail) console.log(`    ${detail}`);
    if (code === '23514') {
      console.log('\n  기존 행이 새 제약을 못 지킵니다. 어느 행인지 세어 보겠습니다…');
      await showOffenders(f.sql);
      console.log('\n  **자동으로 고치지 않습니다** — 무엇이 맞는 값인지는 표가 아니라 사람이 압니다 (추정 이관 금지).');
    }
    console.log('\n  DB 는 되돌렸습니다 — 아무것도 바뀌지 않았습니다.');
    console.log('──────────────────────────────────────────────\n');
    process.exit(1);
  }

  console.log(`\n  ${done.length}건 전부 통과 — 되돌렸습니다.`);
  console.log('  실제로 적용하려면: npm run migration:deploy');
  console.log('──────────────────────────────────────────────\n');
}

main().catch((e: unknown) => {
  console.error(`\n✗ ${(e as Error).message}\n`);
  process.exit(1);
});
