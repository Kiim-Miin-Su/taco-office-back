/** @file-guide
 * 목적: §38~§41 교재 상태·진도·자료 전달 전이를 한 곳에서 검증한다.
 * 책임/재사용: 순수 업무 방어만 소유한다. HTTP 예외·SQL·화면 문구 조립은 호출자가 맡는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

export const ISSUE_STATES = ['wait', 'auto', 'ok', 'returned'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];
export const ISSUE_CREATE_STATES = ['wait', 'auto', 'ok'] as const;
export const ISSUE_TRANSITION_STATES = ['auto', 'ok'] as const;
export const ISSUE_STATE_LABEL: Record<IssueState, string> = {
  wait: '승인 대기', auto: '전달 대기', ok: '배부 완료', returned: '회수 완료',
};

/** §38 배부는 승인 대기 → 전달 대기 → 배부 완료의 한 방향으로만 흐른다. */
export function issueTransitionIssue(from: IssueState, to: 'auto' | 'ok'): string | null {
  if (from === 'wait' && to === 'auto') return null;
  if (from === 'auto' && to === 'ok') return null;
  return `${ISSUE_STATE_LABEL[from]}에서 ${ISSUE_STATE_LABEL[to]} 상태로 바꿀 수 없습니다`;
}

export const PACK_TYPES = ['exam', 'self'] as const;
export type PackType = (typeof PACK_TYPES)[number];
export const PACK_TYPE_LABEL: Record<PackType, string> = { exam: '시험 대비 자료', self: '자습 자료' };

export const PACK_STATES = ['pending', 'delivered', 'received'] as const;
export type PackState = (typeof PACK_STATES)[number];
export const PACK_STATE_LABEL: Record<PackState, string> = {
  pending: '준비 중', delivered: '전달 완료', received: '수령 확인',
};

export function progressPercent(page: number | null, pages: number | null): number | null {
  if (page === null || pages === null || pages <= 0) return null;
  return Math.min(100, Math.round((page / pages) * 100));
}

export function progressIssue(page: number, pages: number | null): string | null {
  if (!Number.isInteger(page) || page < 0) return '진도 쪽수는 0 이상의 정수입니다';
  if (pages !== null && page > pages) return `진도 쪽수는 교재 전체 ${pages}쪽을 넘을 수 없습니다`;
  return null;
}

export function packTransitionIssue(from: PackState, to: PackState): string | null {
  if (from === 'pending' && to === 'delivered') return null;
  if (from === 'delivered' && to === 'received') return null;
  return `${PACK_STATE_LABEL[from]}에서 ${PACK_STATE_LABEL[to]} 상태로 바꿀 수 없습니다`;
}
