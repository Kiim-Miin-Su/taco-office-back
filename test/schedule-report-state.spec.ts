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
  teacher_name: '김서영',
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
});
