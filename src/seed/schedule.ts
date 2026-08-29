/**
 * 일정과 그 파생물.
 *
 * SER(반복 규칙) 를 적고, 회차는 **규칙으로 펼친다** — 손으로 66줄을 적지 않는다.
 * 리포트 상태도 `src/lib/rules.ts` 의 판정을 그대로 통과하는 값만 만든다 (D-R7 · D-R32).
 */
import { addD } from '../lib/recurrence';
import { SEED_TODAY } from './base';

export interface SerSeed {
  id: number;
  kindKey: string;
  subKey: string | null;
  teacherId: number;
  roomId: number | null;
  zaccId: number | null;
  mode: 'offline' | 'online';
  startMin: number;
  endMin: number;
  /** 요일 0=일 … 6=토 */
  days: number[];
  students: number[];
  title?: string;
}

const hm = (h: number, m = 0) => h * 60 + m;

/** 주간 반복 수업 22개 — 4주로 펼치면 회차가 66건 근처가 된다 */
export const SERS: SerSeed[] = [
  { id: 1,  kindKey: 'class', subKey: 'ap-chem',  teacherId: 6,  roomId: 1, zaccId: null, mode: 'offline', startMin: hm(16), endMin: hm(17, 30), days: [2, 4], students: [1, 14] },
  { id: 2,  kindKey: 'class', subKey: 'writing',  teacherId: 6,  roomId: 2, zaccId: null, mode: 'offline', startMin: hm(19), endMin: hm(20), days: [3], students: [1, 6, 11] },
  { id: 3,  kindKey: 'class', subKey: 'sat-math', teacherId: 7,  roomId: 1, zaccId: null, mode: 'offline', startMin: hm(17), endMin: hm(18, 30), days: [1, 3], students: [2, 13, 18] },
  { id: 4,  kindKey: 'class', subKey: 'sat-read', teacherId: 8,  roomId: 2, zaccId: null, mode: 'offline', startMin: hm(19), endMin: hm(20, 30), days: [1, 5], students: [2, 17] },
  { id: 5,  kindKey: 'class', subKey: 'map-math', teacherId: 9,  roomId: 5, zaccId: null, mode: 'offline', startMin: hm(15), endMin: hm(16, 30), days: [2, 5], students: [3, 7, 12, 19] },
  { id: 6,  kindKey: 'class', subKey: 'vocab',    teacherId: 10, roomId: 1, zaccId: null, mode: 'offline', startMin: hm(14), endMin: hm(15), days: [6], students: [4, 9] },
  { id: 7,  kindKey: 'class', subKey: 'writing',  teacherId: 6,  roomId: null, zaccId: 1, mode: 'online',  startMin: hm(20), endMin: hm(21), days: [4], students: [5] },
  { id: 8,  kindKey: 'class', subKey: 'ap-chem',  teacherId: 11, roomId: 1, zaccId: null, mode: 'offline', startMin: hm(18), endMin: hm(19, 30), days: [2], students: [8, 16] },
  { id: 9,  kindKey: 'class', subKey: 'map-read', teacherId: 12, roomId: 6, zaccId: null, mode: 'offline', startMin: hm(16), endMin: hm(17), days: [3, 5], students: [10, 15] },
  { id: 10, kindKey: 'study', subKey: 'study-room', teacherId: 13, roomId: 8, zaccId: null, mode: 'offline', startMin: hm(17), endMin: hm(19), days: [1, 2, 3, 4, 5], students: [7, 12, 15, 19] },
  { id: 11, kindKey: 'class', subKey: 'writing',  teacherId: 14, roomId: 2, zaccId: null, mode: 'offline', startMin: hm(13), endMin: hm(14), days: [6], students: [6, 11] },
  { id: 12, kindKey: 'consulting', subKey: 'admissions', teacherId: 3, roomId: 3, zaccId: 2, mode: 'offline', startMin: hm(17), endMin: hm(18, 30), days: [3], students: [5] },
  { id: 13, kindKey: 'class', subKey: 'sat-math', teacherId: 7,  roomId: null, zaccId: 3, mode: 'online',  startMin: hm(21), endMin: hm(22), days: [2, 4], students: [18] },
  { id: 14, kindKey: 'class', subKey: 'map-math', teacherId: 15, roomId: 7, zaccId: null, mode: 'offline', startMin: hm(15), endMin: hm(16), days: [1, 4], students: [12] },
  { id: 15, kindKey: 'gpa',   subKey: 'gpa-care', teacherId: 3,  roomId: 3, zaccId: null, mode: 'offline', startMin: hm(19), endMin: hm(20), days: [5], students: [5, 8] },
  { id: 16, kindKey: 'class', subKey: 'ap-chem',  teacherId: 16, roomId: 5, zaccId: null, mode: 'offline', startMin: hm(20), endMin: hm(21, 30), days: [1], students: [14, 16] },
  { id: 17, kindKey: 'class', subKey: 'vocab',    teacherId: 10, roomId: 2, zaccId: null, mode: 'offline', startMin: hm(18), endMin: hm(19), days: [4], students: [4, 9, 10] },
  { id: 18, kindKey: 'class', subKey: 'map-read', teacherId: 12, roomId: null, zaccId: 4, mode: 'online',  startMin: hm(10), endMin: hm(11), days: [6], students: [15, 19] },
  { id: 19, kindKey: 'class', subKey: 'sat-read', teacherId: 8,  roomId: 6, zaccId: null, mode: 'offline', startMin: hm(14), endMin: hm(15, 30), days: [0], students: [17, 18] },
  { id: 20, kindKey: 'mock',  subKey: 'mock-sat', teacherId: 7,  roomId: 1, zaccId: null, mode: 'offline', startMin: hm(9), endMin: hm(12), days: [6], students: [2, 13, 17, 18], title: '모의 SAT 정기' },
  { id: 21, kindKey: 'meeting', subKey: 'mt-pg',  teacherId: 2,  roomId: 4, zaccId: null, mode: 'offline', startMin: hm(10), endMin: hm(11), days: [1], students: [], title: '주간 운영 회의' },
  { id: 22, kindKey: 'diagx', subKey: 'diag',     teacherId: 5,  roomId: 3, zaccId: null, mode: 'offline', startMin: hm(11), endMin: hm(12), days: [6], students: [], title: '진단 평가 (신규)' },
];

/** 시드가 덮는 기간 — 오늘 기준 앞 3주 · 뒤 1주 */
export const RANGE_FROM = addD(SEED_TODAY, -21);
export const RANGE_TO = addD(SEED_TODAY, 7);

export interface OccSeed {
  serId: number;
  onDate: string;
  teacherId: number;
  roomId: number | null;
  zaccId: number | null;
  canceled: boolean;
  startMin: number;
  endMin: number;
  kindKey: string;
  subKey: string | null;
  students: number[];
}

/** 규칙을 날짜로 펼친다. 손으로 적은 회차 목록을 두지 않는다. */
export function expand(): OccSeed[] {
  const out: OccSeed[] = [];
  for (let d = RANGE_FROM; d <= RANGE_TO; d = addD(d, 1)) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    for (const s of SERS) {
      if (!s.days.includes(dow)) continue;
      out.push({
        serId: s.id, onDate: d, teacherId: s.teacherId, roomId: s.roomId, zaccId: s.zaccId,
        canceled: false, startMin: s.startMin, endMin: s.endMin,
        kindKey: s.kindKey, subKey: s.subKey, students: [...s.students],
      });
    }
  }
  return out.sort((a, b) => (a.onDate + String(a.startMin).padStart(4, '0')).localeCompare(b.onDate + String(b.startMin).padStart(4, '0')));
}

/**
 * 예외 — 취소 · 강사 교체 · 시간 이동.
 *
 * 날짜를 손으로 적지 않는다. 「그 규칙의 뒤에서 n번째 회차」로 가리키고 실제 날짜는 펼친 결과에서 찾는다.
 * 요일이 안 맞는 날짜를 적으면 예외가 **조용히 아무 데도 안 붙는다** — 처음 시드에서 실제로 그랬다.
 */
export interface ExcSpec {
  serId: number;
  /** 지난 회차 중 뒤에서 몇 번째인가 (1 = 가장 최근) · 음수면 앞으로의 회차 */
  nth: number;
  canceled: boolean;
  teacherId?: number;
  startMin?: number;
  endMin?: number;
  reason: string;
  byId: number;
}

export const EXCEPTIONS: ExcSpec[] = [
  { serId: 6,  nth: 1,  canceled: true,  reason: '학생 본인 사정', byId: 4 },
  { serId: 9,  nth: 2,  canceled: false, teacherId: 15, reason: '강사 교체 — 문태경 개인 사정', byId: 3 },
  { serId: 3,  nth: 1,  canceled: false, startMin: 18 * 60, endMin: 19 * 60 + 30, reason: '학교 시험으로 1시간 미룸', byId: 4 },
  { serId: 17, nth: -1, canceled: true,  reason: '강사 병가', byId: 3 },
];

export interface ResolvedExc extends Omit<ExcSpec, 'nth'> { onDate: string }

/** 예외를 실제 회차 날짜로 푼다. 붙을 회차가 없으면 던진다 — 조용히 빠지지 않게. */
export function resolveExceptions(occs: OccSeed[]): ResolvedExc[] {
  return EXCEPTIONS.map((e) => {
    const mine = occs.filter((o) => o.serId === e.serId);
    const past = mine.filter((o) => o.onDate < SEED_TODAY);
    const future = mine.filter((o) => o.onDate > SEED_TODAY);
    const hit = e.nth > 0 ? past[past.length - e.nth] : future[-e.nth - 1];
    if (!hit) throw new Error(`예외를 붙일 회차가 없습니다 — ser ${e.serId} nth ${e.nth}`);
    const rest: ResolvedExc = { ...e, onDate: hit.onDate };
    delete (rest as Partial<ExcSpec>).nth;
    return rest;
  });
}

/** 불가 시간 — 2주 회차 (§17 · 강사가 직접 등록) */
export const UNAVS = [
  { staffId: 6,  cycle: 1, dow: 0, startMin: hm(9), endMin: hm(18), reason: '주말 학원 강의' },
  { staffId: 7,  cycle: 1, dow: 6, startMin: hm(14), endMin: hm(18), reason: '대학원 수업' },
  { staffId: 8,  cycle: 1, dow: 2, startMin: hm(9), endMin: hm(13), reason: '개인 일정' },
  { staffId: 10, cycle: 2, dow: 4, startMin: hm(9), endMin: hm(12), reason: '병원' },
  { staffId: 12, cycle: 1, dow: 5, startMin: hm(20), endMin: hm(23), reason: '가족 행사' },
];
