/**
 * `npm run seed` — 개발·시연용 데이터를 실제 Postgres 에 넣는다.
 *
 *   npm run seed              넣는다 (표가 비어 있어야 한다)
 *   npm run seed -- --reset   시드 표를 비우고 다시 넣는다
 *
 * 운영 DB 에서는 돌지 않는다. 시드는 **개발 데이터**이지 N-16(초기 운영 데이터)이 아니다.
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import ds from '../src/data-source';
import { runSeed, SEEDED_TABLES } from '../src/seed';
import { assertWritableTarget } from '../src/lib/target';

dotenv.config({ path: '.env.local' });
dotenv.config();

const RESET = process.argv.includes('--reset');

function guard(): void {
  // 판정은 lib/target.ts 한 곳에서만 한다.
  // 예전 안전벨트는 연결 문자열에 'prod' 가 있는지만 봤는데, Neon 주소에는 그 글자가 없다 —
  // 즉 운영 DB 를 통째로 지우는 시드가 그냥 돌았을 것이다.
  const t = assertWritableTarget(process.env.DATABASE_URL, '시드');
  console.log(`대상: ${t.label}`);
}

async function main(): Promise<void> {
  guard();
  await ds.initialize();
  try {
    if (!RESET) {
      const [{ n }] = (await ds.query('SELECT COUNT(*)::int AS n FROM staff')) as [{ n: number }];
      if (n > 0) {
        console.error('staff 에 이미 행이 있습니다. 다시 넣으려면 --reset 을 주세요.');
        process.exitCode = 1;
        return;
      }
    }
    const t0 = Date.now();
    const res = await runSeed(ds, { reset: RESET });
    const total = res.reduce((a, r) => a + r.rows, 0);
    for (const r of res) console.log(`  ${r.table.padEnd(12)} ${String(r.rows).padStart(5)}`);
    console.log(`\n시드 완료 — 표 ${res.length} · 행 ${total} · ${Date.now() - t0}ms`);
    console.log(`계정: ceo@tnacademy.kr / head@tnacademy.kr / t01@tnacademy.kr … 비밀번호 taco1234!`);
  } finally {
    await ds.destroy();
  }
}

void (async () => {
  try {
    await main();
  } catch (e) {
    console.error('시드 실패:', e instanceof Error ? e.message : e);
    console.error(`(시드가 건드리는 표 ${SEEDED_TABLES.length}개)`);
    process.exitCode = 1;
  }
})();
