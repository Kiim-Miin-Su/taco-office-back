/** @file-guide
 * 목적: consulting-rules.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { consultingCloseIssue, consultingRecordIssue, consultingSessionAddIssue, consultingSessionDone, consultingSessionIssue } from '../src/modules/consulting/consulting.rules';

describe('§26 컨설팅 순수 불변식', () => {
  const record = { stage: 'contract', contractStep: null, sessions: null };

  it('계약 미정과 정상 경계값을 허용한다', () => {
    expect(consultingRecordIssue(record)).toBeNull();
    for (const stage of ['contract', 'running', 'done']) {
      for (const sessions of [null, 1, 32767]) {
        expect(consultingRecordIssue({ stage, contractStep: 5, sessions })).toBeNull();
      }
    }
    expect(consultingRecordIssue({ ...record, contractStep: 1 })).toBeNull();
  });

  it.each(['', 'unknown', null, undefined])('오염된 stage %p를 차단한다', (stage) => {
    expect(consultingRecordIssue({ ...record, stage })).toBe('invalid_stage');
  });

  it.each([0, -1, 6, 1.5, NaN, Infinity, '5', undefined])('오염된 step %p를 차단한다', (contractStep) => {
    expect(consultingRecordIssue({ ...record, contractStep })).toBe('invalid_contract_step');
  });

  it.each(['running', 'done'])('%s는 NULL을 포함해 수납 전 단계를 차단한다', (stage) => {
    for (const contractStep of [null, 1, 2, 3, 4]) {
      expect(consultingRecordIssue({ ...record, stage, contractStep })).toBe('unpaid_stage');
    }
  });

  it.each([0, -1, 32768, 1.5, NaN, Infinity, '1', undefined])('전체 회차 %p를 차단한다', (sessions) => {
    expect(consultingRecordIssue({ ...record, sessions })).toBe('invalid_sessions');
  });

  it('회차 순번은 양의 smallint이며 건별로 중복될 수 없다', () => {
    expect(consultingSessionIssue([])).toBeNull();
    expect(consultingSessionIssue([1, 32767])).toBeNull();
    expect(consultingSessionIssue([1, 1])).toBe('duplicate_session_seq');
    for (const seq of [null, undefined, 0, -1, 32768, 1.5, NaN, Infinity, '1']) {
      expect(consultingSessionIssue([seq])).toBe('invalid_session_seq');
    }
  });
});

/** C95 — 종료 판정은 N-18 채택문 그대로다: 「필수 항목과 약정 회차 완료 후 명시 종료」. 화면은 이 문장을 그대로 띄운다 */
describe('§31 회차 · 종료 판정 (C95 · I-91 · I-95 · N-18 채택)', () => {
  it('오늘 이하(또는 미정) 날짜만 「한 회차」다 — 앞으로 잡아 둔 날짜는 기록이지 완료가 아니다', () => {
    expect(consultingSessionDone('2026-09-17', '2026-09-18')).toBe(true);
    expect(consultingSessionDone('2026-09-18', '2026-09-18')).toBe(true);
    expect(consultingSessionDone(null, '2026-09-18')).toBe(true);
    expect(consultingSessionDone('2026-09-19', '2026-09-18')).toBe(false);
  });
  it('회차는 진행 중인 건에만 잡는다', () => {
    expect(consultingSessionAddIssue('running')).toBeNull();
    expect(consultingSessionAddIssue('contract')?.code).toBe('CONS_NOT_RUNNING');
    expect(consultingSessionAddIssue('done')?.code).toBe('CONS_LOCKED');
  });
  it('종료는 필수 항목이 0 · 약정 회차를 채웠을 때만 — 순서대로 막힌 이유 하나를 말한다', () => {
    expect(consultingCloseIssue({ stage: 'running', sessions: 3, sessionsDone: 3, requiredLeft: 0 })).toBeNull();
    expect(consultingCloseIssue({ stage: 'running', sessions: null, sessionsDone: 0, requiredLeft: 0 })).toBeNull();
    expect(consultingCloseIssue({ stage: 'running', sessions: 3, sessionsDone: 5, requiredLeft: 0 })).toBeNull();
    expect(consultingCloseIssue({ stage: 'running', sessions: 3, sessionsDone: 3, requiredLeft: 2 })).toMatchObject({ code: 'CONS_ITEMS_LEFT', message: expect.stringContaining('필수 항목 2개') });
    expect(consultingCloseIssue({ stage: 'running', sessions: 3, sessionsDone: 1, requiredLeft: 0 })).toMatchObject({ code: 'CONS_SESSIONS_LEFT', message: expect.stringContaining('남은 2회') });
    expect(consultingCloseIssue({ stage: 'contract', sessions: 3, sessionsDone: 3, requiredLeft: 0 })?.code).toBe('CONS_NOT_RUNNING');
    expect(consultingCloseIssue({ stage: 'done', sessions: 3, sessionsDone: 3, requiredLeft: 0 })?.code).toBe('CONS_ALREADY_DONE');
  });
});
