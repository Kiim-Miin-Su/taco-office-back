/** @file-guide
 * 목적: golive-reset.ts — GOLIVE_KEEP_TABLES, classifyTables, deleteOrder, keptFixAction, parseGoLiveArgs, applyRefusal, planGoLive, applyGoLive (lib)
 * 책임/재사용: 운영 전환(시험 자료 · 시험 계정 지우기)의 표 분류 · 지우는 순서 · 남는 표 정리 · 인자 검사를 한 곳에서 소유한다. 출력과 종료 코드는 scripts/golive-reset.ts 가 갖는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 운영 전환 — 「테스트 끝나고 운영 시 record 삭제」 (대표 지시 2026-09-26 · W8).
 *
 * 결정(대표 답변): 시험 업무 자료와 시험 계정을 지우고 **대표 계정 하나만** 남긴다. 남는 대표는 초기 비밀번호 +
 * 첫 설정 강제로 되돌린다. 스크립트는 **대표가 직접** 돌리고 기본은 미리 보기(쓰기 0)다 — 우리는 실제 DB 에 돌리지 않는다.
 *
 * 표는 셋으로 나뉜다.
 *   · 남김(설정) — `GOLIVE_KEEP_TABLES`. 수업 종류 · 과목 · 강의실 · 시간대 · 줌 계정 · GPA 항목 · 휴일 · 안내 틀.
 *     시험 기간에 쌓인 것이 아니라 운영에서도 그대로 쓰는 **설정**이다. `migrations` 는 아예 건드리지 않는다.
 *   · 일부 — `staff`. 남길 대표 한 줄만 두고 지운다.
 *   · 비움 — 나머지 전부(학생 · 수업 · 청구 · 기록 …). 새 표가 생기면 **저절로 비움 쪽**이다 — 남기려면 여기 적는다.
 *
 * 순서는 FK 그래프에서 낸다(가리키는 표가 먼저). `TRUNCATE … CASCADE` 는 쓰지 않는다 — 남기는 표로 번지면
 * 설정이 조용히 사라진다. 남는 줄이 지워질 줄을 가리키면 먼저 정리한다: 비울 수 있는 칸은 NULL, staff 를 가리키는
 * NOT NULL 칸은 남는 대표로, 그 밖은 **아무것도 바꾸기 전에** 멈춘다. 전부 한 트랜잭션이다.
 */
import bcrypt from 'bcryptjs';
import { INITIAL_PASSWORD, normalizeLoginEmail } from './account-policy';
import { writtenRows } from './sql';
import { quoteIdent, STAFF_SOFT_REFS, type FkDeleteRule } from './staff-refs';
// 가린 이메일은 발송 원장과 같은 규칙 한 벌을 쓴다(부수효과 없는 순수 함수)
import { maskEmail } from '../modules/notify/sender';

/**
 * 운영에서도 그대로 쓰는 **설정** 표. 여기에 없는 표는 비운다.
 * 단가표(rate) · 교재 목록(lib/vers)은 설정에 가깝지만 값이 시험용일 수 있어 넣지 않았다 — 대표 결정 거리다(구현 기록).
 */
export const GOLIVE_KEEP_TABLES: readonly string[] = ['kind', 'sub', 'room', 'tzg', 'zacc', 'gpasvc', 'holiday', 'gtpl'];
/** 절대 건드리지 않는 표 — 스키마 이력 */
export const GOLIVE_UNTOUCHED: readonly string[] = ['migrations'];
/** 한 줄(남길 대표)만 남기는 표 */
export const GOLIVE_STAFF_TABLE = 'staff';

export interface FkEdge {
  table: string;
  column: string;
  refTable: string;
  notNull: boolean;
  onDelete: FkDeleteRule;
}

export interface TableClasses {
  keep: string[];
  untouched: string[];
  /** 일부만 지우는 표 — staff */
  partial: string[];
  empty: string[];
}

export function classifyTables(all: readonly string[]): TableClasses {
  const sorted = [...new Set(all)].sort();
  return {
    keep: sorted.filter((t) => GOLIVE_KEEP_TABLES.includes(t)),
    untouched: sorted.filter((t) => GOLIVE_UNTOUCHED.includes(t)),
    partial: sorted.filter((t) => t === GOLIVE_STAFF_TABLE),
    empty: sorted.filter((t) => !GOLIVE_KEEP_TABLES.includes(t) && !GOLIVE_UNTOUCHED.includes(t) && t !== GOLIVE_STAFF_TABLE),
  };
}

/**
 * 지우는 순서 — **가리키는 표가 먼저**다(자식 → 부모). 자기 자신을 가리키는 FK 는 한 문장으로 다 지우므로 무시한다.
 * 서로 가리키는 표(순환)가 있으면 순서를 지어내지 않고 던진다 — 아무것도 바꾸기 전이다.
 */
export function deleteOrder(nodes: readonly string[], fks: readonly FkEdge[]): string[] {
  const set = new Set(nodes);
  const children = new Map<string, Set<string>>(nodes.map((n) => [n, new Set<string>()]));
  const parents = new Map<string, Set<string>>(nodes.map((n) => [n, new Set<string>()]));
  for (const fk of fks) {
    if (!set.has(fk.table) || !set.has(fk.refTable) || fk.table === fk.refTable) continue;
    children.get(fk.refTable)!.add(fk.table);
    parents.get(fk.table)!.add(fk.refTable);
  }
  const waiting = new Map<string, number>(nodes.map((n) => [n, children.get(n)!.size]));
  const ready = [...nodes].filter((n) => waiting.get(n) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const parent of [...parents.get(next)!].sort()) {
      const left = waiting.get(parent)! - 1;
      waiting.set(parent, left);
      if (left === 0) ready.push(parent);
    }
    ready.sort();
  }
  if (order.length < set.size) {
    const stuck = [...set].filter((n) => !order.includes(n)).sort();
    throw new Error(`지우는 순서를 정할 수 없습니다 — 서로 가리키는 표가 있습니다: ${stuck.join(', ')}`);
  }
  return order;
}

export type KeptFixAction = 'set_null' | 'reassign_ceo' | 'abort';

/** 남는 줄이 지워질 줄을 가리킬 때 — 비울 수 있으면 NULL, staff 를 가리키는 NOT NULL 이면 남는 대표로, 그 밖은 멈춘다 */
export function keptFixAction(edge: { notNull: boolean; refTable: string }): KeptFixAction {
  if (!edge.notNull) return 'set_null';
  if (edge.refTable === GOLIVE_STAFF_TABLE) return 'reassign_ceo';
  return 'abort';
}

export interface KeptFix {
  table: string;
  column: string;
  refTable: string;
  action: KeptFixAction;
  rows: number;
}

export interface GoLiveArgs {
  apply: boolean;
  confirm: string | null;
  keepEmail: string | null;
  unknown: string[];
}

export function parseGoLiveArgs(argv: readonly string[]): GoLiveArgs {
  const out: GoLiveArgs = { apply: false, confirm: null, keepEmail: null, unknown: [] };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a.startsWith('--confirm=')) out.confirm = a.slice('--confirm='.length).trim() || null;
    else if (a.startsWith('--keep-email=')) out.keepEmail = a.slice('--keep-email='.length).trim() || null;
    // 모르는 인자는 **거절**한다 — `--aply` 같은 오타가 조용히 미리 보기로 끝나거나 반대로 가면 안 된다
    else out.unknown.push(a);
  }
  return out;
}

export interface CeoLine {
  id: number;
  name: string;
  /** 가린 이메일 — 콘솔에도 원문을 찍지 않는다 */
  emailMasked: string;
}

export interface GoLivePlan {
  database: string;
  keep: Array<{ table: string; rows: number }>;
  /** 비우는 표 — **지우는 순서대로**. staff 는 이 줄에 들어 있지 않다(따로 센다) */
  empty: Array<{ table: string; rows: number }>;
  /** staff 까지 넣은 실제 실행 순서 */
  order: string[];
  staff: { rows: number; delete: number; keep: number };
  keptCeo: CeoLine | null;
  keepEmailProblem: string | null;
  activeCeos: CeoLine[];
  fixes: KeptFix[];
  blockers: string[];
}

/** `--apply` 를 거절할 까닭 — 없으면 null. 미리 보기는 이것과 무관하게 돈다 */
export function applyRefusal(args: GoLiveArgs, plan: GoLivePlan): string | null {
  if (args.unknown.length > 0) return `모르는 인자입니다: ${args.unknown.join(' ')}`;
  if (!args.apply) return null;
  if (!args.confirm) return `--apply 에는 --confirm=<지금 DB 이름> 이 필요합니다 (지금 DB: ${plan.database})`;
  if (args.confirm !== plan.database) return `--confirm 값이 지금 DB 이름과 다릅니다 (지금 DB: ${plan.database}) — 다른 DB 를 지우려던 것이 아닌지 확인하세요`;
  if (!args.keepEmail) return '--keep-email=<남길 대표의 이메일> 이 필요합니다 — 활성 대표 계정 하나를 남깁니다';
  if (plan.keepEmailProblem) return plan.keepEmailProblem;
  if (!plan.keptCeo) return '남길 대표를 찾지 못했습니다';
  if (plan.blockers.length > 0) return `남는 표가 지워질 줄을 가리켜 멈춥니다 — ${plan.blockers.join(' · ')}`;
  return null;
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

const rowsOf = async <T>(q: Queryable, sql: string, p: unknown[] = []): Promise<T[]> => (await q.query(sql, p)) as T[];

async function readSchema(q: Queryable): Promise<{ tables: string[]; fks: FkEdge[]; notNull: Map<string, boolean> }> {
  const tables = (await rowsOf<{ t: string }>(q, `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.t);
  const fks = (await rowsOf<{ tbl: string; col: string; ref: string; not_null: boolean; rule: string }>(q,
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confrelid::regclass::text AS ref,
            a.attnotnull AS not_null, c.confdeltype::text AS rule
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
      ORDER BY 1, 2`,
  )).map((r) => ({ table: r.tbl, column: r.col, refTable: r.ref, notNull: r.not_null === true, onDelete: r.rule as FkDeleteRule }));
  const notNull = new Map((await rowsOf<{ c: string; nn: string }>(q,
    `SELECT table_name || '.' || column_name AS c, is_nullable AS nn FROM information_schema.columns WHERE table_schema = 'public'`,
  )).map((r) => [r.c, r.nn === 'NO']));
  return { tables, fks, notNull };
}

/**
 * 남는 줄(설정 표 전부 + 남길 대표 한 줄)이 지워질 줄을 가리키는 칸 — FK 와 FK 없는 staff 칸(STAFF_SOFT_REFS) 둘 다 본다.
 * `ceoId` 가 없으면(미리 보기에서 대표를 안 고름) staff 를 가리키는 값은 전부 지워질 것으로 센다.
 */
async function keptFixes(
  q: Queryable, classes: TableClasses, fks: readonly FkEdge[], notNull: Map<string, boolean>, ceoId: number | null,
): Promise<KeptFix[]> {
  const kept = new Set([...classes.keep, GOLIVE_STAFF_TABLE]);
  const doomed = new Set([...classes.empty, GOLIVE_STAFF_TABLE]);
  const edges: Array<{ table: string; column: string; refTable: string; notNull: boolean }> = [
    ...fks.filter((fk) => kept.has(fk.table) && doomed.has(fk.refTable)),
    ...STAFF_SOFT_REFS.filter(([t]) => kept.has(t))
      .map(([table, column]) => ({ table, column, refTable: GOLIVE_STAFF_TABLE, notNull: notNull.get(`${table}.${column}`) === true })),
  ];
  const out: KeptFix[] = [];
  for (const e of edges) {
    const col = quoteIdent(e.column);
    // staff 자신은 남길 대표 한 줄만 본다 · staff 를 가리키면 남길 대표가 아닌 값만 지워질 줄이다
    const own = e.table === GOLIVE_STAFF_TABLE ? ` AND id IS NOT DISTINCT FROM $1::bigint` : '';
    const toStaff = e.refTable === GOLIVE_STAFF_TABLE ? ` AND ($1::bigint IS NULL OR ${col} <> $1::bigint)` : '';
    // $1 을 쓰는 조건이 있을 때만 값을 넘긴다 — 안 쓰는 값을 넘기면 드라이버가 거절한다
    const [row] = await rowsOf<{ n: number }>(q,
      `SELECT count(*)::int AS n FROM ${quoteIdent(e.table)} WHERE ${col} IS NOT NULL${own}${toStaff}`, own || toStaff ? [ceoId] : []);
    const rows = Number(row?.n ?? 0);
    if (rows > 0) out.push({ table: e.table, column: e.column, refTable: e.refTable, action: keptFixAction(e), rows });
  }
  return out;
}

export async function planGoLive(q: Queryable, keepEmail?: string | null): Promise<GoLivePlan> {
  const [{ db }] = await rowsOf<{ db: string }>(q, `SELECT current_database() AS db`);
  const { tables, fks, notNull } = await readSchema(q);
  const classes = classifyTables(tables);
  const count = async (t: string) =>
    Number((await rowsOf<{ n: string }>(q, `SELECT count(*)::bigint AS n FROM ${quoteIdent(t)}`))[0]?.n ?? 0);

  const activeCeos = (await rowsOf<{ id: string; name: string; email: string }>(q,
    `SELECT id, name, email FROM staff WHERE role = 'ceo' AND active ORDER BY id`,
  )).map((r) => ({ id: Number(r.id), name: r.name, emailMasked: maskEmail(r.email) }));

  let keptCeo: CeoLine | null = null;
  let keepEmailProblem: string | null = null;
  if (keepEmail) {
    // 역할 판정은 SQL 에서 한다 — 활성 대표만 남길 수 있다
    const [hit] = await rowsOf<{ id: string; name: string; email: string }>(q,
      `SELECT id, name, email FROM staff WHERE lower(email) = $1 AND role = 'ceo' AND active`, [normalizeLoginEmail(keepEmail)]);
    if (hit) keptCeo = { id: Number(hit.id), name: hit.name, emailMasked: maskEmail(hit.email) };
    else keepEmailProblem = '--keep-email 이 활성 대표 계정의 이메일이 아닙니다 — 아래 「활성 대표」 중 하나를 적으세요';
  }

  const order = deleteOrder([...classes.empty, ...classes.partial], fks);
  const empty: Array<{ table: string; rows: number }> = [];
  for (const t of order) if (t !== GOLIVE_STAFF_TABLE) empty.push({ table: t, rows: await count(t) });
  const keep: Array<{ table: string; rows: number }> = [];
  for (const t of [...classes.keep, ...classes.untouched]) keep.push({ table: t, rows: await count(t) });
  const staffRows = classes.partial.length ? await count(GOLIVE_STAFF_TABLE) : 0;
  const staffKeep = keptCeo ? 1 : 0;

  const fixes = await keptFixes(q, classes, fks, notNull, keptCeo?.id ?? null);
  const blockers = fixes.filter((f) => f.action === 'abort')
    .map((f) => `${f.table}.${f.column} → ${f.refTable} ${f.rows}줄(비울 수 없는 칸)`);

  return {
    database: db, keep, empty, order,
    staff: { rows: staffRows, delete: staffRows - staffKeep, keep: staffKeep },
    keptCeo, keepEmailProblem, activeCeos, fixes, blockers,
  };
}

export interface GoLiveResult {
  deleted: Array<{ table: string; rows: number }>;
  staffDeleted: number;
  fixed: KeptFix[];
}

/**
 * 실제로 지운다 — **부르는 쪽이 연 트랜잭션 안에서만** 부른다(스크립트 · 시험). 계획을 다시 세워 그 사이 바뀐 것을 반영하고,
 * 끝에 남긴 표의 줄 수가 그대로인지 · 비운 표가 비었는지 다시 센다 — 하나라도 어긋나면 던져서 통째로 되돌린다.
 */
export async function applyGoLive(q: Queryable, keepEmail: string): Promise<GoLiveResult> {
  const plan = await planGoLive(q, keepEmail);
  if (plan.keepEmailProblem || !plan.keptCeo) throw new Error(plan.keepEmailProblem ?? '남길 대표를 찾지 못했습니다');
  if (plan.blockers.length > 0) throw new Error(`남는 표가 지워질 줄을 가리켜 멈춥니다 — ${plan.blockers.join(' · ')}`);
  const ceo = plan.keptCeo.id;

  // ① 남는 줄 정리 — 지우기 **전에** 한다. CASCADE 가 남는 표로 번지지 않게 가리키는 값을 먼저 끊는다
  for (const f of plan.fixes) {
    const col = quoteIdent(f.column);
    const own = f.table === GOLIVE_STAFF_TABLE ? ` AND id = $1` : '';
    const toStaff = f.refTable === GOLIVE_STAFF_TABLE ? ` AND ${col} <> $1` : '';
    const set = f.action === 'set_null' ? 'NULL' : '$1';
    const usesCeo = Boolean(own || toStaff) || f.action === 'reassign_ceo';
    await q.query(`UPDATE ${quoteIdent(f.table)} SET ${col} = ${set} WHERE ${col} IS NOT NULL${own}${toStaff}`, usesCeo ? [ceo] : []);
  }

  // ② 지우기 — FK 그래프 순서(가리키는 표 먼저). staff 는 남길 대표를 뺀 줄만
  const deleted: Array<{ table: string; rows: number }> = [];
  let staffDeleted = 0;
  for (const t of plan.order) {
    if (t === GOLIVE_STAFF_TABLE) {
      const [r] = await rowsOf<{ n: number }>(q, `WITH d AS (DELETE FROM staff WHERE id <> $1 RETURNING 1) SELECT count(*)::int AS n FROM d`, [ceo]);
      staffDeleted = Number(r?.n ?? 0);
    } else {
      const [r] = await rowsOf<{ n: number }>(q, `WITH d AS (DELETE FROM ${quoteIdent(t)} RETURNING 1) SELECT count(*)::int AS n FROM d`);
      deleted.push({ table: t, rows: Number(r?.n ?? 0) });
    }
  }

  // ③ 남길 대표 — 초기 비밀번호 + 첫 설정(아이디·비밀번호 변경 · 휴대폰·이메일 확인)을 다시 건다. 이전 세션은 끊긴다
  const hash = await bcrypt.hash(INITIAL_PASSWORD, 10);
  // UPDATE … RETURNING 은 드라이버가 [행, 수] 로 돌려준다 — 세는 함수 하나(lib/sql.writtenRows)로 읽는다
  const reset = writtenRows<{ id: string }>(await q.query(
    `UPDATE staff SET password_hash = $2, must_change_credentials = true, email_verified = false, phone_verified = false,
            credentials_changed_at = now()
      WHERE id = $1 AND role = 'ceo' AND active RETURNING id`,
    [ceo, hash]));
  if (reset.length !== 1) throw new Error('남길 대표를 초기 상태로 되돌리지 못했습니다 — 아무것도 바꾸지 않고 되돌립니다');

  // ④ 다시 센다 — 남긴 표가 줄었거나 비운 표에 줄이 남았으면 통째로 되돌린다
  for (const k of plan.keep) {
    const [r] = await rowsOf<{ n: string }>(q, `SELECT count(*)::bigint AS n FROM ${quoteIdent(k.table)}`);
    if (Number(r?.n ?? 0) !== k.rows) throw new Error(`남기는 표 ${k.table} 의 줄 수가 바뀌었습니다 — 되돌립니다`);
  }
  for (const e of deleted) {
    const [r] = await rowsOf<{ n: string }>(q, `SELECT count(*)::bigint AS n FROM ${quoteIdent(e.table)}`);
    if (Number(r?.n ?? 0) !== 0) throw new Error(`비운 표 ${e.table} 에 줄이 남았습니다 — 되돌립니다`);
  }

  // ⑤ 흔적 — 운영 원장의 첫 줄이 「언제 누구 이름으로 시험 자료를 비웠는가」다. 연락처·비밀번호는 적지 않는다
  await q.query(
    `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'STAFF',$1,'golive_reset','{}'::jsonb,$2::jsonb)`,
    [ceo, JSON.stringify({
      emptiedTables: deleted.length,
      deletedRows: deleted.reduce((s, d) => s + d.rows, 0),
      staffDeleted,
      keptTables: plan.keep.map((k) => k.table),
    })],
  );
  return { deleted, staffDeleted, fixed: plan.fixes };
}
