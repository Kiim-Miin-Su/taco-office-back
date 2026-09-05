/** 수업 현황판의 네 판정 축. DTO·집계·화면 범례가 이 순서를 공유한다. */
export const BOARD_MARK_KEYS = ['book', 'guide', 'zoom', 'report'] as const;
export type BoardMarkKey = (typeof BOARD_MARK_KEYS)[number];

export const BOARD_MAX_RANGE_DAYS = 62;

export interface BoardMarkValue {
  key: string;
  done: boolean;
  na: boolean;
  note?: string | null;
}

export interface BoardSourceRow {
  teacherId: number | null;
  teacherName: string | null;
  /** 실제 span 날짜. 이동 예외 뒤에도 화면과 집계가 이 날짜를 쓴다. */
  date: string;
  onDate: string;
  canceled: boolean;
  marks: BoardMarkValue[];
}

export interface BoardMarkCount {
  key: BoardMarkKey;
  done: number;
  total: number;
  missing: number;
}

const DAY_MS = 86_400_000;

function dateMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function isIsoDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const ms = dateMs(iso);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso;
}

/** query DTO 형식뿐 아니라 실제 날짜·순서·화면 범위도 한 곳에서 방어한다. */
export function boardRangeIssue(from: string, to: string): string | null {
  if (!isIsoDate(from) || !isIsoDate(to)) return 'from · to 는 실제 YYYY-MM-DD 날짜여야 합니다';
  if (from > to) return 'from 이 to 보다 뒤입니다';
  const days = Math.floor((dateMs(to) - dateMs(from)) / DAY_MS) + 1;
  if (days > BOARD_MAX_RANGE_DAYS) return `현황판 조회는 최대 ${BOARD_MAX_RANGE_DAYS}일입니다`;
  return null;
}

function addDays(iso: string, days: number): string {
  return new Date(dateMs(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

function mondayOf(iso: string): string {
  const day = new Date(dateMs(iso)).getUTCDay();
  return addDays(iso, day === 0 ? -6 : 1 - day);
}

function markCounts(rows: readonly BoardSourceRow[]): BoardMarkCount[] {
  return BOARD_MARK_KEYS.map((key) => {
    let done = 0;
    let total = 0;
    for (const row of rows) {
      const mark = row.marks.find((item) => item.key === key);
      if (!mark || mark.na) continue;
      total += 1;
      if (mark.done) done += 1;
    }
    return { key, done, total, missing: total - done };
  });
}

function missingOf(counts: readonly BoardMarkCount[]): number {
  return counts.reduce((sum, item) => sum + item.missing, 0);
}

function aggregateMarks(rows: readonly BoardSourceRow[]): BoardMarkValue[] {
  return markCounts(rows).map((item) => ({
    key: item.key,
    done: item.total > 0 && item.missing === 0,
    na: item.total === 0,
    note: item.total === 0 ? '판정 대상 없음' : item.missing > 0 ? `${item.missing}건 덜 됨` : null,
  }));
}

function weekLabel(rows: readonly BoardSourceRow[], weekStart: string): string {
  const representative = rows[0]?.date ?? weekStart;
  const monthStart = `${representative.slice(0, 7)}-01`;
  const index = Math.floor((dateMs(weekStart) - dateMs(mondayOf(monthStart))) / (7 * DAY_MS)) + 1;
  return `${Number(representative.slice(5, 7))}월 ${Math.max(1, index)}주`;
}

/**
 * 회차별 clChk 결과를 §35 강사×요일과 §36 월 KPI/주차 표로 합성한다.
 * 취소 회차와 N/A 마크는 분모에서 제외하며 어떤 집계도 DB에 저장하지 않는다 (D-R4).
 */
export function boardSummary(rows: readonly BoardSourceRow[]) {
  const active = rows.filter((row) => !row.canceled);
  const summaryMarks = markCounts(active);
  const total = summaryMarks.reduce((sum, item) => sum + item.total, 0);
  const done = summaryMarks.reduce((sum, item) => sum + item.done, 0);

  const teacherGroups = new Map<string, BoardSourceRow[]>();
  for (const row of active) {
    const key = row.teacherId === null ? 'none' : String(row.teacherId);
    const group = teacherGroups.get(key) ?? [];
    group.push(row);
    teacherGroups.set(key, group);
  }
  const teacherRows = [...teacherGroups.values()]
    .map((teacherLessons) => {
      const dateGroups = new Map<string, BoardSourceRow[]>();
      for (const row of teacherLessons) {
        const group = dateGroups.get(row.date) ?? [];
        group.push(row);
        dateGroups.set(row.date, group);
      }
      return {
        teacherId: teacherLessons[0]?.teacherId ?? null,
        teacherName: teacherLessons[0]?.teacherName ?? '미배정',
        days: [...dateGroups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, dayRows]) => ({
            date,
            lessons: dayRows.length,
            marks: aggregateMarks(dayRows),
            missing: missingOf(markCounts(dayRows)),
          })),
        missing: missingOf(markCounts(teacherLessons)),
      };
    })
    .sort((a, b) => a.teacherName.localeCompare(b.teacherName, 'ko'));

  const weekGroups = new Map<string, BoardSourceRow[]>();
  for (const row of active) {
    const key = mondayOf(row.date);
    const group = weekGroups.get(key) ?? [];
    group.push(row);
    weekGroups.set(key, group);
  }
  const weeks = [...weekGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, weekRows]) => {
      const marks = markCounts(weekRows);
      return {
        from: weekStart,
        to: addDays(weekStart, 6),
        label: weekLabel(weekRows, weekStart),
        lessons: weekRows.length,
        marks,
        missing: missingOf(marks),
      };
    });

  return {
    summary: {
      lessons: active.length,
      marks: summaryMarks,
      missing: missingOf(summaryMarks),
      completionRate: total === 0 ? 100 : Math.round((done / total) * 100),
    },
    teacherRows,
    weeks,
  };
}
