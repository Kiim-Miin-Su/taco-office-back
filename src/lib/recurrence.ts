/**
 * 반복 일정(SER) + 예외(EXC) 편집 엔진 — 단일 출처.
 *
 * 대표 지시 (2026-08-26):
 *   "3, 4 번에 대한 대상이 반복 스케줄인 경우 이번만, 모두, 향후 일정에 대한
 *    컨펌을 받아야 하며 각각 액션이 달라야 함"
 *
 * 규칙 출처: docs/spec/CALENDAR.md §5A · docs/spec/DEV-SPEC.md D-R16~D-R22
 *
 *   D-1    일정(SER)이 사실이고 나머지는 파생이다.
 *   D-R1   occ(date) = SER 반복 규칙 + EXC. 그날 목록을 만드는 유일한 경로.
 *   D-R16  편집 범위는 이번만 · 향후 · 모두 3종. 단발이면 묻지 않는다.
 *   D-R17  「향후」는 SER 를 분할한다. 기준일 == from_date 면 「모두」로 처리.
 *   D-R18  「모두」는 바뀐 필드를 담은 EXC 를 초기화한다. 휴강은 남긴다.
 *   D-R19  붙여넣기 결과는 언제나 새 SER. EXC 는 따라오지 않는다.
 *   D-R20  향후·모두의 선검사 상한은 오늘+90일 또는 to_date 중 이른 쪽.
 *   D-R21  학생 「이 회차만 빼기」는 EXC.stuOut, 「아주 빼기」는 SER_STU 에서 제거.
 *   D-R22  인원이 바뀌면 1인 단가와 총액을 여기서 다시 계산해 돌려준다.
 *
 * 이 파일은 **순수 함수만** 담는다. DOM 도 전역 상태도 만지지 않는다.
 * 화면과 서버가 같은 판정을 쓰려면 여기 말고 다른 곳에 두면 안 된다.
 * (prototype/js/recurrence.js 를 그대로 옮긴 것이며, 테스트 85개가 함께 따라왔다.)
 *
 * 잠정값 — 뒤집히면 이 파일만 고친다 (docs/decisions/PLANNING-REQUIRED.md).
 *   N-8   EXC 초기화 범위 = 바뀐 필드만            → RESET_MODE
 *   N-9   선검사 상한 = 90일                        → PRECHECK_DAYS
 *   N-10  붙여넣기가 SER_STU 를 복제한다            → PASTE_COPIES_STUDENTS
 */

/* ── 잠정 상수 ────────────────────────────────────────────────────────── */
export const RESET_MODE = 'changed-fields' as const; // N-8
export const PRECHECK_DAYS = 90; // N-9
export const PASTE_COPIES_STUDENTS = true; // N-10
/** 한 번의 붙여넣기로 만들 수 있는 SER 상한 — DTO와 순수 방어함수가 같이 쓴다. */
export const PASTE_MAX = 50;

/* ── 타입 ─────────────────────────────────────────────────────────────── */

/** 'YYYY-MM-DD' */
export type IsoDate = string;

/** 자정부터의 분 (0~1439). 시각은 어디서나 이 정수다 — AGENT.md 원칙 17 */
export type Minutes = number;

export type Scope = 'this' | 'future' | 'all';
export type RosterOp = 'add' | 'dropOnce' | 'undoOnce' | 'dropAll';
export type Freq = 'ONCE' | 'DAILY' | 'WEEKLY';

export interface Rule {
  freq: Freq;
  /** 0=일 … 6=토 */
  days: number[];
  interval: number;
}

/** 반복 규칙 원본. 회차마다 행을 만들지 않는다 — AGENT.md 원칙 13 */
export interface Ser {
  id: number;
  kind: string;
  sub: string | null;
  mode: string;
  title: string;
  teacherId: number | null;
  roomId: number | null;
  startMin: Minutes;
  endMin: Minutes;
  /** 'ONCE' | 'DAILY[/n]' | 'WEEKLY:MO,WE[/n]' */
  rrule: string;
  fromDate: IsoDate;
  toDate: IsoDate | null;
}

export interface SerStu {
  serId: number;
  studentId: number;
}

/** 그날 하루치 예외. 시간 예외와 학생 제외가 같은 행에 함께 산다. */
export interface Exc {
  id: number;
  serId: number;
  /** 규칙상 원래 날짜 — EXC 의 키 */
  onDate: IsoDate;
  canceled: boolean;
  /** 다른 날로 옮겼으면 그 날짜 */
  newDate: IsoDate | null;
  startMin: Minutes | null;
  endMin: Minutes | null;
  teacherId: number | null;
  roomId: number | null;
  reason: string | null;
  /** 이 회차만 빠지는 학생 (D-R21) */
  stuOut: number[];
}

export interface State {
  SER: Ser[];
  SER_STU: SerStu[];
  EXC: Exc[];
}

/** 화면에 그려지는 한 칸. 저장되지 않는다 — occ() 가 매번 만든다. */
export interface Occurrence {
  serId: number;
  /** 화면에 그려질 날짜 */
  date: IsoDate;
  /** 규칙상 원래 날짜 — EXC 의 키 */
  onDate: IsoDate;
  startMin: Minutes;
  endMin: Minutes;
  teacherId: number | null;
  roomId: number | null;
  kind: string;
  sub: string | null;
  mode: string;
  title: string;
  isException: boolean;
  /** 그날 명단 — SER_STU 에서 EXC.stuOut 을 뺀 것. 이 배열이 유일한 출처다. */
  students: number[];
  /** 그날만 빠진 사람 (D-R21). 화면이 회색으로 보여 준다. */
  studentsOut: number[];
  movedFrom: IsoDate | null;
  canceled: boolean;
}

export interface Patch {
  startMin?: Minutes | null;
  endMin?: Minutes | null;
  teacherId?: number | null;
  roomId?: number | null;
  /** 옮긴 날짜 */
  date?: IsoDate | null;
  /** applyPatchToSer 가 이동량을 재려면 원래 날짜가 필요하다 */
  __onDate?: IsoDate;
}

export type IdGen = () => number;

/** 적용 결과 — state 를 바꾸지 않고 새 것을 돌려준다. */
export interface Applied extends State {
  /** 사람이 읽는 변경 기록. 화면이 "무엇이 바뀌었나"를 그대로 보여 준다. */
  __log: string[];
  /** 실제로 적용된 범위. 「향후」가 「모두」로 강등되면 여기서 드러난다 (D-R17). */
  __effScope: string;
}

export interface CopyItem {
  serId: number;
  /** 화면에 보이던 날짜. 옮겨 온 EXC면 onDate와 다르며 상대 간격은 이것을 기준으로 한다. */
  date: IsoDate;
  onDate: IsoDate;
  startMin: Minutes;
  endMin: Minutes;
  teacherId: number | null;
  roomId: number | null;
  kind: string;
  sub: string | null;
  mode: string;
  title: string;
  rrule: string;
  fromDate: IsoDate;
  toDate: IsoDate | null;
  students: number[];
  /** 여러 건을 복사했을 때 첫 건 대비 상대 간격 */
  offsetDays: number;
  offsetMinutes: number;
  excCount: number;
}

/* ── 날짜 ─────────────────────────────────────────────────────────────── */
const MS = 86400000;
const toD = (iso: IsoDate): Date => new Date(iso + 'T00:00:00Z');
const isoOf = (d: Date): IsoDate => d.toISOString().slice(0, 10);

export const addD = (s: IsoDate, n: number): IsoDate => isoOf(new Date(toD(s).getTime() + n * MS));
/** a − b (일) */
export const diffD = (a: IsoDate, b: IsoDate): number =>
  Math.round((toD(a).getTime() - toD(b).getTime()) / MS);
/** 0=일 */
export const dow = (s: IsoDate): number => toD(s).getUTCDay();

export const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];
const DOW_KEY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/* ── 반복 규칙 ─────────────────────────────────────────────────────────
   'ONCE'                 단발
   'WEEKLY:MO,WE,FR'      매주 월·수·금
   'WEEKLY:TU/2'          격주 화
   'DAILY' · 'DAILY/3'    매일 · 3일마다                                   */

export function parseRule(rrule: string | null | undefined): Rule {
  const raw = String(rrule || 'ONCE')
    .trim()
    .toUpperCase();
  if (raw === 'ONCE' || raw === '') return { freq: 'ONCE', days: [], interval: 1 };
  const [head, tail] = raw.split(':');
  const body = tail == null ? '' : tail;
  const [listPart, intPart] = body.split('/');
  const headInt = head.split('/')[1];
  const interval = Math.max(1, parseInt(intPart || headInt || '1', 10) || 1);
  if (head.startsWith('DAILY')) return { freq: 'DAILY', days: [], interval };
  const days = (listPart || '')
    .split(',')
    .map((t) => DOW_KEY.indexOf(t.trim()))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  return { freq: 'WEEKLY', days: days.length ? days : [], interval };
}

export function formatRule(rule: Rule): string {
  if (rule.freq === 'ONCE') return 'ONCE';
  if (rule.freq === 'DAILY') return rule.interval > 1 ? `DAILY/${rule.interval}` : 'DAILY';
  const list = rule.days.map((i) => DOW_KEY[i]).join(',');
  return `WEEKLY:${list}` + (rule.interval > 1 ? `/${rule.interval}` : '');
}

/** 사람이 읽는 한 줄 — 다이얼로그 제목에 쓴다 */
export function ruleLabel(ser: Pick<Ser, 'rrule'>): string {
  const r = parseRule(ser.rrule);
  if (r.freq === 'ONCE') return '단발';
  const every = r.interval > 1 ? `${r.interval}주마다 ` : '매주 ';
  if (r.freq === 'DAILY') return r.interval > 1 ? `${r.interval}일마다` : '매일';
  return every + r.days.map((i) => DOW_KO[i]).join('·');
}

/** 규칙만 본다 — EXC 는 보지 않는다 */
export function ruleHits(ser: Ser, date: IsoDate): boolean {
  if (date < ser.fromDate) return false;
  if (ser.toDate && date > ser.toDate) return false;
  const r = parseRule(ser.rrule);
  if (r.freq === 'ONCE') return date === ser.fromDate;
  if (r.freq === 'DAILY') return diffD(date, ser.fromDate) % r.interval === 0;
  if (!r.days.includes(dow(date))) return false;
  if (r.interval === 1) return true;
  // 격주 — 시작 주의 월요일 기준으로 주 번호를 센다
  const mon = (d: IsoDate) => addD(d, dow(d) === 0 ? -6 : 1 - dow(d));
  const weeks = Math.round(diffD(mon(date), mon(ser.fromDate)) / 7);
  return weeks >= 0 && weeks % r.interval === 0;
}

/* ── occ(date) — 그날 목록을 만드는 유일한 경로 (D-R1) ──────────────── */

export function occ(date: IsoDate, state: Partial<State>): Occurrence[] {
  const sers = state.SER || [];
  const excs = state.EXC || [];
  const out: Occurrence[] = [];

  const excAt = (serId: number, onDate: IsoDate) =>
    excs.find((e) => e.serId === serId && e.onDate === onDate) || null;

  sers.forEach((ser) => {
    // 1) 규칙상 오늘 발생 → 예외를 얹는다
    if (ruleHits(ser, date)) {
      const e = excAt(ser.id, date);
      if (!e) {
        out.push(mk(ser, date, date, null));
      } else if (e.canceled) {
        /* 휴강 — 그리지 않는다 */
      } else if (e.newDate && e.newDate !== date) {
        /* 다른 날로 옮겨 감 */
      } else {
        out.push(mk(ser, date, date, e));
      }
    }
    // 2) 다른 날에서 오늘로 옮겨 온 것
    excs.forEach((e) => {
      if (e.serId !== ser.id || e.canceled) return;
      if (e.newDate !== date || e.onDate === date) return;
      if (!ruleHits(ser, e.onDate)) return;
      out.push(mk(ser, date, e.onDate, e));
    });
  });

  out.forEach((o) => {
    const roster = (state.SER_STU || []).filter((r) => r.serId === o.serId).map((r) => r.studentId);
    const e = excs.find((x) => x.serId === o.serId && x.onDate === o.onDate);
    const outIds = (e && e.stuOut) || [];
    o.students = roster.filter((id) => !outIds.includes(id));
    o.studentsOut = roster.filter((id) => outIds.includes(id));
  });
  return out.sort((a, b) => a.startMin - b.startMin || a.serId - b.serId);
}

function mk(ser: Ser, date: IsoDate, onDate: IsoDate, e: Exc | null): Occurrence {
  return {
    serId: ser.id,
    date,
    onDate,
    startMin: e && e.startMin != null ? e.startMin : ser.startMin,
    endMin: e && e.endMin != null ? e.endMin : ser.endMin,
    teacherId: e && e.teacherId != null ? e.teacherId : ser.teacherId,
    roomId: e && e.roomId != null ? e.roomId : ser.roomId,
    kind: ser.kind,
    sub: ser.sub,
    mode: ser.mode,
    title: ser.title,
    isException: !!e,
    students: [], // occ() 가 곧바로 채운다 — 이 배열이 비어 나가는 경우는 없다
    studentsOut: [],
    movedFrom: e && e.newDate && e.newDate !== e.onDate ? e.onDate : null,
    canceled: false,
  };
}

/* ── 반복인가 — 이게 곧 "물어볼 것인가" 다 (D-R16) ─────────────────── */

export function remainingCount(ser: Ser, fromDate?: IsoDate | null, cap = 400): number {
  const r = parseRule(ser.rrule);
  if (r.freq === 'ONCE') return 1;
  const start = fromDate && fromDate > ser.fromDate ? fromDate : ser.fromDate;
  const end = ser.toDate || addD(start, cap);
  let n = 0;
  for (let d = start; d <= end && n < 3; d = addD(d, 1)) if (ruleHits(ser, d)) n++;
  return n;
}

/** true 면 범위 확인 다이얼로그를 띄운다. false 면 바로 저장한다. */
export function isRecurring(ser: Ser | null | undefined, fromDate?: IsoDate | null): boolean {
  if (!ser) return false;
  if (parseRule(ser.rrule).freq === 'ONCE') return false;
  return remainingCount(ser, fromDate) >= 2;
}

/** 이 시점에 고를 수 있는 범위. 단발이면 빈 배열 = 묻지 않는다. */
export function scopesFor(ser: Ser | null | undefined, onDate: IsoDate): Scope[] {
  if (!isRecurring(ser, onDate)) return [];
  // 첫 회차에서 「향후」는 「모두」와 같다 (D-R17) — 버튼을 두 개 두지 않는다
  return onDate <= ser!.fromDate ? ['this', 'all'] : ['this', 'future', 'all'];
}

export const SCOPE_LABEL: Record<string, string> = {
  this: '이번만',
  future: '향후 일정',
  all: '모든 일정',
};

/* ── 영향받는 날짜 (D-R20) ────────────────────────────────────────────── */

export function affectedDates(
  ser: Ser,
  scope: Scope,
  onDate: IsoDate,
  today?: IsoDate | null,
  cap = PRECHECK_DAYS,
): IsoDate[] {
  if (scope === 'this') return [onDate];
  const start = scope === 'future' ? onDate : ser.fromDate;
  const horizonBase = today && today > start ? today : start;
  let end = addD(horizonBase, cap);
  if (ser.toDate && ser.toDate < end) end = ser.toDate;
  const out: IsoDate[] = [];
  for (let d = start; d <= end; d = addD(d, 1)) if (ruleHits(ser, d)) out.push(d);
  return out;
}

/* ── 「모두」가 초기화할 EXC (D-R18 · N-8) ───────────────────────────── */

type ExcNullableField = 'startMin' | 'endMin' | 'teacherId' | 'roomId';

const PATCH_TO_EXC: Record<string, ExcNullableField> = {
  startMin: 'startMin',
  endMin: 'endMin',
  teacherId: 'teacherId',
  roomId: 'roomId',
};

function resetTargets(
  state: State,
  serId: number,
  patch: Patch | null | undefined,
  fromDate: IsoDate | null,
): Exc[] {
  const fields = Object.keys(patch || {})
    .map((k) => PATCH_TO_EXC[k])
    .filter(Boolean);
  if (!fields.length) return [];
  return (state.EXC || []).filter(
    (e) =>
      e.serId === serId &&
      !e.canceled && // 휴강은 남긴다
      (!fromDate || e.onDate >= fromDate) &&
      fields.some((f) => e[f] != null),
  );
}

/** 다이얼로그에 숫자로 보여줄 것 — "예외 3건이 초기화됩니다" */
export function resetPreview(
  state: State,
  serId: number,
  patch: Patch,
  scope: Scope,
  onDate: IsoDate,
): { count: number; dates: IsoDate[] } {
  if (scope === 'this') return { count: 0, dates: [] };
  const from = scope === 'future' ? onDate : null;
  const hit = resetTargets(state, serId, patch, from);
  return { count: hit.length, dates: hit.map((e) => e.onDate).sort() };
}

/* ── 편집 적용 ─────────────────────────────────────────────────────────
   state 를 바꾸지 않고 새 {SER, SER_STU, EXC} 를 돌려준다.               */

export function applyEdit(
  state: State,
  args: { serId: number; onDate: IsoDate; scope: Scope; patch: Patch; nextId?: IdGen },
): Applied {
  const { serId, onDate, scope, patch, nextId } = args;
  const S = clone(state);
  const ser = S.SER.find((s) => s.id === serId);
  if (!ser) throw new Error('SER not found: ' + serId);
  const eff: Scope = scope === 'future' && onDate <= ser.fromDate ? 'all' : scope;
  const log: string[] = [];
  const genId = mkGen(S, nextId);

  if (eff === 'this') {
    const e = upsertExc(S, serId, onDate, genId);
    if (patch.startMin != null) e.startMin = patch.startMin;
    if (patch.endMin != null) e.endMin = patch.endMin;
    if (patch.teacherId != null) e.teacherId = patch.teacherId;
    if (patch.roomId !== undefined) e.roomId = patch.roomId;
    if (patch.date && patch.date !== onDate) e.newDate = patch.date;
    e.canceled = false;
    log.push(`EXC upsert (${serId}, ${onDate})`);
    return { ...S, __log: log, __effScope: eff };
  }

  let target = ser;
  if (eff === 'future') {
    const copy: Ser = { ...ser, id: genId(), fromDate: onDate, toDate: ser.toDate };
    ser.toDate = addD(onDate, -1);
    S.SER.push(copy);
    (S.SER_STU || [])
      .filter((r) => r.serId === ser.id)
      .slice()
      .forEach((r) => S.SER_STU.push({ serId: copy.id, studentId: r.studentId }));
    S.EXC.filter((e) => e.serId === ser.id && e.onDate >= onDate).forEach((e) => {
      e.serId = copy.id;
    });
    log.push(`SER ${ser.id} 분할 → ${copy.id} (${onDate}~)`);
    target = copy;
  }

  applyPatchToSer(target, patch, log);
  resetTargets(S, target.id, patch, null).forEach((e) => {
    Object.keys(patch).forEach((k) => {
      const f = PATCH_TO_EXC[k];
      if (f) e[f] = null;
    });
    log.push(`EXC (${target.id}, ${e.onDate}) 초기화`);
  });
  S.EXC = S.EXC.filter(
    (e) =>
      e.canceled ||
      e.newDate != null ||
      e.startMin != null ||
      e.endMin != null ||
      e.teacherId != null ||
      e.roomId != null ||
      (e.stuOut && e.stuOut.length > 0),
  );

  return { ...S, __log: log, __effScope: eff };
}

function applyPatchToSer(ser: Ser, patch: Patch, log: string[]): void {
  if (patch.startMin != null) {
    ser.startMin = patch.startMin;
    log.push(`start_min=${patch.startMin}`);
  }
  if (patch.endMin != null) {
    ser.endMin = patch.endMin;
    log.push(`end_min=${patch.endMin}`);
  }
  if (patch.teacherId != null) {
    ser.teacherId = patch.teacherId;
    log.push(`teacher_id=${patch.teacherId}`);
  }
  if (patch.roomId !== undefined) {
    ser.roomId = patch.roomId ?? null;
    log.push(`room_id=${patch.roomId}`);
  }
  if (patch.date && patch.__onDate && patch.date !== patch.__onDate) {
    shiftSer(ser, diffD(patch.date, patch.__onDate));
    log.push(`날짜 ${diffD(patch.date, patch.__onDate)}일 이동`);
  }
}

/** 요일 반복을 통째로 n일 밀어 준다 — 규칙 요일도 같이 돈다 */
function shiftSer(ser: Ser, days: number): Ser {
  if (!days) return ser;
  const r = parseRule(ser.rrule);
  if (r.freq === 'WEEKLY') {
    r.days = r.days.map((d) => (((d + days) % 7) + 7) % 7).sort((a, b) => a - b);
    ser.rrule = formatRule(r);
  }
  ser.fromDate = addD(ser.fromDate, days);
  if (ser.toDate) ser.toDate = addD(ser.toDate, days);
  return ser;
}

/* ── 삭제 (CALENDAR.md §5A.2) ─────────────────────────────────────────── */

export function applyDelete(
  state: State,
  args: { serId: number; onDate: IsoDate; scope: Scope; nextId?: IdGen; hasRefs?: boolean },
): Applied {
  const { serId, onDate, scope, nextId, hasRefs } = args;
  const S = clone(state);
  const ser = S.SER.find((s) => s.id === serId);
  if (!ser) throw new Error('SER not found: ' + serId);
  const eff: Scope = scope === 'future' && onDate <= ser.fromDate ? 'all' : scope;
  const log: string[] = [];
  const genId = mkGen(S, nextId);

  if (eff === 'this') {
    const e = upsertExc(S, serId, onDate, genId);
    e.canceled = true;
    log.push(`EXC (${serId}, ${onDate}) canceled=true`);
  } else if (eff === 'future') {
    ser.toDate = addD(onDate, -1);
    S.EXC = S.EXC.filter((e) => !(e.serId === serId && e.onDate >= onDate));
    log.push(`SER ${serId} to_date=${ser.toDate}`);
  } else if (hasRefs) {
    // 리포트·청구가 붙어 있으면 지우지 않는다 — 지난 회차의 근거가 사라진다
    ser.toDate = addD(onDate, -1);
    log.push(`SER ${serId} 참조 있음 → 삭제 대신 to_date 마감`);
  } else {
    S.SER = S.SER.filter((s) => s.id !== serId);
    S.SER_STU = (S.SER_STU || []).filter((r) => r.serId !== serId);
    S.EXC = S.EXC.filter((e) => e.serId !== serId);
    log.push(`SER ${serId} 삭제`);
  }
  return { ...S, __log: log, __effScope: eff };
}

/* ── 복사 · 붙여넣기 (§5A.3 · D-R19) ─────────────────────────────────── */

export function copyPayload(state: State, occurrence: Occurrence): CopyItem {
  const ser = (state.SER || []).find((s) => s.id === occurrence.serId);
  if (!ser) throw new Error('SER not found: ' + occurrence.serId);
  return {
    serId: ser.id,
    date: occurrence.date,
    onDate: occurrence.onDate,
    startMin: occurrence.startMin,
    endMin: occurrence.endMin,
    teacherId: occurrence.teacherId,
    roomId: occurrence.roomId,
    kind: ser.kind,
    sub: ser.sub,
    mode: ser.mode,
    title: ser.title,
    rrule: ser.rrule,
    fromDate: ser.fromDate,
    toDate: ser.toDate,
    students: (state.SER_STU || []).filter((r) => r.serId === ser.id).map((r) => r.studentId),
    offsetDays: 0,
    offsetMinutes: 0,
    excCount: (state.EXC || []).filter((e) => e.serId === ser.id).length,
  };
}

/** 여러 건을 복사하면 첫 건 대비 상대 간격을 남긴다 */
export function copyMany(state: State, occurrences: Occurrence[]): CopyItem[] {
  const items = occurrences.map((o) => copyPayload(state, o));
  if (!items.length) return items;
  const base = items.reduce((a, b) =>
    a.date < b.date || (a.date === b.date && a.startMin <= b.startMin) ? a : b,
  );
  items.forEach((it) => {
    it.offsetDays = diffD(it.date, base.date);
    it.offsetMinutes = it.startMin - base.startMin;
  });
  return items;
}

export interface PasteSlot {
  date: IsoDate;
  startMin: Minutes;
  endMin: Minutes;
}

/** 화면 프리뷰와 저장이 공유해야 하는 붙여넣기 위치 계산. */
export function pasteSlots(
  items: CopyItem[],
  targetDate: IsoDate,
  targetMin?: Minutes | null,
): PasteSlot[] {
  const baseMin = targetMin ?? items[0]?.startMin ?? 0;
  return items.map((it) => {
    const startMin = baseMin + (it.offsetMinutes || 0);
    return {
      date: addD(targetDate, it.offsetDays || 0),
      startMin,
      endMin: startMin + (it.endMin - it.startMin),
    };
  });
}

/**
 * DB에 손대기 전 거르는 붙여넣기 방어함수. DTO 크기 검증과 별개로 순수 엔진도 스스로 안전해야 한다.
 * null이면 저장 가능, 문자열이면 사람이 고칠 수 있는 이유다.
 */
export function pasteIssue(items: CopyItem[], targetDate: IsoDate, targetMin?: Minutes | null): string | null {
  if (!items.length) return '복사할 회차가 없습니다';
  if (items.length > PASTE_MAX) return `한 번에 ${PASTE_MAX}건까지만 붙여넣을 수 있습니다`;
  const refs = new Set<string>();
  for (const item of items) {
    const key = `${item.serId}|${item.onDate}`;
    if (refs.has(key)) return '같은 원본 회차가 두 번 들어 있습니다';
    refs.add(key);
  }
  const slots = pasteSlots(items, targetDate, targetMin);
  for (const slot of slots) {
    const duration = slot.endMin - slot.startMin;
    if (duration < 10 || duration > 480) return '수업 길이는 10~480분이어야 합니다';
    if (slot.startMin < 0 || slot.startMin >= 1440 || slot.endMin > 1440) {
      return `${slot.date} 일정이 자정을 넘습니다`;
    }
  }
  return null;
}

export function applyPaste(
  state: State,
  args: {
    items: CopyItem | CopyItem[];
    targetDate: IsoDate;
    targetMin?: Minutes | null;
    patch?: Patch | null;
    scope?: Scope;
    nextId?: IdGen;
  },
): Applied {
  const { items, targetDate, targetMin, patch, scope, nextId } = args;
  const S = clone(state);
  const genId = mkGen(S, nextId);
  const log: string[] = [];
  const list = Array.isArray(items) ? items : [items];
  const issue = pasteIssue(list, targetDate, targetMin);
  if (issue) throw new Error(issue);
  const slots = pasteSlots(list, targetDate, targetMin);

  list.forEach((it, index) => {
    const { date, startMin: start, endMin: end } = slots[index];
    const eff: Scope = scope || 'this';
    const ser: Ser = {
      id: genId(),
      kind: it.kind,
      sub: it.sub,
      mode: it.mode,
      title: it.title,
      teacherId: patch && patch.teacherId !== undefined ? (patch.teacherId ?? null) : it.teacherId,
      roomId: patch && patch.roomId !== undefined ? (patch.roomId ?? null) : it.roomId,
      startMin: start,
      endMin: end,
      rrule: 'ONCE',
      fromDate: date,
      toDate: date,
    };
    if (eff === 'future') {
      ser.rrule = it.rrule;
      ser.fromDate = date;
      ser.toDate = it.toDate && it.toDate > date ? it.toDate : null;
      shiftRuleTo(ser, date);
    } else if (eff === 'all') {
      const delta = diffD(date, it.date);
      ser.rrule = it.rrule;
      ser.fromDate = addD(it.fromDate, delta);
      ser.toDate = it.toDate ? addD(it.toDate, delta) : null;
      const r = parseRule(ser.rrule);
      if (r.freq === 'WEEKLY') {
        r.days = r.days.map((d) => (((d + delta) % 7) + 7) % 7).sort((a, b) => a - b);
        ser.rrule = formatRule(r);
      }
    }
    S.SER.push(ser);
    if (PASTE_COPIES_STUDENTS) {
      (it.students || []).forEach((sid) => S.SER_STU.push({ serId: ser.id, studentId: sid }));
    }
    log.push(`SER ${ser.id} 생성 (${SCOPE_LABEL[eff]}) ${ser.fromDate} ${ser.rrule}`);
  });
  // D-R19 — EXC 는 따라오지 않는다
  return { ...S, __log: log, __effScope: scope || 'this' };
}

/** 붙여넣기 「향후」에서 첫 발생이 붙인 날이 되도록 요일을 맞춘다 */
function shiftRuleTo(ser: Ser, date: IsoDate): Ser {
  const r = parseRule(ser.rrule);
  if (r.freq !== 'WEEKLY' || !r.days.length) return ser;
  if (r.days.includes(dow(date))) return ser;
  const delta = dow(date) - r.days[0];
  r.days = r.days.map((d) => (((d + delta) % 7) + 7) % 7).sort((a, b) => a - b);
  ser.rrule = formatRule(r);
  return ser;
}

/* ── 새 일정 (빈 칸 드래그) — 묻지 않는다 ────────────────────────────── */

export interface Draft {
  kind?: string;
  sub?: string | null;
  mode?: string;
  title?: string;
  teacherId?: number | null;
  roomId?: number | null;
  startMin: Minutes;
  endMin: Minutes;
  date: IsoDate;
  rrule?: string;
  toDate?: IsoDate | null;
  students?: number[];
}

export function applyCreate(state: State, args: { draft: Draft; nextId?: IdGen }): Applied {
  const { draft, nextId } = args;
  const S = clone(state);
  const genId = mkGen(S, nextId);
  const ser: Ser = {
    id: genId(),
    kind: draft.kind || 'regular',
    sub: draft.sub || null,
    mode: draft.mode || 'offline',
    title: draft.title || '새 일정',
    teacherId: draft.teacherId ?? null,
    roomId: draft.roomId ?? null,
    startMin: draft.startMin,
    endMin: draft.endMin,
    rrule: draft.rrule || 'ONCE',
    fromDate: draft.date,
    toDate: draft.rrule && draft.rrule !== 'ONCE' ? (draft.toDate ?? null) : draft.date,
  };
  S.SER.push(ser);
  (draft.students || []).forEach((sid) => S.SER_STU.push({ serId: ser.id, studentId: sid }));
  return { ...S, __log: [`SER ${ser.id} 신규`], __effScope: 'this' };
}

/* ── 수강 학생 — 2범위 (명세서 v2 §79·§80 · D-R21) ───────────────────
   시간·강사·강의실은 3범위(이번만/향후/모두)인데 학생은 2범위다.
   「이 회차만」은 EXC.stuOut, 「아주」는 SER_STU 에서 제거한다.
   묻는 말이 다르므로 범위 다이얼로그를 재사용하지 않는다.                */

export const ROSTER_OPS: RosterOp[] = ['add', 'dropOnce', 'undoOnce', 'dropAll'];

export const ROSTER_LABEL: Record<RosterOp, string> = {
  add: '넣기',
  dropOnce: '이 회차만 빼기',
  undoOnce: '되돌리기',
  dropAll: '아주 빼기',
};

/** 그날 명단 — occ() 와 같은 규칙을 쓴다. 두 곳으로 갈라지면 어긋난다. */
export function rosterAt(state: Partial<State>, serId: number, date: IsoDate): number[] {
  const roster = (state.SER_STU || []).filter((r) => r.serId === serId).map((r) => r.studentId);
  const e = (state.EXC || []).find((x) => x.serId === serId && x.onDate === date);
  const outIds = (e && e.stuOut) || [];
  return roster.filter((id) => !outIds.includes(id));
}

/** 학생에게 열 수 있는 범위. 「향후」는 결정 안건 N-15 라 넣지 않는다. */
export function rosterScopes(
  state: Partial<State>,
  serId: number,
  studentId: number,
  onDate: IsoDate,
): RosterOp[] {
  const inRoster = (state.SER_STU || []).some(
    (r) => r.serId === serId && r.studentId === studentId,
  );
  if (!inRoster) return ['add'];
  return rosterAt(state, serId, onDate).includes(studentId)
    ? ['dropOnce', 'dropAll']
    : ['undoOnce', 'dropAll'];
}

export function applyRoster(
  state: State,
  args: {
    serId: number;
    onDate?: IsoDate | null;
    studentId: number;
    op: RosterOp;
    nextId?: IdGen;
  },
): Applied {
  const { serId, onDate, studentId, op, nextId } = args;
  if (!ROSTER_OPS.includes(op)) throw new Error('unknown roster op: ' + op);
  if ((op === 'dropOnce' || op === 'undoOnce') && !onDate)
    throw new Error(op + ' 에는 onDate 가 필요합니다');
  const S = clone(state);
  const ser = S.SER.find((s) => s.id === serId);
  if (!ser) throw new Error('SER not found: ' + serId);
  const genId = mkGen(S, nextId);
  const log: string[] = [];

  if (op === 'add') {
    if (!S.SER_STU.some((r) => r.serId === serId && r.studentId === studentId)) {
      S.SER_STU.push({ serId, studentId });
      log.push(`SER_STU += ${studentId}`);
    }
    // 아주 빼기 뒤 다시 넣으면 그날 제외도 함께 풀어 준다 — 안 그러면 넣었는데 안 보인다
    S.EXC.forEach((e) => {
      if (e.serId === serId && e.stuOut && e.stuOut.includes(studentId)) {
        e.stuOut = e.stuOut.filter((id) => id !== studentId);
        log.push(`EXC (${e.onDate}) stuOut −= ${studentId}`);
      }
    });
  } else if (op === 'dropOnce') {
    const e = upsertExc(S, serId, onDate as IsoDate, genId);
    e.stuOut = e.stuOut || [];
    if (!e.stuOut.includes(studentId)) {
      e.stuOut.push(studentId);
      log.push(`EXC (${onDate}) stuOut += ${studentId}`);
    }
  } else if (op === 'undoOnce') {
    const e = S.EXC.find((x) => x.serId === serId && x.onDate === onDate);
    if (e && e.stuOut) {
      e.stuOut = e.stuOut.filter((id) => id !== studentId);
      log.push(`EXC (${onDate}) stuOut −= ${studentId}`);
    }
  } else {
    S.SER_STU = S.SER_STU.filter((r) => !(r.serId === serId && r.studentId === studentId));
    // 명단에서 빠졌으므로 그날 제외는 의미가 없다. 남겨 두면 되돌릴 때 유령이 된다
    S.EXC.forEach((e) => {
      if (e.serId === serId && e.stuOut) e.stuOut = e.stuOut.filter((id) => id !== studentId);
    });
    log.push(`SER_STU −= ${studentId}`);
  }
  S.EXC = S.EXC.filter(
    (e) =>
      e.canceled ||
      e.newDate != null ||
      e.startMin != null ||
      e.endMin != null ||
      e.teacherId != null ||
      e.roomId != null ||
      (e.stuOut && e.stuOut.length > 0),
  );

  return { ...S, __log: log, __effScope: op };
}

export interface RosterResult {
  count: number;
  cap: number | null;
  room: number | null;
  students: number[];
  total: number | null;
  unitPrice: number | null;
  overCap: boolean;
}

/** 인원이 바뀌면 1인 단가와 총액이 바뀐다 (D-R22). 화면이 다시 계산하지 않게 여기서 돌려준다. */
export function rosterAfter(
  state: Partial<State>,
  serId: number,
  date: IsoDate,
  opts?: { cap?: number | null; classTotal?: number | null },
): RosterResult {
  const o = opts || {};
  const ids = rosterAt(state, serId, date);
  const cap = o.cap != null ? o.cap : null;
  const total = o.classTotal != null ? o.classTotal : null;
  return {
    count: ids.length,
    cap,
    room: cap == null ? null : Math.max(0, cap - ids.length),
    students: ids,
    total,
    unitPrice: total != null && ids.length ? Math.floor(total / ids.length) : null,
    overCap: cap != null && ids.length > cap,
  };
}

/* ── 충돌 선검사 (§5A.4) ───────────────────────────────────────────────
   범위 안의 모든 발생일에 자원 검사를 돌린다. 클라이언트와 서버가 같은
   함수를 쓴다 — 두 벌로 나뉘는 순간 어긋난다.
   ⚠️ 이것은 **안내용**이다. 겹침의 최종 방어선은 DB 의 EXCLUDE 제약이다
      (D-R43 · docs/contracts/STACK.md §1.2).                             */

export interface GuardCandidate {
  id: number;
  date: IsoDate;
  startMin: Minutes;
  endMin: Minutes;
  instructorId: number | null;
  roomId: number | null;
  mode: string;
  studentIds: number[];
}

/** guard.js 와 같은 형태 — 막는 것과 알려만 주는 것을 나눈다. */
export interface GuardResult {
  ok: boolean;
  /** 저장을 막는 사유. 하나라도 있으면 ok=false */
  blocking: { message: string }[];
  /** 저장은 되지만 알려 줘야 하는 것 (안내 없음 · 교재 없음 등) */
  warnings?: { message: string }[];
}

export interface Precheck {
  ok: boolean;
  dates: { date: IsoDate; reasons: string[] }[];
  checked: number;
  horizon?: number;
}

export function precheck(
  state: Partial<State>,
  args: {
    serId: number;
    onDate: IsoDate;
    scope: Scope;
    patch: Patch;
    today?: IsoDate | null;
    guard: (cand: GuardCandidate, ctx: unknown) => GuardResult;
    ctxOf: (date: IsoDate) => unknown;
    cap?: number;
  },
): Precheck {
  const { serId, onDate, scope, patch, today, guard, ctxOf, cap } = args;
  const ser = (state.SER || []).find((s) => s.id === serId);
  if (!ser) return { ok: true, dates: [], checked: 0 };
  const dates = affectedDates(ser, scope, onDate, today, cap || PRECHECK_DAYS);
  const bad: { date: IsoDate; reasons: string[] }[] = [];
  dates.forEach((d) => {
    const day = patch && patch.date && scope === 'this' ? patch.date : d;
    const cand: GuardCandidate = {
      id: ser.id,
      date: day,
      startMin: patch.startMin != null ? patch.startMin : ser.startMin,
      endMin: patch.endMin != null ? patch.endMin : ser.endMin,
      instructorId: patch.teacherId != null ? patch.teacherId : ser.teacherId,
      roomId: patch.roomId !== undefined ? (patch.roomId ?? null) : ser.roomId,
      mode: ser.mode,
      studentIds: (state.SER_STU || [])
        .filter((r) => r.serId === ser.id)
        .map((r) => r.studentId),
    };
    const r = guard(cand, ctxOf(day));
    if (!r.ok) bad.push({ date: day, reasons: r.blocking.map((b) => b.message) });
  });
  return {
    ok: bad.length === 0,
    dates: bad,
    checked: dates.length,
    horizon: cap || PRECHECK_DAYS,
  };
}

/** 다이얼로그 문구 — 최대 5개 + "외 N일" */
export function conflictSummary(pre: Precheck): string {
  if (pre.ok) return '';
  const head = pre.dates.slice(0, 5).map((d) => `${d.date} — ${d.reasons[0]}`);
  const rest = pre.dates.length - head.length;
  return head.join('\n') + (rest > 0 ? `\n외 ${rest}일` : '');
}

/* ── 유틸 ─────────────────────────────────────────────────────────────── */

function clone(state: Partial<State>): State {
  return {
    SER: (state.SER || []).map((o) => ({ ...o })),
    SER_STU: (state.SER_STU || []).map((o) => ({ ...o })),
    EXC: (state.EXC || []).map((o) => ({ ...o, stuOut: (o.stuOut || []).slice() })),
  };
}

function mkGen(S: State, nextId?: IdGen): IdGen {
  if (typeof nextId === 'function') return nextId;
  let n = Math.max(0, ...S.SER.map((s) => s.id || 0), ...S.EXC.map((e) => e.id || 0));
  return () => ++n;
}

function upsertExc(S: State, serId: number, onDate: IsoDate, genId: IdGen): Exc {
  let e = S.EXC.find((x) => x.serId === serId && x.onDate === onDate);
  if (!e) {
    e = {
      id: genId(),
      serId,
      onDate,
      canceled: false,
      newDate: null,
      startMin: null,
      endMin: null,
      teacherId: null,
      roomId: null,
      reason: null,
      stuOut: [],
    };
    S.EXC.push(e);
  }
  return e;
}
