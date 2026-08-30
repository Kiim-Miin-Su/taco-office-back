/**
 * 배포 전에 **어디를 보고 있는지 눈으로 확인**하는 명령.
 *
 *   npm run deploy:check          보기만 한다
 *   npm run migration:deploy      확인을 찍고 마이그레이션을 돌린다
 *
 * Vercel 에는 배포 후 훅이 없다. 마이그레이션은 사람이 돌리는 일이고,
 * 사람이 돌리는 일은 **틀린 DB 를 가리킨 채로 돌기 쉽다.** 그래서 먼저 보여 준다.
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import ds from '../src/data-source';
import { describeTarget } from '../src/lib/target';
import { assertCookieConfig } from '../src/auth/cookie';

dotenv.config({ path: '.env.local' });
dotenv.config();

const RUN = process.argv.includes('--run');

/** 있어야 하는 키 — 없으면 배포가 조용히 반쯤 뜬다 */
const REQUIRED = ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'CORS_ORIGIN'];
const PROD_ONLY = ['COOKIE_DOMAIN'];

async function main(): Promise<void> {
  const prod = process.env.NODE_ENV === 'production';
  const t = describeTarget(process.env.DATABASE_URL);

  console.log('\n── 배포 점검 ─────────────────────────────────');
  console.log(`  모드      ${prod ? '운영 (NODE_ENV=production)' : '개발'}`);
  console.log(`  DB        ${t.label}`);

  const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
  const missingProd = prod ? PROD_ONLY.filter((k) => !process.env[k]?.trim()) : [];
  console.log(`  필수 키   ${missing.length === 0 ? '전부 있음' : `없음: ${missing.join(' · ')}`}`);
  if (prod) console.log(`  운영 키   ${missingProd.length === 0 ? '전부 있음' : `없음: ${missingProd.join(' · ')}`}`);

  try {
    console.log(`  쿠키      ${assertCookieConfig()}`);
  } catch (e) {
    console.log(`  쿠키      ✗ ${(e as Error).message.split('\n')[0]}`);
    process.exitCode = 1;
  }

  if (missing.length || missingProd.length) process.exitCode = 1;

  await ds.initialize();
  try {
    const pending = await ds.showMigrations();
    console.log(`  마이그레이션  ${pending ? '**밀린 것이 있다**' : '최신'}`);

    if (!RUN) {
      console.log('\n  돌리려면: npm run migration:deploy');
      console.log('──────────────────────────────────────────────\n');
      return;
    }
    if (!pending) {
      console.log('\n  밀린 마이그레이션이 없습니다 — 아무것도 하지 않았습니다.\n');
      return;
    }
    // 여기서 한 번 더 보여 주는 이유: --run 을 붙인 사람이 위 세 줄을 안 읽었을 수 있다.
    console.log(`\n  ${t.label} 에 마이그레이션을 적용합니다…`);
    const done = await ds.runMigrations();
    done.forEach((m) => console.log(`    ✓ ${m.name}`));
    console.log(`\n  ${done.length}건 적용 완료.\n`);
  } finally {
    await ds.destroy();
  }
}

main().catch((e: unknown) => {
  console.error(`\n✗ ${(e as Error).message}\n`);
  process.exit(1);
});
