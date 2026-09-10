/** @file-guide
 * 목적: consulting-rules.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { consultingRecordIssue, consultingSessionIssue } from '../src/modules/consulting/consulting.rules';

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
