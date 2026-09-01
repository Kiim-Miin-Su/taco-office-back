import { addD } from '../src/lib/recurrence';
import { effectiveRepState } from '../src/lib/rules';
import { SEED_TODAY } from '../src/seed/base';
import { buildReports } from '../src/seed/outputs';
import type { OccSeed } from '../src/seed/schedule';

const occurrence = (over: Partial<OccSeed> = {}): OccSeed => ({
  serId: 1,
  onDate: SEED_TODAY,
  teacherId: 6,
  roomId: 1,
  zaccId: null,
  canceled: false,
  startMin: 16 * 60,
  endMin: 17 * 60,
  kindKey: 'class',
  subKey: 'ap-chem',
  students: [1],
  ...over,
});

describe('리포트 상태 — 캘린더 색상의 단일 진실원', () => {
  it('오래된 미작성 상태는 현재 시각으로 방어하고 작성 상태는 보존한다', () => {
    const session = { date: SEED_TODAY, startMin: 16 * 60, durationMin: 60 };

    expect(effectiveRepState('na', session, true, SEED_TODAY, 15 * 60)).toBe('plan');
    expect(effectiveRepState('none', session, true, SEED_TODAY, 17 * 60)).toBe('none');
    expect(effectiveRepState('wait', session, true, SEED_TODAY, 15 * 60)).toBe('wait');
    expect(effectiveRepState('plan', session, false, SEED_TODAY, 15 * 60)).toBe('na');
  });

  it('미래 수업은 예정(plan)이다', () => {
    const [report] = buildReports(
      [occurrence({ onDate: addD(SEED_TODAY, 1) })],
      () => 'ko',
      10 * 60,
    );

    expect(report?.state).toBe('plan');
    expect(report?.body).toEqual({});
  });

  it('오늘 수업은 종료 전 plan, 종료 후 none으로 전이한다', () => {
    const before = buildReports([occurrence()], () => 'ko', 15 * 60);
    const after = buildReports([occurrence()], () => 'ko', 17 * 60);

    expect(before[0]?.state).toBe('plan');
    expect(after[0]?.state).toBe('none');
  });

  it('리포트 대상 여부는 종류 코드표를 따른다', () => {
    const reports = buildReports([
      occurrence({ serId: 1, kindKey: 'class' }),
      occurrence({ serId: 2, kindKey: 'consult' }),
      occurrence({ serId: 3, kindKey: 'study' }),
      occurrence({ serId: 4, kindKey: 'meeting' }),
    ], () => 'ko', 15 * 60);

    expect(reports.map((report) => report.serId)).toEqual([1]);
  });
});
