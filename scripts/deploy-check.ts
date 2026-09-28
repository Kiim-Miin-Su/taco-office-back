/** @file-guide
 * 목적: deploy-check.ts (script)
 * 책임/재사용: 검사/생성/실행 도구의 책임만 소유한다. 대상 경로와 실행 권한을 확인하고 실패를 성공으로 기록하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

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
import { MigrationExecutor } from 'typeorm';
import ds from '../src/data-source';
import { describeTarget } from '../src/lib/target';
import { assertCookieConfig } from '../src/auth/cookie';

dotenv.config({ path: '.env.local' });
dotenv.config();

const RUN = process.argv.includes('--run');

/** 있어야 하는 키 — 없으면 배포가 조용히 반쯤 뜬다 */
const REQUIRED = ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'CORS_ORIGIN'];
/**
 * 운영에서만 있어야 하는 키. `AUTH_CODE_SECRET` — 첫 설정 · 비밀번호 찾기 인증 코드의 해시 키(N-105 · 대표 결정 2026-09-26
 * 「운영용 코드 비밀 값 분리」). 운영 서버는 이 값이 없으면 코드를 보내지 않는다(503) — 배포 전에 여기서 먼저 멈춘다.
 */
// 쿠키 모드는 assertCookieConfig가 domain/proxy/cross-site 셋 중 유효한 조합인지 판정한다.
const PROD_ONLY = ['AUTH_CODE_SECRET'];

/**
 * 비밀 값의 **모양** (AUTH-OPS · TBO-54 · 2026-09-29). 부팅 Joi 는 길이(16)만 본다 — 배포 뒤에 아는 것은 늦다.
 *   · Access 와 Refresh 서명 비밀이 같으면 Access 토큰이 Refresh 쿠키 자리에서도 검증을 지난다(refresh 는 `sub` 만 본다) —
 *     httpOnly 쿠키에만 두려던 재발급 권한이 본문 토큰에도 생긴다.
 *   · 운영의 코드 비밀 값은 「JWT 두 값과 다른 값」이다(N-105 · 대표 결정 2026-09-26).
 *   · 개발 기본값(`AuthService` · `JwtStrategy` 의 `??` 뒤 글자)이 운영에 그대로 있으면 서명이 공개된 것과 같다.
 * 회전(값 바꾸기)은 이 검사가 하지 않는다 — 언제 · 어떻게는 docs/sprint/evidence/TBO-54/auth-ops/README.md 의 절차.
 */
const SECRET_MIN = 16;
const DEV_DEFAULT_SECRETS = new Set(['dev-only-change-me', 'dev-only-change-me-too']);
function secretIssues(prod: boolean): string[] {
  const issues: string[] = [];
  const v = (k: string) => process.env[k]?.trim() ?? '';
  const access = v('JWT_SECRET');
  const refresh = v('JWT_REFRESH_SECRET');
  const code = v('AUTH_CODE_SECRET');
  for (const [k, value] of [['JWT_SECRET', access], ['JWT_REFRESH_SECRET', refresh], ['AUTH_CODE_SECRET', code]] as const) {
    if (value && value.length < SECRET_MIN) issues.push(`${k} 가 ${SECRET_MIN}자보다 짧다`);
  }
  if (access && refresh && access === refresh) issues.push('JWT_SECRET 과 JWT_REFRESH_SECRET 이 같다 — Access 토큰이 Refresh 자리에서도 통한다');
  if (code && (code === access || code === refresh)) issues.push('AUTH_CODE_SECRET 이 JWT 비밀과 같다 — 다른 값이어야 한다(N-105)');
  if (prod) {
    for (const [k, value] of [['JWT_SECRET', access], ['JWT_REFRESH_SECRET', refresh], ['AUTH_CODE_SECRET', code]] as const) {
      if (value && DEV_DEFAULT_SECRETS.has(value)) issues.push(`${k} 가 개발 기본값 그대로다`);
    }
  }
  return issues;
}

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

  const secrets = secretIssues(prod);
  // 값은 찍지 않는다 — 어느 키가 왜 안 되는지만 (배포 로그에 남는다)
  console.log(`  비밀 값   ${secrets.length === 0 ? `서로 다르고 ${SECRET_MIN}자 이상` : `✗ ${secrets.join(' · ')}`}`);

  let invalid = missing.length > 0 || missingProd.length > 0 || secrets.length > 0;
  try {
    console.log(`  쿠키      ${assertCookieConfig()}`);
  } catch (e) {
    console.log(`  쿠키      ✗ ${(e as Error).message.split('\n')[0]}`);
    invalid = true;
  }

  // exitCode만 세우면 --run이 아래로 내려가 잘못된 설정에서도 실제 DB를 바꾼다.
  if (invalid) {
    process.exitCode = 1;
    return;
  }

  await ds.initialize();
  try {
    // showMigrations는 이력표가 없으면 만든다. 조회 모드는 표 존재 확인/SELECT만 한다.
    const pending = (await new MigrationExecutor(ds).getPendingMigrations()).length > 0;
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
