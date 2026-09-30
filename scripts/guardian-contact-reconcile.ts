/** @file-guide
 * 목적: ST1-b3b 구형 보호자 연락처 scalar↔선택 child 복구 도구의 명시 대상·운영자 게이트.
 * 책임/재사용: 기본 read-only; apply는 local exact ack·old writer drain·backup 진술 뒤 한 트랜잭션만 쓴다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/contracts/db/student-registration-target.dbml
 */
/**
 * 사용: DATABASE_URL=<명시 URL> npm run guardian:reconcile
 * 쓰기: 같은 대상에서 --apply --confirm=<user@host:port/db> --writers-drained --backup=<receipt>
 *
 * --writers-drained/--backup은 운영자의 확인 진술이다. 도구가 배포 중인 구형 writer나 외부 백업을
 * 독립적으로 검증할 수는 없다. localhost SSH/Cloud 프록시·터널도 사용 금지다. 서버 loopback 검사로
 * 원격 터널을 모두 구별할 수는 없으므로 실제 중지·백업·복구 가능성과 물리적 로컬 DB를 사람이 확인한다.
 * managed/unknown 대상 apply는 항상 거절한다. 운영 DB에는 자동 실행하지 않는다.
 * 원문 연락처·연결 URL·비밀번호·백업 영수증은 출력하지 않는다.
 */
import {
  assertApplyGate, inspectGuardianContacts, parseReconcileArgs, parseReconcileTarget,
  reconcileGuardianContacts, ReconcileRefusal, type ReconcileCounts, type ReconcileTarget,
} from '../src/lib/guardian-contact-reconcile';

function printCounts(stage: string, counts: ReconcileCounts): void {
  console.log(`${stage}: guardians=${counts.guardians} email=${counts.email} phone=${counts.phone} user_selected_conflicts=${counts.userSelectedConflicts}`);
}

function safeFailure(error: unknown): void {
  if (error instanceof ReconcileRefusal) {
    console.error(`REFUSED: ${error.code}`);
    process.exitCode = 2;
    return;
  }
  // QueryFailedError.message/query/parameters에는 연락처 값이 들어갈 수 있다. 절대 그대로 출력하지 않는다.
  const sqlState = (error as { driverError?: { code?: unknown } } | null)?.driverError?.code;
  console.error(`FAILED: DB_OPERATION_FAILED${typeof sqlState === 'string' && /^[A-Z0-9]{5}$/.test(sqlState) ? ` (${sqlState})` : ''}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  let target: ReconcileTarget;
  let args;
  try {
    // data-source는 import 순간 dotenv fallback을 읽는다. 그 전에 셸에서 명시한 대상만 받는다.
    target = parseReconcileTarget(process.env.DATABASE_URL);
    args = parseReconcileArgs(process.argv.slice(2));
    assertApplyGate(target, args);
  } catch (error) {
    safeFailure(error);
    return;
  }

  // 이 아래에서만 DB 모듈을 적재한다. SQL 오류 로그의 query/parameters 누출도 비활성화한다.
  const [{ DataSource }, { dataSourceOptions }] = await Promise.all([
    import('typeorm'), import('../src/data-source'),
  ]);
  if (dataSourceOptions.type !== 'postgres') throw new ReconcileRefusal('POSTGRESQL_REQUIRED');
  const ds = new DataSource({ ...dataSourceOptions, logging: false });
  await ds.initialize();
  const q = ds.createQueryRunner();
  try {
    await q.connect();
    console.log(`target: host=${target.host} port=${target.port} database=${target.database} mode=${args.apply ? 'apply' : 'read-only'}`);
    console.log('operator attestations are not independently verified; localhost proxies/tunnels are prohibited');
    await q.startTransaction();
    if (!args.apply) {
      await q.query('SET TRANSACTION READ ONLY');
      await q.query(`SET LOCAL statement_timeout = '30s'`);
      const counts = await inspectGuardianContacts(q, target);
      await q.rollbackTransaction();
      printCounts('dry_run', counts);
      console.log('writes=0');
      return;
    }
    const result = await reconcileGuardianContacts(q, target);
    await q.commitTransaction();
    printCounts('before', result.before);
    console.log(`applied=${result.applied}`);
    printCounts('readback', result.after);
    // 여기부터는 이미 commit됐다. 후속 재검사는 경쟁/구형 writer 재발만 탐지하며 되돌리지는 못한다.
    try {
      await q.startTransaction();
      await q.query('SET TRANSACTION READ ONLY');
      await q.query(`SET LOCAL statement_timeout = '30s'`);
      const verified = await inspectGuardianContacts(q, target, true);
      await q.rollbackTransaction();
      if (verified.guardians || verified.email || verified.phone || verified.userSelectedConflicts) {
        throw new ReconcileRefusal('POST_COMMIT_VERIFY_FAILED');
      }
      printCounts('post_commit_verify', verified);
    } catch {
      console.error('COMMITTED_BUT_POST_VERIFY_FAILED: changes already committed; investigate new writes before retry');
      process.exitCode = 1;
    }
  } finally {
    if (q.isTransactionActive) await q.rollbackTransaction();
    if (!q.isReleased) await q.release();
    if (ds.isInitialized) await ds.destroy();
  }
}

main().catch(safeFailure);
