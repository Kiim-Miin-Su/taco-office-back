/** @file-guide
 * 목적: noti.ts — NOTI_TONES, NotiTone, notiTone (service)
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
