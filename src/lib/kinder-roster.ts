/** @file-guide
 * 목적: BO-09E-01 Kinder 표식과 반복수업 최종 명단을 실제 시작 시각으로 대조하는 공용 순수 판정기.
 * 책임/재사용: 서비스·표식 writer·DB 영수증 검증이 같은 판정을 쓰며 90일 투영이나 학년·나이를 사용하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import {
  addD, diffD, dow, parseRule, rosterAt, ruleHits,
  type Exc, type IsoDate, type Ser, type SerStu, type State,
} from './recurrence';

export const KINDER_GROUP_CONFLICT = 'KINDER_GROUP_CONFLICT' as const;

export interface KinderMarkerEvent {
  studentId: number;
  marked: boolean;
  effectiveFrom: string;
  version: number;
}

export interface KinderRosterConflictShape {
  code: typeof KINDER_GROUP_CONFLICT;
  serId: number;
  onDate: IsoDate;
  date: IsoDate;
  conflictFrom: IsoDate;
  conflictTo: IsoDate | null;
  studentIds: number[];
}

/**
 * 권고안 채택(BO-09E-01): Kinder는 별도 marker만 정본이며 일반 `class`에서 정확히 한 명이다.
 * 충돌을 자동 분리하거나 학생을 제거하지 않는다. 호출자는 이 객체를 409 응답으로 그대로 투영한다.
 */
export class KinderRosterConflict extends Error implements KinderRosterConflictShape {
  readonly code = KINDER_GROUP_CONFLICT;
  constructor(
    public readonly serId: number,
    public readonly onDate: IsoDate,
    public readonly date: IsoDate,
    public readonly conflictFrom: IsoDate,
    public readonly conflictTo: IsoDate | null,
    public readonly studentIds: number[],
  ) {
    super('Kinder 수업에는 학생 한 명만 참여할 수 있습니다');
    this.name = 'KinderRosterConflict';
  }
}

const dayOffset = (weekday: number): number => weekday === 0 ? 6 : weekday - 1;
const monday = (date: IsoDate): IsoDate => addD(date, dow(date) === 0 ? -6 : 1 - dow(date));

/** from 이상 첫 규칙 날짜. 하루씩 훑지 않아 interval이 큰 무기한 규칙도 정확히 건너뛴다. */
export function nextRuleDate(ser: Ser, from: IsoDate): IsoDate | null {
  const start = from > ser.fromDate ? from : ser.fromDate;
  if (ser.toDate && start > ser.toDate) return null;
  const rule = parseRule(ser.rrule);
  let candidate: IsoDate;
  if (rule.freq === 'ONCE') {
    candidate = ser.fromDate;
    if (candidate < start) return null;
  } else if (rule.freq === 'DAILY') {
    const elapsed = Math.max(0, diffD(start, ser.fromDate));
    const steps = Math.ceil(elapsed / rule.interval);
    candidate = addD(ser.fromDate, steps * rule.interval);
  } else {
    if (!rule.days.length) return null;
    const baseMonday = monday(ser.fromDate);
    const startMonday = monday(start);
    const elapsedWeeks = Math.max(0, Math.floor(diffD(startMonday, baseMonday) / 7));
    let activeWeek = Math.ceil(elapsedWeeks / rule.interval) * rule.interval;
    const inWeek = () => rule.days
      .map((weekday) => addD(baseMonday, activeWeek * 7 + dayOffset(weekday)))
      .find((date) => date >= start && date >= ser.fromDate);
    candidate = inWeek() ?? (() => {
      activeWeek += rule.interval;
      return rule.days.map((weekday) => addD(baseMonday, activeWeek * 7 + dayOffset(weekday)))[0]!;
    })();
  }
  if (candidate < ser.fromDate || !ruleHits(ser, candidate)) return null;
  if (ser.toDate && candidate > ser.toDate) return null;
  return candidate;
}

const kstDateOfInstant = (iso: string): IsoDate => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms + 9 * 3600_000).toISOString().slice(0, 10) : '0000-00-00';
};

const actualStartMs = (date: IsoDate, startMin: number): number =>
  Date.parse(`${date}T00:00:00+09:00`) + startMin * 60_000;

function markerAt(events: readonly KinderMarkerEvent[], studentId: number, atMs: number): boolean {
  let latest: KinderMarkerEvent | null = null;
  for (const event of events) {
    if (event.studentId !== studentId) continue;
    const effective = Date.parse(event.effectiveFrom);
    if (!Number.isFinite(effective) || effective > atMs) continue;
    if (!latest || effective > Date.parse(latest.effectiveFrom)
      || (effective === Date.parse(latest.effectiveFrom) && event.version > latest.version)) latest = event;
  }
  return latest?.marked === true;
}

function occurrenceFacts(ser: Ser, exceptions: readonly Exc[], onDate: IsoDate) {
  const exc = exceptions.find((row) => row.serId === ser.id && row.onDate === onDate) ?? null;
  if (exc?.canceled) return null;
  return {
    exc,
    date: exc?.newDate ?? onDate,
    startMin: exc?.startMin ?? ser.startMin,
  };
}

function overlapPeriod(ser: Ser, rows: readonly SerStu[]): { from: IsoDate; to: IsoDate | null } {
  const from = rows.reduce((max, row) => row.fromDate && row.fromDate > max ? row.fromDate : max, ser.fromDate);
  const ends = [ser.toDate, ...rows.map((row) => row.toDate ?? null)].filter((date): date is string => date !== null);
  return { from, to: ends.length ? ends.reduce((min, date) => date < min ? date : min) : null };
}

function stableBoundary(ser: Ser, rows: readonly SerStu[], exceptions: readonly Exc[], markers: readonly KinderMarkerEvent[]): IsoDate {
  const dates: IsoDate[] = [ser.fromDate];
  for (const row of rows) {
    if (row.fromDate) dates.push(row.fromDate);
    if (row.toDate) dates.push(row.toDate, addD(row.toDate, 1));
  }
  for (const exc of exceptions) dates.push(exc.onDate);
  for (const marker of markers) {
    const date = kstDateOfInstant(marker.effectiveFrom);
    if (date !== '0000-00-00') dates.push(date, addD(date, 1));
  }
  return dates.reduce((max, date) => date > max ? date : max, ser.fromDate);
}

/**
 * 모든 일반 class의 원본 반복규칙·참여기간·취소·이동·회차 제외를 끝까지 검사한다.
 * 무기한 규칙은 마지막 상태 변화 뒤 첫 실제 회차까지 보므로 고정 90일 horizon에 의존하지 않는다.
 */
export function findKinderRosterConflict(
  state: Pick<State, 'SER' | 'SER_STU' | 'EXC'>,
  markers: readonly KinderMarkerEvent[],
): KinderRosterConflict | null {
  for (const ser of state.SER) {
    if (ser.kind !== 'class') continue;
    const rows = state.SER_STU.filter((row) => row.serId === ser.id);
    if (rows.length < 2) continue;
    const exceptions = state.EXC.filter((row) => row.serId === ser.id);
    const relevantStudentIds = new Set(rows.map((row) => row.studentId));
    const relevantMarkers = markers.filter((event) => relevantStudentIds.has(event.studentId));
    if (!relevantMarkers.some((event) => event.marked)) continue;
    const boundary = ser.toDate ?? stableBoundary(ser, rows, exceptions, relevantMarkers);
    let onDate = nextRuleDate(ser, ser.fromDate);
    let checkedStable = false;
    while (onDate) {
      const beyondBoundary = onDate > boundary;
      if (beyondBoundary && checkedStable) break;
      const facts = occurrenceFacts(ser, exceptions, onDate);
      if (facts) {
        const studentIds = [...new Set(rosterAt(state, ser.id, onDate))].sort((a, b) => a - b);
        const atMs = actualStartMs(facts.date, facts.startMin);
        if (studentIds.length !== 1 && studentIds.some((studentId) => markerAt(relevantMarkers, studentId, atMs))) {
          const activeRows = rows.filter((row) => studentIds.includes(row.studentId));
          const period = facts.exc ? { from: onDate, to: onDate } : overlapPeriod(ser, activeRows);
          return new KinderRosterConflict(ser.id, onDate, facts.date, period.from, period.to, studentIds);
        }
      }
      if (beyondBoundary) checkedStable = true;
      if (ser.toDate && onDate >= ser.toDate) break;
      onDate = nextRuleDate(ser, addD(onDate, 1));
    }
  }
  return null;
}

export function assertKinderRosterState(
  state: Pick<State, 'SER' | 'SER_STU' | 'EXC'>,
  markers: readonly KinderMarkerEvent[],
): void {
  const conflict = findKinderRosterConflict(state, markers);
  if (conflict) throw conflict;
}
