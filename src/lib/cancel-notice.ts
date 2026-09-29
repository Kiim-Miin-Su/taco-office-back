/** @file-guide
 * 목적: cancel-notice.ts — 학원 사유 휴강의 학부모 안내 준비행 두 갈래(전일 휴원 · 한 회차 학원 사정 휴강)의 머리말과 이름
 * 책임/재사용: 안내를 쓰는 곳(schedule.write) · 읽는 곳(schedule.service) · 걷는 곳(undo)이 같은 머리말 목록을 본다. 낱말은 서버가 준다(D-R18).
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md · docs/report/GO-LIVE-GAP-2026-09-29.md §5-4
 */

/**
 * PNOTI 에는 「무슨 안내인가」를 적는 칸이 없다 — 본문 첫 줄의 머리말이 그 표지다(N-133 이 처음 정했다).
 * 머리말이 세 곳(쓰기 · 읽기 · 되돌리기)에 따로 적혀 있으면 한쪽만 늘어난 것을 모른 채 낡는다(D-R22).
 * 그래서 목록은 여기 하나이고, 둘째 갈래(C-32 한 회차 학원 사정 휴강)도 이 목록에 한 줄로 더했다.
 */
export const DAY_CANCEL_NOTICE_PREFIX = '[학원 전체 휴원]';
export const LESSON_CANCEL_NOTICE_PREFIX = '[학원 사정 휴강]';

export const CANCEL_NOTICE_KINDS = [
  { prefix: DAY_CANCEL_NOTICE_PREFIX, title: '전일 휴원 안내' },
  { prefix: LESSON_CANCEL_NOTICE_PREFIX, title: '휴강 안내' },
] as const;

/** SQL `body LIKE ANY($n::text[])` 에 그대로 넘기는 머리말 패턴 — `[` 는 LIKE 의 특수 문자가 아니다 */
export const CANCEL_NOTICE_LIKE: string[] = CANCEL_NOTICE_KINDS.map((kind) => `${kind.prefix}%`);

/** 본문의 머리말로 안내 이름을 고른다 — 모르는 머리말이면 넓은 이름(「휴강 안내」)으로 */
export function cancelNoticeTitle(body: string): string {
  return CANCEL_NOTICE_KINDS.find((kind) => body.startsWith(kind.prefix))?.title ?? '휴강 안내';
}
