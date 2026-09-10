/** @file-guide
 * 목적: schedule-references.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import type { QueryRunner } from 'typeorm';
import { assertScheduleReferences } from '../src/modules/schedule/schedule.references';
import { applyCreate, applyEdit, applyRoster, type State } from '../src/lib/recurrence';

const initial = (): State => applyCreate({ SER: [], SER_STU: [], EXC: [] }, { draft: {
  kind: 'class', sub: null, mode: 'offline', teacherId: null, roomId: null,
  startMin: 600, endMin: 660, date: '2026-09-11', students: [1, 2],
} });
const runner = () => {
  const query = jest.fn(async (_sql: string, params: string[][]) => params[0].map(value => ({ value })));
  return { query, q: { query } as unknown as QueryRunner };
};

it('빈 최종 State는 삭제를 막지 않고 참조 SELECT도 하지 않는다', async () => {
  const { q, query } = runner();
  await assertScheduleReferences(q, { SER: [], SER_STU: [], EXC: [] });
  expect(query).not.toHaveBeenCalled();
});

it('null은 조회하지 않고 정식/회차 제외 학생은 한 번에 중복 제거한다', async () => {
  const { q, query } = runner();
  const state = initial();
  const after = applyRoster(state, { serId: state.SER[0].id, onDate: '2026-09-11', studentId: 1, op: 'dropOnce' });
  await assertScheduleReferences(q, after);
  expect(query).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining('FROM stu'), [['1', '2']]);
  for (const [sql] of query.mock.calls) expect(sql).toMatch(/ORDER BY .+ FOR KEY SHARE$/);
});

it('SER에는 없지만 EXC에 지정한 강사/강의실도 검증한다', async () => {
  const { q, query } = runner();
  const state = initial();
  state.SER[0].rrule = 'WEEKLY:FR';
  state.SER[0].toDate = null;
  const after = applyEdit(state, { serId: state.SER[0].id, onDate: '2026-09-11', scope: 'this', patch: { teacherId: 3, roomId: 4 } });
  expect(after.SER[0]).toMatchObject({ teacherId: null, roomId: null });
  expect(after.EXC[0]).toMatchObject({ teacherId: 3, roomId: 4 });
  await assertScheduleReferences(q, after);
  expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM staff'), [['3']]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM room'), [['4']]);
});

it('회차 제외 명단에만 남은 고아 학생을 저장 성공으로 넘기지 않는다', async () => {
  const { q, query } = runner();
  const state = initial();
  const after = applyRoster(state, { serId: state.SER[0].id, onDate: '2026-09-11', studentId: 1, op: 'dropOnce' });
  after.EXC[0].stuOut = [999];
  query.mockImplementation(async (_sql, params) => params[0].filter(value => value !== '999').map(value => ({ value })));
  await expect(assertScheduleReferences(q, after)).rejects.toMatchObject({ response: { code: 'REFERENCE_NOT_FOUND' }, status: 400 });
});
