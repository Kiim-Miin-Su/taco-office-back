import {
  boardRangeIssue,
  boardSummary,
  type BoardSourceRow,
} from '../src/modules/board/board.rules';

const row = (
  onDate: string,
  marks: Array<{ key: string; done: boolean; na?: boolean }>,
  overrides: Partial<BoardSourceRow> = {},
): BoardSourceRow => ({
  teacherId: 10,
  teacherName: '김강사',
  date: onDate,
  onDate,
  canceled: false,
  marks: marks.map((mark) => ({ ...mark, na: mark.na ?? false })),
  ...overrides,
});

describe('boardRangeIssue', () => {
  it('실제 날짜와 최대 62일 범위만 허용한다', () => {
    expect(boardRangeIssue('2026-08-01', '2026-10-01')).toBeNull();
    expect(boardRangeIssue('2026-02-30', '2026-03-01')).toContain('실제');
    expect(boardRangeIssue('2026-08-02', '2026-08-01')).toContain('뒤');
    expect(boardRangeIssue('2026-08-01', '2026-10-02')).toContain('62일');
  });
});

describe('boardSummary', () => {
  it('취소와 N/A를 분모에서 빼고 강사·요일·주차를 같은 규칙으로 집계한다', () => {
    const result = boardSummary([
      row('2026-09-01', [
        { key: 'book', done: true },
        { key: 'guide', done: true },
        { key: 'zoom', done: false, na: true },
        { key: 'report', done: false },
      ]),
      row('2026-09-01', [
        { key: 'book', done: true },
        { key: 'guide', done: true },
        { key: 'zoom', done: true },
        { key: 'report', done: true },
      ]),
      row(
        '2026-09-08',
        [
          { key: 'book', done: false },
          { key: 'guide', done: false },
          { key: 'zoom', done: false },
          { key: 'report', done: false },
        ],
        { canceled: true },
      ),
      row(
        '2026-09-02',
        [
          { key: 'book', done: true },
          { key: 'guide', done: true },
          { key: 'zoom', done: false, na: true },
          { key: 'report', done: true },
        ],
        { teacherId: null, teacherName: null },
      ),
    ]);

    expect(result.summary).toEqual({
      lessons: 3,
      marks: [
        { key: 'book', done: 3, total: 3, missing: 0 },
        { key: 'guide', done: 3, total: 3, missing: 0 },
        { key: 'zoom', done: 1, total: 1, missing: 0 },
        { key: 'report', done: 2, total: 3, missing: 1 },
      ],
      missing: 1,
      completionRate: 90,
    });
    expect(result.weeks).toHaveLength(1);
    expect(result.weeks[0]).toMatchObject({
      from: '2026-08-31',
      to: '2026-09-06',
      label: '9월 1주',
      lessons: 3,
      missing: 1,
    });

    const teacher = result.teacherRows.find((item) => item.teacherId === 10);
    expect(teacher?.days[0]).toMatchObject({ date: '2026-09-01', lessons: 2, missing: 1 });
    expect(teacher?.days[0].marks.find((mark) => mark.key === 'report')).toMatchObject({
      done: false,
      na: false,
      note: '1건 덜 됨',
    });
    expect(result.teacherRows.find((item) => item.teacherId === null)?.teacherName).toBe('미배정');
  });

  it('판정 대상이 없으면 100%이며 일자 마크는 N/A다', () => {
    const result = boardSummary([
      row('2026-09-01', [
        { key: 'book', done: false, na: true },
        { key: 'guide', done: false, na: true },
        { key: 'zoom', done: false, na: true },
        { key: 'report', done: false, na: true },
      ]),
    ]);

    expect(result.summary.completionRate).toBe(100);
    expect(result.summary.missing).toBe(0);
    expect(result.teacherRows[0].days[0].marks.every((mark) => mark.na)).toBe(true);
  });
});
