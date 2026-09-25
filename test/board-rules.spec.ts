/** @file-guide
 * 목적: board-rules.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

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
      // 원본 §34 머리의 「3/20 다 됐음」과 「0 휴강」 — 마크 합계가 아니라 **수업 단위**다
      doneLessons: 2,
      canceled: 1,
    });
    // 「다 됐음」은 **네 축이 전부 선 수업**만 센다 — 리포트 하나가 빈 수업은 빠진다
    expect(result.summary.doneLessons).toBeLessThan(result.summary.lessons);
    // 휴강은 lessons 에 안 들어 있다 — 두 수를 더해야 그날의 전부가 된다 (넣은 행은 넷)
    expect(result.summary.lessons + result.summary.canceled).toBe(4);

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

  /**
   * §35 요일 머리 「월 17 · 6 남음」과 §36 달력 칸(건수 · N 남음 · 과목색 점)은 **날짜 하나**의 집계다.
   * 화면이 rows 를 다시 세지 않게 서버가 `days[]` 로 준다 (D-R37 · N-19).
   */
  it('날짜별 집계 days[] — 수업 수 · 남은 수 · 휴강 · 과목 키(처음 나온 순서, 겹침 없음)', () => {
    const all = (done: boolean) => [
      { key: 'book', done },
      { key: 'guide', done },
      { key: 'zoom', done: false, na: true },
      { key: 'report', done },
    ];
    const result = boardSummary([
      row('2026-09-02', all(true), { subKey: 'vocab' }),
      row('2026-09-01', all(true), { subKey: 'writing' }),
      row('2026-09-01', all(false), { subKey: 'vocab' }),
      row('2026-09-01', all(true), { subKey: 'writing' }),
      row('2026-09-01', all(false), { subKey: 'sat_math', canceled: true }),
      row('2026-09-03', all(false), { subKey: null, canceled: true }),
    ]);

    expect(result.days).toEqual([
      { date: '2026-09-01', lessons: 3, remaining: 1, canceled: 1, subKeys: ['writing', 'vocab'] },
      { date: '2026-09-02', lessons: 1, remaining: 0, canceled: 0, subKeys: ['vocab'] },
      // 휴강만 있는 날도 칸이 선다 — 「0 · 휴강 1」
      { date: '2026-09-03', lessons: 0, remaining: 0, canceled: 1, subKeys: [] },
    ]);
    // 날짜 합 = 머리 칸의 수 (한 화면의 두 숫자가 갈리지 않는다)
    expect(result.days.reduce((sum, day) => sum + day.lessons, 0)).toBe(result.summary.lessons);
    expect(result.days.reduce((sum, day) => sum + day.canceled, 0)).toBe(result.summary.canceled);
    expect(result.days.reduce((sum, day) => sum + day.remaining, 0)).toBe(
      result.summary.lessons - result.summary.doneLessons,
    );
  });
});
