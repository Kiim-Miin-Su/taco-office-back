/** @file-guide
 * 목적: ST1-b3b 구형 guardian scalar와 선택 guardian_contact 행의 명시적 정합성 검사·복구.
 * 책임/재사용: PII를 반환하지 않는 집계와 잠금·재검사·브리지 재사용만 소유한다. 운영자 승인·연결은 CLI 몫이다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/contracts/db/student-registration-target.dbml
 */
import type { QueryRunner } from 'typeorm';
import { syncLegacyGuardianContacts } from './guardian-contact-bridge';

export class ReconcileRefusal extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface ReconcileTarget {
  database: string;
  dbUser: string;
  host: string;
  port: number;
  local: boolean;
  explicitPort: boolean;
  hasUrlOptions: boolean;
  acknowledgement: string;
}

/** .env fallback를 열기 전에, 호출자가 명시한 TCP PostgreSQL 대상을 확정한다. 비밀번호는 반환하지 않는다. */
export function parseReconcileTarget(value: string | undefined): ReconcileTarget {
  if (!value) throw new ReconcileRefusal('EXPLICIT_DATABASE_URL_REQUIRED');
  let url: URL;
  try { url = new URL(value); } catch { throw new ReconcileRefusal('INVALID_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username
    || !url.pathname || url.pathname === '/') throw new ReconcileRefusal('INVALID_DATABASE_URL');
  const database = decodeURIComponent(url.pathname.slice(1));
  const dbUser = decodeURIComponent(url.username);
  const host = url.hostname;
  const port = Number(url.port || '5432');
  if (!database || !dbUser || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ReconcileRefusal('INVALID_DATABASE_URL');
  }
  return {
    database, dbUser, host, port,
    local: ['127.0.0.1', 'localhost', '[::1]'].includes(host),
    explicitPort: Boolean(url.port),
    hasUrlOptions: Boolean(url.search || url.hash),
    acknowledgement: `${dbUser}@${host}:${port}/${database}`,
  };
}

export interface ReconcileArgs {
  apply: boolean;
  confirm: string | null;
  writersDrained: boolean;
  backupReceipt: string | null;
}

export function parseReconcileArgs(argv: string[]): ReconcileArgs {
  const args: ReconcileArgs = { apply: false, confirm: null, writersDrained: false, backupReceipt: null };
  for (const arg of argv) {
    if (arg === '--apply' && !args.apply) args.apply = true;
    else if (arg === '--writers-drained' && !args.writersDrained) args.writersDrained = true;
    else if (arg.startsWith('--confirm=') && args.confirm === null) args.confirm = arg.slice('--confirm='.length);
    else if (arg.startsWith('--backup=') && args.backupReceipt === null) args.backupReceipt = arg.slice('--backup='.length);
    else throw new ReconcileRefusal('UNKNOWN_OR_DUPLICATE_ARGUMENT');
  }
  if (args.confirm !== null && !args.confirm.trim()) throw new ReconcileRefusal('EMPTY_CONFIRMATION');
  if (args.backupReceipt !== null && !args.backupReceipt.trim()) throw new ReconcileRefusal('EMPTY_BACKUP_RECEIPT');
  return args;
}

/** local도 자동 승인하지 않는다. drain/backup은 CLI가 실증할 수 없는 운영자 진술이다. */
export function assertApplyGate(target: ReconcileTarget, args: ReconcileArgs): void {
  if (!args.apply) return;
  if (!target.local) throw new ReconcileRefusal('APPLY_LOCAL_TARGET_ONLY');
  // pg 연결 문자열의 query option은 host/port를 덮어쓸 수 있다. apply는 해석 여지를 남기지 않는다.
  if (!target.explicitPort || target.hasUrlOptions) throw new ReconcileRefusal('APPLY_EXPLICIT_PLAIN_TCP_URL_REQUIRED');
  if (args.confirm !== target.acknowledgement) throw new ReconcileRefusal('TARGET_ACK_MISMATCH');
  if (!args.writersDrained) throw new ReconcileRefusal('OLD_WRITERS_NOT_ATTESTED');
  if (!args.backupReceipt) throw new ReconcileRefusal('BACKUP_NOT_ATTESTED');
}

export async function assertConnectedTarget(q: QueryRunner, target: ReconcileTarget, requireLoopback = false): Promise<void> {
  const [identity] = await q.query(`SELECT current_database() AS database, current_user AS db_user,
    inet_server_port() AS port,
    COALESCE(inet_server_addr() <<= inet '127.0.0.0/8' OR inet_server_addr() = inet '::1', false) AS loopback`) as Array<{
    database: string; db_user: string; port: number | null; loopback: boolean;
  }>;
  if (!identity || identity.database !== target.database || identity.db_user !== target.dbUser || identity.port !== target.port) {
    throw new ReconcileRefusal('TARGET_IDENTITY_MISMATCH');
  }
  // NULL은 Unix socket, false는 비-loopback 주소다. URL이 localhost여도 프록시일 수 있으므로 apply를 닫는다.
  if (requireLoopback && identity.loopback !== true) throw new ReconcileRefusal('LOCAL_SERVER_ADDRESS_REQUIRED');
}

/** 마이그레이션과 핵심 DB 제약이 없는 대상은 조회조차 성공으로 기록하지 않는다. */
export async function assertReconcileSchema(q: QueryRunner): Promise<void> {
  const [migration] = await q.query(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE name='GuardianContact1765900000000')::int AS bridge
    FROM public.migrations`) as Array<{ total: number; bridge: number }>;
  if (!migration || migration.total < 92 || migration.bridge !== 1) throw new ReconcileRefusal('GUARDIAN_CONTACT_MIGRATION_REQUIRED');
  const [table] = await q.query(`SELECT to_regclass('public.guardian_contact') IS NOT NULL AS present`) as Array<{ present: boolean }>;
  if (!table?.present) throw new ReconcileRefusal('GUARDIAN_CONTACT_TABLE_REQUIRED');
  const constraints = await q.query(`SELECT conname FROM pg_constraint
    WHERE conrelid='public.guardian_contact'::regclass AND convalidated`) as Array<{ conname: string }>;
  const names = new Set(constraints.map((row) => row.conname));
  for (const name of ['guardian_contact_kind', 'guardian_contact_value', 'guardian_contact_label',
    'guardian_contact_origin', 'guardian_contact_selected', 'guardian_contact_email_shape',
    'guardian_contact_phone_shape', 'guardian_contact_guardian_id_fkey']) {
    if (!names.has(name)) throw new ReconcileRefusal('GUARDIAN_CONTACT_CONSTRAINT_REQUIRED');
  }
  const [index] = await q.query(`SELECT i.indisunique AS unique, i.indisvalid AS valid, i.indisready AS ready,
    i.indnkeyatts AS key_count, pg_get_indexdef(i.indexrelid,1,true) AS first_key,
    pg_get_indexdef(i.indexrelid,2,true) AS second_key, pg_get_expr(i.indpred,i.indrelid) AS predicate
    FROM pg_index i WHERE i.indexrelid=to_regclass('public.guardian_contact_one_selected_kind')`) as Array<{
    unique: boolean; valid: boolean; ready: boolean; key_count: number;
    first_key: string | null; second_key: string | null; predicate: string | null;
  }>;
  if (!index?.unique || !index.valid || !index.ready || index.key_count !== 2
    || index.first_key !== 'guardian_id' || index.second_key !== 'kind'
    || index.predicate !== 'is_delivery_selected') {
    throw new ReconcileRefusal('GUARDIAN_CONTACT_UNIQUE_INDEX_REQUIRED');
  }
}

export interface ReconcileCounts {
  guardians: number;
  email: number;
  phone: number;
  userSelectedConflicts: number;
}

/** 값은 읽기만 하며 밖으로는 건수만 낸다. NULL과 없음도 IS DISTINCT FROM으로 정확히 비교한다. */
export async function guardianContactMismatchCounts(q: QueryRunner): Promise<ReconcileCounts> {
  const [row] = await q.query(`WITH current_contact AS (
      SELECT g.id, kind.kind,
        CASE WHEN kind.kind='email' THEN g.email ELSE g.phone END AS scalar_value,
        c.value AS selected_value, c.origin AS selected_origin
      FROM public.guardian g
      CROSS JOIN (VALUES ('email'),('phone')) AS kind(kind)
      LEFT JOIN public.guardian_contact c ON c.guardian_id=g.id AND c.kind=kind.kind AND c.is_delivery_selected
    )
    SELECT count(DISTINCT id) FILTER (WHERE scalar_value IS DISTINCT FROM selected_value)::int AS guardians,
      count(*) FILTER (WHERE kind='email' AND scalar_value IS DISTINCT FROM selected_value)::int AS email,
      count(*) FILTER (WHERE kind='phone' AND scalar_value IS DISTINCT FROM selected_value)::int AS phone,
      count(*) FILTER (WHERE scalar_value IS DISTINCT FROM selected_value AND selected_origin='user')::int AS user_conflicts
    FROM current_contact`) as Array<{ guardians: number; email: number; phone: number; user_conflicts: number }>;
  return { guardians: row.guardians, email: row.email, phone: row.phone, userSelectedConflicts: row.user_conflicts };
}

export async function inspectGuardianContacts(q: QueryRunner, target: ReconcileTarget, requireLoopback = false): Promise<ReconcileCounts> {
  await assertConnectedTarget(q, target, requireLoopback);
  await assertReconcileSchema(q);
  return guardianContactMismatchCounts(q);
}

export interface ReconcileResult { before: ReconcileCounts; after: ReconcileCounts; applied: number }

/** 호출자가 트랜잭션을 소유한다. 반드시 잠금 뒤 재검사하고 결과 0건을 확인한 뒤에만 commit할 수 있다. */
export async function reconcileGuardianContacts(q: QueryRunner, target: ReconcileTarget): Promise<ReconcileResult> {
  if (!q.isTransactionActive) throw new ReconcileRefusal('TRANSACTION_REQUIRED');
  await q.query(`SET LOCAL lock_timeout = '2s'`);
  await q.query(`SET LOCAL statement_timeout = '30s'`);
  // 구형 writer도 guardian에 먼저 쓰므로 이 순서로 막는다. 둘째 잠금은 child 단독 writer까지 막는다.
  await q.query('LOCK TABLE public.guardian IN SHARE ROW EXCLUSIVE MODE');
  await q.query('LOCK TABLE public.guardian_contact IN SHARE ROW EXCLUSIVE MODE');
  const before = await inspectGuardianContacts(q, target, true);
  if (before.userSelectedConflicts > 0) throw new ReconcileRefusal('USER_SELECTED_CONFLICT');
  const rows = await q.query(`SELECT g.id::text AS id, g.email, g.phone
    FROM public.guardian g
    LEFT JOIN public.guardian_contact e ON e.guardian_id=g.id AND e.kind='email' AND e.is_delivery_selected
    LEFT JOIN public.guardian_contact p ON p.guardian_id=g.id AND p.kind='phone' AND p.is_delivery_selected
    WHERE g.email IS DISTINCT FROM e.value OR g.phone IS DISTINCT FROM p.value ORDER BY g.id`) as Array<{
    id: string; email: string | null; phone: string | null;
  }>;
  if (rows.length !== before.guardians) throw new ReconcileRefusal('MISMATCH_PLAN_CHANGED');
  for (const row of rows) {
    const scalar = { email: row.email, phone: row.phone };
    // before=after라 새 사용자 입력이 아니다. 과거 선택은 비활성 보존하고 현 scalar만 legacy_copy로 선택한다.
    await syncLegacyGuardianContacts(q, row.id, scalar, scalar, null);
  }
  const after = await guardianContactMismatchCounts(q);
  if (after.guardians || after.email || after.phone || after.userSelectedConflicts) {
    throw new ReconcileRefusal('POST_APPLY_MISMATCH');
  }
  return { before, after, applied: rows.length };
}
