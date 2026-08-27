/**
 * 권한 — 역할 4종에서 세 줄로 파생 (D-R39 · 대표 결정 3번).
 *
 * "매니저: 이 이상부터는 모든 항목에 대해 CRUD 가능 (관리자 페이지 열어줌)"
 * "대표: 지출 및 총 수입만 대표만 볼 수 있음"
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
  type Role,
} from '../src/common/perm';

describe('권한 3줄 파생 (D-R39)', () => {
  it('역할은 넷이고 순서가 있다', () => {
    expect(ROLES).toEqual(['teacher', 'manager', 'admin', 'ceo']);
    expect(ROLES.map((r) => ROLE_LABEL[r])).toEqual(['강사', '매니저', '관리자', '대표']);
  });

  it.each<[Role, boolean, boolean, boolean]>([
    // role,      관리자페이지, 전항목CRUD, 지출·총수입
    ['teacher', false, false, false],
    ['manager', true, true, false],
    ['admin', true, true, false],
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

  it('지출·총수입은 대표만 본다', () => {
    const allowed = ROLES.filter((r) => canSeeProfit(r));
    expect(allowed).toEqual(['ceo']);
  });

  it('관리자와 매니저는 권한이 같다 — 직함만 다르다', () => {
    expect(permsOf('manager')).toEqual(permsOf('admin'));
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

  it('매니저는 돈만 닫혀 있다', () => {
    const p = permsOf('manager');
    expect(p.canMoney).toBe(false);
    expect(p.canSeeProfit).toBe(false);
    // 나머지는 전부 열린다 — "매니저부터 모든 항목 CRUD"
    expect(p.canWage && p.canApprove && p.canHide && p.canGpaPack).toBe(true);
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

  it('true/false 만 파생 결과를 덮어쓴다', () => {
    const p = permsOf('manager', { canMoney: true });
    expect(p.canMoney).toBe(true);
    expect(p.canSeeProfit).toBe(false); // 덮어쓴 칸만 바뀐다
  });

  it('강사에게 한 칸만 열어 줄 수 있다', () => {
    const p = permsOf('teacher', { canGpaPack: true });
    expect(p.canGpaPack).toBe(true);
    expect(p.canCrudAll).toBe(false);
  });

  it('hasPerm 이 같은 판정을 쓴다', () => {
    expect(hasPerm('ceo', 'canSeeProfit')).toBe(true);
    expect(hasPerm('admin', 'canSeeProfit')).toBe(false);
    expect(hasPerm('admin', 'canSeeProfit', { canSeeProfit: true })).toBe(true);
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
