/** @file-guide
 * 목적: schedule-rule-input.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import type { DataSource } from 'typeorm';
import { ScheduleWriteService } from '../src/modules/schedule/schedule.write.service';
import { formatRule, lessonTimeIssue, parseRuleInput } from '../src/lib/recurrence';

const create = { kindKey: 'meeting', mode: 'offline' as const, fromDate: '2026-09-11', startMin: 600, endMin: 660 };

describe('일정 반복 입력을 다른 규칙으로 바꾸어 저장하지 않는다', () => {
  it.each([
    ['ONCE', 'ONCE'], [' once ', 'ONCE'], ['daily/1', 'DAILY'], ['DAILY/003', 'DAILY/3'],
    [' weekly:we, mo/02 ', 'WEEKLY:MO,WE/2'], ['WEEKLY:SA,SU,FR,TH,WE,TU,MO', 'WEEKLY:SU,MO,TU,WE,TH,FR,SA'],
    ['DAILY/9007199254740991', 'DAILY/9007199254740991'],
  ])('%j는 기존 정규화 %s를 보존한다', (input, expected) => {
    const parsed = parseRuleInput(input);
    expect(parsed).not.toBeNull();
    expect(formatRule(parsed!)).toBe(expected);
  });
  it('문자열 아닌 값은 단발 기본값으로 바꾸지 않는다', () => {
    for (const input of [null, undefined, 1, {}, ['ONCE']]) expect(parseRuleInput(input)).toBeNull();
  });
  it.each(['', ' ', 'DAILYjunk', 'DAILY:MO', 'MONTHLY:MO', 'WEEKLY:MO,XX', 'WEEKLY:MO,',
    'WEEKLY:MO:WE', 'WEEKLY:MO/2/3', 'DAILY/0', 'DAILY/-2', 'DAILY/2junk', 'DAILY/1.5',
    'DAILY/1e2', 'DAILY/', 'DAILY/9007199254740992', 'WEEKLY:MO/0', 'ONCE/2'])('%j는 transaction 전에 BAD_RRULE', async rrule => {
    const ds = { createQueryRunner: jest.fn() };
    const service = new ScheduleWriteService(ds as unknown as DataSource);
    await expect(service.create({ ...create, rrule })).rejects.toMatchObject({ response: { code: 'BAD_RRULE' } });
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
  });
});

describe('공용 시간 방어는 HTTP 밖에서도 정수 분을 보장한다', () => {
  it.each([[NaN, 660], [600, NaN], [600.5, 660], [600, 660.5], [Infinity, Infinity], [-Infinity, 600]])(
    '%s~%s 거절', (start, end) => { expect(lessonTimeIssue(start, end)).not.toBeNull(); },
  );
  it.each([[0, 10], [600, 1080], [1430, 1440]])('%s~%s 기존 경계 허용', (start, end) => {
    expect(lessonTimeIssue(start, end)).toBeNull();
  });
});
