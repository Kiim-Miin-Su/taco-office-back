/** @file-guide
 * 목적: lead-care-words.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 등록 뒤 사후 관리의 날짜 · 낱말 (W11 · N-86 · DQ2 권장안) — `lib/intake-words` 한 곳의 순수 함수.
 *
 *   · 월간은 **기준일(첫 실제 수업)과 같은 날**, 그 날이 없는 달은 말일 — 기준일의 날을 매번 새로 댄다(1/31 → 2/28 → 3/31)
 *   · 휴원 중이면 **복귀 뒤로** · 복귀일을 모르는 휴원이면 날을 짓지 않는다 · 수강이 끝났으면 **멈춘다**
 *   · 카드 줄은 원문 §23 컷의 낱말 그대로 — 「해피콜 완료 08-15」 · 「월간 완료」 · 「08-24 예정」 · 띠 「해피콜 D-3」 · 「정기 관리 중」
 */
import {
  addMonths, leadAftercareRows, leadCareDue, leadCareTitle, leadMonthlyNextOn, leadMonthlyOn,
} from '../src/lib/intake-words';

const ZERO = { inv: 0, bookOk: 0, bookWait: 0, guideSent: 0, guideDraft: 0 };

describe('사후 관리 날짜 (N-86 · DQ2)', () => {
  it('달 더하기는 해를 넘는다', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-09', 14)).toBe('2027-11');
  });

  it('월간은 기준일과 같은 날 — 없으면 그 달 말일 · 앞 달의 말일에서 잇지 않는다', () => {
    expect(leadMonthlyOn('2027-01-31', '2027-02')).toBe('2027-02-28');
    expect(leadMonthlyOn('2027-01-31', '2027-03')).toBe('2027-03-31');
    expect(leadMonthlyOn('2027-01-30', '2028-02')).toBe('2028-02-29');
    expect(leadMonthlyOn('2026-09-05', '2026-10')).toBe('2026-10-05');
  });

  it('다음 월간 — 끝낸 달의 다음 달 같은 날', () => {
    expect(leadMonthlyNextOn('2026-09-15', '2026-09', [], null)).toEqual({ on: '2026-10-15' });
    // 늦게 끝내도 그 달의 약속에서 잇는다 — 부르는 쪽이 끝낸 월간의 달을 넘긴다
    expect(leadMonthlyNextOn('2026-09-15', '2026-11', [], null)).toEqual({ on: '2026-12-15' });
  });

  it('수강이 끝났으면 멈춘다 — 끝난 뒤의 날이면 null · 수강 줄이 아예 없어도 null', () => {
    expect(leadMonthlyNextOn('2026-09-15', '2026-09', [], '2026-10-10')).toBeNull();
    expect(leadMonthlyNextOn('2026-09-15', '2026-09', [], '2026-10-15')).toEqual({ on: '2026-10-15' });
    expect(leadMonthlyNextOn('2026-09-15', '2026-09', [], undefined)).toBeNull();
  });

  it('휴원 중이면 복귀 뒤의 첫 「같은 날」로 민다 — 복귀 달의 같은 날이 복귀 전이면 그다음 달', () => {
    expect(leadMonthlyNextOn('2026-09-15', '2026-09', [{ from: '2026-10-01', to: '2026-11-20' }], null)).toEqual({ on: '2026-12-15' });
    expect(leadMonthlyNextOn('2026-09-15', '2026-09', [{ from: '2026-10-01', to: '2026-11-10' }], null)).toEqual({ on: '2026-11-15' });
    // 휴원 끝이 그날이면 아직 휴원이다(끝 날 포함)
    expect(leadMonthlyNextOn('2026-09-15', '2026-09', [{ from: '2026-10-01', to: '2026-10-15' }], null)).toEqual({ on: '2026-11-15' });
    // 휴원이 그 날을 덮지 않으면 그대로
    expect(leadMonthlyNextOn('2026-09-15', '2026-09', [{ from: '2026-10-16', to: '2026-10-30' }], null)).toEqual({ on: '2026-10-15' });
  });

  it('복귀일을 모르는 휴원이면 날을 짓지 않는다 — 할 일은 서고 날은 비운다', () => {
    expect(leadMonthlyNextOn('2026-09-15', '2026-09', [{ from: '2026-10-01', to: null }], null)).toEqual({ on: null });
  });

  it('휴원이 끝나기 전에 수강이 끝나면 멈춘다', () => {
    expect(leadMonthlyNextOn('2026-09-15', '2026-09', [{ from: '2026-10-01', to: '2026-12-31' }], '2026-11-30')).toBeNull();
  });
});

describe('사후 관리 낱말 (N-86 · 원문 §23 등록 카드)', () => {
  const TODAY = '2026-08-21';

  it('할 일 제목 — 「해피콜 — 이름」 · 「월간 상담 — 이름」', () => {
    expect(leadCareTitle('happycall', '박시온')).toBe('해피콜 — 박시온');
    expect(leadCareTitle('monthly', '박시온')).toBe('월간 상담 — 박시온');
  });

  it('카드 줄 — 해피콜 · 월간이 앞에 서고 컷의 낱말 그대로', () => {
    const rows = leadAftercareRows(ZERO, { happy: { due: '2026-08-15', done: true }, firstMonthly: { due: '2026-09-08', done: true } });
    expect(rows.map((r) => [r.label, r.value, r.done])).toEqual([
      ['해피콜', '완료 08-15', true], ['월간', '완료', true], ['청구서', '없음', false], ['교재', '없음', false], ['안내', '없음', false],
    ]);
    const open = leadAftercareRows(ZERO, { happy: { due: '2026-08-24', done: false }, firstMonthly: { due: null, done: false } });
    expect(open.slice(0, 2).map((r) => r.value)).toEqual(['08-24 예정', '날짜 미정']);
  });

  it('할 일이 없는 옛 등록 건은 「없음」 — 한 적 없는 것을 「완료」로 짓지 않는다 (N-25)', () => {
    expect(leadAftercareRows(ZERO).slice(0, 2).map((r) => [r.key, r.value, r.done])).toEqual([['happycall', '없음', false], ['monthly', '없음', false]]);
  });

  it('띠 — 남은 해피콜 → 첫 월간 → 「정기 관리 중」 · 할 일이 없으면 띠가 없다', () => {
    expect(leadCareDue({ happy: { due: '2026-08-24', done: false }, firstMonthly: { due: '2026-09-17', done: false } }, TODAY))
      .toEqual({ task: '해피콜', dueOn: '2026-08-24', dueLabel: 'D-3', tone: 'neutral' });
    expect(leadCareDue({ happy: { due: '2026-08-14', done: true }, firstMonthly: { due: '2026-08-19', done: false } }, TODAY))
      .toEqual({ task: '월간 상담', dueOn: '2026-08-19', dueLabel: '2일 지남', tone: 'danger' });
    expect(leadCareDue({ happy: { due: '2026-08-14', done: true }, firstMonthly: { due: TODAY, done: false } }, TODAY))
      .toMatchObject({ dueLabel: '오늘', tone: 'warning' });
    expect(leadCareDue({ happy: { due: '2026-08-14', done: true }, firstMonthly: { due: null, done: false } }, TODAY))
      .toEqual({ task: '월간 상담', dueOn: null, dueLabel: null, tone: 'neutral' });
    expect(leadCareDue({ happy: { due: '2026-08-14', done: true }, firstMonthly: { due: '2026-08-19', done: true } }, TODAY))
      .toEqual({ task: '정기 관리 중', dueOn: null, dueLabel: null, tone: 'neutral' });
    expect(leadCareDue({ happy: null, firstMonthly: null }, TODAY)).toBeNull();
  });
});
