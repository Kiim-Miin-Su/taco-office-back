/**
 * 권한 — 역할 4종에서 **세 줄로 파생**한다 (D-R39 · 대표 결정 3번).
 *
 * 원문: "유저 역할은 1. 강사 2. 매니저: 이 이상부터는 모든 항목에 대해 CRUD 가능
 *        (관리자 페이지 열어줌) 3. 관리자 4. 대표: 지출 및 총 수입만 대표만 볼 수 있음."
 *
 * ⚠️ **이 파일이 권한 판정의 유일한 자리다.**
 *    컨트롤러·서비스·컴포넌트에서 role 을 직접 비교하지 않는다 — eslint 가 막는다
 *    (eslint.config.mjs 의 no-restricted-syntax). 권한을 한 칸 열어 줄 때
 *    고칠 곳이 한 군데여야 한다.
 *
 * 명세서 v2 의 교수실장·상담실장·코디네이터는 **직함**이며 권한상 전부 manager 와 같다.
 * 직함은 STAFF.title 에 문자열로 둔다 (docs/contracts/db/erd.dbml).
 */

export const ROLES = ['teacher', 'manager', 'admin', 'ceo'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  teacher: '강사',
  manager: '매니저',
  admin: '관리자',
  ceo: '대표',
};

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

/* ── 세 줄 ─────────────────────────────────────────────────────────────
   이 셋 말고는 없다. 새 권한이 필요해지면 여기에 네 번째 줄을 만들고,
   화면과 서버가 그 줄을 부른다.                                          */

/** 관리자 백오피스에 들어갈 수 있는가 */
export const canAdminPage = (r: Role): boolean => r !== 'teacher';

/** 학생·수업·일정·결재 전 항목을 만들고 고치고 지울 수 있는가 */
export const canCrudAll = (r: Role): boolean => r !== 'teacher';

/** 지출과 총수입을 볼 수 있는가 — 대표 전용 */
export const canSeeProfit = (r: Role): boolean => r === 'ceo';

/* ── 화면이 읽는 플래그 ────────────────────────────────────────────────
   명세서 v2 §76 은 플래그 5개로 그린다. 그 이름을 그대로 두되 **판정은
   위 세 줄에서 다시 파생**한다. 저장하지 않는다 (D-R39 · N-11 닫힘).   */

export interface PermFlags {
  /** 관리자 페이지 진입 */
  canAdminPage: boolean;
  /** 전 항목 CRUD */
  canCrudAll: boolean;
  /** 지출 · 총수입 */
  canSeeProfit: boolean;
  /** 오늘·이전 스케줄의 출결 (D-R35) — canCrudAll 과 같다 */
  canCrudAttendance: boolean;
  /** v2 §76 이름 — 지출·총수입 */
  canMoney: boolean;
  /** v2 §76 이름 — 강사 시급 · 시수 기준 */
  canWage: boolean;
  /** v2 §76 이름 — 보고 · 기획 · 지출 결재 */
  canApprove: boolean;
  /** v2 §76 이름 — 내역 비공개 · 비공개 컨설팅 열람 */
  canHide: boolean;
  /** v2 §76 이름 — 자료 요청 접수 */
  canGpaPack: boolean;
}

export type PermName = keyof PermFlags;

/**
 * @param overrides STAFF 의 권한 컬럼. **평소에는 전부 null** 이고,
 *   사람별 예외가 생기는 날에만 값이 들어와 파생 결과를 덮어쓴다.
 */
export function permsOf(
  role: Role,
  overrides?: Partial<Record<PermName, boolean | null>> | null,
): PermFlags {
  const base: PermFlags = {
    canAdminPage: canAdminPage(role),
    canCrudAll: canCrudAll(role),
    canSeeProfit: canSeeProfit(role),
    canCrudAttendance: canCrudAll(role),
    canMoney: canSeeProfit(role),
    canWage: canCrudAll(role),
    canApprove: canCrudAll(role),
    canHide: canCrudAll(role),
    canGpaPack: canCrudAll(role),
  };
  if (!overrides) return base;
  const out = { ...base };
  (Object.keys(base) as PermName[]).forEach((k) => {
    const v = overrides[k];
    if (v === true || v === false) out[k] = v;
  });
  return out;
}

export function hasPerm(
  role: Role,
  name: PermName,
  overrides?: Partial<Record<PermName, boolean | null>> | null,
): boolean {
  return permsOf(role, overrides)[name];
}
