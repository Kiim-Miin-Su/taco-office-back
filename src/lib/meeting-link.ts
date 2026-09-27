/** @file-guide
 * 목적: meeting-link.ts — meetingNotiLink (util) · 회의 알림 링크를 받는 사람이 열 수 있는 자리로
 * 책임/재사용: 판정은 `common/perm` 의 `hasPerm`(역할 기본값) 한 곳을 부른다 — 역할 문자열을 여기서 비교하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { hasPerm, isRole } from '../common/perm';

/**
 * 회의 알림(§66 「안내 보내기」 · 회의 할 일 배정)의 링크 — **받는 사람이 열 수 있는 자리**로 (W11 A' 후속 · N-32).
 *
 * 운영 화면(`/ops`)은 관리 화면 권한(`canAdminPage` · `canCrudAll`)이 있어야 열린다. 강사 참석자에게 `/ops?…` 를 보내면
 * 강사 알림 서랍이 그 링크를 열지 못해(직접 URL 판정) **읽음만** 된다 — 회의 상세를 볼 길이 없었다.
 * 그래서 못 여는 **참석자**에게는 강사 홈의 회의 창(`/teacher?meeting=`)을 보낸다. 거기서 같은 `GET /ops/meetings/:id`
 * (참석자 본인에게 열려 있다)를 읽고, 쓰기 단추는 서버 플래그(`canEdit` · `canRespond` · 할 일 `canToggle`)가 정한다.
 * 참석자도 아니면 그 회의를 읽을 수 없으므로 링크를 두지 않는다(null — 알림 글만 읽는다). 읽기 범위는 넓히지 않는다.
 * 두 권한은 사람별 예외 칸이 아니라 역할에서만 나온다 — 그래서 역할 기본값으로 가른다.
 *
 * @param adminLink 운영 화면을 여는 사람에게 보낼 링크(예: `/ops?tab=meeting&meeting=7` · 할 일이면 `/ops?todo`)
 * @param attendee 받는 사람이 그 회의의 참석자인가(안내는 참석자에게만 가므로 늘 참이다)
 */
export function meetingNotiLink(role: string, meetingId: number, adminLink: string, attendee = true): string | null {
  const canOpenOps = isRole(role) && hasPerm(role, 'canAdminPage') && hasPerm(role, 'canCrudAll');
  if (canOpenOps) return adminLink;
  return attendee ? `/teacher?meeting=${meetingId}` : null;
}
