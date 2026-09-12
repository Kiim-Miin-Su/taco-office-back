/** @file-guide
 * 목적: noti.ts — NOTI_TONES, notiTone, NOTI_CATEGORIES, notiCategory, NOTI_WINDOW_DAYS (service)
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
const WARN = ['/reports/unwritten', '/ops/complaints', '/accounting/overdue', '/exec/pending'];
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
 * ⚠ **`NOTI` 표에는 분류 컬럼도 없다.** 색(`notiTone`)과 **같은 방식**으로 링크에서 파생한다 —
 *   몸통 글자를 읽어 짐작하지 않는다. 표에 컬럼이 생기면 이 함수 하나만 바꾸면 된다.
 *
 * 원본 §16 의 칩은 다섯이었다 — 작성 독촉 · **재알람** · 리포트 · 요청 처리 · 일정 변경.
 * 이 중 **재알람은 만들지 않는다**: 그것은 화면 주소가 아니라 **발송 이력**(같은 알림을 다시 보냈는가)이라
 * 링크로 파생되지 않는다. 짐작해서 붙이면 정산에 반영되는 숫자를 거짓으로 만든다 — 표에 이력이 생길 때 만든다.
 */
export const NOTI_CATEGORIES = ['report_due', 'report', 'schedule', 'request', 'etc'] as const;
export type NotiCategory = (typeof NOTI_CATEGORIES)[number];

export const NOTI_CATEGORY_LABEL: Record<NotiCategory, string> = {
  report_due: '작성 독촉',
  report: '리포트',
  schedule: '일정 변경',
  request: '요청 처리',
  etc: '알림',
};

export function notiCategory(link: string | null | undefined): NotiCategory {
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
