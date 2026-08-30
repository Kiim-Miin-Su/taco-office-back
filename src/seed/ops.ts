/**
 * 운영 — 할 일 · 알림 · 승인 요청 · 컨설팅 · 마케팅 · 기획 · 회의 · 컴플레인 · 보고.
 * 탭 10(§59~§67) 과 탭 11(§69~§73), 탭 02 서랍(§14~§21)이 이 데이터를 쓴다.
 */
import { addD } from '../lib/recurrence';
import { SEED_TODAY } from './base';

const D = (n: number) => addD(SEED_TODAY, n);

/** 승인 요청 — 우측 서랍 §14 승인 대기함 */
export const REQS = [
  { staffId: 6,  reqType: 'wage_change', payload: { from: 42000, to: 45000 }, state: 'pending', createdAt: D(-2) },
  { staffId: 9,  reqType: 'unav_add',    payload: { dow: 3, startMin: 540, endMin: 720 }, state: 'pending', createdAt: D(-1) },
  { staffId: 12, reqType: 'wage_change', payload: { from: 35000, to: 37000 }, state: 'rejected', resolvedBy: 1, rejectReason: '3개월 뒤 재검토', createdAt: D(-9) },
  { staffId: 7,  reqType: 'unav_add',    payload: { dow: 6, startMin: 840, endMin: 1080 }, state: 'approved', resolvedBy: 3, createdAt: D(-14) },
];

/** 변경 요청 — §19 넣기 · §20 이력 */
export const CHREQS = [
  { serId: 3,  onDate: D(-2), reqType: 'time_move', payload: { startMin: 1080, endMin: 1170 }, reason: '학교 시험 기간이라 1시간 미뤄 주세요', state: 'approved', byId: 7, resolvedBy: 3, applyAll: false, createdAt: D(-6) },
  { serId: 9,  onDate: D(-4), reqType: 'teacher',   payload: { teacherId: 15 }, reason: '개인 사정으로 하루 대강 부탁드립니다', state: 'approved', byId: 12, resolvedBy: 3, applyAll: false, createdAt: D(-7) },
  { serId: 17, onDate: D(2),  reqType: 'cancel',    payload: {}, reason: '병가', state: 'pending', byId: 10, applyAll: false, createdAt: D(-1) },
  { serId: 5,  onDate: null,  reqType: 'room',      payload: { roomId: 1 }, reason: '송도 강의실이 좁습니다. 강남으로 옮겨 주세요', state: 'rejected', byId: 9, resolvedBy: 3, applyAll: true, createdAt: D(-12) },
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
  { toId: 6,  fromId: 3, body: '리포트 5건이 밀려 있습니다. 오늘 자정까지 써 주세요.', link: '/reports/unwritten', createdAt: D(0) },
  { toId: 7,  fromId: 3, body: '리포트 3건이 밀려 있습니다.', link: '/reports/unwritten', createdAt: D(0) },
  { toId: 3,  fromId: 1, body: '주간 보고가 이틀째 결재 대기입니다.', link: '/reports/weekly', createdAt: D(-1) },
  { toId: 2,  fromId: 1, body: '컴플레인 2건이 모두 스케줄 통보 누락입니다. 재발 방지안을 주세요.', link: '/ops/complaints', createdAt: D(-1) },
  { toId: 4,  fromId: 1, body: '인스타 등록당 비용이 10만원을 넘었습니다. 9월 집행 재검토 바랍니다.', link: '/ops/marketing', createdAt: D(-2), readAt: D(-1) },
];

/** 컨설팅 — 계약 5단계 → 진행 → 종료 (§26~§31) */
export const CONSULTINGS = [
  { id: 1, consType: 'admissions', stage: 'running', contractStep: 5, amount: 8400000, sessions: 13, endOn: '2027-01-31', ownerId: 3, share: 'money_only', students: [5] },
  { id: 2, consType: 'essay',      stage: 'running', contractStep: 5, amount: 3600000, sessions: 8,  endOn: '2026-12-20', ownerId: 6, share: 'money_only', students: [6] },
  { id: 3, consType: 'roadmap',    stage: 'contract', contractStep: 1, amount: 2800000, sessions: 6, endOn: '2027-02-28', ownerId: 3, share: 'money_only', students: [3] },
  // 공개 범위를 섞어 둔다 — 전부 money_only 면 두 번째 권한 층(csCan)이 한 번도 안 돈다.
  { id: 4, consType: 'admissions', stage: 'contract', contractStep: 3, amount: 7200000, sessions: 12, endOn: '2027-01-31', ownerId: 2, share: 'picked',  students: [1] },
  { id: 5, consType: 'admissions', stage: 'done',    contractStep: 5, amount: 8400000, sessions: 13, endOn: '2026-08-15', ownerId: 6, share: 'private', students: [8] },
];

/** share='picked' 일 때 볼 수 있는 사람 (CONS_PICK) */
export const CONS_PICKS = [
  { consId: 4, staffId: 3 },
];

export const CONS_SESSIONS = [
  { consId: 1, seq: 8, onDate: D(-2), who: '이수현 · 오예린', what: '보충 에세이 A대 2차 첨삭 · 문단 3개 재구성', why: 'A대 마감 09-15. 남은 5회 안에 3개 대학 보충분을 끝내야 함', how: '학생이 먼저 낭독 → 문단 단위 지적 → 그 자리에서 재작성' },
  { consId: 1, seq: 7, onDate: D(-9), who: '이수현 · 오예린', what: '공통 에세이 최종 확정', why: '9월 첫 주 제출분 확정 필요', how: '3안 비교 후 1안 채택' },
  { consId: 1, seq: 6, onDate: D(-16), who: '이수현 · 오예린', what: '추천서 요청 메일 발송', why: '교사 3인 회신에 2주 필요', how: '초안 작성 → 학생이 발송' },
  { consId: 2, seq: 3, onDate: D(-5), who: '김서영 · 정하람', what: 'Body Paragraph 논거 재배치', why: '주제문과 근거 순서가 뒤집혀 있었음', how: 'MLA 형식 교정 병행' },
];

/** 마케팅 — 채널 7종 (§59) */
export const MKTS = [
  { channel: 'instagram', item: 'ad',      url: 'https://ig.com/tnacademy/p/9f2', result: { impressions: 42180, clicks: 1204, inquiries: 18, booked: 12, enrolled: 6, cost: 640000 }, onDate: D(-27) },
  { channel: 'naver',     item: 'blog',    url: 'https://blog.naver.com/tnacad',  result: { impressions: 18640, clicks: 842, inquiries: 11, booked: 8, enrolled: 4, cost: 0 }, onDate: D(-27) },
  { channel: 'daangn',    item: 'biz',     url: 'https://daangn.com/kr/biz/tn',   result: { impressions: 9320, clicks: 410, inquiries: 7, booked: 5, enrolled: 2, cost: 180000 }, onDate: D(-27) },
  { channel: 'kakao',     item: 'channel', url: 'https://pf.kakao.com/_tnacad',   result: { impressions: 6140, clicks: 388, inquiries: 5, booked: 3, enrolled: 1, cost: 120000 }, onDate: D(-27) },
  { channel: 'youtube',   item: 'video',   url: 'https://youtube.com/@tnacademy', result: { impressions: 12400, clicks: 214, inquiries: 3, booked: 1, enrolled: 0, cost: 320000 }, onDate: D(-27) },
  { channel: 'referral',  item: 'word',    url: null, result: { inquiries: 4, booked: 4, enrolled: 3, cost: 0 }, onDate: D(-27) },
  { channel: 'flyer',     item: 'print',   url: null, result: { impressions: 3000, inquiries: 0, booked: 1, enrolled: 0, cost: 90000 }, onDate: D(-27) },
];

/** 기획 — 5단계 (§61) */
export const PLANS = [
  { id: 1, title: '9월 인스타 광고 집행안', stage: 'review', goal: '9월 등록 6건을 인스타 단독으로 만들되 등록당 비용을 8만원 아래로 내린다', research: '8월 게시물 14건 중 문의를 만든 것은 4건. 전부 합격 후기 형식.', ask: '① 예산 640,000 → 400,000 ② 차액을 블로그 대행에 ③ 후기형 60% 고정', dueOn: D(-1), ownerId: 4 },
  { id: 2, title: '교재 재고 회전율 개선안', stage: 'review', goal: '사장 재고를 줄인다', research: '20권 매입분 중 6권만 나감', ask: '매입 단위를 10권으로', dueOn: D(-2), ownerId: 4 },
  { id: 3, title: '9월 신규 강사 채용안',   stage: 'rework', goal: '주말 수요 대응', research: null, ask: '인건비 3개월치 추정 필요', dueOn: D(-4), ownerId: 2 },
  { id: 4, title: '겨울 특강 커리큘럼 초안', stage: 'draft',  goal: '12월 특강 3종', research: null, ask: null, dueOn: D(2), ownerId: 3 },
  { id: 5, title: '출결 일괄 확정 도입',     stage: 'approved', goal: '출결 확인율 95% 이상', research: '금요일 일괄 확정 도입 후 94.1% → 97.4%', ask: '승인 완료', dueOn: D(-4), ownerId: 2 },
];

/** 회의 5종 (§63 · §66) */
export const MEETINGS = [
  { id: 1, mtType: 'plan',      title: '9월 마케팅 집행 확정 회의', onDate: D(0),  minutes: null, attendees: [1, 2, 3, 4, 6] },
  { id: 2, mtType: 'consulting', title: '대학 원서 마감 일정 점검',  onDate: D(0),  minutes: null, attendees: [3, 6, 8] },
  { id: 3, mtType: 'general',   title: '주간 운영 회의 (35주차)',   onDate: D(3),  minutes: null, attendees: [1, 2, 3, 4, 5, 6, 7, 8] },
  { id: 4, mtType: 'marketing', title: '8월 채널별 성과 리뷰',      onDate: D(-2), minutes: '채널별 등록당 비용을 비교. 인스타 재검토 결정.', attendees: [1, 2, 4, 5, 6] },
  { id: 5, mtType: 'general',   title: '주간 운영 회의 (34주차)',   onDate: D(-4), minutes: '리포트 작성률 하락 원인 공유. 배정 분산 합의.', attendees: [1, 2, 3, 4, 5, 6, 7] },
];

/** 컴플레인 — 영역 5종 · 접수 → 대응 → 결과 (§67) */
export const COMPLAINTS = [
  { area: 'schedule', studentId: 9,  stage: 'received', body: '스케줄 변경을 통보받지 못했습니다.', teacherChanged: false, ownerId: 2, createdAt: D(-1) },
  { area: 'teacher',  studentId: 5,  stage: 'received', body: '수업 시작이 10분씩 반복해서 늦습니다.', teacherChanged: false, ownerId: 4, createdAt: D(-1) },
  { area: 'book',     studentId: 4,  stage: 'acting',   body: '교재 배송이 3일 지연됐습니다.', action: '통화 완료 · 재발송 처리 중', teacherChanged: false, ownerId: 4, createdAt: D(-5) },
  { area: 'lesson',   studentId: 7,  stage: 'acting',   body: '그룹 수업 인원이 너무 많습니다.', action: '분반 검토 중 · 09-01 회신 약속', teacherChanged: false, ownerId: 3, createdAt: D(-6) },
  { area: 'intake',   studentId: null, stage: 'acting', body: '상담 예약 시간이 착오로 잡혔습니다.', action: '사과 + 재예약 완료', teacherChanged: false, ownerId: 5, createdAt: D(-8) },
  { area: 'lesson',   studentId: 11, stage: 'closed',   body: '수업 취소 환불이 지연됩니다.', action: '환불 처리', result: '08-24 환불 완료', teacherChanged: false, ownerId: 2, createdAt: D(-12) },
  { area: 'lesson',   studentId: 2,  stage: 'closed',   body: '리포트 내용이 부실합니다.', action: '재작성 요청', result: '08-22 재작성 전달', teacherChanged: true, ownerId: 3, createdAt: D(-14) },
  { area: 'book',     studentId: 10, stage: 'closed',   body: '교재가 파본입니다.', action: '교체 발송', result: '08-20 교체 완료', teacherChanged: false, ownerId: 4, createdAt: D(-16) },
];

/** 건의 사항 — 강사 창구 (§Data/Suggestion Card) */
export const SUGGESTIONS = [
  { staffId: 6,  category: 'schedule', body: '화요일 저녁 슬롯이 너무 붙어 있습니다. 30분 간격을 주세요.', state: 'open',      createdAt: D(-2) },
  { staffId: 9,  category: 'lesson',   body: 'MAP Math 그룹 인원을 4명 이하로 유지해 주세요.', state: 'reviewing', createdAt: D(-6) },
  { staffId: 12, category: 'pay',      body: '지각 차감 기준을 강사 화면에도 표시해 주세요.', state: 'done', reply: '§47 화면에 구간표를 넣었습니다.', replyBy: 3, replyAt: D(-3), createdAt: D(-11) },
  { staffId: 7,  category: 'etc',      body: '3층 회의실 프로젝터 교체 요청합니다.', state: 'open', createdAt: D(-4) },
];

/** 대표 보고 — 일 · 주 · 월 (§69~§71) */
export const REPORTS = [
  { rptType: 'day',   onDate: D(-4), memo: { note: '출결 미확인 2건은 야간 수업이라 다음 날 정리됩니다.' }, state: 'sent',   sentAt: D(-4) },
  { rptType: 'day',   onDate: D(-3), memo: { note: '특이사항 없습니다.' }, state: 'sent',   sentAt: D(-3) },
  { rptType: 'day',   onDate: D(-2), memo: { note: '컴플레인 1건 접수 — 오늘 중 통화 예정입니다.' }, state: 'sent', sentAt: D(-2) },
  { rptType: 'day',   onDate: D(-1), memo: { note: '리포트 독촉 5건 발송했습니다.' }, state: 'ok', sentAt: D(-1), reviewedAt: D(0) },
  { rptType: 'week',  onDate: D(-4), memo: { note: '리포트 작성률 3.4%p 하락은 한 강사에게 몰린 결과입니다. 배정을 나눴습니다.' }, state: 'sent', sentAt: D(-3) },
  { rptType: 'month', onDate: '2026-08-01', memo: { note: '영업이익률 35.4% — 목표 32% 대비 +3.4%p.' }, state: 'draft' },
];

/** 할 일 — 회의·컴플레인·기획에서 자동으로 모인다 (§64) */
export const TODOS = [
  { title: '컴플레인 2건 학부모 통화', toId: 2, fromId: 1, dueOn: D(0),  done: false, src: 'complaint' },
  { title: '프린터 토너 영수증 첨부',   toId: 4, fromId: 2, dueOn: D(0),  done: false, src: 'manual' },
  { title: '리포트 독촉 5건 발송',      toId: 2, fromId: 3, dueOn: D(0),  done: true,  src: 'manual' },
  { title: '9월 인스타 광고 집행안 마무리', toId: 4, fromId: 1, dueOn: D(1), done: false, src: 'plan', planId: 1 },
  { title: '대학 원서 마감 일정표 배포', toId: 3, fromId: 3, dueOn: D(1), done: false, src: 'meeting', mtId: 2 },
  { title: '교재 재고 회전율 자료 정리', toId: 4, fromId: 2, dueOn: D(2), done: false, src: 'plan', planId: 2 },
  { title: '8월 강사료 정산 입금 처리',  toId: 2, fromId: 1, dueOn: D(3), done: false, src: 'manual' },
  { title: '8월 채널별 성과 표 정리',    toId: 4, fromId: 2, dueOn: D(1), done: false, src: 'meeting', mtId: 4 },
];
