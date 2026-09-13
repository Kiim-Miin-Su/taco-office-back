/** @file-guide
 * 목적: role-words.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §17 역할 묶음 — **서버가 묶고 서버가 센다** (C73).
 *
 * 화면에서 묶으면 두 가지가 한꺼번에 깨진다: 「강사 13」의 13 을 화면이 세게 되고(D-R37),
 * `m.role === 'teacher'` 라는 **역할 비교가 화면에 생긴다**(D-R39 · eslint 가 막는 바로 그 모양).
 */
import { ROLE_ORDER, groupByRole, roleLabel } from '../src/lib/role-words';

const who = (id: number, role: string) => ({ id, role });

describe('§17 역할 묶음', () => {
  it('차례는 역할 차례다 — 이름 순도, 인원 순도 아니다', () => {
    const out = groupByRole([who(1, 'ceo'), who(2, 'teacher'), who(3, 'manager'), who(4, 'admin')]);
    expect(out.map((g) => g.role)).toEqual([...ROLE_ORDER]);
  });

  it('사람이 없는 역할은 묶음을 만들지 않는다 — 빈 머리만 서 있지 않는다', () => {
    const out = groupByRole([who(1, 'teacher'), who(2, 'ceo')]);
    expect(out.map((g) => g.role)).toEqual(['teacher', 'ceo']);
  });

  it('수는 묶음 배열의 길이다 — 따로 세지 않으므로 갈릴 수 없다', () => {
    const out = groupByRole([who(1, 'teacher'), who(2, 'teacher'), who(3, 'manager')]);
    for (const g of out) expect(g.count).toBe(g.members.length);
    expect(out.reduce((n, g) => n + g.count, 0)).toBe(3);
  });

  it('한 사람은 한 묶음에만 든다 — 우리 저장소의 역할은 하나뿐이다 (컷은 직함이라 겹친다 · N-41)', () => {
    const out = groupByRole([who(1, 'teacher'), who(2, 'manager')]);
    const ids = out.flatMap((g) => g.members.map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('표에 없는 역할값이 와도 사람을 잃지 않는다 — 맨 뒤에 제 코드값으로 선다', () => {
    const out = groupByRole([who(1, 'teacher'), who(2, 'intern')]);
    expect(out.map((g) => g.role)).toEqual(['teacher', 'intern']);
    expect(out[1].label).toBe('intern');   // 비어 보이느니 낯설게 보이는 편이 낫다
  });

  it('낱말은 여기 한 곳에서만 만든다 — 원문 §17 의 첫 묶음이 「강사」다', () => {
    expect(roleLabel('teacher')).toBe('강사');
    expect(ROLE_ORDER.every((r) => roleLabel(r) !== r)).toBe(true);
  });
});
