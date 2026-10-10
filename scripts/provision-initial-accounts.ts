/** @file-guide
 * 목적: 운영 최초 CEO·manager·admin 계정을 지정 로그인 아이디와 서버 전용 초기 비밀번호로 멱등 발급한다.
 * 책임/재사용: 비밀번호를 출력·기록하지 않고 STAFF 해시와 최소 감사 영수증만 갱신한다. 일반 계정 생성은 DrawerService가 소유한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import ds from '../src/data-source';
import { INITIAL_PASSWORD } from '../src/lib/account-policy';
import { INITIAL_ACCOUNTS, InitialAccountProvisionError, provisionInitialAccounts } from '../src/lib/provision-initial-accounts';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const confirm = process.argv.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length) ?? null;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL_MISSING');
  }
  // SQL 오류 로거도 hash/연결 인자를 출력하지 않도록 CLI의 구조화 실패 코드만 사용한다.
  ds.setOptions({ logging: false });
  await ds.initialize();
  try {
    const result = await provisionInitialAccounts(ds, { apply: APPLY, confirm, initialPassword: INITIAL_PASSWORD });
    console.log(`대상 DB: ${result.database} · 사용자: ${result.user}`);
    console.log(`계정: ${INITIAL_ACCOUNTS.map((account) => `${account.loginId}(${account.role})`).join(' · ')}`);
    console.log('비밀번호: 서버 전용 TACO_INITIAL_PASSWORD 사용 · 출력하지 않음');
    console.log(`기존 보존 ${result.preserved} · 신규 ${result.created} · 최초 CEO 아이디 변경 ${result.renamed}`);
    if (!APPLY) {
      console.log(`쓰기 0 · 적용하려면 --apply --confirm=${result.database}`);
      return;
    }
    console.log('초기 계정 확인 완료 · 기존 자격 덮어쓰기 0 · 비밀번호 출력/기록 0');
  } finally {
    await ds.destroy();
  }
}

void main().catch((error: unknown) => {
  // DB/driver 오류에는 접속 문자열·쿼리 인자가 섞일 수 있으므로 승인된 코드만 출력한다.
  const code = error instanceof InitialAccountProvisionError ? error.code : 'PROVISION_FAILED';
  console.error(`초기 계정 발급 실패: ${code} · 기존 계정 복구는 정식 관리 절차를 사용하세요`);
  process.exitCode = 1;
});
