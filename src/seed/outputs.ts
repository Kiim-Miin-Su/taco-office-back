/** @file-guide
 * 목적: outputs.ts — RepState, RepSeed, buildReports, GUIDES, PNOTIS 등 (seed)
 * 책임/재사용: 격리 개발/테스트 자료 생성용이다. 기존 enum/키/참조 제약을 재사용하고 운영 데이터를 임의 수정하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 회차에서 파생되는 것 — 리포트 · 안내 · 교재.
 *
 * 리포트 상태는 손으로 찍지 않고 **회차 날짜에서 뽑는다.** 그래야 `rules.ts` 의
 * countsForSettlement · isOverdue · latePenalty 가 시드 위에서 그대로 성립한다 (D-R7 · D-R32).
 */
import { addD, diffD } from '../lib/recurrence';
import { nowMinKst } from '../lib/kst';
import { effectiveRepState } from '../lib/rules';
import { KINDS, SEED_TODAY } from './base';
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
const REPORTABLE_KIND = new Map<string, boolean>(KINDS.map(({ key, rep }) => [key, rep]));

/**
 * 리포트 결재자 — 기본은 매니저 김범준(3)이고, **그가 쓴 리포트는 관리자 김민수(2)가 결재한다.**
 * 「올린 사람은 결재하지 못한다」를 DB 가 막으므로(`rep_no_self_review`) 시드도 그 규칙을 지킨다.
 */
const REVIEWER_ID = 3;
const REVIEWER_ALT_ID = 2;

export function buildReports(
  occs: OccSeed[],
  langOf: (id: number) => string,
  nowMin: number = nowMinKst(),
): RepSeed[] {
  const out: RepSeed[] = [];
  let past = 0;
  for (const o of occs) {
    if (o.canceled) continue;
    if (!REPORTABLE_KIND.get(o.kindKey)) continue;                  // 종류 코드표가 단일 진실원
    if (!o.students.length) continue;                                // 학생이 없으면 리포트도 없다
    const past_ = diffD(SEED_TODAY, o.onDate); // 양수면 지난 것
    {
      let state: RepState;
      let writtenAt: string | null = null, submittedAt: string | null = null;
      let reviewedAt: string | null = null, reviewerId: number | null = null, rejectReason: string | null = null;
      // 결재자는 **쓴 사람과 달라야 한다** — 김범준(3)은 강사로도 수업을 맡으므로 자기 결재가 된다.
      // DB `rep_no_self_review` 가 막고 시드는 언제나 새 INSERT 라 여기서 걸린다 (C86-g 와 같은 자리).
      const reviewer = o.teacherId === REVIEWER_ID ? REVIEWER_ALT_ID : REVIEWER_ID;

      if (past_ <= 0) {
        state = effectiveRepState(
          null,
          { date: o.onDate, startMin: o.startMin, durationMin: o.endMin - o.startMin },
          true,
          SEED_TODAY,
          nowMin,
        );
      } else {
        past += 1;
        if (past % UNWRITTEN_EVERY === 0) {
          state = 'none';                   // 밀린 것 — §47 독촉 대상
        } else if (past % 11 === 0) {
          state = 'rej';                    // 반려도 「썼다」로 센다 (D-R7)
          writtenAt = `${o.onDate}T12:10:00Z`; submittedAt = `${o.onDate}T12:20:00Z`;
          reviewedAt = `${addD(o.onDate, 1)}T00:30:00Z`; reviewerId = reviewer;
          rejectReason = '진도 칸이 비어 있습니다. 어디까지 나갔는지 적어 주세요.';
        } else if (past % 5 === 0) {
          state = 'wait';                   // 제출됨 · 승인 대기 (D-R34)
          writtenAt = `${o.onDate}T12:05:00Z`; submittedAt = `${o.onDate}T12:15:00Z`;
        } else {
          state = 'ok';
          writtenAt = `${o.onDate}T11:40:00Z`; submittedAt = `${o.onDate}T11:55:00Z`;
          reviewedAt = `${addD(o.onDate, 1)}T00:10:00Z`; reviewerId = reviewer;
        }
      }
      // 한 수업에 여러 학생이면 언어는 첫 학생 기준이다. 섞인 그룹은 시드에 두지 않는다.
      const lang = langOf(o.students[0]);
      out.push({
        serId: o.serId, onDate: o.onDate, teacherId: o.teacherId,
        kindKey: o.kindKey, lang, state,
        body: state === 'na' || state === 'plan' || state === 'none' ? {} : (lang === 'en' ? BODY_EN : BODY_KO),
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
  // body 가 비어 있으면 화면의 「내용」 칸이 전부 「—」 로 나온다 — 있으나 마나 한 칸이 된다.
  { serId: 1,  studentId: 1,  teacherId: 7,  reason: 'new',            state: 'read',  dueOn: addD(SEED_TODAY, -20),
    body: '첫 수업 안내 — 교재는 당일 배부하고, 준비물은 필기구만 있으면 됩니다.' },
  { serId: 1,  studentId: 14, teacherId: 7,  reason: 'new',            state: 'read',  dueOn: addD(SEED_TODAY, -18),
    body: '첫 수업 안내 — 강의실은 2층 A입니다. 10분 전까지 와 주세요.' },
  { serId: 9,  studentId: 10, teacherId: 7, reason: 'teacher_change', state: 'sent',  dueOn: addD(SEED_TODAY, -4),
    body: '담당 선생님이 이번 주부터 바뀝니다. 진도와 교재는 그대로 이어집니다.' },
  { serId: 5,  studentId: 19, teacherId: 7,  reason: 'new',            state: 'draft', dueOn: addD(SEED_TODAY, 1),
    body: '첫 수업 안내 — 초안입니다. 시간과 강의실 확인 후 보냅니다.' },
  { serId: 11, studentId: 11, teacherId: 7, reason: 'teacher_change', state: 'ready', dueOn: addD(SEED_TODAY, 1),
    body: '담당 선생님 변경 안내 — 학부모님께 오늘 중 발송 예정입니다.' },
];

/** 매번 보내는 것 — 온라인 수업 줌 링크 (§43 · PNOTI) */
export const PNOTIS = [
  { serId: 7,  onDate: addD(SEED_TODAY, -1), studentId: 5,  channel: 'app', body: '오늘 20:00 Writing 줌 링크입니다.', sentAt: addD(SEED_TODAY, -1) },
  { serId: 13, onDate: addD(SEED_TODAY, -1), studentId: 18, channel: 'app', body: '오늘 21:00 SAT Math 줌 링크입니다.', sentAt: addD(SEED_TODAY, -1) },
  { serId: 18, onDate: addD(SEED_TODAY, 1),  studentId: 15, channel: 'app', body: '내일 12:00 MAP Reading 줌 링크입니다.', sentAt: null },
  { serId: 18, onDate: addD(SEED_TODAY, 1),  studentId: 19, channel: 'app', body: '내일 12:00 MAP Reading 줌 링크입니다.', sentAt: null },
];

/** 서가 — 교재 */
export const LIBS = [
  { id: 1, code: 'APC-4E',  title: 'AP Chemistry 4th Edition', subKey: 'ap-chem',  level: 'AP',  grade: '11',  pages: 620, seTe: 'SE' },
  { id: 2, code: 'SATM-9',  title: 'SAT Math Practice 9',      subKey: 'sat-math', level: 'SAT', grade: '11',  pages: 410, seTe: 'SE' },
  { id: 3, code: 'SATR-7',  title: 'SAT Reading Drills 7',     subKey: 'sat-read', level: 'SAT', grade: '10',  pages: 380, seTe: 'SE' },
  { id: 4, code: 'WRT-B2',  title: 'Writing Builder 2',        subKey: 'writing',  level: 'B2',  grade: '9',   pages: 240, seTe: 'SE' },
  { id: 5, code: 'MAPM-5',  title: 'MAP Math Level 5',         subKey: 'map-math', level: 'M5',  grade: '5',   pages: 300, seTe: 'SE' },
  { id: 6, code: 'MAPR-5',  title: 'MAP Reading Level 5',      subKey: 'map-read', level: 'M5',  grade: '5',   pages: 290, seTe: 'SE' },
  { id: 7, code: 'VOC-3K',  title: 'Vocab 3000',               subKey: 'vocab',    level: 'ALL', grade: 'ALL', pages: 180, seTe: 'SE' },
  { id: 8, code: 'APC-4T',  title: 'AP Chemistry 4th (Teacher)', subKey: 'ap-chem', level: 'AP', grade: '11', pages: 700, seTe: 'TE' },
];

/**
 * §39 판 파일 시드. 본문은 외부 주소가 아니라 Neon `file` 행에 저장한다.
 * 8번 교재의 TE만 의도적으로 비워 두어 원본의 「TE 없음」 경고를 실제 DB 상태로 검증한다.
 */
export const BOOK_FILES = LIBS.flatMap((book) => [
  { id: (book.id - 1) * 2 + 1, libId: book.id, kind: 'lib-se', name: `${book.code}-SE.pdf`, body: `${book.code} student edition seed` },
  ...(book.id === 8 ? [] : [{ id: (book.id - 1) * 2 + 2, libId: book.id, kind: 'lib-te', name: `${book.code}-TE.pdf`, body: `${book.code} teacher edition seed` }]),
]);

/** 현재 판 8개 + AP Chemistry의 다음 달 판 1개. 미래 효력 판이 §39 「더 최신 판」 경고를 만든다. */
export const BOOK_VERSIONS = [
  { id: 1, libId: 1, edition: '2026.1', fromOffset: -90, seFileId: 1, teFileId: 2 },
  { id: 2, libId: 1, edition: '2026.2', fromOffset: 30,  seFileId: 1, teFileId: 2 },
  { id: 3, libId: 2, edition: '2026.1', fromOffset: -80, seFileId: 3, teFileId: 4 },
  { id: 4, libId: 3, edition: '2026.1', fromOffset: -70, seFileId: 5, teFileId: 6 },
  { id: 5, libId: 4, edition: '2026.1', fromOffset: -60, seFileId: 7, teFileId: 8 },
  { id: 6, libId: 5, edition: '2026.1', fromOffset: -50, seFileId: 9, teFileId: 10 },
  { id: 7, libId: 6, edition: '2026.1', fromOffset: -40, seFileId: 11, teFileId: 12 },
  { id: 8, libId: 7, edition: '2026.1', fromOffset: -30, seFileId: 13, teFileId: 14 },
  { id: 9, libId: 8, edition: '2026.1', fromOffset: -20, seFileId: 15, teFileId: null },
] as const;

/**
 * §40의 9개 필터 낱말을 모두 포함하는 18행. refId는 reset 뒤 결정적인 LIB/VERS/ISSUE/GUIDE id다.
 * 화면 문장은 HIST에 복제하지 않고 원본 행을 조인해 만들기 때문에 여기에는 사실 키만 둔다.
 */
export const BOOK_HISTORY = [
  ...Array.from({ length: 7 }, (_, n) => ({ entity: 'issue', refId: n + 1, action: 'book_issue', byId: 3, dayOffset: -n })),
  { entity: 'issue', refId: 8, action: 'book_drop', byId: 3, dayOffset: -7 },
  { entity: 'lib', refId: 1, action: 'book_upload', byId: 2, dayOffset: -8 },
  { entity: 'lib', refId: 2, action: 'book_upload', byId: 2, dayOffset: -9 },
  { entity: 'vers', refId: 1, action: 'book_upload', byId: 2, dayOffset: -10 },
  { entity: 'vers', refId: 2, action: 'book_swap', byId: 2, dayOffset: -11 },
  { entity: 'guide', refId: 1, action: 'guide_write', byId: 7, dayOffset: -12 },
  { entity: 'guide', refId: 1, action: 'guide_send', byId: 3, dayOffset: -13 },
  { entity: 'guide', refId: 2, action: 'guide_send', byId: 3, dayOffset: -14 },
  { entity: 'guide', refId: 3, action: 'guide_ack', byId: 7, dayOffset: -15 },
  { entity: 'guide', refId: 4, action: 'teacher_req', byId: 7, dayOffset: -16 },
  { entity: 'guide', refId: 5, action: 'teacher_swap', byId: 2, dayOffset: -17 },
] as const;

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
