/** @file-guide
 * 목적: schedule-history.ts — scheduleHistoryLine (util) · §20 「최근 변경 이력」 한 줄의 서버 문장
 * 책임/재사용: 스케줄 감사 줄(`log` entity SER · `schedule.audit.ts` 의 before/after 모양)을 읽어 사람이 읽는 한 줄을 만든다. 순수 함수 — DB 를 읽지 않는다(이름은 부르는 쪽이 준다).
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §20 「최근 변경 이력」 (W11 A' 후속 · N-73 의 읽는 쪽).
 *
 * 원문 §20 컷의 줄은 셋이다 — 「누가 —」 · 「— → —」 · 「SAT Reading 8/28 → 20:00 이동 (이 주만)」.
 * 원문 슬라이드 20 의 데이터 줄이 「CHREQ(요청), 반영 시 EXC 생성, **LOG 기록**」이라 이력의 원천은 감사 원장(`log`)이다.
 * 한 줄은 **규칙(SER) 하나의 쓰기 한 번**이다(`schedule.audit.ts` — 바뀐 것만 before/after 에 있다).
 *
 * - 문장은 **있는 칸으로만** 만든다. 모르는 이름은 지어내지 않는다(「미지정」 · 「알 수 없는 사람」처럼 모른다고 적는다).
 * - 범위 말은 원문의 두 낱말을 따른다 — 회차 예외(EXC)면 「이 주만」, 규칙 칸이면 「반복 규칙」, 새로 만든 단발은 「단발」.
 * - 비밀 값은 원장에 없다(줌 배정 `zaccId` 도 감사 줄에서 뺐다 — schedule.audit.ts). 그래서 문장에도 없다.
 */

type View = Record<string, unknown>;

export interface ScheduleHistoryNames {
  teacher: (id: number) => string | null;
  room: (id: number) => string | null;
  student: (id: number) => string | null;
}

export interface ScheduleHistoryLine {
  /** 원문 셋째 줄 — 「SAT Reading 8/28 → 20:00 이동 (이 주만)」 */
  summary: string;
  /** 원문 둘째 줄 「— → —」의 앞 · 뒤 — 첫 번째 바뀐 것 하나. 모르면 null(화면이 「—」로 적는다) */
  from: string | null;
  to: string | null;
}

const hm = (v: unknown): string | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1440
    ? `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}` : null;

/** 'YYYY-MM-DD' → 'M/D' */
const md = (v: unknown): string | null =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${Number(v.slice(5, 7))}/${Number(v.slice(8, 10))}` : null;

const idOf = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
const view = (v: unknown): View | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as View) : null);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const modeWord = (v: unknown): string | null => (v === 'online' ? '온라인' : v === 'offline' ? '현장' : null);

interface Part { text: string; from: string | null; to: string | null }

/** 예외가 없는 회차의 값 — 예외 줄이 새로 생기거나 걷힐 때 한쪽이 없으므로 이 값으로 견준다 */
const EXC_PLAIN: View = {
  canceled: false, newDate: null, startMin: null, endMin: null, teacherSet: false, teacherId: null,
  roomSet: false, roomId: null, mode: null, stuOut: [], memo: null, reason: null,
};

/** 회차 예외 한 날짜의 바뀐 것 — 앞(b) 뒤(a) 는 schedule.audit 의 excView 모양이다(없으면 예외 없음) */
function excPart(day: string, b0: View | null, a0: View | null, names: ScheduleHistoryNames): Part {
  const d = md(day) ?? day;
  const b = { ...EXC_PLAIN, ...(b0 ?? {}) };
  const a = { ...EXC_PLAIN, ...(a0 ?? {}) };
  const changed = (...keys: string[]) => keys.some((k) => !same(b[k], a[k]));
  if (a.canceled === true && b.canceled !== true) return { text: `${d} 휴강`, from: '수업', to: '휴강' };
  if (b.canceled === true && a.canceled !== true) return { text: `${d} 휴강 취소`, from: '휴강', to: '수업' };
  if (changed('startMin', 'endMin', 'newDate')) {
    const where = [md(a.newDate), hm(a.startMin)].filter(Boolean).join(' ');
    return {
      text: where ? `${d} → ${where} 이동` : `${d} 원래 시각으로`,
      from: [md(b.newDate), hm(b.startMin)].filter(Boolean).join(' ') || null,
      to: where || null,
    };
  }
  if (changed('teacherId', 'teacherSet')) {
    const name = (v: unknown) => { const id = idOf(v); return id === null ? null : names.teacher(id); };
    const to = a.teacherSet === true ? (name(a.teacherId) ?? '미지정') : null;
    return { text: `${d} 강사 → ${to ?? '원래 강사'}`, from: b.teacherSet === true ? (name(b.teacherId) ?? '미지정') : null, to };
  }
  if (changed('roomId', 'roomSet')) {
    const name = (v: unknown) => { const id = idOf(v); return id === null ? null : names.room(id); };
    const to = a.roomSet === true ? (name(a.roomId) ?? '미지정') : null;
    return { text: `${d} 강의실 → ${to ?? '원래 강의실'}`, from: b.roomSet === true ? (name(b.roomId) ?? '미지정') : null, to };
  }
  if (changed('mode')) {
    const to = modeWord(a.mode);
    return { text: `${d} 방식 → ${to ?? '원래 방식'}`, from: modeWord(b.mode), to };
  }
  if (changed('stuOut')) {
    const out = Array.isArray(a.stuOut) ? a.stuOut.length : 0;
    return { text: `${d} 빠지는 학생 ${out}명`, from: null, to: null };
  }
  if (changed('memo')) return { text: `${d} 메모`, from: null, to: null };
  // 사유만 적힌 예외(예: 줌 계정 배정으로 생긴 줄) — 사유는 이미 시간표에 보이는 글이다. 길면 자른다
  const reason = typeof a.reason === 'string' && a.reason.trim() ? a.reason.trim().slice(0, 20) : null;
  if (!b0) return { text: `${d} ${reason ?? '회차 예외'}`, from: null, to: null };
  if (!a0) return { text: `${d} 회차 예외 걷음`, from: null, to: null };
  return { text: `${d} ${reason ?? '회차 바꿈'}`, from: null, to: null };
}

/** 규칙 칸의 바뀐 것 — 앞(b) 뒤(a) 는 schedule.audit 의 serView 에서 바뀐 칸만이다 */
function serParts(b: View, a: View, names: ScheduleHistoryNames): Part[] {
  const parts: Part[] = [];
  const has = (k: string) => k in b || k in a;
  if (has('startMin') || has('endMin')) {
    const to = [hm(a.startMin ?? b.startMin), hm(a.endMin ?? b.endMin)].filter(Boolean).join('–') || null;
    const from = [hm(b.startMin ?? a.startMin), hm(b.endMin ?? a.endMin)].filter(Boolean).join('–') || null;
    parts.push({ text: `시각 → ${to ?? '—'}`, from, to });
  }
  if (has('teacherId')) {
    const name = (v: unknown) => { const id = idOf(v); return id === null ? null : names.teacher(id); };
    const to = name(a.teacherId);
    parts.push({ text: `강사 → ${to ?? '미지정'}`, from: name(b.teacherId), to });
  }
  if (has('roomId')) {
    const name = (v: unknown) => { const id = idOf(v); return id === null ? null : names.room(id); };
    const to = name(a.roomId);
    parts.push({ text: `강의실 → ${to ?? '미지정'}`, from: name(b.roomId), to });
  }
  if (has('mode')) parts.push({ text: `방식 → ${modeWord(a.mode) ?? '—'}`, from: modeWord(b.mode), to: modeWord(a.mode) });
  if (has('toDate')) {
    const to = md(a.toDate);
    parts.push({ text: to ? `${to}까지로 끝냄` : '끝나는 날 없앰', from: md(b.toDate), to });
  }
  if (has('fromDate')) parts.push({ text: `시작 → ${md(a.fromDate) ?? '—'}`, from: md(b.fromDate), to: md(a.fromDate) });
  if (has('rrule')) parts.push({ text: '반복 바꿈', from: null, to: null });
  if (has('title')) {
    const to = typeof a.title === 'string' && a.title ? a.title : null;
    parts.push({ text: `이름 → ${to ?? '—'}`, from: typeof b.title === 'string' && b.title ? b.title : null, to });
  }
  if (has('kind') || has('sub')) parts.push({ text: '종류 · 과목 바꿈', from: null, to: null });
  return parts;
}

/** 명단의 바뀐 것 — 들어온 사람 · 나간 사람(이름 둘까지) */
function rosterPart(b: unknown, a: unknown, names: ScheduleHistoryNames): Part | null {
  const ids = (v: unknown) => new Set((Array.isArray(v) ? v : []).map((r) => idOf(view(r)?.studentId)).filter((x): x is number => x !== null));
  const before = ids(b);
  const after = ids(a);
  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  const who = (list: number[]) => {
    const shown = list.slice(0, 2).map((id) => names.student(id) ?? '학생');
    return `${shown.join(', ')}${list.length > 2 ? ` 외 ${list.length - 2}명` : ''}`;
  };
  const bits = [added.length ? `+ ${who(added)}` : null, removed.length ? `− ${who(removed)}` : null].filter(Boolean);
  if (bits.length) return { text: `명단 ${bits.join(' · ')}`, from: null, to: null };
  // 사람은 같고 기간만 바뀌었다(수강 종료 등)
  return same(b, a) ? null : { text: '명단 기간 바꿈', from: null, to: null };
}

/**
 * 감사 줄 한 줄 → §20 이력 한 줄.
 * @param name 규칙의 사람 이름(제목 · 과목 · 종류 중 있는 것) — 부르는 쪽이 지금의 표와 줄의 앞뒤에서 고른다
 */
export function scheduleHistoryLine(
  input: { action: string; before: unknown; after: unknown; name: string },
  names: ScheduleHistoryNames,
): ScheduleHistoryLine {
  const b = view(input.before);
  const a = view(input.after);
  const undo = input.action === 'undo' ? ' · 되돌리기' : '';
  if (!b && a) {
    const once = String(a.rrule ?? 'ONCE').startsWith('ONCE');
    return { summary: `${input.name} 생성 (${once ? '단발' : '반복'})${undo}`, from: null, to: null };
  }
  if (b && !a) return { summary: `${input.name} 삭제${undo}`, from: null, to: null };

  const before = b ?? {};
  const after = a ?? {};
  const parts: Part[] = [];
  let scope: string | null = null;

  const excB = view(before.exc) ?? {};
  const excA = view(after.exc) ?? {};
  const days = [...new Set([...Object.keys(excB), ...Object.keys(excA)])].sort();
  for (const day of days) parts.push(excPart(day, view(excB[day]), view(excA[day]), names));
  if (days.length) scope = '이 주만';

  const serB: View = {};
  const serA: View = {};
  for (const k of Object.keys({ ...before, ...after })) {
    if (k === 'exc' || k === 'roster') continue;
    if (k in before) serB[k] = before[k];
    if (k in after) serA[k] = after[k];
  }
  const rule = serParts(serB, serA, names);
  if (rule.length) { parts.push(...rule); scope = scope ?? '반복 규칙'; }

  if ('roster' in before || 'roster' in after) {
    const r = rosterPart(before.roster, after.roster, names);
    if (r) parts.push(r);
  }

  if (!parts.length) return { summary: `${input.name} 바꿈${undo}`, from: null, to: null };
  // 한 줄에 둘까지 — 넘치면 「외 N」(원문 컷의 줄은 한 줄이다)
  const shown = parts.slice(0, 2).map((p) => p.text).join(' · ');
  const more = parts.length > 2 ? ` 외 ${parts.length - 2}` : '';
  return {
    summary: `${input.name} ${shown}${more}${scope ? ` (${scope})` : ''}${undo}`,
    from: parts[0].from,
    to: parts[0].to,
  };
}
