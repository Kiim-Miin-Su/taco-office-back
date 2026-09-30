/** @file-guide
 * 목적: student-profile-period.spec.ts — ST-PERIOD 기간 입력·경계·분할 preview의 DB 없는 회귀.
 * 책임/재사용: 제품의 공개 순수 함수를 호출한다. 현재 profile SQL resolver·DTO·DB/권한 검증을 대체하지 않는다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md §3·§6 ST1-a · docs/AGENT.md
 */

import {
  normalizeStudentPeriod, previewStudentPeriodReplacement, studentPeriodContains, studentPeriodsOverlap,
  type StudentPeriod, type StudentPeriodInput,
} from '../src/lib/student-profile-period';

const day = (from: string, to: string | null): StudentPeriod => normalizeStudentPeriod({
  from, to, fromPrecision: 'day', toPrecision: to === null ? null : 'day',
});
const raw = (patch: Partial<StudentPeriodInput> = {}): StudentPeriodInput => ({
  from: '2020-01-01', to: '2023-12-31', fromPrecision: 'day', toPrecision: 'day', ...patch,
});

describe('ST-PERIOD-01 입력 정밀도 → 실제 inclusive 날짜', () => {
  it.each([
    ['2020', 'year', '2021', 'year', '2020-01-01', '2021-12-31'],
    ['2020-02', 'month', '2020-02', 'month', '2020-02-01', '2020-02-29'],
    ['1900-02', 'month', '1900-02', 'month', '1900-02-01', '1900-02-28'],
    ['2000-02', 'month', '2000-02', 'month', '2000-02-01', '2000-02-29'],
    ['0100-02', 'month', '0100-02', 'month', '0100-02-01', '0100-02-28'],
    ['0096-02', 'month', '0096-02', 'month', '0096-02-01', '0096-02-29'],
    ['0099', 'year', '0099-12', 'month', '0099-01-01', '0099-12-31'],
    ['0001', 'year', '0001', 'year', '0001-01-01', '0001-12-31'],
    ['9999-12', 'month', '9999', 'year', '9999-12-01', '9999-12-31'],
    ['2020-04', 'month', '2020-04', 'month', '2020-04-01', '2020-04-30'],
    ['2020-02-29', 'day', '2020-02-29', 'day', '2020-02-29', '2020-02-29'],
    ['2020', 'year', null, null, '2020-01-01', null],
  ] as const)('%s(%s) ~ %s(%s)의 원래 정밀도와 끝일을 보존한다', (from, fromPrecision, to, toPrecision, expectedFrom, expectedTo) => {
    expect(normalizeStudentPeriod({ from, fromPrecision, to, toPrecision })).toEqual({
      from: expectedFrom, to: expectedTo, fromPrecision, toPrecision, fromDerived: false, toDerived: false,
    });
  });

  it.each([
    undefined, null, [], '', 2020,
    raw({ from: '0000-01-01' }), raw({ from: '10000-01-01' }),
    raw({ from: '2020-2-01' }), raw({ from: '2020-02-30' }), raw({ from: '1900-02-29' }),
    raw({ from: '2020-01-01T00:00:00Z' }), raw({ from: ' 2020-01-01' }),
    raw({ from: '2020', fromPrecision: 'day' }), raw({ from: '2020-01-01', fromPrecision: 'year' }),
    raw({ from: '2020-13', fromPrecision: 'month' }), raw({ from: '2020-00', fromPrecision: 'month' }),
    raw({ from: '0000', fromPrecision: 'year' }), raw({ from: '020', fromPrecision: 'year' }),
    raw({ to: '2020-04-31' }), raw({ to: '2020-13', toPrecision: 'month' }),
    raw({ to: '2020', toPrecision: 'day' }), raw({ to: null, toPrecision: 'day' }),
    raw({ toPrecision: null }), raw({ from: '2024-01-01' }),
    { ...raw(), fromPrecision: 'week' }, { ...raw(), toPrecision: 'week' },
    { ...raw(), from: 2020 }, { ...raw(), to: undefined },
    { ...raw(), fromPrecision: undefined }, { ...raw(), toPrecision: undefined },
  ])('잘못된 runtime 입력 %p를 자동 보정하지 않는다', input => {
    expect(() => normalizeStudentPeriod(input as StudentPeriodInput)).toThrow(RangeError);
  });

  it('월 정밀도여도 정규화 뒤 역전이면 거절한다', () => {
    expect(() => normalizeStudentPeriod({ from: '2021-03', fromPrecision: 'month', to: '2021-02', toPrecision: 'month' }))
      .toThrow(RangeError);
  });

  it('입력 객체를 변경하지 않고 새 정규화 결과를 반환한다', () => {
    const input = Object.freeze(raw({ from: '2020', fromPrecision: 'year' }));
    const before = { ...input };
    const out = normalizeStudentPeriod(input);
    expect(input).toEqual(before);
    expect(out).not.toBe(input);
    expect(out.from).toBe('2020-01-01');
  });
});

describe('ST-PERIOD-02 포함·겹침은 양끝 포함이고 NULL은 무기한이다', () => {
  it.each([
    ['2019-12-31', false], ['2020-01-01', true], ['2020-06-30', true],
    ['2020-12-31', true], ['2021-01-01', false],
  ])('유한 기간의 asOf=%s는 %s다', (asOf, expected) => {
    expect(studentPeriodContains({ period: day('2020-01-01', '2020-12-31'), asOf })).toBe(expected);
  });

  it('하루·최소일·최대일·무기한 기간을 센티널 날짜로 바꾸지 않는다', () => {
    const one = day('0001-01-01', '0001-01-01');
    expect(studentPeriodContains({ period: one, asOf: '0001-01-01' })).toBe(true);
    expect(studentPeriodContains({ period: one, asOf: '0001-01-02' })).toBe(false);
    const open = day('2020-01-01', null);
    expect(studentPeriodContains({ period: open, asOf: '9999-12-31' })).toBe(true);
    expect(open.to).toBeNull();
  });

  it.each([
    ['2020-01-01', '2020-01-31', '2020-02-01', '2020-02-28', false],
    ['2020-01-01', '2020-01-31', '2020-01-31', '2020-02-28', true],
    ['2020-01-01', '2020-12-31', '2020-02-01', '2020-02-28', true],
    ['2020-01-01', '2020-01-01', '2020-01-01', '2020-01-01', true],
    ['2020-01-01', null, '9999-12-31', null, true],
    ['2020-01-01', '2020-01-31', '2020-02-01', null, false],
    ['0001-01-01', '9999-12-31', '9999-12-31', null, true],
  ] as const)('%s~%s와 %s~%s의 겹침=%s이며 순서와 무관하다', (fromA, toA, fromB, toB, expected) => {
    const left = day(fromA, toA), right = day(fromB, toB);
    expect(studentPeriodsOverlap({ left, right })).toBe(expected);
    expect(studentPeriodsOverlap({ left: right, right: left })).toBe(expected);
  });

  it('2020~2021과 2021~2023을 비겹침으로 바꾸지 않는다', () => {
    const left = normalizeStudentPeriod({ from: '2020', to: '2021', fromPrecision: 'year', toPrecision: 'year' });
    const right = normalizeStudentPeriod({ from: '2021', to: '2023', fromPrecision: 'year', toPrecision: 'year' });
    expect(studentPeriodsOverlap({ left, right })).toBe(true);
  });

  it.each([null, '', '2020', '2020-02-30', '0000-01-01', '10000-01-01', 2020])('잘못된 asOf=%p를 거절한다', asOf => {
    expect(() => studentPeriodContains({ period: day('2020-01-01', null), asOf: asOf as string })).toThrow(RangeError);
  });
});

describe('ST-PERIOD-03 단일 원본 범위 안 명시 대체 preview', () => {
  const originalValue: Readonly<{ educationSystem: string; gradeCode: string }> = Object.freeze({ educationSystem: 'US', gradeCode: 'G3' });
  const newValue: typeof originalValue = Object.freeze({ educationSystem: 'US', gradeCode: 'G5' });

  it.each([
    ['2020-01-01', '2023-12-31', null, null],
    ['2020-01-01', '2021-12-31', null, ['2022-01-01', '2023-12-31']],
    ['2022-01-01', '2023-12-31', ['2020-01-01', '2021-12-31'], null],
    ['2021-01-01', '2021-12-31', ['2020-01-01', '2020-12-31'], ['2022-01-01', '2023-12-31']],
    ['2020-02-29', '2020-02-29', ['2020-01-01', '2020-02-28'], ['2020-03-01', '2023-12-31']],
  ] as const)('대체 %s~%s 뒤 앞뒤 원본 값과 날짜를 보존한다', (from, to, before, after) => {
    const out = previewStudentPeriodReplacement({
      original: { period: day('2020-01-01', '2023-12-31'), value: originalValue },
      replacement: { period: day(from, to), value: newValue },
    });
    expect(out.replacement).toEqual({ period: day(from, to), value: newValue });
    expect(out.before && [out.before.period.from, out.before.period.to]).toEqual(before);
    expect(out.after && [out.after.period.from, out.after.period.to]).toEqual(after);
    if (out.before) {
      expect(out.before.value).toBe(originalValue);
      expect(out.before.period.toDerived).toBe(true);
      expect(studentPeriodsOverlap({ left: out.before.period, right: out.replacement.period })).toBe(false);
    }
    if (out.after) {
      expect(out.after.value).toBe(originalValue);
      expect(out.after.period.fromDerived).toBe(true);
      expect(studentPeriodsOverlap({ left: out.after.period, right: out.replacement.period })).toBe(false);
    }
  });

  it('원래 precision을 원본에 남기고 계산한 경계만 day+derived로 바꾼다', () => {
    const originalPeriod = Object.freeze(normalizeStudentPeriod({ from: '2020', to: '2023', fromPrecision: 'year', toPrecision: 'year' }));
    const replacementPeriod = Object.freeze(normalizeStudentPeriod({ from: '2021-03', to: '2021-03', fromPrecision: 'month', toPrecision: 'month' }));
    const original = Object.freeze({ period: originalPeriod, value: originalValue });
    const replacement = Object.freeze({ period: replacementPeriod, value: newValue });
    const input = Object.freeze({ original, replacement });
    const snapshot = JSON.stringify(input);
    const out = previewStudentPeriodReplacement(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out.before!.period).toEqual({ from: '2020-01-01', to: '2021-02-28', fromPrecision: 'year', toPrecision: 'day', fromDerived: false, toDerived: true });
    expect(out.after!.period).toEqual({ from: '2021-04-01', to: '2023-12-31', fromPrecision: 'day', toPrecision: 'year', fromDerived: true, toDerived: false });
    expect(out.replacement.period).toEqual(replacementPeriod);
    expect(out.replacement.period).not.toBe(replacementPeriod);
    expect(out.replacement).not.toBe(replacement);
    expect(originalPeriod.fromPrecision).toBe('year');
  });

  it('이미 derived인 원본의 손대지 않은 경계 메타데이터도 유지한다', () => {
    const period = { ...day('2020-01-01', '2023-12-31'), fromDerived: true, toDerived: true };
    const out = previewStudentPeriodReplacement({
      original: { period, value: originalValue }, replacement: { period: day('2021-01-01', '2021-12-31'), value: newValue },
    });
    expect(out.before!.period.fromDerived).toBe(true);
    expect(out.after!.period.toDerived).toBe(true);
  });

  it.each([
    ['2020-01-01', '2021-12-31', false, true],
    ['2022-01-01', null, true, false],
    ['2021-01-01', '2021-12-31', true, true],
    ['2020-01-01', null, false, false],
  ] as const)('무기한 원본의 %s~%s 대체는 남는 무기한 꼬리를 보존한다', (from, to, hasBefore, hasAfter) => {
    const out = previewStudentPeriodReplacement({
      original: { period: day('2020-01-01', null), value: 'old' }, replacement: { period: day(from, to), value: 'new' },
    });
    expect(out.before !== null).toBe(hasBefore);
    expect(out.after !== null).toBe(hasAfter);
    if (out.after) expect(out.after.period.to).toBeNull();
  });

  it.each([
    ['2019-12-31', '2021-01-01'], ['2020-01-01', '2024-01-01'],
    ['2024-01-01', '2024-12-31'], ['2021-01-01', null],
  ] as const)('원본 밖 대체 %s~%s를 clamp하지 않는다', (from, to) => {
    expect(() => previewStudentPeriodReplacement({
      original: { period: day('2020-01-01', '2023-12-31'), value: 'old' }, replacement: { period: day(from, to), value: 'new' },
    })).toThrow(RangeError);
  });

  it('최소일/최대일 전체 대체는 불필요한 ±1을 계산하지 않는다', () => {
    for (const edge of ['0001-01-01', '9999-12-31']) {
      const period = day(edge, edge);
      expect(previewStudentPeriodReplacement({ original: { period, value: 1 }, replacement: { period, value: 2 } }))
        .toEqual({ before: null, replacement: { period, value: 2 }, after: null });
    }
  });

  it('유한 최대일은 무기한이 아니며 표현할 수 없는 10000년 잔여 구간은 거절한다', () => {
    expect(() => previewStudentPeriodReplacement({
      original: { period: day('2020-01-01', null), value: 'old' },
      replacement: { period: day('2021-01-01', '9999-12-31'), value: 'new' },
    })).toThrow(RangeError);
    const period = day('9999-12-31', null);
    expect(previewStudentPeriodReplacement({ original: { period, value: 1 }, replacement: { period, value: 2 } }).after).toBeNull();
  });
});

describe('ST-PERIOD-04 정규화 객체도 runtime 경계에서 검사한다', () => {
  const valid = (): StudentPeriod => day('2020-01-01', '2023-12-31');
  it.each([
    null, undefined, [], {},
    { from: '2020-01-01', to: null },
    { ...raw(), fromDerived: 'false', toDerived: false },
    { ...raw(), fromDerived: false, toDerived: undefined },
    { ...raw(), from: '2020-02-30', fromDerived: false, toDerived: false },
    { ...raw(), from: '2024-01-01', fromDerived: false, toDerived: false },
    { ...raw(), fromPrecision: 'week', fromDerived: false, toDerived: false },
    { ...raw(), from: '2020-02-01', fromPrecision: 'year', fromDerived: false, toDerived: false },
    { ...raw(), from: '2020-01-02', fromPrecision: 'month', fromDerived: false, toDerived: false },
    { ...raw(), to: '2023-12-30', toPrecision: 'year', fromDerived: false, toDerived: false },
    { ...raw(), to: '2023-02-27', toPrecision: 'month', fromDerived: false, toDerived: false },
    { ...raw(), fromPrecision: 'year', fromDerived: true, toDerived: false },
    { ...raw(), toPrecision: 'year', fromDerived: false, toDerived: true },
    { ...raw(), to: null, fromDerived: false, toDerived: false },
    { ...raw(), to: null, toPrecision: null, fromDerived: false, toDerived: true },
  ])('비정상 정규화 기간 %p는 포함/겹침/분할 어디서도 통과하지 않는다', input => {
    const period = input as StudentPeriod;
    expect(() => studentPeriodContains({ period, asOf: '2021-01-01' })).toThrow(RangeError);
    expect(() => studentPeriodsOverlap({ left: period, right: valid() })).toThrow(RangeError);
    expect(() => studentPeriodsOverlap({ left: valid(), right: period })).toThrow(RangeError);
    expect(() => previewStudentPeriodReplacement({ original: { period, value: 1 }, replacement: { period: valid(), value: 2 } })).toThrow(RangeError);
    expect(() => previewStudentPeriodReplacement({ original: { period: valid(), value: 1 }, replacement: { period, value: 2 } })).toThrow(RangeError);
  });

  it('함수 인자/period entry 자체가 없거나 배열이면 명시적 입력 오류다', () => {
    for (const invalid of [undefined, null, [], {}, { original: null, replacement: null }]) {
      expect(() => studentPeriodContains(invalid as Parameters<typeof studentPeriodContains>[0])).toThrow(RangeError);
      expect(() => studentPeriodsOverlap(invalid as Parameters<typeof studentPeriodsOverlap>[0])).toThrow(RangeError);
      expect(() => previewStudentPeriodReplacement(invalid as unknown as Parameters<typeof previewStudentPeriodReplacement>[0])).toThrow(RangeError);
    }
    const missingValue = { original: { period: valid() }, replacement: { period: valid(), value: 2 } };
    expect(() => previewStudentPeriodReplacement(missingValue as Parameters<typeof previewStudentPeriodReplacement>[0])).toThrow(RangeError);
  });
});

describe('ST-PERIOD-05 KST 기준일은 기존 todayKst를 따른다', () => {
  afterEach(() => jest.useRealTimers());

  it('기본 asOf는 KST 자정에 바뀌고 명시적 과거/미래 조회를 덮지 않는다', () => {
    const period = day('2026-10-01', '2026-10-01');
    jest.useFakeTimers().setSystemTime(new Date('2026-09-30T14:59:59.999Z'));
    expect(studentPeriodContains({ period })).toBe(false);
    jest.setSystemTime(new Date('2026-09-30T15:00:00.000Z'));
    expect(studentPeriodContains({ period })).toBe(true);
    expect(studentPeriodContains({ period, asOf: '2026-09-30' })).toBe(false);
    expect(studentPeriodContains({ period, asOf: '2026-10-02' })).toBe(false);
    expect(studentPeriodContains({ period, asOf: '2026-10-01' })).toBe(true);
  });
});
