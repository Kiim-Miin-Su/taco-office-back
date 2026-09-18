/** @file-guide
 * 목적: perm.ts — ROLES, Role, ROLE_LABEL, isRole, canAdminPage 등 (auth)
 * 책임/재사용: 공용 인증/권한 경계만 소유한다. 토큰·쿠키 원문을 노출하지 않고 만료/익명/권한 회수 경계를 회귀로 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

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
 * 2026-09-14 재확정: admin과 manager는 현재 같은 기본 권한을 소비한다.
 * 추후 분리도 여기서만 변경한다. STAFF의 개인별 예외와 대표 전용 판정은 보존한다.
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

/**
 * 대표 피드백에 **코멘트를 남길 수 있는가** — 대표 전용 (원문 §60 「대표가 코멘트하면」).
 *
 * `canSeeProfit` 을 빌려 쓰지 않는다. 둘 다 지금은 `role === 'ceo'` 지만 뜻이 다르고,
 * `canMoney` 처럼 사람별 예외가 붙는 날 금액 예외가 코멘트 권한까지 열어 버린다.
 * 사람별 예외가 없다는 것이 이 줄의 내용이라 `PermFlags`(§76 다섯 칸)에는 넣지 않는다 —
 * 원문 §76 의 권한 목록에 코멘트는 없다.
 */
export const canCeoComment = (r: Role): boolean => r === 'ceo';

/**
 * 기획 보고서의 **기한 승인과 최종 승인** — 대표 전용 (원문 §61·§65 「대표는 기한을 먼저
 * 승인해야 최종 승인이 열립니다」).
 *
 * `canApprove`(§76 의 다섯 칸 중 하나)는 `canCrudAll` 파생이라 매니저도 참이다. 원문이 이
 * 자리에서는 **직책 이름으로 「대표」를 지목**하므로 그 칸을 빌려 쓰면 매니저가 자기 기획의
 * 기한을 스스로 승인할 수 있게 된다.
 *
 * `canCeoComment` 와 같은 값이지만 **줄을 나눠 둔다** — 뜻이 다르고, 한쪽에 사람별 예외가
 * 생기는 날 다른 쪽까지 함께 열리면 안 된다.
 */
export const canCeoApprovePlan = (r: Role): boolean => r === 'ceo';

/**
 * §54 **월 마감 · 마감 해제** — 대표 전용 (테스트 시나리오 C-39 「회계 → 수강·월 청구 → 8월 마감하기」 ·
 * N-140 「마감 해제」). 회계 탭은 `canMoney` 인데 사람별 예외로 매니저에게 금액을 열어 준 날 마감까지
 * 열리면 안 된다 — 다른 대표 전용 줄과 같은 값이지만 같은 이유로 줄을 나눈다.
 */
export const canCeoCloseMonth = (r: Role): boolean => r === 'ceo';

/**
 * §75 중앙 결재 흐름의 서버 projection 범위.
 *
 * 역할 문자열 비교를 drawer controller에 복제하지 않고 이 결과만 소비한다.
 * 강사는 개인 예외로 canAdminPage가 켜져도 §75 정보를 받지 않는다.
 */
export type ApprovalFlowScope = 'none' | 'head' | 'all';

export function approvalFlowScope(
  role: Role,
  overrides?: Partial<Record<PermName, boolean | null>> | null,
): ApprovalFlowScope {
  if (!canAdminPage(role) || !hasPerm(role, 'canAdminPage', overrides)) return 'none';
  return canCeoApprovePlan(role) ? 'all' : 'head';
}

/* ── 화면이 읽는 플래그 ────────────────────────────────────────────────
   명세서 v2 §76 은 플래그 5개로 그린다. 그 이름을 그대로 두되 **판정은
   위 세 줄에서 다시 파생**한다. 저장하지 않는다 (D-R39 · N-11 닫힘).   */

/**
 * ⚠️ **금액을 가리는 판정은 `canMoney` 로 한다** — `canSeeProfit` 이 아니다.
 *
 * 둘의 기본값은 같지만(`role === 'ceo'`) 사람별 예외는 `STAFF.can_money` 컬럼으로만 들어온다.
 * 컨트롤러가 `canSeeProfit` 을 물어보면 그 컬럼이 **읽히지 않는다** —
 * 관리자가 「이 매니저에게 지출을 열어 준다」고 켜 놓아도 화면은 그대로 잠겨 있고,
 * 아무 오류도 안 난다. 실제로 네 컨트롤러가 전부 그랬다.
 *
 * `canSeeProfit` 은 **역할에서 파생된 원본**이고, `canMoney` 는 **예외까지 반영된 결론**이다.
 * 화면과 서버가 물어봐야 하는 것은 언제나 결론 쪽이다.
 */
export interface PermFlags {
  /** 관리자 페이지 진입 */
  canAdminPage: boolean;
  /** 전 항목 CRUD */
  canCrudAll: boolean;
  /** 지출 · 총수입 — **역할에서 나온 원본.** 가리는 판정에는 `canMoney` 를 쓴다 */
  canSeeProfit: boolean;
  /** 오늘·이전 스케줄의 출결 (D-R35) — canCrudAll 과 같다 */
  canCrudAttendance: boolean;
  /** ★ 금액을 볼 수 있는가 — **사람별 예외(STAFF.can_money)까지 반영된 결론** */
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
    // 27N5 채택 (2026-09-12 §4-17): 비공개 지정·열람은 **대표 전용** — §76 「비공개 컨설팅 열람 — 대표만」 원문 그대로
    canHide: canSeeProfit(role),
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
