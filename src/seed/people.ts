/** @file-guide
 * 목적: people.ts — STUDENTS, ENROLLMENTS, LEADS, LEAD_DIAGS, LEAD_PLANS, LEAD_APPTS (seed)
 * 책임/재사용: 격리 개발/테스트 자료 생성용이다. 기존 enum/키/참조 제약을 재사용하고 운영 데이터를 임의 수정하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 학생 19명 · 등록 · 상담 18건.
 * 명세서 v2 §2 의 실측 규모(상담 18건 · 청구서 6건)를 그대로 맞춘다.
 *
 * 학년은 원문 표기 「G + 학년」이다(27-02 · W11) — §27 「G12 · G10」 · §23 「G8 · G5 · G10」 · §12 「강라율 G7」 · §39 「K · G1 … G12」 · §41 「G9」.
 * 중1~3 = G7~G9 · 고1~3 = G10~G12 로 옮겼다(시드만 · 사람이 입력한 학년은 적은 그대로 둔다 — N-25).
 */
import { AUTHORED_ON } from './base';

export const STUDENTS = [
  { id: 1,  name: '김민준', grade: 'G11', school: '대원외고',   targetExam: 'AP',  startedOn: '2026-03-02', lang: 'ko' },
  { id: 2,  name: '박지우', grade: 'G12', school: '한영외고',   targetExam: 'SAT', startedOn: '2025-09-01', lang: 'ko' },
  { id: 3,  name: '최유나', grade: 'G9',  school: '대치중',     targetExam: 'MAP', startedOn: '2026-06-03', lang: 'ko' },
  { id: 4,  name: '한서준', grade: 'G10', school: '휘문고',     targetExam: 'SAT', startedOn: '2026-05-11', lang: 'ko' },
  { id: 5,  name: '오예린', grade: 'G12', school: '민사고',     targetExam: 'AP',  startedOn: '2025-07-08', lang: 'ko' },
  { id: 6,  name: '정하람', grade: 'G11', school: '외대부고',   targetExam: 'SAT', startedOn: '2026-01-12', lang: 'ko' },
  { id: 7,  name: '윤도현', grade: 'G8',  school: '숙명중',     targetExam: 'MAP', startedOn: '2026-04-06', lang: 'ko' },
  { id: 8,  name: '서지안', grade: 'G12', school: '청심국제고', targetExam: 'AP',  startedOn: '2025-03-04', lang: 'ko' },
  { id: 9,  name: '김하윤', grade: 'G10', school: '개포고',     targetExam: 'SAT', startedOn: '2026-02-02', lang: 'ko' },
  { id: 10, name: '이서우', grade: 'G7',  school: '역삼중',     targetExam: 'MAP', startedOn: '2026-07-01', lang: 'ko' },
  { id: 11, name: '조민서', grade: 'G11', school: '경기고',     targetExam: 'SAT', startedOn: '2026-02-16', lang: 'ko' },
  { id: 12, name: '강태윤', grade: 'G9',  school: '중동중',     targetExam: 'MAP', startedOn: '2026-03-16', lang: 'ko' },
  { id: 13, name: '임하준', grade: 'G10', school: '단대부고',   targetExam: 'SAT', startedOn: '2026-04-20', lang: 'ko' },
  { id: 14, name: '송지호', grade: 'G11', school: '숭실고',     targetExam: 'AP',  startedOn: '2026-05-04', lang: 'ko' },
  { id: 15, name: '백서현', grade: 'G8',  school: '언주중',     targetExam: 'MAP', startedOn: '2026-06-15', lang: 'ko' },
  { id: 16, name: 'Emily Park', grade: 'G10', school: 'SIS',   targetExam: 'AP',  startedOn: '2026-01-05', lang: 'en' },
  { id: 17, name: 'Daniel Cho', grade: 'G11', school: 'KIS',   targetExam: 'SAT', startedOn: '2025-11-03', lang: 'en' },
  { id: 18, name: '문채원', grade: 'G12', school: '세화여고',   targetExam: 'SAT', startedOn: '2025-08-18', lang: 'ko' },
  { id: 19, name: '권시우', grade: 'G9',  school: '압구정중',   targetExam: 'MAP', startedOn: '2026-07-13', lang: 'ko' },
] as const;

/** 등록 — 학생이 무엇을 듣는가 */
export const ENROLLMENTS = [
  { studentId: 1,  kindKey: 'class', subKey: 'ap-chem',  sessions: 8, startedOn: '2026-03-02' },
  { studentId: 1,  kindKey: 'class', subKey: 'writing',  sessions: 8, startedOn: '2026-03-02' },
  { studentId: 2,  kindKey: 'class', subKey: 'sat-math', sessions: 10, startedOn: '2025-09-01' },
  { studentId: 2,  kindKey: 'class', subKey: 'sat-read', sessions: 10, startedOn: '2025-09-01' },
  { studentId: 3,  kindKey: 'class', subKey: 'map-math', sessions: 6, startedOn: '2026-06-03' },
  { studentId: 4,  kindKey: 'class', subKey: 'vocab',    sessions: 12, startedOn: '2026-05-11' },
  { studentId: 5,  kindKey: 'class', subKey: 'writing',  sessions: 6, startedOn: '2025-07-08' },
  { studentId: 5,  kindKey: 'consulting', subKey: 'admissions', sessions: 13, startedOn: '2026-07-08' },
  { studentId: 6,  kindKey: 'class', subKey: 'writing',  sessions: 6, startedOn: '2026-01-12' },
  { studentId: 7,  kindKey: 'class', subKey: 'map-math', sessions: 5, startedOn: '2026-04-06' },
  { studentId: 7,  kindKey: 'study', subKey: 'study-room', sessions: 20, startedOn: '2026-04-06' },
  { studentId: 8,  kindKey: 'class', subKey: 'ap-chem',  sessions: 8, startedOn: '2025-03-04' },
  { studentId: 9,  kindKey: 'class', subKey: 'vocab',    sessions: 12, startedOn: '2026-02-02' },
  { studentId: 10, kindKey: 'class', subKey: 'map-read', sessions: 6, startedOn: '2026-07-01' },
  { studentId: 11, kindKey: 'class', subKey: 'writing',  sessions: 7, startedOn: '2026-02-16' },
  { studentId: 12, kindKey: 'class', subKey: 'map-math', sessions: 6, startedOn: '2026-03-16' },
  { studentId: 13, kindKey: 'class', subKey: 'sat-math', sessions: 8, startedOn: '2026-04-20' },
  { studentId: 14, kindKey: 'class', subKey: 'ap-chem',  sessions: 8, startedOn: '2026-05-04' },
  { studentId: 15, kindKey: 'class', subKey: 'map-read', sessions: 6, startedOn: '2026-06-15' },
  { studentId: 16, kindKey: 'class', subKey: 'ap-chem',  sessions: 8, startedOn: '2026-01-05' },
  { studentId: 17, kindKey: 'class', subKey: 'sat-read', sessions: 10, startedOn: '2025-11-03' },
  { studentId: 18, kindKey: 'class', subKey: 'sat-math', sessions: 10, startedOn: '2025-08-18' },
  { studentId: 19, kindKey: 'class', subKey: 'map-math', sessions: 6, startedOn: '2026-07-13' },
  // 최근 등록 — 화면의 「등록」 칸이 늘 0 이면 아무도 그 칸을 안 본다.
  // 마지막 1건은 AUTHORED_ON 에 고정한다. rel() 뒤에는 항상 SEED_TODAY 가 되어
  // 월초·연말에도 「이번 달 등록」 계약을 지킨다 (학생 수는 그대로 19명).
  { studentId: 9,  kindKey: 'class', subKey: 'sat-read', sessions: 8, startedOn: '2026-08-11' },
  { studentId: 15, kindKey: 'study', subKey: 'study-room', sessions: 20, startedOn: AUTHORED_ON },
];

/**
 * 상담 18건 — 1차 → 2차 대기 → 2차 → 보류 → 등록 / 실패.
 * §24 중단 지점은 **실패 당시 단계**(`failFrom` · W11 N-87)로 분류된다 — 실패 넷 중 셋에 그 단계를 적고(1차 · 2차 대기 · 2차),
 * 천보람(18)은 단계 기록이 없는 **옛 실패**로 남겨 「미분류」가 실제로 서게 한다(대응표 이관 없음 · N-25).
 * 옛 중단 지점(`stopAt`)은 넷 모두 그대로 둔다 — 읽기 전용 기록이다.
 * 유입 경로(`source` · C90 · N-44)는 깔때기 안의 여섯 건(7~12)에만 하나씩 — 나머지는 NULL 로 두어
 * 「경로 없음」 칩(옛 건 보정 0 · N-25)이 실제로 서는 표본을 남긴다. 접촉 원장(`lead_touch`)은 시드가 넣지 않는다.
 */
export const LEADS = [
  { id: 1,  name: '김민준', studentId: 1,  school: '대원외고',   ownerId: 3, stage: 'enrolled', createdAt: '2026-02-20' },
  { id: 2,  name: '박지우', studentId: 2,  school: '한영외고',   ownerId: 3, stage: 'enrolled', createdAt: '2025-08-14' },
  { id: 3,  name: '최유나', studentId: 3,  school: '대치중',     ownerId: 3, stage: 'enrolled', createdAt: '2026-05-22' },
  { id: 4,  name: '한서준', studentId: 4,  school: '휘문고',     ownerId: 4, stage: 'enrolled', createdAt: '2026-04-29' },
  { id: 5,  name: '권시우', studentId: 19, school: '압구정중',   ownerId: 3, stage: 'enrolled', createdAt: '2026-07-02' },
  { id: 6,  name: '백서현', studentId: 15, school: '언주중',     ownerId: 4, stage: 'enrolled', createdAt: '2026-06-04' },
  { id: 7,  name: '노현우', studentId: null, school: '세종고',   ownerId: 3, stage: 'first',    createdAt: '2026-08-26', source: 'kakao' },
  { id: 8,  name: '차서윤', studentId: null, school: '반포중',   ownerId: 3, stage: 'first',    createdAt: '2026-08-27', source: 'phone' },
  { id: 9,  name: '유하람', studentId: null, school: '경신고',   ownerId: 4, stage: 'wait2nd',  createdAt: '2026-08-24', source: 'instagram' },
  { id: 10, name: '남지완', studentId: null, school: '서초중',   ownerId: 3, stage: 'wait2nd',  createdAt: '2026-08-22', source: 'blog' },
  { id: 11, name: '표은결', studentId: null, school: '양재고',   ownerId: 4, stage: 'second',   createdAt: '2026-08-19', source: 'referral' },
  { id: 12, name: '구시온', studentId: null, school: '대명중',   ownerId: 3, stage: 'second',   createdAt: '2026-08-18', source: 'walkin' },
  { id: 13, name: '진예람', studentId: null, school: '숭의여고', ownerId: 4, stage: 'hold',     createdAt: '2026-08-11' },
  { id: 14, name: '홍은결', studentId: null, school: 'DIS',    ownerId: 3, stage: 'hold',     createdAt: '2026-08-08' },
  { id: 15, name: '고윤슬', studentId: null, school: '개포중',   ownerId: 3, stage: 'failed',   createdAt: '2026-08-05', stopAt: 'before_book', failFrom: 'first', reason: '전화 연결 실패 · 3회 회신 없음' },
  { id: 16, name: '류하은', studentId: null, school: '경기여고', ownerId: 4, stage: 'failed',   createdAt: '2026-08-03', stopAt: 'after_first', failFrom: 'wait2nd', reason: '수업료 부담' },
  { id: 17, name: '심우주', studentId: null, school: '삼성중',   ownerId: 3, stage: 'failed',   createdAt: '2026-07-29', stopAt: 'after_second', failFrom: 'second', reason: '시간대 불일치 — 주말반 요청' },
  { id: 18, name: '천보람', studentId: null, school: '휘경고',   ownerId: 4, stage: 'failed',   createdAt: '2026-07-24', stopAt: 'before_first', reason: '타 학원 등록' },
];

/**
 * 상담 단계 진단 점수 세 줄 (DQ1 대표 답변 2026-09-25 「점수만 저장 + 담당자가 선택」 · A-04) — 2차 상담·보류 건에만.
 *
 * 레벨·교재는 **담당자가 고른 값**을 적은 표본이다 — 점수에서 계산한 것이 아니고, 이 점수들로 경계를 읽어 내면 안 된다.
 * 11번(표은결)은 PDF A-04 의 표본 점수 62·71·58 을 그대로 쓰고, 12번(구시온)은 **아직 레벨·교재를 고르기 전**(점수만)이라
 * 화면의 「담당자가 고릅니다」 빈 칸이 실제로 선다. 교재 id 는 `outputs.LIBS` 의 행이다.
 */
export const LEAD_DIAGS = [
  { leadId: 11, english: 62, math: 71, interview: 58, takenOn: '2026-08-21', level: 'practice', bookId: 2, note: '어머니 동석 · SAT 수학 먼저 희망', createdBy: 4 },
  { leadId: 12, english: 48, math: 55, interview: 70, takenOn: '2026-08-20', level: null, bookId: null, note: null, createdBy: 3 },
  { leadId: 13, english: 81, math: 77, interview: 85, takenOn: '2026-08-13', level: 'master', bookId: 3, note: '수락 여부 확인 중', createdBy: 4 },
] as const;

/**
 * 배치안 초안 (23-16 · 24-07) — 2차 상담 · 보류 · 실패(「당시 배치안」) 건에만. 원본 §23 카드의 「SAT Reading 주2 · Rebecca」 모양.
 * 단가는 적지 않는다 — 읽을 때 적은 날의 단가표(RATE)가 붙는다. 강사는 시드의 유일한 강사(7 · 김재훈)다.
 */
export const LEAD_PLANS = [
  { leadId: 11, seq: 1, kindKey: 'class', subKey: 'sat-math', perWeek: 2, teacherId: 7, createdBy: 4, on: '2026-08-21' },
  { leadId: 13, seq: 1, kindKey: 'class', subKey: 'map-read', perWeek: 3, teacherId: 7, createdBy: 4, on: '2026-08-13' },
  { leadId: 13, seq: 2, kindKey: 'class', subKey: 'writing', perWeek: 2, teacherId: null, createdBy: 4, on: '2026-08-13' },
  { leadId: 14, seq: 1, kindKey: 'class', subKey: 'ap-chem', perWeek: 2, teacherId: 7, createdBy: 3, on: '2026-08-10' },
  { leadId: 17, seq: 1, kindKey: 'class', subKey: 'sat-read', perWeek: 2, teacherId: 7, createdBy: 3, on: '2026-07-31' },
] as const;

/**
 * 2차 · 진단 일정 (23-15) — 2차 대기 두 건. 시간표 회차는 만들지 않은 상태(「미생성」)라 「스케줄에 N건 만들기」가 실제로 선다.
 * 강의실 3 = 3층 컨설팅룸 · 1 = 2층 A강의실. 날짜는 rel() 로 시드 기준일에 맞춰 앞으로 밀린다.
 */
export const LEAD_APPTS = [
  { leadId: 9, kind: 'diag', onDate: '2026-08-31', startMin: 600, endMin: 660, mode: 'offline', roomId: 1, createdBy: 4 },
  { leadId: 9, kind: 'second', onDate: '2026-09-02', startMin: 870, endMin: 930, mode: 'offline', roomId: 3, createdBy: 4 },
  { leadId: 10, kind: 'second', onDate: '2026-09-01', startMin: 1140, endMin: 1200, mode: 'online', roomId: null, createdBy: 3 },
] as const;
