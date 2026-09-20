/** @file-guide
 * 목적: perm.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 권한 — 역할 4종에서 세 줄로 파생 (D-R39 · 대표 결정 3번).
 *
 * "매니저: 이 이상부터는 모든 항목에 대해 CRUD 가능 (관리자 페이지 열어줌)"
 * "대표: 지출 및 총 수입만 대표만 볼 수 있음"
 *
 * **대표 결정 2026-09-21 「우선은 매니저에게도 모든 권한」** — 원문의 마지막 줄(대표 전용)을
 * 지금은 적용하지 않는다. 판정은 `perm.ts` 의 `ceoGate` 한 줄이고, 되돌리면 이 표가 먼저
 * 빨개진다. **원문이 무엇이었는지는 위 두 줄에 그대로 남겨 둔다** — 지금 값이 원문이라고
 * 읽히면 다음 사람이 결정을 사실로 착각한다.
 *
 * 이 표가 곧 계약이다. 한 칸이라도 바뀌면 여기가 먼저 빨개져야 한다.
 */
import {
  ROLES,
  canAdminPage,
  canCrudAll,
  canSeeProfit,
  permsOf,
  hasPerm,
  isRole,
  ROLE_LABEL,
  canCeoComment,
  canCeoApprovePlan,
  approvalFlowScope,
  type Role,
} from '../src/common/perm';

describe('권한 3줄 파생 (D-R39)', () => {
  it('역할은 넷이고 순서가 있다', () => {
    expect(ROLES).toEqual(['teacher', 'manager', 'admin', 'ceo']);
    expect(ROLES.map((r) => ROLE_LABEL[r])).toEqual(['강사', '매니저', '관리자', '대표']);
  });

  it.each<[Role, boolean, boolean, boolean]>([
    // role,      관리자페이지, 전항목CRUD, 지출·총수입(대표 결정 2026-09-21 로 관리자급까지)
    ['teacher', false, false, false],
    ['manager', true, true, true],
    ['admin', true, true, true],
    ['ceo', true, true, true],
  ])('%s — 진입 %s · CRUD %s · 지출/총수입 %s', (role, page, crud, profit) => {
    expect(canAdminPage(role)).toBe(page);
    expect(canCrudAll(role)).toBe(crud);
    expect(canSeeProfit(role)).toBe(profit);
  });

  it('강사만 관리자 페이지에서 막힌다', () => {
    const blocked = ROLES.filter((r) => !canAdminPage(r));
    expect(blocked).toEqual(['teacher']);
  });

  /**
   * 원문 §76 은 「대표만」이지만 대표 결정 2026-09-21 로 관리자급까지 열었다.
   * **경계가 사라진 것이 아니라 옮겨졌다** — 강사는 그대로 막힌다. 그 사실을 계속 센다.
   */
  it('지출·총수입은 이제 강사만 못 본다 — 원문은 「대표만」이었다 (대표 결정 2026-09-21)', () => {
    const allowed = ROLES.filter((r) => canSeeProfit(r));
    expect(allowed).toEqual(['manager', 'admin', 'ceo']);
    expect(canSeeProfit('teacher')).toBe(false);
  });

  it('관리자와 매니저는 권한이 같다 — 직함만 다르다', () => {
    expect(permsOf('manager')).toEqual(permsOf('admin'));
    expect(canCeoComment('manager')).toBe(canCeoComment('admin'));
    expect(canCeoApprovePlan('manager')).toBe(canCeoApprovePlan('admin'));
    // 같은 DB 예외가 주어졌을 때에도 역할에 따른 숨은 분기가 없어야 한다.
    for (const flag of ['canMoney', 'canWage', 'canApprove', 'canHide', 'canGpaPack'] as const) {
      for (const value of [null, true, false]) {
        expect(permsOf('manager', { [flag]: value })).toEqual(permsOf('admin', { [flag]: value }));
      }
    }
  });

  it('§75 projection은 강사=none, 나머지=all 한 곳에서 파생한다 (대표 결정 2026-09-21 · 원래 관리자급은 head)', () => {
    expect(ROLES.map((role) => approvalFlowScope(role))).toEqual(['none', 'all', 'all', 'all']);
    expect(approvalFlowScope('admin', { canAdminPage: false })).toBe('none');
    expect(approvalFlowScope('teacher', { canAdminPage: true })).toBe('none');
  });
});

describe('명세서 v2 §76 플래그 5개도 같은 세 줄에서 나온다', () => {
  it('대표는 전부 열려 있다', () => {
    const p = permsOf('ceo');
    expect(p).toEqual({
      canAdminPage: true,
      canCrudAll: true,
      canSeeProfit: true,
      canCrudAttendance: true,
      canMoney: true,
      canWage: true,
      canApprove: true,
      canHide: true,
      canGpaPack: true,
    });
  });

  it('매니저도 대표와 같다 — 대표 결정 2026-09-21 (원래는 돈과 비공개가 닫혀 있었다)', () => {
    expect(permsOf('manager')).toEqual(permsOf('ceo'));
    const p = permsOf('manager');
    expect(p.canMoney).toBe(true);
    expect(p.canSeeProfit).toBe(true);
    // 비공개 층도 열렸다 — 원문 §76 은 「비공개 컨설팅 열람 — 대표만」이다 (27N5 · §4-17)
    expect(p.canHide).toBe(true);
  });

  it('강사는 전부 닫혀 있다', () => {
    const p = permsOf('teacher');
    expect(Object.values(p).some(Boolean)).toBe(false);
  });

  it('출결 권한은 canCrudAll 과 같다 (D-R35)', () => {
    ROLES.forEach((r) => {
      expect(permsOf(r).canCrudAttendance).toBe(canCrudAll(r));
    });
  });
});

describe('사람별 예외 — 평소에는 쓰지 않는다', () => {
  it('null 은 파생 결과를 건드리지 않는다', () => {
    expect(permsOf('manager', { canMoney: null, canWage: null })).toEqual(permsOf('manager'));
    expect(permsOf('manager', {})).toEqual(permsOf('manager'));
    expect(permsOf('manager', null)).toEqual(permsOf('manager'));
  });

  /**
   * 역할이 전부 열린 뒤로 **예외 칸은 끄는 쪽으로 쓰인다** — 「이 매니저에게는 금액을 닫는다」.
   * 덮어쓰는 칸만 바뀌는 성질은 그대로다(`canSeeProfit` 은 예외 칸이 없어 파생값 그대로).
   */
  it('true/false 만 파생 결과를 덮어쓴다 — 이제는 끄는 쪽이 많다', () => {
    const off = permsOf('manager', { canMoney: false });
    expect(off.canMoney).toBe(false);
    expect(off.canSeeProfit).toBe(true); // 덮어쓴 칸만 바뀐다
    const on = permsOf('teacher', { canMoney: true });
    expect(on.canMoney).toBe(true);
    expect(on.canSeeProfit).toBe(false);
  });

  it('강사에게 한 칸만 열어 줄 수 있다', () => {
    const p = permsOf('teacher', { canGpaPack: true });
    expect(p.canGpaPack).toBe(true);
    expect(p.canCrudAll).toBe(false);
  });

  it('hasPerm 이 같은 판정을 쓴다', () => {
    expect(hasPerm('ceo', 'canSeeProfit')).toBe(true);
    expect(hasPerm('admin', 'canSeeProfit')).toBe(true);
    expect(hasPerm('teacher', 'canSeeProfit')).toBe(false);
    expect(hasPerm('teacher', 'canSeeProfit', { canSeeProfit: true })).toBe(true);
    expect(hasPerm('admin', 'canSeeProfit', { canSeeProfit: false })).toBe(false);
  });
});

describe('isRole — 밖에서 온 값을 그대로 믿지 않는다', () => {
  it.each(['teacher', 'manager', 'admin', 'ceo'])('%s 는 역할이다', (r) => {
    expect(isRole(r)).toBe(true);
  });

  it.each(['head', 'adm', 'coord', 'CEO', '', null, undefined, 1, {}])(
    '%p 는 역할이 아니다',
    (v) => {
      expect(isRole(v)).toBe(false);
    },
  );
});
