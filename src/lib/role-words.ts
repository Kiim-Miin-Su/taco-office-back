/** @file-guide
 * 목적: role-words.ts — ROLE_ORDER, ROLE_LABEL, roleLabel, groupByRole (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 역할의 **낱말 한 벌**과 §17 묶음 만들기.
 *
 * 묶는 일이 서버에 있는 이유는 둘이다.
 *   ① 「강사 13」의 **13 은 세는 일**이다 — 화면이 세면 서랍과 다른 화면이 다른 수를 말한다 (D-R37).
 *   ② 화면에서 `m.role === 'teacher'` 를 적는 순간 **역할 비교가 화면에 생긴다** — 여기서는
 *      묶음을 나눌 뿐이지만, 같은 모양이 한 줄만 옆으로 가면 권한 판정이 된다. eslint 가 그것을 막고,
 *      막는 쪽이 옳다 (D-R39). 그래서 서버가 묶어서 준다.
 *
 * 낱말은 `ROLE_LABEL` 한 곳에서만 만든다. 프런트 `lib/roles.ts` 의 `ROLES` 와 **같은 네 낱말**이며,
 * 회귀가 두 표가 갈리지 않는지 본다.
 */
export const ROLE_ORDER = ['teacher', 'manager', 'admin', 'ceo'] as const;
export type RoleKey = (typeof ROLE_ORDER)[number];

export const ROLE_LABEL: Record<string, string> = {
  teacher: '강사',
  manager: '매니저',
  admin: '관리자',
  ceo: '대표',
};

/** 모르는 코드값이면 코드값을 그대로 보인다 — 비어 보이느니 낯설게 보이는 편이 낫다 */
export const roleLabel = (role: string): string => ROLE_LABEL[role] ?? role;

/**
 * §17 묶음 — 역할 차례대로, **사람이 없는 역할은 묶음을 만들지 않는다.**
 *
 * 표에 없는 역할값이 들어와도 사람을 잃지 않는다 — 맨 뒤에 제 코드값 이름으로 묶음이 선다.
 * 원문 §17 의 묶음은 사실 **직함**이고 한 사람이 여럿에 걸친다(Kim 은 강사이자 코디네이터다).
 * 우리 저장소는 `staff.title` 한 칸뿐이라 그 모양을 적을 수 없어 역할로 묶는다 (N-41).
 */
export function groupByRole<T extends { role: string }>(
  rows: readonly T[],
): Array<{ role: string; label: string; count: number; members: T[] }> {
  /*
   * 나누기는 **한 번 훑어 담는 것**이지 역할을 비교하는 것이 아니다.
   * `r.role === 'teacher'` 같은 모양을 쓰면 eslint 가 막는데, 막는 쪽이 옳다 —
   * 같은 모양이 한 줄만 옆으로 가면 권한 판정이 되기 때문이다 (D-R39).
   */
  const bucket = new Map<string, T[]>();
  for (const row of rows) {
    const got = bucket.get(row.role);
    if (got) got.push(row);
    else bucket.set(row.role, [row]);
  }

  // 아는 역할이 먼저, 표에 없는 값은 온 차례대로 뒤에 — 사람을 잃지 않는다
  const order = [...new Set([...ROLE_ORDER, ...bucket.keys()])];
  return order.flatMap((role) => {
    const members = bucket.get(role);
    if (!members) return [];
    // 수는 **그 배열의 길이**다 — 따로 세면 「13」인데 줄이 열둘인 화면이 생긴다 (D-R37)
    return [{ role, label: roleLabel(role), count: members.length, members }];
  });
}
