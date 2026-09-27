/** @file-guide
 * 목적: ops.ts — REQS, CHREQS, GPAPACKS, NOTIS, CONSULTINGS 등 (seed)
 * 책임/재사용: 격리 개발/테스트 자료 생성용이다. 기존 enum/키/참조 제약을 재사용하고 운영 데이터를 임의 수정하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 운영 — 할 일 · 알림 · 승인 요청 · 컨설팅 · 마케팅 · 기획 · 회의 · 컴플레인 · 보고.
 * 탭 10(§59~§67) 과 탭 11(§69~§73), 탭 02 서랍(§14~§21)이 이 데이터를 쓴다.
 */
import { addD } from '../lib/recurrence';
import { addMonths, LEAD_HAPPYCALL_DAYS, leadCareTitle, leadMonthlyOn } from '../lib/intake-words';
import { SEED_TODAY, WAGES } from './base';
import { expand, resolveExceptions } from './schedule';

const D = (n: number) => addD(SEED_TODAY, n);
const SCHEDULE_OCCURRENCES = expand();
const occurrenceDate = (serId: number, side: 'past' | 'future', nth = 1) => {
  const dates = SCHEDULE_OCCURRENCES
    .filter((o) => o.serId === serId && (side === 'past' ? o.onDate < SEED_TODAY : o.onDate >= SEED_TODAY))
    .map((o) => o.onDate);
  const hit = side === 'past' ? dates[dates.length - nth] : dates[nth - 1];
  if (!hit) throw new Error(`변경 요청 시드의 회차가 없습니다 — ser ${serId} ${side} ${nth}`);
  return hit;
};

/**
 * 승인 요청 — 우측 서랍 §14 승인 대기함.
 * 교재 변경 요청의 studentName 은 **시드 학생의 이름**이어야 한다 — §38 트래킹 보드가 이 이름이 학생 하나를 가리킬 때만
 * 그 학생 줄에 「강사 요청」 칩을 세운다(§38-8 · wave 6). 원문 컷의 표본 이름(강라율·고은성)은 시드 학생이 아니라 칩이 안 섰다.
 * 낱말은 컷 그대로 두고 학생만 컷과 같은 모양(중1 교재 41% · 고2 교재 67%)으로 골랐다.
 */
export const REQS = [
  { staffId: 7, reqType: 'book_change', payload: { studentName: '이서우', message: '너무 어렵습니다' }, state: 'pending', createdAt: D(0) },
  { staffId: 7, reqType: 'book_change', payload: { studentName: '송지호', message: '다 풀었습니다' }, state: 'pending', createdAt: D(-1) },
  { staffId: 7,  reqType: 'wage_change', payload: { from: WAGES.find((w) => w.staffId === 7)!.rate, to: 45000 }, state: 'pending', createdAt: D(-2) },
  { staffId: 7,  reqType: 'unav_add',    payload: { dow: 3, startMin: 540, endMin: 720 }, state: 'pending', createdAt: D(-1) },
  { staffId: 7, reqType: 'wage_change', payload: { from: 35000, to: 37000 }, state: 'rejected', resolvedBy: 1, rejectReason: '3개월 뒤 재검토', createdAt: D(-9) },
  { staffId: 7,  reqType: 'unav_add',    payload: { dow: 6, startMin: 840, endMin: 1080 }, state: 'approved', resolvedBy: 3, createdAt: D(-14) },
];

/** 변경 요청 — §19 넣기 · §20 이력 */
export const CHREQS = [
  // 승인 이력과 회차의 날짜·시간·사유는 같은 예외에서 파생한다.
  ...resolveExceptions(SCHEDULE_OCCURRENCES).filter((e) => e.startMin !== undefined).map((e) => ({
    serId: e.serId, onDate: e.onDate, reqType: 'time_move',
    payload: { startMin: e.startMin, endMin: e.endMin }, reason: e.reason,
    state: 'approved', byId: 7, resolvedBy: e.byId, applyAll: false, createdAt: e.onDate,
  })),
  { serId: 17, onDate: occurrenceDate(17, 'future'), reqType: 'cancel', payload: {}, reason: '병가', state: 'pending', byId: 7, applyAll: false, createdAt: D(-1) },
  { serId: 5,  onDate: occurrenceDate(5, 'past', 2), reqType: 'room', payload: { roomId: 1 }, reason: '송도 강의실이 좁습니다. 강남으로 옮겨 주세요', rejectReason: '강남 같은 시간대에 빈 강의실이 없습니다 — 10월 시간표에서 다시 봅니다', state: 'rejected', byId: 7, resolvedBy: 3, applyAll: true, createdAt: D(-12) },
];

/**
 * 자료 요청 — 결재 다섯 갈래의 다섯 번째 (§82 · D-R26).
 * 표는 처음부터 있었는데 시드가 비어 있어 「표가 없다」로 오해했다.
 * GPA **점수 저장**이 N-13 대기인 것이지 이 표가 없는 것이 아니다.
 */
export const GPAPACKS = [
  { studentId: 5,  packType: 'exam', detail: 'AP Chem 기출 5개년 + 오답 정리', state: 'pending',  createdAt: D(-1) },
  { studentId: 18, packType: 'self', detail: 'SAT Math 자습 패키지 (Level 2)', state: 'approved', createdAt: D(-8) },
];

/** 알림 — 앱 안에서만 (카카오 실발송은 출시 후) */
export const NOTIS = [
  { toId: 7,  fromId: 3, body: '리포트 5건이 밀려 있습니다. 오늘 자정까지 써 주세요.', link: '/reports/unwritten', category: 'report_due', createdAt: D(0) },
  { toId: 7,  fromId: 3, body: '리포트 3건이 밀려 있습니다.', link: '/reports/unwritten', category: 'report_due', createdAt: D(0) },
  { toId: 3,  fromId: 1, body: '주간 보고가 이틀째 결재 대기입니다.', link: '/reports/weekly', category: 'report', createdAt: D(-1) },
  { toId: 2,  fromId: 1, body: '컴플레인 2건이 모두 스케줄 통보 누락입니다. 재발 방지안을 주세요.', link: '/ops/complaints', category: 'request', createdAt: D(-1) },
  { toId: 4,  fromId: 1, body: '인스타 등록당 비용이 10만원을 넘었습니다. 9월 집행 재검토 바랍니다.', link: '/ops/marketing', category: 'request', createdAt: D(-2), readAt: D(-1) },
  // 대표에게 온 것 — §16 은 대표의 서랍이다. 하나도 없으면 「전부 읽음」 분기가 한 번도 안 돌아 본 적이 없게 된다
  { toId: 1,  fromId: 3, body: '4시간 이상 미작성 16건 — 재알람이 필요합니다.', link: '/reports/unwritten', category: 're_alarm', createdAt: D(0) },
  { toId: 1,  fromId: 3, body: 'Rebecca 스케줄 변경 요청 — 현지 학부모 면담', link: '/schedule', category: 'schedule', createdAt: D(-1) },
  // 보관 표본 (N-7 · D-16) — 30일 창 밖이라 목록에는 안 보이지만 **지운 것이 아니다**
  { toId: 1,  fromId: 2, body: '지난 분기 정산 마감 안내', link: '/accounting', category: 'etc', createdAt: D(-95) },
];

/**
 * 컨설팅 — 계약 5단계 → 진행 → 종료 (§26~§31).
 * 진행·종료 건은 계약 시작일(`startOn` → cons.start_on)을 갖는다 — 없으면 §27 기간이 「건이 생긴 날(시드 날짜) ~ 종료일」로 거꾸로 보였다(QA 0925).
 * 요청자(`requester` → cons.requester)와 시작일은 §29 시작 폼이 **처음부터 받는 값**이라 계약 단계 건도 갖는다
 * (impl3-w8 · 26-11) — 비워 두면 §26 카드가 담당만, §30 머리가 「요청자 미정 · 시작 미정」이라 원문과 달랐다.
 * 계약 단계 건의 시작일은 아직 오지 않은 **예정일**이다.
 */
export const CONSULTINGS = [
  { id: 1, consType: 'admissions', stage: 'running', contractStep: 5, amount: 8400000, sessions: 13, requester: 'mother', startOn: '2026-07-13', endOn: '2027-01-31', ownerId: 3, share: 'money_only', students: [5] },
  { id: 2, consType: 'essay',      stage: 'running', contractStep: 5, amount: 3600000, sessions: 8,  requester: 'father', startOn: '2026-08-03', endOn: '2026-12-20', ownerId: 7, share: 'money_only', students: [6] },
  { id: 3, consType: 'roadmap',    stage: 'contract', contractStep: 1, amount: 2800000, sessions: 6, requester: 'mother', startOn: '2026-10-12', endOn: '2027-02-28', ownerId: 3, share: 'money_only', students: [3] },
  // 공개 범위를 섞어 둔다 — 전부 money_only 면 두 번째 권한 층(csCan)이 한 번도 안 돈다.
  { id: 4, consType: 'admissions', stage: 'contract', contractStep: 3, amount: 7200000, sessions: 12, requester: 'mother', startOn: '2026-10-05', endOn: '2027-01-31', ownerId: 2, share: 'picked',  students: [1] },
  { id: 5, consType: 'admissions', stage: 'done',    contractStep: 5, amount: 8400000, sessions: 13, requester: 'father', startOn: '2026-03-02', endOn: '2026-08-15', ownerId: 7, share: 'private', students: [8] },
];

/**
 * 진단 리포트 (C61 · 강사 원문 슬라이드 20 「04 진단 리포트 · 신규 학생 첫 수업」).
 *
 * **한 명만 넣는다.** 이 표는 C61 전까지 0행이었고, 한 건도 없으면 강사 화면이 늘
 * 「진단 기록이 없습니다」라 적어 **읽기 갈래가 한 번도 안 돈다.** 반대로 다 채우면
 * 「아직 없음 → 쓰기」 갈래가 안 돈다. 그래서 담당 학생 하나만 채워 둔다.
 *
 * 강사 7 은 시리즈 1·2 의 담당이고 학생 1 은 그 두 수업에 다 들어 있다.
 */
export const DIAGS = [
  {
    studentId: 1, serId: 2, createdBy: 7,
    levelSummary: '학년 수준 독해는 되지만 논증 글쓰기에서 문단 사이 연결이 끊긴다.',
    strengths: '어휘 폭이 또래보다 넓고, 읽은 것을 자기 말로 옮기는 것을 잘한다.',
    weaknesses: '근거를 하나만 대고 넘어간다. 긴 지문 후반부에서 집중이 떨어진다.',
    curriculum: 'Writing 주 1회 유지 + 문단 연결 연습 4주. 이후 재진단.',
  },
];

/**
 * 컨설팅 납부 원장 (§28 · C58) — 받은 합은 어디에도 저장하지 않는다. 합계는 읽을 때 만든다 (D-R37).
 *
 * 다섯 갈래가 화면에 한 번씩은 보이게 깔았다 —
 *   1번 일부 납부(전환 가능) · 2번 완납(남은 돈 0 → 전환할 것 없음) ·
 *   3번 계약 1단계(수납 전이라 전환 불가) · 4번 지정 공개(두 번째 권한 층) · 5번 종료(납부 잠김).
 */
export const CONS_PAYS = [
  { consId: 1, amount: 3000000, paidOn: D(-40), memo: '계약금' },
  { consId: 1, amount: 1400000, paidOn: D(-10), memo: null },
  { consId: 2, amount: 3600000, paidOn: D(-25), memo: '일시납' },
  { consId: 5, amount: 8400000, paidOn: D(-120), memo: null },
];

/** share='picked' 일 때 볼 수 있는 사람 (CONS_PICK) */
export const CONS_PICKS = [
  { consId: 4, staffId: 3 },
];

/**
 * 컨설팅 항목 원장 (N-18 채택 §4-17 · 47D-B) — §31 원문의 국제학교 지원 기본 7항목만 시드한다.
 * essay·roadmap 유형의 기본 항목표는 확정 전(N-18-a)이라 비워 둔다 — 화면이 그 이유를 말한다.
 */
/**
 * GPA 4표 시드 (N-13 채택 · v2 §4.5) — 서비스 5종은 원문 포인트 그대로.
 * 현재 사이클은 원문 실측(배정 56 · 사용 32 · 대기 3 · 잔여 21)을 합계로 재현하고
 * 초과 표본 1명(학생 3: 8p 배정 − 10p 사용 = −2)을 둔다 — «붉게 + 안내» 경로가 화면에 보이게.
 */
export const GPASVCS = [
  { key: 'hw',   name: '숙제 지원',        point: 1, sort: 1 },
  { key: 'prj',  name: '프로젝트 피드백',  point: 2, sort: 2 },
  { key: 'quiz', name: 'Quiz 대비',        point: 2, sort: 3 },
  { key: 'test', name: 'Test 대비',        point: 4, sort: 4 },
  { key: 'self', name: '자습 지원',        point: 6, sort: 5 },
];
/**
 * 지난 3차 사이클은 **끝났지만 아직 마감하지 않은** 상태로 둔다 (C95 · O-150 「4주마다 — GPA 사이클 마감」의 할 일 표본).
 * 마감(`POST /gpa/cycles/{id}/close`)이 도장(closed_at/by)을 찍고 잔여를 소멸시킨다 — 시드가 `closed:true` 로 켜 두면 누가 언제 닫았는지 없는 행이 된다.
 */
export const GPA_CYCLES = [
  { id: 1, no: 3, fromDate: D(-41), toDate: D(-14), closed: false },
  { id: 2, no: 4, fromDate: D(-13), toDate: D(14), closed: false },
];
export const GPA_ALLOCS = [
  { cycleId: 2, studentId: 5, coordId: 3, points: 24 },
  { cycleId: 2, studentId: 8, coordId: 3, points: 24 },
  { cycleId: 2, studentId: 3, coordId: 4, points: 8 },
  { cycleId: 1, studentId: 5, coordId: 3, points: 20 },
];
export const GPA_USES = [
  // 학생 5 — ok 10p (hw1 + prj2 + self6 + hw1)
  { cycleId: 2, studentId: 5, serId: 15, svcKey: 'hw',   points: 1, onDate: D(-10), startMin: 1140, coordId: 3, state: 'ok' },
  { cycleId: 2, studentId: 5, serId: 15, svcKey: 'prj',  points: 2, onDate: D(-6),  startMin: 1140, coordId: 3, state: 'ok' },
  { cycleId: 2, studentId: 5, serId: null, svcKey: 'self', points: 6, onDate: D(-3), startMin: null, coordId: 3, state: 'ok' },
  { cycleId: 2, studentId: 5, serId: 15, svcKey: 'hw',   points: 1, onDate: D(-1),  startMin: 1140, coordId: 3, state: 'ok' },
  // 학생 8 — ok 12p (test4 + self6 + quiz2) + wait 3p (prj2 + hw1)
  { cycleId: 2, studentId: 8, serId: 15, svcKey: 'test', points: 4, onDate: D(-9), startMin: 1140, coordId: 3, state: 'ok' },
  { cycleId: 2, studentId: 8, serId: null, svcKey: 'self', points: 6, onDate: D(-5), startMin: null, coordId: 3, state: 'ok' },
  { cycleId: 2, studentId: 8, serId: 15, svcKey: 'quiz', points: 2, onDate: D(-2), startMin: 1140, coordId: 3, state: 'ok' },
  { cycleId: 2, studentId: 8, serId: null, svcKey: 'prj', points: 2, onDate: D(-1), startMin: null, coordId: 4, state: 'wait' },
  { cycleId: 2, studentId: 8, serId: null, svcKey: 'hw',  points: 1, onDate: D(0),  startMin: null, coordId: 3, state: 'wait' },
  // 학생 3 — 초과 표본: 8p 배정에 ok 10p (test4 + test4 + prj2)
  { cycleId: 2, studentId: 3, serId: null, svcKey: 'test', points: 4, onDate: D(-8), startMin: null, coordId: 4, state: 'ok' },
  { cycleId: 2, studentId: 3, serId: null, svcKey: 'test', points: 4, onDate: D(-4), startMin: null, coordId: 4, state: 'ok' },
  { cycleId: 2, studentId: 3, serId: null, svcKey: 'prj',  points: 2, onDate: D(-2), startMin: null, coordId: 4, state: 'ok' },
  // 지난 사이클(끝남 · 마감 대기) — 마감하면 20 − 6 = 14p 가 소멸한다
  { cycleId: 1, studentId: 5, serId: null, svcKey: 'self', points: 6, onDate: D(-20), startMin: null, coordId: 3, state: 'ok' },
];

export const INTL_SCHOOL_ITEMS = ['지원서 작성', '학업 성적 공증', '추천서 2부', '자기소개 에세이', '활동 증빙 자료', '여권 사본', '재학 증명서'] as const;
export const CONS_ITEMS = [
  // cons 1 — 진행 중: 4/7 완료 (처리자 김범준)
  ...INTL_SCHOOL_ITEMS.map((label, i) => ({ consId: 1, seq: i + 1, label, done: i < 4, doneBy: i < 4 ? 3 : null, doneAt: i < 4 ? D(-18 + i * 4) : null })),
  // cons 4 — 계약 중: 아직 0/7
  ...INTL_SCHOOL_ITEMS.map((label, i) => ({ consId: 4, seq: i + 1, label, done: false, doneBy: null, doneAt: null })),
  // cons 5 — 종료: 7/7 (종료 건 잠금 표본)
  ...INTL_SCHOOL_ITEMS.map((label, i) => ({ consId: 5, seq: i + 1, label, done: true, doneBy: 3, doneAt: D(-40 + i * 3) })),
];

export const CONS_SESSIONS = [
  { consId: 1, seq: 8, onDate: D(-2), who: '김범준 · 오예린', what: '보충 에세이 A대 2차 첨삭 · 문단 3개 재구성', why: 'A대 마감 09-15. 남은 5회 안에 3개 대학 보충분을 끝내야 함', how: '학생이 먼저 낭독 → 문단 단위 지적 → 그 자리에서 재작성' },
  { consId: 1, seq: 7, onDate: D(-9), who: '김범준 · 오예린', what: '공통 에세이 최종 확정', why: '9월 첫 주 제출분 확정 필요', how: '3안 비교 후 1안 채택' },
  { consId: 1, seq: 6, onDate: D(-16), who: '김범준 · 오예린', what: '추천서 요청 메일 발송', why: '교사 3인 회신에 2주 필요', how: '초안 작성 → 학생이 발송' },
  { consId: 2, seq: 3, onDate: D(-5), who: '김재훈 · 정하람', what: 'Body Paragraph 논거 재배치', why: '주제문과 근거 순서가 뒤집혀 있었음', how: 'MLA 형식 교정 병행' },
];

/**
 * 마케팅 (§59) — 1~4 는 **원문 컷 한 주의 넷**이다(W11 · N-29 ①②): 채널 × 항목은 따로 움직이고(시드의 1:1 짝을 풀었다)
 * 카드마다 제목 아래 메모 한 줄(`mkt.memo`)이 선다. 5 이후는 **옛 코드의 옛 행**이다 — 원문 넷에 대응이 없어
 * 옛 이름 그대로 읽힌다(`naver` 「네이버」 · 이관 없음 · N-25). 그때는 칸이 없어 옛 행에는 메모가 없다.
 */
export const MKTS: Array<{
  id: number; channel: string; item: string; url: string | null;
  result: Record<string, number>; onDate: string; title?: string; byId?: number; memo?: string;
}> = [
  { id: 1, channel: 'instagram',  item: 'video', url: 'https://ig.com/tnacademy/p/9f2', result: { impressions: 42180, clicks: 1204, inquiries: 18, booked: 12, enrolled: 6, cost: 640000 }, onDate: D(-1), title: '학습실 하루 · 30초 릴스', byId: 2, memo: '조회 1.2천' },
  { id: 2, channel: 'naver_blog', item: 'post',  url: 'https://blog.naver.com/tnacad',  result: { impressions: 18640, clicks: 842, inquiries: 11, booked: 8, enrolled: 4, cost: 0 }, onDate: D(-1), title: '강남 국제학교 준비 로드맵 · 8월', byId: 2, memo: 'MAP 준비 편 3부작 중 1편' },
  { id: 3, channel: 'kakao',      item: 'reply', url: null, result: { inquiries: 12, booked: 4, enrolled: 1, cost: 0 }, onDate: D(-3), title: '카카오채널 문의 12건 응대', byId: 4, memo: '상담 예약 4건 전환' },
  { id: 4, channel: 'naver_ad',   item: 'ad',    url: 'https://searchad.naver.com/tnacad', result: { impressions: 15200, clicks: 471, inquiries: 6, booked: 3, enrolled: 1, cost: 350000 }, onDate: D(-2), title: '검색광고 · 대치 국제학교 키워드', byId: 3, memo: '일 예산 5만 · CTR 3.1%' },
  // 옛 행 — 제목 · 메모 없음(카드 이름은 채널 · 항목의 옛 이름으로 선다)
  { id: 5, channel: 'naver',     item: 'blog',    url: 'https://blog.naver.com/tnacad',  result: { impressions: 9640, clicks: 402, inquiries: 5, booked: 3, enrolled: 2, cost: 0 }, onDate: D(-27) },
  { id: 6, channel: 'daangn',    item: 'biz',     url: 'https://daangn.com/kr/biz/tn',   result: { impressions: 9320, clicks: 410, inquiries: 7, booked: 5, enrolled: 2, cost: 180000 }, onDate: D(-27) },
  { id: 7, channel: 'kakao',     item: 'channel', url: 'https://pf.kakao.com/_tnacad',   result: { impressions: 6140, clicks: 388, inquiries: 5, booked: 3, enrolled: 1, cost: 120000 }, onDate: D(-27) },
  { id: 8, channel: 'youtube',   item: 'video',   url: 'https://youtube.com/@tnacademy', result: { impressions: 12400, clicks: 214, inquiries: 3, booked: 1, enrolled: 0, cost: 320000 }, onDate: D(-27) },
  { id: 9, channel: 'referral',  item: 'word',    url: null, result: { inquiries: 4, booked: 4, enrolled: 3, cost: 0 }, onDate: D(-27) },
  { id: 10, channel: 'flyer',    item: 'print',   url: null, result: { impressions: 3000, inquiries: 0, booked: 1, enrolled: 0, cost: 90000 }, onDate: D(-27) },
];

/**
 * §60 대표 피드백 — 원문 카드 두 장 그대로.
 *
 * 위 글타래는 대표 코멘트에 담당자 답이 달려 **「고쳤습니다」**, 아래는 답이 없어
 * **「확인 필요」** 다. 이 한 쌍이 있어야 §60 머리의 「고쳐야 할 것 1건」이 실제로 1 이 된다.
 * 판정을 시드가 적지 않는다 — 서버가 parent_id 를 보고 정한다 (D-R39).
 */
export const MFBS: Array<{
  id: number; mktId: number; byId: number; kind: 'comment' | 'reply'; parentId: number | null;
  body: string; at: string;
}> = [
  { id: 1, mktId: 2, byId: 1, kind: 'comment', parentId: null,
    body: '제목이 길어 검색에 안 걸립니다. 키워드를 앞에 두세요.', at: `${D(-23)}T21:15:00+09:00` },
  { id: 2, mktId: 2, byId: 2, kind: 'reply', parentId: 1,
    body: "제목을 '국제학교 준비 로드맵 | 강남 TN'으로 바꿨습니다.", at: `${D(-22)}T09:30:00+09:00` },
  { id: 3, mktId: 1, byId: 1, kind: 'comment', parentId: null,
    body: '릴스 첫 3초에 학원명이 안 보입니다. 로고를 앞으로 빼주세요.', at: `${D(-23)}T21:10:00+09:00` },
];

/** 기획 — 5단계 (§61) */
export const PLANS = [
  { id: 1, title: '9월 인스타 광고 집행안', stage: 'review', goal: '9월 등록 6건을 인스타 단독으로 만들되 등록당 비용을 8만원 아래로 내린다', research: '8월 게시물 14건 중 문의를 만든 것은 4건. 전부 합격 후기 형식.', ask: '① 예산 640,000 → 400,000 ② 차액을 블로그 대행에 ③ 후기형 60% 고정', dueOn: D(-1), ownerId: 4 },
  { id: 2, title: '교재 재고 회전율 개선안', stage: 'review', goal: '사장 재고를 줄인다', research: '20권 매입분 중 6권만 나감', ask: '매입 단위를 10권으로', dueOn: D(-2), ownerId: 4 },
  { id: 3, title: '9월 신규 강사 채용안',   stage: 'rework', goal: '주말 수요 대응', research: null, ask: '인건비 3개월치 추정 필요', dueOn: D(-4), ownerId: 2 },
  { id: 4, title: '겨울 특강 커리큘럼 초안', stage: 'draft',  goal: '12월 특강 3종', research: null, ask: null, dueOn: D(2), ownerId: 3 },
  // 승인 칸 건은 기한 승인을 거친 뒤다 — 규칙상 기한 승인 없이 최종 승인이 열리지 않는다(C56 · impl3-w8 61-9). 기한 승인은 대표(1)
  { id: 5, title: '출결 일괄 확정 도입',     stage: 'approved', goal: '출결 확인율 95% 이상', research: '금요일 일괄 확정 도입 후 94.1% → 97.4%', ask: '승인 완료', dueOn: D(-4), ownerId: 2, dueApprovedAt: D(-6), dueApprovedBy: 1 },
];

/** 회의 5종 (§63 · §66) */
/*
 * `serId` — 이어진 하루짜리 회의 회차(`schedule.SERS` 24~27 · impl3-w8 63-3). §63 줄의 시각·자리는 그 회차에서 읽는다.
 * 5번은 **옛 기록**으로 둔다(연결 없음 → 「시각 없음」) — 모두 이으면 그 갈래가 시드에서 한 번도 안 돈다.
 */
export const MEETINGS: Array<{ id: number; mtType: string; title: string; onDate: string; minutes: string | null; attendees: number[]; serId: number | null }> = [
  { id: 1, mtType: 'plan',      title: '9월 마케팅 집행 확정 회의', onDate: D(0),  minutes: null, attendees: [1, 2, 3, 4, 7], serId: 24 },
  { id: 2, mtType: 'consulting', title: '대학 원서 마감 일정 점검',  onDate: D(0),  minutes: null, attendees: [3, 7], serId: 25 },
  { id: 3, mtType: 'general',   title: '주간 운영 회의 (35주차)',   onDate: D(3),  minutes: null, attendees: [1, 2, 3, 4, 7], serId: 26 },
  { id: 4, mtType: 'marketing', title: '8월 채널별 성과 리뷰',      onDate: D(-2), minutes: '채널별 등록당 비용을 비교. 인스타 재검토 결정.', attendees: [1, 2, 3, 4, 7], serId: 27 },
  { id: 5, mtType: 'general',   title: '주간 운영 회의 (34주차)',   onDate: D(-4), minutes: '리포트 작성률 하락 원인 공유. 배정 분산 합의.', attendees: [1, 2, 3, 4, 7], serId: null },
];

/**
 * 컴플레인 — 영역 5종 · 접수 → 대응 → 결과 (§67).
 * 심각도(`severity` · light | normal | severe)는 접수 때 고르는 값이다 — 비워 두면 §67 카드의 칩이 하나도 안 섰다
 * (impl3-w8 · 67-8). 지난 건 하나(8)는 심각도를 모르는 옛 기록으로 남긴다 — 칩 없는 갈래도 화면에 보이게.
 */
/*
 * 문의자 관계(`requester` · 67-5)와 마무리 시각(`closedAt` · 67-6)은 w6-2 가 더한 칸이다 — 화면 확인용 표본을 섞어 둔다.
 * 마무리 시각은 「결과」 칸의 건에만 적는다(`cpl_closed_at_stage` — 열린 건에 마무리 날짜가 있으면 거짓이다).
 * 관계를 비워 둔 건도 남긴다 — 운영의 옛 행은 NULL 이고 화면이 「—」로 읽는 것을 함께 본다.
 */
export const COMPLAINTS: Array<{
  area: string; studentId: number | null; stage: string; body: string; action?: string; result?: string;
  teacherChanged: boolean; ownerId: number; createdAt: string; severity: 'light' | 'normal' | 'severe' | null;
  requester?: 'mother' | 'father'; closedAt?: string;
}> = [
  { area: 'schedule', studentId: 9,  stage: 'received', body: '스케줄 변경을 통보받지 못했습니다.', teacherChanged: false, ownerId: 2, createdAt: D(-1), severity: 'severe', requester: 'mother' },
  { area: 'teacher',  studentId: 5,  stage: 'received', body: '수업 시작이 10분씩 반복해서 늦습니다.', teacherChanged: false, ownerId: 4, createdAt: D(-1), severity: 'normal', requester: 'father' },
  { area: 'book',     studentId: 4,  stage: 'acting',   body: '교재 배송이 3일 지연됐습니다.', action: '통화 완료 · 재발송 처리 중', teacherChanged: false, ownerId: 4, createdAt: D(-5), severity: 'normal', requester: 'mother' },
  { area: 'lesson',   studentId: 7,  stage: 'acting',   body: '그룹 수업 인원이 너무 많습니다.', action: '분반 검토 중 · 09-01 회신 약속', teacherChanged: false, ownerId: 3, createdAt: D(-6), severity: 'light' },
  { area: 'intake',   studentId: null, stage: 'acting', body: '상담 예약 시간이 착오로 잡혔습니다.', action: '사과 + 재예약 완료', teacherChanged: false, ownerId: 3, createdAt: D(-8), severity: 'light' },
  { area: 'lesson',   studentId: 11, stage: 'closed',   body: '수업 취소 환불이 지연됩니다.', action: '환불 처리', result: '08-24 환불 완료', teacherChanged: false, ownerId: 2, createdAt: D(-12), severity: 'severe', requester: 'mother', closedAt: D(-9) },
  { area: 'lesson',   studentId: 2,  stage: 'closed',   body: '리포트 내용이 부실합니다.', action: '재작성 요청', result: '08-22 재작성 전달', teacherChanged: true, ownerId: 3, createdAt: D(-14), severity: 'normal', requester: 'father', closedAt: D(-11) },
  { area: 'book',     studentId: 10, stage: 'closed',   body: '교재가 파본입니다.', action: '교체 발송', result: '08-20 교체 완료', teacherChanged: false, ownerId: 4, createdAt: D(-16), severity: null },
];

/** 건의 사항 — 강사 창구 (§Data/Suggestion Card) */
export const SUGGESTIONS = [
  { staffId: 7,  category: 'schedule', body: '화요일 저녁 슬롯이 너무 붙어 있습니다. 30분 간격을 주세요.', state: 'open',      createdAt: D(-2) },
  { staffId: 7,  category: 'lesson',   body: 'MAP Math 그룹 인원을 4명 이하로 유지해 주세요.', state: 'reviewing', createdAt: D(-6) },
  { staffId: 7, category: 'pay',      body: '지각 차감 기준을 강사 화면에도 표시해 주세요.', state: 'done', reply: '리포트 화면과 수업 히스토리에 지각 차감 구간표를 넣었습니다.', replyBy: 3, replyAt: D(-3), createdAt: D(-11) },
  { staffId: 7,  category: 'etc',      body: '3층 회의실 프로젝터 교체 요청합니다.', state: 'open', createdAt: D(-40) },
];

/** 대표 보고 — 일 · 주 · 월 (§69~§71) */
/**
 * 대표 보고 — §69~§71.
 *
 * **서명은 시각과 사람이 짝이다** (`rpt_sign_pair` CHECK · C85-a). `sentAt` 을 적으면 `sentBy` 를,
 * `reviewedAt` 을 적으면 `reviewedBy` 를 **반드시 함께** 적어야 한다 — 한쪽만 있으면 DB 가 막는다.
 * 올린 사람은 관리자(김민수 2), 결재는 **대표만**(김민선 1) 한다.
 */
/*
 * 메모는 **6영역 모양**(`lib/exec-areas` EXEC_AREA_KEYS — money · mkt · ops · consulting · complaint · lesson)이다.
 * 한동안 옛 `{ note }` 한 칸이라 §73 결재함이 모두 「0/6 적음」이었다 — 영역 칸이 아니면 세지 않는다(impl3-w8 · 73-4).
 * 적은 칸 수를 섞어 둔다(1 · 2 · 3 · 4 · 6) — 다 같으면 「N/6」이 무엇을 세는지 화면에서 안 보인다.
 */
export const REPORTS = [
  { rptType: 'day',   onDate: D(-4), memo: { money: '카드 결제 2건은 내일 입금 확인합니다.', ops: '출결 미확인 2건은 야간 수업이라 다음 날 정리됩니다.', lesson: '야간 AP Chem 2회차 교재 배부 완료.' }, state: 'sent',   sentAt: D(-4), sentBy: 2 },
  { rptType: 'day',   onDate: D(-3), memo: { ops: '특이사항 없습니다.' }, state: 'sent',   sentAt: D(-3), sentBy: 2 },
  { rptType: 'day',   onDate: D(-2), memo: { ops: '리포트 독촉 3건 발송했습니다.', complaint: '컴플레인 1건 접수 — 오늘 중 통화 예정입니다.' }, state: 'sent', sentAt: D(-2), sentBy: 2 },
  { rptType: 'day',   onDate: D(-1), memo: {
    money: '8월 미납 1건 통화 — 이번 주 금요일 입금 약속.', mkt: '인스타 릴스 문의 2건, 둘 다 상담 예약으로 이어졌습니다.',
    ops: '리포트 독촉 5건 발송했습니다.', consulting: '원서 마감 점검 회의 일정 확정.',
    complaint: '어제 접수 건 통화 완료 — 재발 방지로 변경 문자 발송을 매니저가 확인합니다.', lesson: '대강 없이 전 수업 진행.',
  }, state: 'ok', sentAt: D(-1), sentBy: 2, reviewedAt: D(0), reviewedBy: 1 },
  { rptType: 'week',  onDate: D(-4), memo: {
    money: '주간 입금 12건 · 미납 2건.', ops: '리포트 작성률 3.4%p 하락은 한 강사에게 몰린 결과입니다. 배정을 나눴습니다.',
    complaint: '스케줄 통보 누락 2건 — 변경 알림을 보호자에게도 보내기로 했습니다.', lesson: '그룹 수업 인원 조정 검토 중.',
  }, state: 'sent', sentAt: D(-3), sentBy: 3 },
  { rptType: 'month', onDate: '2026-08-01', memo: { money: '영업이익률 35.4% — 목표 32% 대비 +3.4%p.', mkt: '인스타 등록당 비용이 10만원을 넘어 9월 집행을 재검토합니다.' }, state: 'draft' },
];

/**
 * 등록 뒤 사후 관리 (W11 · N-86) — 등록 확정이 만드는 할 일의 표본. 기준일은 첫 실제 수업(`lead.first_lesson_on`)이고
 * 해피콜은 +7일, 월간 상담은 다음 달부터 같은 날(없으면 말일)이다 — 날짜는 제품과 같은 함수(`lib/intake-words`)로 짓는다.
 *   · 최유나(상담 3) — 해피콜 · 첫 월간을 마쳐 「정기 관리 중」, 월간이 두 번 이어져 셋째 달이 열려 있다
 *   · 권시우(상담 5) — 해피콜 D-3 · 첫 월간 예정 (원문 컷 홍채원 카드의 띠)
 *   · 백서현(상담 6) — 해피콜 완료 · 첫 월간이 지났다(띠가 「지남」)
 * 나머지 등록 건(1 · 2 · 4)은 N-86 이전 등록이라 할 일이 없다 — 카드가 「없음」으로 읽는다(한 적 없는 것을 짓지 않는다 · N-25).
 */
export const LEAD_CARE_FIRST: Record<number, string> = { 3: D(-75), 5: D(-4), 6: D(-40) };
const careMonthlyOn = (leadId: number, n: number): string =>
  leadMonthlyOn(LEAD_CARE_FIRST[leadId]!, addMonths(LEAD_CARE_FIRST[leadId]!.slice(0, 7), n));
const LEAD_CARE_TODOS: Array<{ title: string; toId: number; fromId: number; dueOn: string; done: boolean; src: 'lead'; leadId: number; care: 'happycall' | 'monthly' }> = [
  { title: leadCareTitle('happycall', '최유나'), toId: 3, fromId: 2, dueOn: addD(LEAD_CARE_FIRST[3]!, LEAD_HAPPYCALL_DAYS), done: true, src: 'lead', leadId: 3, care: 'happycall' },
  { title: leadCareTitle('monthly', '최유나'), toId: 3, fromId: 2, dueOn: careMonthlyOn(3, 1), done: true, src: 'lead', leadId: 3, care: 'monthly' },
  { title: leadCareTitle('monthly', '최유나'), toId: 3, fromId: 3, dueOn: careMonthlyOn(3, 2), done: true, src: 'lead', leadId: 3, care: 'monthly' },
  { title: leadCareTitle('monthly', '최유나'), toId: 3, fromId: 3, dueOn: careMonthlyOn(3, 3), done: false, src: 'lead', leadId: 3, care: 'monthly' },
  { title: leadCareTitle('happycall', '권시우'), toId: 3, fromId: 2, dueOn: addD(LEAD_CARE_FIRST[5]!, LEAD_HAPPYCALL_DAYS), done: false, src: 'lead', leadId: 5, care: 'happycall' },
  { title: leadCareTitle('monthly', '권시우'), toId: 3, fromId: 2, dueOn: careMonthlyOn(5, 1), done: false, src: 'lead', leadId: 5, care: 'monthly' },
  { title: leadCareTitle('happycall', '백서현'), toId: 4, fromId: 2, dueOn: addD(LEAD_CARE_FIRST[6]!, LEAD_HAPPYCALL_DAYS), done: true, src: 'lead', leadId: 6, care: 'happycall' },
  { title: leadCareTitle('monthly', '백서현'), toId: 4, fromId: 2, dueOn: careMonthlyOn(6, 1), done: false, src: 'lead', leadId: 6, care: 'monthly' },
];

/** 할 일 — 회의·컴플레인·기획에서 자동으로 모인다 (§64) · 등록 확정이 만든 사후 관리(W11 · N-86)도 여기 선다 */
export const TODOS = [
  { title: '컴플레인 2건 학부모 통화', toId: 2, fromId: 1, dueOn: D(0),  done: false, src: 'complaint' },
  { title: '프린터 토너 영수증 첨부',   toId: 4, fromId: 2, dueOn: D(0),  done: false, src: 'manual' },
  { title: '리포트 독촉 5건 발송',      toId: 2, fromId: 3, dueOn: D(0),  done: true,  src: 'manual' },
  { title: '9월 인스타 광고 집행안 마무리', toId: 4, fromId: 1, dueOn: D(1), done: false, src: 'plan', planId: 1 },
  { title: '대학 원서 마감 일정표 배포', toId: 3, fromId: 3, dueOn: D(1), done: false, src: 'meeting', mtId: 2 },
  { title: '교재 재고 회전율 자료 정리', toId: 4, fromId: 2, dueOn: D(2), done: false, src: 'plan', planId: 2 },
  { title: '8월 강사료 정산 입금 처리',  toId: 2, fromId: 1, dueOn: D(3), done: false, src: 'manual' },
  { title: '8월 채널별 성과 표 정리',    toId: 4, fromId: 2, dueOn: D(1), done: false, src: 'meeting', mtId: 4 },
  ...LEAD_CARE_TODOS,
];
