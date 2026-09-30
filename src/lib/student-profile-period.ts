/** @file-guide
 * 목적: student-profile-period.ts — 학생 기간 입력 정밀도·포함/겹침·명시 분할 preview.
 * 책임/재사용: kst의 실제 날짜/KST 계산을 재사용한다. DB 현재 profile resolver·권한·revision 쓰기는 소유하지 않는다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md §3·§6 ST1-a · docs/AGENT.md
 */

import { addDays, isIsoDate, todayKst } from './kst';

export type StudentPeriodPrecision = 'year' | 'month' | 'day';

/** 입력의 모양은 precision에 맞춰 YYYY / YYYY-MM / YYYY-MM-DD다. 종료 생략 대신 명시적 NULL을 쓴다. */
export interface StudentPeriodInput {
  readonly from: string;
  readonly to: string | null;
  readonly fromPrecision: StudentPeriodPrecision;
  readonly toPrecision: StudentPeriodPrecision | null;
}

/** 양끝 포함 ISO 날짜. 계산으로 자른 경계는 day+derived이며 원행의 원래 정밀도를 덮어쓰지 않는다. */
export interface StudentPeriod extends StudentPeriodInput {
  readonly fromDerived: boolean;
  readonly toDerived: boolean;
}

/** 기간 판정은 payload 내용을 해석하지 않는다. 학생/field 선택과 typed payload 검증은 호출자 책임이다. */
export interface StudentPeriodEntry<T> {
  readonly period: StudentPeriod;
  readonly value: T;
}

export interface StudentPeriodReplacement<T> {
  readonly before: StudentPeriodEntry<T> | null;
  readonly replacement: StudentPeriodEntry<T>;
  readonly after: StudentPeriodEntry<T> | null;
}

function invalid(reason: string): never {
  throw new RangeError(`STUDENT_PERIOD_INVALID: ${reason}`);
}

function assertObject(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('객체가 필요합니다');
}

function isPrecision(value: unknown): value is StudentPeriodPrecision {
  return value === 'year' || value === 'month' || value === 'day';
}

/** Date.UTC의 0~99년 보정과 다음 달/10000년 overflow를 피하고 기존 달력 validator를 그대로 쓴다. */
function monthEnd(month: string): string {
  for (const day of ['31', '30', '29', '28']) {
    const date = `${month}-${day}`;
    if (isIsoDate(date)) return date;
  }
  return invalid('실제 달력 월이 아닙니다');
}

function normalizeBoundary(value: unknown, precision: unknown, side: 'from' | 'to'): string {
  if (typeof value !== 'string' || !isPrecision(precision)) return invalid('날짜와 정밀도가 필요합니다');
  let date: string;
  if (precision === 'year') {
    if (!/^\d{4}$/.test(value)) return invalid('연 정밀도는 YYYY입니다');
    date = `${value}-${side === 'from' ? '01-01' : '12-31'}`;
  } else if (precision === 'month') {
    if (!/^\d{4}-\d{2}$/.test(value) || !isIsoDate(`${value}-01`)) return invalid('월 정밀도는 실제 YYYY-MM입니다');
    date = side === 'from' ? `${value}-01` : monthEnd(value);
  } else {
    date = value;
  }
  if (!isIsoDate(date)) return invalid('날짜는 0001~9999년의 실제 달력 날짜여야 합니다');
  return date;
}

/** 외부 입력의 precision을 보존한다. 계산한 달력 경계를 실제로 아는 날짜라고 주장하지 않는다. */
export function normalizeStudentPeriod(input: StudentPeriodInput): StudentPeriod {
  assertObject(input);
  const from = normalizeBoundary(input.from, input.fromPrecision, 'from');
  if (input.to === null && input.toPrecision !== null) return invalid('무기한 종료의 정밀도는 NULL이어야 합니다');
  const to = input.to === null ? null : normalizeBoundary(input.to, input.toPrecision, 'to');
  if (to !== null && to < from) return invalid('종료일은 시작일보다 앞설 수 없습니다');
  return { from, to, fromPrecision: input.fromPrecision, toPrecision: input.toPrecision, fromDerived: false, toDerived: false };
}

/** 타입 단언/DB raw row로 들어온 값도 canonical 경계·derived 의미를 우회하지 못한다. */
function assertPeriod(value: unknown): asserts value is StudentPeriod {
  assertObject(value);
  if (!isIsoDate(value.from) || (value.to !== null && !isIsoDate(value.to))) invalid('정규화 기간은 실제 ISO 날짜여야 합니다');
  if (typeof value.fromDerived !== 'boolean' || typeof value.toDerived !== 'boolean') invalid('계산 경계 표식은 boolean이어야 합니다');
  for (const side of ['from', 'to'] as const) {
    const date = value[side];
    const precision = value[`${side}Precision`];
    const derived = value[`${side}Derived`];
    if (side === 'to' && date === null) {
      if (precision !== null || derived !== false) invalid('무기한 종료의 정밀도/계산 표식이 잘못되었습니다');
      continue;
    }
    if (typeof date !== 'string' || !isPrecision(precision)) invalid('정규화 경계의 정밀도가 잘못되었습니다');
    if (derived && precision !== 'day') invalid('분할로 계산한 경계는 day 정밀도여야 합니다');
    const raw = precision === 'year' ? date.slice(0, 4) : precision === 'month' ? date.slice(0, 7) : date;
    if (normalizeBoundary(raw, precision, side) !== date) invalid('정밀도와 정규화 경계가 일치하지 않습니다');
  }
  if (value.to !== null && value.to < value.from) invalid('종료일은 시작일보다 앞설 수 없습니다');
}

/** 한 기간의 포함 판정일 뿐이다. 학생/field별 현재값·legacy fallback은 후속 SQL resolver가 소유한다. */
export function studentPeriodContains(input: { readonly period: StudentPeriod; readonly asOf?: string }): boolean {
  assertObject(input);
  assertPeriod(input.period);
  const asOf = input.asOf === undefined ? todayKst() : input.asOf;
  if (!isIsoDate(asOf)) return invalid('asOf는 실제 ISO 날짜여야 합니다');
  return asOf >= input.period.from && (input.period.to === null || asOf <= input.period.to);
}

/** 같은 학생/field의 활성 revision 선택은 호출자가 한다. 끝일=다른 시작일도 겹친다. */
export function studentPeriodsOverlap(input: { readonly left: StudentPeriod; readonly right: StudentPeriod }): boolean {
  assertObject(input);
  assertPeriod(input.left);
  assertPeriod(input.right);
  return (input.left.to === null || input.right.from <= input.left.to)
    && (input.right.to === null || input.left.from <= input.right.to);
}

function assertEntry(value: unknown): void {
  assertObject(value);
  assertPeriod(value.period);
  if (!Object.hasOwn(value, 'value')) invalid('기간에 연결된 원본/대체 값이 필요합니다');
}

function adjacentDate(date: string, days: -1 | 1): string {
  const result = addDays(date, days);
  if (!isIsoDate(result)) return invalid('분할 후 잔여 구간을 0001~9999년으로 표현할 수 없습니다');
  return result;
}

/**
 * 단일 원본 안의 명시 대체 계획만 만든다. 여러 원본 병합/자동 clamp/DB 쓰기/정정 승인이 아니다.
 * 양옆은 원본 payload, 가운데는 대체 payload를 그대로 참조하며 어느 payload도 수정하지 않는다.
 * 원본과 별개의 기간 객체를 반환한다. payload 자체의 복제·내용 검증은 해당 typed writer의 책임이다.
 */
export function previewStudentPeriodReplacement<T>(input: {
  readonly original: StudentPeriodEntry<T>;
  readonly replacement: StudentPeriodEntry<T>;
}): StudentPeriodReplacement<T> {
  assertObject(input);
  assertEntry(input.original);
  assertEntry(input.replacement);
  const original = input.original.period, replacement = input.replacement.period;
  if (replacement.from < original.from
    || (original.to !== null && (replacement.to === null || replacement.to > original.to))) {
    return invalid('대체 기간은 단일 원본 기간 안에 있어야 합니다');
  }
  const before = replacement.from > original.from ? {
    value: input.original.value,
    period: { ...original, to: adjacentDate(replacement.from, -1), toPrecision: 'day' as const, toDerived: true },
  } : null;
  const after = replacement.to !== null && (original.to === null || replacement.to < original.to) ? {
    value: input.original.value,
    period: { ...original, from: adjacentDate(replacement.to, 1), fromPrecision: 'day' as const, fromDerived: true },
  } : null;
  return { before, replacement: { period: { ...replacement }, value: input.replacement.value }, after };
}
