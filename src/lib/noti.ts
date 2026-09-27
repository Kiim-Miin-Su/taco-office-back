/** @file-guide
 * 목적: noti.ts — NOTI_TONES, NotiTone, notiTone, NOTI_CATEGORIES, NotiCategory 등 (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 알림의 색 — §16 은 `alarm` · `ok` · `warn` 세 가지로 그린다.
 *
 * ⚠ **`NOTI` 표에는 색 컬럼이 없다** (`docs/contracts/db/erd.dbml`).
 *   그래서 여기서 **링크가 가리키는 곳**으로 파생한다. 몸통 글자를 읽어 짐작하지 않는다 —
 *   글자는 사람이 바꾸지만 링크는 화면 주소라서 잘 안 바뀐다.
 *
 *   나중에 표에 컬럼이 생기면 **이 함수 하나만** 바꾸면 된다. 화면은 `tone` 만 보므로
 *   컴포넌트를 건드릴 일이 없다 — 그러라고 한 곳에 모아 둔 것이다.
 */

/** `cf` 알림 상자와 같은 세 가지 (DEV-SPEC §9.1) */
export const NOTI_TONES = ['alarm', 'ok', 'warn'] as const;
export type NotiTone = (typeof NOTI_TONES)[number];

/**
 * 링크 앞자리 → 색.
 *
 *   warn   손을 대야 하고, 안 대면 뒤가 막히는 것 — 밀린 리포트 · 컴플레인 · 결재 지연
 *   ok     끝났다는 소식 — 승인 · 입금 · 발송 완료
 *   alarm  그 밖의 알림 (기본값)
 */
const WARN = ['/reports/unwritten', '/reports?section=unwritten', '/ops/complaints', '/accounting/overdue', '/exec/pending'];
const OK = ['/accounting/paid', '/reports/sent', '/guides/sent'];

export function notiTone(link: string | null | undefined): NotiTone {
  const l = (link ?? '').trim();
  if (!l) return 'alarm';
  if (WARN.some((p) => l.startsWith(p))) return 'warn';
  if (OK.some((p) => l.startsWith(p))) return 'ok';
  return 'alarm';
}

/* ── §16 분류 칩 · 보관 (D9 · N-7 · D-16 채택 · C38) ─────────────────────────── */

/**
 * 알림 분류 — §16 의 칩.
 *
 * `NOTI.category`가 정본이다. **재알람**은 같은 `/reports/unwritten` 링크라도 최초 독촉과
 * 다른 업무 사건이라 링크로는 구분할 수 없다. C76에서 컬럼을 추가해 발송자가 분류를 명시한다.
 * 과거 배포에서 컬럼이 없던 행만 링크 fallback으로 읽으며, 몸통 글자를 런타임에 해석하지 않는다.
 *
 * **차례도 원문이다**(g2 16-3) — §16 컷의 칩 줄이 「작성 독촉 · 재알람 · 리포트 · **요청 처리 · 일정 변경**」이다.
 * 화면은 이 배열 차례대로 칩을 그리므로 차례를 바꾸는 자리는 여기 하나다.
 */
export const NOTI_CATEGORIES = ['report_due', 're_alarm', 'report', 'request', 'schedule', 'etc'] as const;
export type NotiCategory = (typeof NOTI_CATEGORIES)[number];

export const NOTI_CATEGORY_LABEL: Record<NotiCategory, string> = {
  report_due: '작성 독촉',
  re_alarm: '재알람',
  report: '리포트',
  request: '요청 처리',
  schedule: '일정 변경',
  etc: '시스템',   // 원문 M-128 의 여섯째 낱말이다 — 「알림」이라 적던 것을 되돌렸다 (C99 · D-R18)
};

export function notiCategory(
  stored: string | null | undefined,
  link: string | null | undefined,
): NotiCategory {
  if (NOTI_CATEGORIES.includes(stored as NotiCategory)) return stored as NotiCategory;
  const l = (link ?? '').trim();
  if (!l) return 'etc';
  // 독촉이 리포트보다 먼저다 — /reports/unwritten 은 둘 다에 걸린다
  if (l.startsWith('/reports/unwritten')) return 'report_due';
  if (l.startsWith('/reports')) return 'report';
  if (l.startsWith('/schedule')) return 'schedule';
  if (l.startsWith('/ops') || l.startsWith('/drawer')) return 'request';
  return 'etc';
}

/**
 * 목록에 보이는 기간 — **지우지 않는다** (N-7 · D-16 채택).
 *
 * 「1개월」은 행을 지우는 규칙이 아니라 **조회 범위**다. 정산·세무 근거가 되는 기록을
 * 화면이 안 보인다는 이유로 없애면 나중에 되돌릴 방법이 없다.
 * 창 밖의 건수는 `notiOlderCount` 로 내려보내 화면이 「더 있다」고 말한다.
 */
export const NOTI_WINDOW_DAYS = 30;

/* ── §16 알림 제목 (16-1 · impl3-w8) ───────────────────────────────────────── */

/**
 * 알림 제목 — §16 카드의 **굵은 한 줄**(`noti.title` · varchar 80 · 없으면 화면이 본문 한 줄로 그린다).
 *
 * 쓰는 자리가 열 개 넘는 모듈에 흩어져 있어 **낱말은 여기 한 곳**에 둔다(D-R18) — 같은 일이 모듈마다
 * 다른 제목이 되지 않게(예: 「교재 배정 필요」는 명단 쓰기와 등록 확정 두 곳이 보낸다).
 * 제목은 「무슨 일」만 짧게, 누구·언제·무엇은 **본문이 예전 그대로** 말한다. 서랍의 결재 결과 둘
 * (「{종류} 요청 승인/반려」 · 「변경 요청 반영/반려」)은 요청 종류가 들어가 drawer 가 직접 짓는다.
 */
export const NOTI_TITLE = {
  // 회계
  expenseSubmitted: '지출 심사 요청',
  expenseRejected: '지출 반려',
  wageChanged: '시급 변경',
  // 교재 · 안내
  bookReceived: '자료 수령 확인',
  bookNeeded: '교재 배정 필요',
  guideNeeded: '수업 안내 필요',
  guideArrived: '수업 안내 도착',
  zoomGuide: '줌 안내',
  // 리포트
  reportDue: '리포트 작성 독촉',
  reportApproved: '리포트 승인',
  reportRejected: '리포트 반려',
  // 시간표
  absence: '결강',
  carryOver: '이월 발생',
  rosterAdded: '수업에 학생 추가',
  // 컨설팅
  consSessions: '컨설팅 회차 잡힘',
  consNextTask: '컨설팅 다음 할 일',
  consDone: '컨설팅 종료',
  // 컨설팅 계약 → 진행 — 수납이 계약 금액을 채운 순간 담당에게 두 건(N-65 · 테스트 시나리오 I-90+)
  consPaid: '수납 · 진행 가능',
  consRecordRequest: '회차 기록 요청',
  // 운영
  teacherChange: '강사 교체',
  teacherHandover: '담당 이관',
  meetingInvite: '회의 초대',
  meetingTodo: '회의 할 일',
  planOwner: '기획 담당 지정',
  planTask: '기획 과제',
  complaintOwner: '컴플레인 담당 지정',
  mktFeedback: '대표 피드백',
  mktReply: '피드백 답변',
  enrollNewStudent: '새 학생 등록',
  enrollConfirmed: '등록 확정',
  // 대표 보고
  execSubmitted: '대표 보고 올라옴',
  // W11 운영 · 대표 보고 (O) — §66 「안내 보내기」(N-32) · §73 결재 결과를 올린 사람에게(N-97)
  meetingNotice: '회의 안내',
  execApproved: '대표 보고 승인',
  execRejected: '대표 보고 반려',
} as const satisfies Record<string, string>;

export type NotiTitleKey = keyof typeof NOTI_TITLE;
