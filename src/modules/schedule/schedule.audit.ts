/** @file-guide
 * 목적: schedule.audit.ts — scheduleAuditLines, auditScheduleWrite (service)
 * 책임/재사용: 스케줄 쓰기의 감사 한 줄(N-73)을 State 앞뒤 차이로 만든다. 남기는 목록·쓰기는 lib/audit 한 곳을 쓴다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 스케줄 쓰기의 감사 줄 — N-73 채택(대표 위임 2026-09-26 · W11) 「정본 표의 쓰기만 · SER 단위 한 줄」.
 *
 *   · **규칙(SER) 하나에 한 줄**이다. 한 번의 쓰기가 규칙 여럿을 바꾸면(향후 분할 · 여러 회차 이동 · 그날 전체 휴강)
 *     바뀐 규칙마다 한 줄이다. 바뀌지 않은 규칙은 줄이 없다.
 *   · before/after 에는 **바뀐 것만** 싣는다 — 규칙 칸은 바뀐 칸만, 회차 예외는 바뀐 날짜만, 명단은 바뀌었을 때만.
 *     새로 생긴 규칙은 before 가 없고(만들기), 사라진 규칙은 after 가 없다(지우기).
 *   · **투영은 남기지 않는다** — `ser_occ` 는 쓰기마다 구간을 다시 쓰고, 줌 배정(`zassign`)은 lib/audit 이 투영 쪽으로 분류했다.
 *     그래서 State 의 `zaccId` 는 여기서 뺀다. 줌 배정의 이력은 계정 화면의 zlog 가 갖는다.
 *   · 쓰기와 **같은 트랜잭션**에서 남긴다(`audit()` 의 규칙). 겹침(409)으로 되돌아가면 줄도 함께 사라진다.
 *   · 누가를 모르는 쓰기(시스템 호출 · actor 없음)는 남기지 않는다 — `log.actor_id` 는 NOT NULL 이고 없는 사람을 지어내지 않는다.
 */
import type { QueryRunner } from 'typeorm';
import { audit, type AuditKey } from '../../lib/audit';
import type { Exc, Ser, SerStu, State } from '../../lib/recurrence';

type View = Record<string, unknown>;

const SER_FIELDS = [
  'kind', 'sub', 'mode', 'title', 'teacherId', 'roomId', 'startMin', 'endMin', 'rrule', 'fromDate', 'toDate',
] as const satisfies ReadonlyArray<keyof Ser>;

/** 회차 예외의 업무 칸 — 행 번호(id)와 줌 배정(zaccId)은 싣지 않는다 */
const EXC_FIELDS = [
  'canceled', 'newDate', 'startMin', 'endMin', 'teacherSet', 'teacherId', 'roomSet', 'roomId',
  'reason', 'cancelKind', 'cancelTreat', 'makeupSerId', 'mode', 'memo',
] as const satisfies ReadonlyArray<keyof Exc>;

const serView = (s: Ser): View => Object.fromEntries(SER_FIELDS.map((f) => [f, s[f] ?? null]));

const excView = (e: Exc): View => ({
  ...Object.fromEntries(EXC_FIELDS.map((f) => [f, e[f] ?? null])),
  stuOut: [...(e.stuOut ?? [])].sort((a, b) => a - b),
});

const rosterView = (rows: SerStu[]): View[] =>
  [...rows]
    .sort((a, b) => a.studentId - b.studentId)
    .map((r) => ({ studentId: r.studentId, fromDate: r.fromDate ?? null, toDate: r.toDate ?? null }));

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface ScheduleAuditLine {
  serId: number;
  /** 없으면 만들기 */
  before?: View;
  /** 없으면 지우기 */
  after?: View;
}

/** State 앞뒤에서 규칙마다 바뀐 것만 뽑는다. 순수 함수 — DB 를 읽지 않는다 */
export function scheduleAuditLines(before: State, after: State): ScheduleAuditLine[] {
  const ids = [...new Set([...before.SER, ...after.SER].map((s) => s.id))].sort((a, b) => a - b);
  const lines: ScheduleAuditLine[] = [];
  for (const id of ids) {
    const sb = before.SER.find((s) => s.id === id);
    const sa = after.SER.find((s) => s.id === id);
    const excOf = (state: State) =>
      new Map(state.EXC.filter((e) => e.serId === id).map((e) => [e.onDate, excView(e)]));
    const rosterOf = (state: State) => rosterView(state.SER_STU.filter((r) => r.serId === id));
    const full = (s: Ser, state: State): View => ({
      ...serView(s),
      exc: Object.fromEntries([...excOf(state)].sort(([a], [b]) => a.localeCompare(b))),
      roster: rosterOf(state),
    });

    if (!sb || !sa) {
      lines.push({ serId: id, before: sb ? full(sb, before) : undefined, after: sa ? full(sa, after) : undefined });
      continue;
    }

    const b: View = {};
    const a: View = {};
    for (const f of SER_FIELDS) {
      if (!same(sb[f] ?? null, sa[f] ?? null)) {
        b[f] = sb[f] ?? null;
        a[f] = sa[f] ?? null;
      }
    }
    const eb = excOf(before);
    const ea = excOf(after);
    const days = [...new Set([...eb.keys(), ...ea.keys()])].sort();
    const excB: View = {};
    const excA: View = {};
    for (const d of days) {
      if (same(eb.get(d) ?? null, ea.get(d) ?? null)) continue;
      excB[d] = eb.get(d) ?? null;
      excA[d] = ea.get(d) ?? null;
    }
    if (Object.keys(excB).length) {
      b.exc = excB;
      a.exc = excA;
    }
    const rb = rosterOf(before);
    const ra = rosterOf(after);
    if (!same(rb, ra)) {
      b.roster = rb;
      a.roster = ra;
    }
    if (Object.keys(b).length || Object.keys(a).length) lines.push({ serId: id, before: b, after: a });
  }
  return lines;
}

/** 감사 줄을 쓰기와 같은 트랜잭션에 남긴다. actor 가 없으면 남기지 않는다 */
export async function auditScheduleWrite(
  q: QueryRunner, key: AuditKey, actorId: number | undefined, before: State, after: State,
): Promise<number> {
  if (actorId === undefined) return 0;
  const lines = scheduleAuditLines(before, after);
  for (const line of lines) {
    await audit(q, key, { actorId, entityId: line.serId, before: line.before, after: line.after });
  }
  return lines.length;
}
