/**
 * 회차에서 파생되는 것 — 리포트 · 안내 · 교재.
 *
 * 리포트 상태는 손으로 찍지 않고 **회차 날짜에서 뽑는다.** 그래야 `rules.ts` 의
 * countsForSettlement · isOverdue · latePenalty 가 시드 위에서 그대로 성립한다 (D-R7 · D-R32).
 */
import { addD, diffD } from '../lib/recurrence';
import { SEED_TODAY } from './base';
import type { OccSeed } from './schedule';

export type RepState = 'na' | 'plan' | 'none' | 'draft' | 'wait' | 'ok' | 'rej';

/**
 * 리포트는 **수업 하나에 하나**다 — (serId, onDate) 가 유니크다.
 * 학생은 `students` 로 붙고 REP_STU 가 된다. 학부모에게 나가는 PNG 만 학생 수만큼 만든다
 * (CONTRACTS §10.5 · D-R40).
 */
export interface RepSeed {
  serId: number; onDate: string; teacherId: number;
  kindKey: string; lang: string; state: RepState;
  body: Record<string, unknown>;
  writtenAt: string | null; submittedAt: string | null;
  reviewedAt: string | null; reviewerId: number | null; rejectReason: string | null;
  students: number[];
}

const BODY_KO = {
  content: '도함수 응용 — 최적화 문제 6제를 함께 풀었습니다. 4제는 정확히 맞혔고, 나머지 2제는 조건식을 세우는 부분에서 막혀 풀이 과정을 처음부터 다시 정리했습니다.',
  progress: '교재 p.148 → p.161 (13쪽). 단원 4-3 최적화 마무리.',
  homework: 'p.162 연습문제 1~12번. 틀린 문제는 풀이 과정을 적어 오기.',
};
const BODY_EN = {
  content: 'Worked through six optimization problems. Four were correct; for the remaining two we rebuilt the constraint equations from scratch.',
  progress: 'Textbook p.148 → p.161. Finished unit 4-3.',
  homework: 'p.162 exercises 1–12. Write out the full working for any you miss.',
};

/**
 * 안 쓴 리포트를 만들 회차 — 배열 인덱스로 고른다(결정적).
 * 지난 회차 중 이 비율만큼을 「안 씀」으로 남겨 §47 독촉 화면이 실제로 채워지게 한다.
 */
const UNWRITTEN_EVERY = 6;

export function buildReports(occs: OccSeed[], langOf: (id: number) => string): RepSeed[] {
  const out: RepSeed[] = [];
  let past = 0;
  for (const o of occs) {
    if (o.canceled) continue;
    if (o.kindKey === 'meeting' || o.kindKey === 'study') continue; // 리포트를 쓰지 않는 종류
    if (!o.students.length) continue;                                // 학생이 없으면 리포트도 없다
    const past_ = diffD(SEED_TODAY, o.onDate); // 양수면 지난 것
    {
      let state: RepState;
      let writtenAt: string | null = null, submittedAt: string | null = null;
      let reviewedAt: string | null = null, reviewerId: number | null = null, rejectReason: string | null = null;

      if (past_ < 0) {
        state = 'na';                       // 아직 안 한 수업
      } else if (past_ === 0) {
        state = 'none';                     // 오늘 수업 — 아직 안 씀
      } else {
        past += 1;
        if (past % UNWRITTEN_EVERY === 0) {
          state = 'none';                   // 밀린 것 — §47 독촉 대상
        } else if (past % 11 === 0) {
          state = 'rej';                    // 반려도 「썼다」로 센다 (D-R7)
          writtenAt = `${o.onDate}T12:10:00Z`; submittedAt = `${o.onDate}T12:20:00Z`;
          reviewedAt = `${addD(o.onDate, 1)}T00:30:00Z`; reviewerId = 3;
          rejectReason = '진도 칸이 비어 있습니다. 어디까지 나갔는지 적어 주세요.';
        } else if (past % 5 === 0) {
          state = 'wait';                   // 제출됨 · 승인 대기 (D-R34)
          writtenAt = `${o.onDate}T12:05:00Z`; submittedAt = `${o.onDate}T12:15:00Z`;
        } else {
          state = 'ok';
          writtenAt = `${o.onDate}T11:40:00Z`; submittedAt = `${o.onDate}T11:55:00Z`;
          reviewedAt = `${addD(o.onDate, 1)}T00:10:00Z`; reviewerId = 3;
        }
      }
      // 한 수업에 여러 학생이면 언어는 첫 학생 기준이다. 섞인 그룹은 시드에 두지 않는다.
      const lang = langOf(o.students[0]);
      out.push({
        serId: o.serId, onDate: o.onDate, teacherId: o.teacherId,
        kindKey: o.kindKey, lang, state,
        body: state === 'na' || state === 'none' ? {} : (lang === 'en' ? BODY_EN : BODY_KO),
        writtenAt, submittedAt, reviewedAt, reviewerId, rejectReason,
        students: [...o.students],
      });
    }
  }
  return out;
}

/**
 * 수업 안내 — **한 번 보내는 것**만 여기 있다 (첫 수업 · 강사 교체 · D-R5).
 * 온라인 줌 링크처럼 매번 나가는 것은 PNOTI 다 (§43 「한 번 / 매번」).
 */
export const GUIDES = [
  { serId: 1,  studentId: 1,  teacherId: 6,  reason: 'new',            state: 'read',  dueOn: addD(SEED_TODAY, -20) },
  { serId: 1,  studentId: 14, teacherId: 6,  reason: 'new',            state: 'read',  dueOn: addD(SEED_TODAY, -18) },
  { serId: 9,  studentId: 10, teacherId: 12, reason: 'teacher_change', state: 'sent',  dueOn: addD(SEED_TODAY, -4) },
  { serId: 5,  studentId: 19, teacherId: 9,  reason: 'new',            state: 'draft', dueOn: addD(SEED_TODAY, 1) },
  { serId: 11, studentId: 11, teacherId: 14, reason: 'teacher_change', state: 'ready', dueOn: addD(SEED_TODAY, 1) },
];

/** 매번 보내는 것 — 온라인 수업 줌 링크 (§43 · PNOTI) */
export const PNOTIS = [
  { serId: 7,  onDate: addD(SEED_TODAY, -1), studentId: 5,  channel: 'app', body: '오늘 20:00 Writing 줌 링크입니다.', sentAt: addD(SEED_TODAY, -1) },
  { serId: 13, onDate: addD(SEED_TODAY, -1), studentId: 18, channel: 'app', body: '오늘 21:00 SAT Math 줌 링크입니다.', sentAt: addD(SEED_TODAY, -1) },
  { serId: 18, onDate: addD(SEED_TODAY, 1),  studentId: 15, channel: 'app', body: '내일 10:00 MAP Reading 줌 링크입니다.', sentAt: null },
  { serId: 18, onDate: addD(SEED_TODAY, 1),  studentId: 19, channel: 'app', body: '내일 10:00 MAP Reading 줌 링크입니다.', sentAt: null },
];

/** 서가 — 교재 */
export const LIBS = [
  { id: 1, code: 'APC-4E',  title: 'AP Chemistry 4th Edition', subKey: 'ap-chem',  level: 'AP',  pages: 620, seTe: 'SE' },
  { id: 2, code: 'SATM-9',  title: 'SAT Math Practice 9',      subKey: 'sat-math', level: 'SAT', pages: 410, seTe: 'SE' },
  { id: 3, code: 'SATR-7',  title: 'SAT Reading Drills 7',     subKey: 'sat-read', level: 'SAT', pages: 380, seTe: 'SE' },
  { id: 4, code: 'WRT-B2',  title: 'Writing Builder 2',        subKey: 'writing',  level: 'B2',  pages: 240, seTe: 'SE' },
  { id: 5, code: 'MAPM-5',  title: 'MAP Math Level 5',         subKey: 'map-math', level: 'M5',  pages: 300, seTe: 'SE' },
  { id: 6, code: 'MAPR-5',  title: 'MAP Reading Level 5',      subKey: 'map-read', level: 'M5',  pages: 290, seTe: 'SE' },
  { id: 7, code: 'VOC-3K',  title: 'Vocab 3000',               subKey: 'vocab',    level: 'ALL', pages: 180, seTe: 'SE' },
  { id: 8, code: 'APC-4T',  title: 'AP Chemistry 4th (Teacher)', subKey: 'ap-chem', level: 'AP', pages: 700, seTe: 'TE' },
];

/** 교재 지급 — 안 나간 것이 §38 트래킹 보드에 뜬다 */
export const ISSUES = [
  { libId: 1, studentId: 1,  issuedOn: addD(SEED_TODAY, -170) },
  { libId: 4, studentId: 1,  issuedOn: addD(SEED_TODAY, -170) },
  { libId: 2, studentId: 2,  issuedOn: addD(SEED_TODAY, -350) },
  { libId: 3, studentId: 2,  issuedOn: addD(SEED_TODAY, -350) },
  { libId: 5, studentId: 3,  issuedOn: addD(SEED_TODAY, -80) },
  { libId: 7, studentId: 4,  issuedOn: addD(SEED_TODAY, -100) },
  { libId: 4, studentId: 6,  issuedOn: addD(SEED_TODAY, -220) },
  { libId: 1, studentId: 8,  issuedOn: addD(SEED_TODAY, -500) },
  { libId: 7, studentId: 9,  issuedOn: addD(SEED_TODAY, -190) },
  { libId: 6, studentId: 10, issuedOn: addD(SEED_TODAY, -50) },
  { libId: 5, studentId: 12, issuedOn: addD(SEED_TODAY, -160) },
  { libId: 1, studentId: 14, issuedOn: addD(SEED_TODAY, -110) },
  { libId: 6, studentId: 15, issuedOn: addD(SEED_TODAY, -70) },
  { libId: 1, studentId: 16, issuedOn: addD(SEED_TODAY, -230) },
  { libId: 3, studentId: 17, issuedOn: addD(SEED_TODAY, -290) },
  { libId: 2, studentId: 18, issuedOn: addD(SEED_TODAY, -370) },
  // 5(최유나 map-math) · 11(조민서 writing) · 13 · 19 는 일부러 비운다 — 미수령이 화면에 떠야 한다
];
