/** @file-guide
 * 목적: staff-refs.ts — STAFF_SOFT_REFS, STAFF_OWN_TABLES, staffForeignKeys, staffRecordTables (lib)
 * 책임/재사용: 「누가 이 계정(staff.id)을 가리키는가」를 한 곳에서 소유한다. 구성원 삭제(§17)와 운영 전환 스크립트가 같이 쓴다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 계정을 가리키는 칸 — **DB 제약만 믿으면 안 되는 이유** (W8 · 대표 지시 2026-09-26 「user table CRUD」).
 *
 * ERD(v4.50)에는 `ref: > STAFF.id` 가 80칸 넘게 적혀 있지만, 실제 DB 에 FK 가 선 것은 그 절반쯤이다.
 * 초기 마이그레이션이 급여·알림·할 일·기록(log) 같은 오래된 표에 FK 를 걸지 않았다. 그래서
 * `DELETE FROM staff` 가 23503 없이 **통과**하고, 시급(WAGE)·알림·할 일·기록이 없는 사람을 가리킨 채 남는다.
 * 지우기 전에 이 목록을 **직접** 물어야 한다 — 아래 칸이 그 목록이다.
 *
 * 목록이 낡는 것을 막는 회귀는 `test/staff-crud-w8-db.spec.ts` 가 갖는다 — ERD 의 STAFF 참조가
 * 「DB FK 이거나 이 목록에 있거나」 둘 중 하나가 아니면 실패한다. 새 표가 FK 없이 staff 를 가리키면 거기서 걸린다.
 */

/** DB FK 가 **없는** staff 참조 칸 — [표, 칸]. 이 칸에 값이 있으면 그 계정은 「기록이 있는」 계정이다 */
export const STAFF_SOFT_REFS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['chreq', 'by_id'], ['chreq', 'resolved_by'],
  ['cpl', 'owner_id'],
  ['diag', 'created_by'],
  ['expense', 'requester_id'], ['expense', 'reviewer_id'],
  ['hist', 'by_id'],
  ['inv', 'created_by'],
  ['lead', 'owner_id'],
  // 이 계정이 **한 일**의 기록. 「이 계정에 대한」 기록(entity='STAFF' · 만든 사람이 actor)은 여기에 걸리지 않는다
  ['log', 'actor_id'],
  ['mfb', 'by_id'],
  ['mkt', 'by_id'],
  ['mtattd', 'staff_id'],
  ['mtrec', 'minutes_by'],
  ['note', 'author_id'],
  ['noti', 'to_id'], ['noti', 'from_id'], ['noti', 'request_teacher_id'],
  ['pay', 'entered_by'], ['pay', 'confirmed_by'],
  ['payout', 'staff_id'], ['payout', 'confirmed_by'],
  ['plan', 'owner_id'], ['plan', 'due_approved_by'],
  ['rep', 'teacher_id'], ['rep', 'reviewer_id'],
  ['req', 'staff_id'], ['req', 'resolved_by'],
  ['rsend', 'sent_by'],
  ['ser_occ', 'teacher_id'],
  ['suggestion', 'staff_id'], ['suggestion', 'reply_by'],
  ['todo', 'to_id'], ['todo', 'from_id'],
  ['unav', 'staff_id'],
  // 시급 줄도 기록이다 — 「+ 구성원」에서 시급을 적었으면 그 계정은 지울 수 없고 사용 중지로 막는다 (정산 근거 · I-8)
  ['wage', 'staff_id'], ['wage', 'approved_by'],
  ['zlog', 'actor_id'],
];

/**
 * 계정 **자신만의** 것 — 계정과 함께 사라져도 되는 표(FK ON DELETE CASCADE).
 * 인증 코드는 그 계정의 첫 설정 · 확인에만 쓰이고 다른 업무가 읽지 않는다.
 */
export const STAFF_OWN_TABLES: readonly string[] = ['auth_code'];

/** pg_constraint 의 confdeltype — a: NO ACTION · r: RESTRICT · c: CASCADE · n: SET NULL · d: SET DEFAULT */
export type FkDeleteRule = 'a' | 'r' | 'c' | 'n' | 'd';

export interface StaffFk {
  table: string;
  column: string;
  notNull: boolean;
  onDelete: FkDeleteRule;
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** 식별자 인용 — 표·칸 이름은 카탈로그와 위 상수에서만 오지만, SQL 에 이어 붙이는 자리는 늘 인용한다 */
export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** 지금 DB 의 staff FK 전부 — 이름을 적어 두지 않고 카탈로그에서 읽는다 (새 FK 가 생기면 저절로 들어온다) */
export async function staffForeignKeys(q: Queryable): Promise<StaffFk[]> {
  const rows = (await q.query(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, a.attnotnull AS not_null, c.confdeltype::text AS rule
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'staff'::regclass
      ORDER BY 1, 2`,
  )) as Array<{ tbl: string; col: string; not_null: boolean; rule: string }>;
  return rows.map((r) => ({ table: r.tbl, column: r.col, notNull: r.not_null === true, onDelete: r.rule as FkDeleteRule }));
}

/**
 * 이 계정을 가리키는 행이 있는 표 이름들 — 비어 있으면 「기록 없는」 계정이다.
 *
 * 묻는 것은 두 갈래다. ① FK 가 없는 칸(`STAFF_SOFT_REFS`) ② FK 가 있어도 지울 때 **조용히 같이 지워지거나
 * 비워지는** 칸(CASCADE · SET NULL · SET DEFAULT) — 계정 자신만의 표(`STAFF_OWN_TABLES`)는 뺀다.
 * NO ACTION · RESTRICT FK 는 묻지 않는다 — DELETE 가 23503 으로 막히고 부르는 쪽이 409 로 바꾼다.
 */
export async function staffRecordTables(q: Queryable, staffId: number): Promise<string[]> {
  const fks = await staffForeignKeys(q);
  const quiet = fks
    .filter((fk) => fk.onDelete !== 'a' && fk.onDelete !== 'r' && !STAFF_OWN_TABLES.includes(fk.table))
    .map((fk) => [fk.table, fk.column] as const);
  const hits: string[] = [];
  for (const [table, column] of [...STAFF_SOFT_REFS, ...quiet]) {
    const [row] = (await q.query(
      `SELECT EXISTS (SELECT 1 FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} = $1) AS hit`,
      [staffId],
    )) as Array<{ hit: boolean }>;
    if (row?.hit === true && !hits.includes(table)) hits.push(table);
  }
  return hits;
}
