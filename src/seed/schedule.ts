/** @file-guide
 * 목적: schedule.ts — SerSeed, SERS, RANGE_FROM, RANGE_TO, OccSeed 등 (seed)
 * 책임/재사용: 격리 개발/테스트 자료 생성용이다. 기존 enum/키/참조 제약을 재사용하고 운영 데이터를 임의 수정하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 일정과 그 파생물.
 *
 * SER(반복 규칙) 를 적고, 회차는 **규칙으로 펼친다** — 손으로 66줄을 적지 않는다.
 * 표(`ser_occ`)에 넣는 것은 제품 투영(`schedule.project`)이다(N-49 · `seed/index`). 여기 `expand()` 는
 * 예외 · 그날만 빠짐 · 리포트 상태가 설 **날짜를 고르는** 순수 함수이고, 날짜 판정은 제품 규칙(`ruleHits`) 하나다.
 * 리포트 상태도 `src/lib/rules.ts` 의 판정을 그대로 통과하는 값만 만든다 (D-R7 · D-R32).
 */
import { addD, formatRule, ruleHits, type Ser } from '../lib/recurrence';
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
  /** 단발(ONCE) — 이 날짜 하루뿐. days 는 비워 둔다 */
  onceOn?: string;
}

const hm = (h: number, m = 0) => h * 60 + m;

/** 주간 반복 수업 22개 — 4주로 펼치면 회차가 66건 근처가 된다 */
export const SERS: SerSeed[] = [
  { id: 1,  kindKey: 'class', subKey: 'ap-chem',  teacherId: 7,  roomId: 1, zaccId: null, mode: 'offline', startMin: hm(16), endMin: hm(17, 30), days: [2, 4], students: [1, 14] },
  { id: 2,  kindKey: 'class', subKey: 'writing',  teacherId: 7,  roomId: 2, zaccId: null, mode: 'offline', startMin: hm(19), endMin: hm(20), days: [3], students: [1, 6, 11] },
  { id: 3,  kindKey: 'class', subKey: 'sat-math', teacherId: 7,  roomId: 1, zaccId: null, mode: 'offline', startMin: hm(17), endMin: hm(18, 30), days: [1, 3], students: [2, 13, 18] },
  { id: 4,  kindKey: 'class', subKey: 'sat-read', teacherId: 7,  roomId: 2, zaccId: null, mode: 'offline', startMin: hm(19), endMin: hm(20, 30), days: [1, 5], students: [2, 17] },
  { id: 5,  kindKey: 'class', subKey: 'map-math', teacherId: 7,  roomId: 5, zaccId: null, mode: 'offline', startMin: hm(13), endMin: hm(14, 30), days: [2, 5], students: [3, 7, 12, 19] },
  { id: 6,  kindKey: 'class', subKey: 'vocab',    teacherId: 7, roomId: 1, zaccId: null, mode: 'offline', startMin: hm(14), endMin: hm(15), days: [6], students: [4, 9] },
  { id: 7,  kindKey: 'class', subKey: 'writing',  teacherId: 7,  roomId: null, zaccId: 1, mode: 'online',  startMin: hm(20), endMin: hm(21), days: [4], students: [5] },
  { id: 8,  kindKey: 'class', subKey: 'ap-chem',  teacherId: 7, roomId: 1, zaccId: null, mode: 'offline', startMin: hm(18), endMin: hm(19, 30), days: [2], students: [8, 16] },
  { id: 9,  kindKey: 'class', subKey: 'map-read', teacherId: 7, roomId: 6, zaccId: null, mode: 'offline', startMin: hm(16), endMin: hm(17), days: [3, 5], students: [10, 15] },
  { id: 10, kindKey: 'study', subKey: 'study-room', teacherId: 4, roomId: 8, zaccId: null, mode: 'offline', startMin: hm(17), endMin: hm(19), days: [1, 2, 3, 4, 5], students: [7, 12, 15, 19] },
  { id: 11, kindKey: 'class', subKey: 'writing',  teacherId: 7, roomId: 2, zaccId: null, mode: 'offline', startMin: hm(13), endMin: hm(14), days: [6], students: [6, 11] },
  // 현장 수업이라 줌 계정이 없다(N-56 「현장 회차에는 줌이 없다」) — 전에는 계정 2 를 적어 현장 회차에 줌이 붙은,
  // 제품이 만들 수 없는 행을 넣었다(투영은 현장 회차의 계정 자리를 비운다 · 줌 배정은 현장 수업을 거절한다 · N-49)
  { id: 12, kindKey: 'consulting', subKey: 'admissions', teacherId: 3, roomId: 3, zaccId: null, mode: 'offline', startMin: hm(17), endMin: hm(18, 30), days: [3], students: [5] },
  { id: 13, kindKey: 'class', subKey: 'sat-math', teacherId: 7,  roomId: null, zaccId: 3, mode: 'online',  startMin: hm(21), endMin: hm(22), days: [2, 4], students: [18] },
  { id: 14, kindKey: 'class', subKey: 'map-math', teacherId: 7, roomId: 7, zaccId: null, mode: 'offline', startMin: hm(15), endMin: hm(16), days: [1, 4], students: [12] },
  { id: 15, kindKey: 'gpa',   subKey: 'gpa-care', teacherId: 3,  roomId: 3, zaccId: null, mode: 'offline', startMin: hm(19), endMin: hm(20), days: [5], students: [5, 8] },
  { id: 16, kindKey: 'class', subKey: 'ap-chem',  teacherId: 7, roomId: 5, zaccId: null, mode: 'offline', startMin: hm(21), endMin: hm(22, 30), days: [1], students: [14, 16] },
  { id: 17, kindKey: 'class', subKey: 'vocab',    teacherId: 7, roomId: 2, zaccId: null, mode: 'offline', startMin: hm(18), endMin: hm(19), days: [4], students: [4, 9, 10] },
  { id: 18, kindKey: 'class', subKey: 'map-read', teacherId: 7, roomId: null, zaccId: 4, mode: 'online',  startMin: hm(12), endMin: hm(13), days: [6], students: [15, 19] },
  { id: 19, kindKey: 'class', subKey: 'sat-read', teacherId: 7,  roomId: 6, zaccId: null, mode: 'offline', startMin: hm(14), endMin: hm(15, 30), days: [0], students: [17, 18] },
  { id: 20, kindKey: 'mock',  subKey: 'mock-sat', teacherId: 7,  roomId: 1, zaccId: null, mode: 'offline', startMin: hm(9), endMin: hm(12), days: [6], students: [2, 13, 17, 18], title: '모의 SAT 정기' },
  { id: 21, kindKey: 'meeting', subKey: 'mt-pg',  teacherId: 2,  roomId: 4, zaccId: null, mode: 'offline', startMin: hm(10), endMin: hm(11), days: [1], students: [], title: '주간 운영 회의' },
  { id: 22, kindKey: 'diagx', subKey: 'diag',     teacherId: 3,  roomId: 3, zaccId: null, mode: 'offline', startMin: hm(11), endMin: hm(12), days: [6], students: [], title: '진단 평가 (신규)' },
  // 단발이 하나는 있어야 recurring=false 분기가 시드에서 돈다 — 값이 한 종류뿐이면 검증된 적 없는 것
  { id: 23, kindKey: 'mock',  subKey: 'mock-sat', teacherId: 3,  roomId: 3, zaccId: null, mode: 'offline', startMin: hm(15), endMin: hm(16, 30), days: [], students: [13], title: '모의 SAT 1회 특강', onceOn: addD(SEED_TODAY, 3) },
  /*
   * 회의 기록(`ops.MEETINGS`)이 잇는 하루짜리 회의 회차 (impl3-w8 · 63-3).
   * 「+ 회의 잡기」(C96)와 같은 모양이다 — 종류 meeting · 과목은 회의 종류 · 「강사」 자리가 주관자 · 학생 없음.
   * 이것이 없으면 §63 줄의 시각·자리가 전부 「시각 없음」·「—」이었다. 34주차 회의 하나는 옛 기록(연결 없음)으로 남긴다.
   */
  { id: 24, kindKey: 'meeting', subKey: 'mt-pl', teacherId: 2, roomId: 4, zaccId: null, mode: 'offline', startMin: hm(11), endMin: hm(12), days: [], students: [], title: '9월 마케팅 집행 확정 회의', onceOn: addD(SEED_TODAY, 0) },
  { id: 25, kindKey: 'meeting', subKey: 'mt-cs', teacherId: 3, roomId: 3, zaccId: null, mode: 'offline', startMin: hm(14), endMin: hm(15), days: [], students: [], title: '대학 원서 마감 일정 점검', onceOn: addD(SEED_TODAY, 0) },
  { id: 26, kindKey: 'meeting', subKey: 'mt-pg', teacherId: 2, roomId: 4, zaccId: null, mode: 'offline', startMin: hm(11), endMin: hm(12), days: [], students: [], title: '주간 운영 회의 (35주차)', onceOn: addD(SEED_TODAY, 3) },
  { id: 27, kindKey: 'meeting', subKey: 'mt-mk', teacherId: 4, roomId: 4, zaccId: null, mode: 'offline', startMin: hm(14), endMin: hm(15), days: [], students: [], title: '8월 채널별 성과 리뷰', onceOn: addD(SEED_TODAY, -2) },
];

/** 시드가 덮는 기간 — 오늘 기준 앞 3주 · 뒤 1주 (예외 · 리포트 상태 · 변경 요청이 이 안의 회차에 선다) */
export const RANGE_FROM = addD(SEED_TODAY, -21);
export const RANGE_TO = addD(SEED_TODAY, 7);

/**
 * 규칙의 시작일 (N-49 · W11) — 반복 규칙은 **가장 이른 지난 회차(3주 전 · RANGE_FROM)** 에서 시작한다. 단발은 그날 하루다.
 *
 * 전에는 반복 규칙을 오늘부터 시작하게 두고 지난 3주 회차를 `ser_occ` 에 손으로 넣었다. 규칙이 만들 수 없는 행이라
 * 그 수업에 「이번만」 쓰기를 하면 재투영이 지난 회차를 지웠고, 지난 회차의 쓰기는 `OCCURRENCE_NOT_FOUND` 로 헛돌았다.
 * 이제 지난 회차도 규칙이 만든다 — 리포트 · 출결 · 변경 요청 시드가 서는 날짜가 모두 이 시작일 뒤다.
 */
export const serFromDate = (s: SerSeed): string => s.onceOn ?? RANGE_FROM;

/** 규칙 문자열 — `recurrence.ts` 가 읽는 형식으로만 쓴다(형식이 둘이면 회차가 통째로 사라진다) */
export const serRrule = (s: SerSeed): string =>
  formatRule(s.onceOn ? { freq: 'ONCE', days: [], interval: 1 } : { freq: 'WEEKLY', days: [...s.days], interval: 1 });

/** 제품 리듀서가 먹는 모양 — 날짜 판정을 제품 함수(`ruleHits`)에 맡기려고 만든다 */
const asSer = (s: SerSeed): Ser => ({
  id: s.id, kind: s.kindKey, sub: s.subKey, mode: s.mode, title: s.title ?? '',
  teacherId: s.teacherId, roomId: s.roomId, startMin: s.startMin, endMin: s.endMin,
  rrule: serRrule(s), fromDate: serFromDate(s), toDate: null, zaccId: s.zaccId,
});

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

/**
 * 예외를 회차에 **덮어씌운다.**
 *
 * 예외를 표에만 넣고 회차에 반영하지 않으면, 화면은 규칙의 강사·시간을 그대로 보여 준다.
 * 「강사 교체」를 승인했는데 시간표에는 원래 강사가 남아 있는 상태가 된다 — 실제로 그랬다.
 */
export function applyExceptions(occs: OccSeed[], exc: ResolvedExc[]): OccSeed[] {
  const by = new Map(exc.map((e) => [`${e.serId}|${e.onDate}`, e]));
  return occs.map((o) => {
    const e = by.get(`${o.serId}|${o.onDate}`);
    if (!e) return o;
    return {
      ...o,
      canceled: e.canceled || o.canceled,
      teacherId: e.teacherId ?? o.teacherId,
      startMin: e.startMin ?? o.startMin,
      endMin: e.endMin ?? o.endMin,
    };
  });
}

/** 그날만 빠지는 학생 (D-R21) — 「아주 빼기」는 SER_STU 에서 지운다 */
export const STU_OUT: Array<{ serId: number; nth: number; studentId: number }> = [
  { serId: 5,  nth: 2, studentId: 12 },
  { serId: 10, nth: 1, studentId: 15 },
  { serId: 3,  nth: 3, studentId: 18 },
];

/**
 * 그 달 안의 그 수업 회차 하나 — 오늘 전 마지막, 그 달에 지난 회차가 아직 없으면(월초) 그 달 첫 회차.
 * 달에 매인 표본(F12 「이월 막힘」 · `money.CARRY_BLOCKED`)이 쓴다 — 「뒤에서 n번째」는 월초에 지난달로 넘어가 버린다.
 * 휴강한 회차는 고르지 않는다. 붙을 회차가 없으면 던진다 — 조용히 빠지지 않게.
 */
export function occurrenceInMonth(occs: OccSeed[], serId: number, month: string): string {
  const mine = occs.filter((o) => o.serId === serId && !o.canceled && o.onDate.slice(0, 7) === month);
  const past = mine.filter((o) => o.onDate < SEED_TODAY);
  const hit = past.length ? past[past.length - 1] : mine[0];
  if (!hit) throw new Error(`시드: 수업 ${serId} 의 ${month} 회차가 없습니다`);
  return hit.onDate;
}

/**
 * 규칙을 날짜로 펼친다. 손으로 적은 회차 목록을 두지 않는다.
 * 날짜 판정은 제품 규칙(`ruleHits` — 시작일 · 요일)이다 — 시드가 고르는 날짜가 투영이 펴는 회차와 어긋나지 않는다 (N-49).
 */
export function expand(): OccSeed[] {
  const out: OccSeed[] = [];
  const rules = SERS.map((s) => [s, asSer(s)] as const);
  for (let d = RANGE_FROM; d <= RANGE_TO; d = addD(d, 1)) {
    for (const [s, rule] of rules) {
      if (!ruleHits(rule, d)) continue;
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
  // 단일 강사 표본에서는 자신으로 대강 교체하지 않는다. 시간 이동 갈래를 검증한다.
  { serId: 9,  nth: 2,  canceled: false, startMin: hm(12), endMin: hm(13), reason: '개인 사정으로 이번 수업 시간 변경', byId: 3 },
  // nth=1이 월/수 중 어느 요일에 걸려도 다른 회차와 겹치지 않는 표본이어야 한다.
  // 20:30은 월요일 SER16(21:00)과 충돌해 기준일이 화요일인 날 seed 전체를 깨뜨렸다.
  { serId: 3,  nth: 1,  canceled: false, startMin: hm(13, 30), endMin: hm(15), reason: '학교 시험으로 3시간 30분 앞당김', byId: 4 },
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

/** 불가 시간 — 날짜가 판정 기준 (N-20 채택 §4-17 · 강사가 직접 등록). dow 는 삽입 때 날짜에서 파생. */
export const UNAVS = [
  { staffId: 7,  onDate: addD(SEED_TODAY, 8),  startMin: hm(9),  endMin: hm(18), reason: '주말 학원 강의' },
  { staffId: 7,  onDate: addD(SEED_TODAY, 3),  startMin: hm(18), endMin: hm(23), reason: '가족 행사 — 이미 마감된 날짜 표본' },
  { staffId: 7,  onDate: addD(SEED_TODAY, 9),  startMin: hm(14), endMin: hm(18), reason: '대학원 수업' },
  { staffId: 7,  onDate: addD(SEED_TODAY, 12), startMin: hm(9),  endMin: hm(13), reason: '개인 일정' },
  { staffId: 7, onDate: addD(SEED_TODAY, 16), startMin: hm(20), endMin: hm(23), reason: '가족 행사' },
];
