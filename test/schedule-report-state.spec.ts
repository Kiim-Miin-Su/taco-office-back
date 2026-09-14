/** @file-guide
 * 목적: schedule-report-state.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ScheduleService } from '../src/modules/schedule/schedule.service';

const row = (over: Record<string, unknown> = {}) => ({
  ser_id: '1',
  date: '2999-09-01',
  on_date: '2999-09-01',
  start_min: 16 * 60,
  end_min: 17 * 60,
  kind_key: 'class',
  sub_key: 'ap-chem',
  title: null,
  mode: 'offline',
  reportable: true,
  rrule: 'ONCE',
  ser_from: '2999-09-01',
  ser_to: null,
  teacher_id: '6',
  teacher_name: '이다현',
  room_id: '1',
  room_name: '2층 A강의실',
  zacc_id: null,
  canceled: false,
  has_exception: false,
  rep_state: 'na',
  students: [{ id: 1, name: '학생', grade: null, droppedOnce: false }],
  ...over,
});

describe('ScheduleService 리포트 상태 계약', () => {
  it('학생별 조회는 그날만 빠진 학생을 EXC_STU_OUT에서 제외한다', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new ScheduleService({ query } as never);

    await service.list({ from: '2026-09-01', to: '2026-09-01', studentId: 7 });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('FROM exc e2 JOIN exc_stu_out xo');
    expect(sql).toContain('e2.on_date = o.on_date');
    expect(sql).toContain('xo.student_id = ss.student_id');
  });

  it('오래된 na와 REP 없는 회차도 종류·시각 기준 유효 상태로 내려준다', async () => {
    const query = jest.fn().mockResolvedValue([
      row(),
      row({ ser_id: '2', kind_key: 'study', reportable: false, rep_state: null }),
    ]);
    const service = new ScheduleService({ query } as never);

    const items = await service.list({ from: '2999-09-01', to: '2999-09-01' });

    expect(items.map(({ repState }) => repState)).toEqual(['plan', 'na']);
    expect(items.every(({ written }) => written === false)).toBe(true);
    expect(String(query.mock.calls[0]?.[0])).toContain('JOIN kind k');
  });

  /**
   * `ended` 는 화면의 「리포트 미제출」이 서 있는 바닥이다 (N-19 · v2 §09).
   * 「썼다」는 **제출부터**라(rules.ts REPORT_WRITTEN) 끝난 수업의 **초안**도 미제출인데,
   * `repState` 는 draft 가 끝난 것인지 말해 주지 않는다. 그래서 사실 하나를 따로 내려보낸다.
   */
  it('ended 는 끝난 회차에만 참이고 리포트 상태와 같은 판정에서 나온다', async () => {
    const past = { date: '2000-01-01', on_date: '2000-01-01', ser_from: '2000-01-01' };
    const query = jest.fn().mockResolvedValue([
      row(),
      row({ ser_id: '2', ...past }),
      row({ ser_id: '3', ...past, rep_state: 'draft' }),
      row({ ser_id: '4', ...past, reportable: false }),
    ]);
    const service = new ScheduleService({ query } as never);

    const items = await service.list({ from: '2000-01-01', to: '2999-09-01' });

    expect(items.map(({ ended }) => ended)).toEqual([false, true, true, true]);
    // 같은 판정에서 나온다 — 끝나지 않았으면 plan, 끝났으면 none 이다
    expect(items.map(({ repState }) => repState)).toEqual(['plan', 'none', 'draft', 'na']);
    // **끝난 초안은 아직 안 쓴 것이다** — 미제출에서 빠지면 안 된다
    expect(items.map(({ written }) => written)).toEqual([false, false, false, false]);
  });
});
