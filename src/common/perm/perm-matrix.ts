/** @file-guide
 * 목적: perm-matrix.ts — §76 권한 표 열네 줄 · 사람별 예외 다섯 칸의 낱말과 칸 이름 · 역할 설명 문장 (auth)
 * 책임/재사용: 판정은 `perm.ts` 의 `permsOf` 한 곳을 부른다 — 여기서 역할을 비교하지 않는다. 화면은 이 표가 만든 줄과 문장만 그린다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §76 권한 — **표도 문장도 서버가 만든다** (N-98 채택 · W11 · D-R39).
 *
 * 원문 §76 상자의 첫 줄 「역할은 상단 오른쪽에서 바꿉니다」는 프로토타입의 역할 전환 배지 이야기라 옮기지 않는다
 * (제품에는 그 배지가 없다 — 옮기면 거짓 문장이 된다). 나머지 줄은 역할마다 한 줄이고, 원문의 옛 직함 낱말 대신
 * **지금의 `permsOf` 에서 센** 「역할 이름 · N가지 가능 / M가지 잠김」이다 — P1 을 되돌리면 문장이 저절로 참이 된다.
 *
 * 열네 줄의 낱말은 예전 화면(`PermissionMatrix.tsx`)이 들고 있던 것을 **그대로 옮긴 것**이다 — 바꾸지 않았다.
 * 「누가」 칸은 원문의 「대표만 · 실장까지」가 아니라 **권한 깃발의 이름**이다(C68 · 사람별 예외가 있는 계정에서
 * 역할 낱말은 틀린 말이 된다). 그 이름은 아래 예외 다섯 칸의 이름과 한 벌이다.
 */
import { ROLE_LABEL, ROLES, permsOf, type PermFlags, type PermName, type Role } from './perm';

/**
 * 사람별 예외 다섯 칸 — 원문 §76 데이터 줄 「canMoney/canWage/canApprove/canHide/canGpaPack」 그대로 (N-68).
 * 값은 `STAFF.can_*` 의 nullable 불리언 — null 이면 역할을 따른다.
 */
export const PERM_OVERRIDE_KEYS = ['canMoney', 'canWage', 'canApprove', 'canHide', 'canGpaPack'] as const;
export type PermOverrideKey = (typeof PERM_OVERRIDE_KEYS)[number];

/** 칸의 사람 낱말 — §76 표의 「누가」 칸과 §17 수정 창의 토글이 같은 이름을 쓴다 */
export const PERM_OVERRIDE_LABEL: Record<PermOverrideKey, string> = {
  canMoney: '회계 권한',
  canWage: '시급 권한',
  canApprove: '결재 권한',
  canHide: '비공개 권한',
  canGpaPack: '자료 요청 권한',
};

/**
 * 권한 깃발 아홉의 사람 낱말 — 권한 한도(아래 `permGrantIssue`)의 거절 문장이 쓴다.
 * 예외 다섯 칸은 위 표와 **같은 낱말**이고, 역할에서만 나오는 넷은 여기서 이름을 붙인다(낱말은 모두 「권한」으로 끝난다 — 조사 「은」).
 */
export const PERM_FLAG_LABEL: Record<PermName, string> = {
  canAdminPage: '관리 화면 권한',
  canCrudAll: '전체 편집 권한',
  canSeeProfit: '손익 보기 권한',
  canCrudAttendance: '출결 편집 권한',
  ...PERM_OVERRIDE_LABEL,
};

/** 한도를 보는 차례 — 예외 다섯 칸이 먼저(사람마다 달라지는 칸이라 거절 이유로 가장 흔하다), 역할에서만 나오는 넷이 뒤 */
const GRANT_ORDER: readonly PermName[] = [
  ...PERM_OVERRIDE_KEYS, 'canAdminPage', 'canCrudAll', 'canSeeProfit', 'canCrudAttendance',
];

/**
 * 권한 한도 — **내게 없는 권한을 남에게 주지 못한다** (W11 A' 후속 · 리드 결정 · 권한 상승 막기).
 *
 * 대상이 이 쓰기로 **새로 얻게 될** 권한(`after` 에서 참인데 `before` 에서는 아니던 것) 중 보는 사람(`actor`)에게 없는 것이
 * 하나라도 있으면 그 깃발을 돌려준다. 계정 만들기는 `before` 가 없다(전부 새로 얻는다). 잃는 쪽(좁히기)은 막지 않는다.
 * 이 쓰기가 **직접 건드린 예외 칸**(`touched`)은 결과가 켜짐이면 이미 켜져 있던 것도 켜는 것이다(N-68 그대로 —
 * 역할 기본값에 기대던 칸을 예외로 못 박으면 역할이 바뀌어도 남는다).
 * 사람별 예외로 좁혀지지 않은 매니저 · 대표는 역할의 모든 깃발을 가지므로 지금과 같다(P1 그대로).
 * 판정 재료는 전부 `permsOf` 의 결론이다 — 역할을 여기서 비교하지 않는다(D-R39).
 */
export function permGrantIssue(
  actor: PermFlags, before: PermFlags | null, after: PermFlags, touched: readonly PermName[] = [],
): PermName | null {
  return GRANT_ORDER.find((k) => after[k] && !actor[k] && (!(before?.[k] ?? false) || touched.includes(k))) ?? null;
}

/** 거절 문장 — 어느 길로 주려 했는지(만들기 · 역할 바꾸기 · 예외 켜기)에 따라 말만 다르다. 역할 낱말은 넷 다 모음으로 끝난다(조사 「로」) */
export function permGrantBlockedMessage(key: PermName, via: { kind: 'create' | 'role'; role: Role } | { kind: 'override' }): string {
  const label = PERM_FLAG_LABEL[key];
  if (via.kind === 'create') {
    return `${ROLE_LABEL[via.role]} 계정을 만들면 ${label}까지 주게 됩니다 — 내게 없는 권한은 남에게 줄 수 없습니다`;
  }
  if (via.kind === 'role') {
    return `${ROLE_LABEL[via.role]}로 바꾸면 ${label}까지 주게 됩니다 — 내게 없는 권한은 남에게 줄 수 없습니다`;
  }
  return `${label}은 지금 내게 없는 권한이라 남에게 켤 수 없습니다`;
}

/** 저장 칸 이름 — SQL 에 넣는 칸 이름은 이 표에서만 온다(보낸 글이 SQL 이 되지 않는다) */
export const PERM_OVERRIDE_COLUMN: Record<PermOverrideKey, string> = {
  canMoney: 'can_money',
  canWage: 'can_wage',
  canApprove: 'can_approve',
  canHide: 'can_hide',
  canGpaPack: 'can_gpa_pack',
};

export interface PermMatrixRow {
  /** 줄 식별자 — 화면의 React key */
  key: string;
  feature: string;
  what: string;
  who: string;
  perm: PermName;
}

const CRUD_ALL_LABEL = '매니저 이상';
const whoOf = (perm: PermName): string =>
  (PERM_OVERRIDE_KEYS as readonly string[]).includes(perm) ? PERM_OVERRIDE_LABEL[perm as PermOverrideKey] : CRUD_ALL_LABEL;

const row = (key: string, feature: string, what: string, perm: PermName): PermMatrixRow =>
  ({ key, feature, what, who: whoOf(perm), perm });

/** 원문 §76 표 열네 줄 — 차례 · 낱말 그대로 */
export const PERM_MATRIX_ROWS: readonly PermMatrixRow[] = [
  row('money-tab', '회계 탭 전체', '매출 · 수납 · 지출 · 정산 화면', 'canMoney'),
  row('payment', '입금 처리', '받은 돈으로 확정하기', 'canCrudAll'),
  row('expense-review', '사용 내역 승인 · 반려', '직원이 올린 지출 결재', 'canApprove'),
  row('invoice-edit', '청구서 삭제 · 수정', '발행 뒤에도 고칠 수 있음', 'canCrudAll'),
  row('wage-open', '강사 시급 공개 지정', '다른 담당자에게 열어줄지 결정', 'canWage'),
  row('consulting-fee', '컨설팅비 보기', '고액 계약 금액', 'canMoney'),
  row('hide', '내역 비공개 지정', '특정 항목을 나만 보게', 'canHide'),
  row('report-review', '보고 승인 · 반려', '일일 · 주간 · 월간 보고 결재', 'canApprove'),
  row('plan-review', '기획 결재', '기한 승인 → 최종 승인', 'canApprove'),
  row('marketing-comment', '마케팅 코멘트', '대표 피드백 남기기', 'canCrudAll'),
  row('private-consulting', '비공개 컨설팅 열람', '지정 · 전체 비공개 건까지', 'canHide'),
  row('adjust-review', '보정 승인', '금액 조정 결재', 'canApprove'),
  row('gpapack', '자료 요청 접수', '시험 대비 · 자습 자료', 'canGpaPack'),
  row('wage-hours', '강사 시수 기준', '정산 기준 시수 확인', 'canWage'),
];

type Overrides = Partial<Record<PermName, boolean | null>> | null | undefined;

/** 한 줄이 이 사람에게 열려 있는가 — 관리 화면에 못 들어오면 전부 잠김(§76 은 관리 화면의 표다) */
const allowedFor = (flags: ReturnType<typeof permsOf>, perm: PermName): boolean => flags.canAdminPage && flags[perm];

/** 가능 · 잠김 수 — 표와 문장이 **같은 줄들**에서 센다 (D-R37) */
export function permCounts(role: Role, overrides?: Overrides): { possible: number; locked: number } {
  const flags = permsOf(role, overrides);
  const possible = PERM_MATRIX_ROWS.filter((r) => allowedFor(flags, r.perm)).length;
  return { possible, locked: PERM_MATRIX_ROWS.length - possible };
}

/**
 * §76 창 한 벌 — 이 사람의 표(사람별 예외까지 반영된 결론) · 창 머리 부제 · 역할 설명 줄.
 * 역할 설명은 **역할의 기본값**(예외 없음)으로 센다 — 사람이 아니라 역할을 설명하는 줄이다.
 */
export function permissionTable(role: Role, overrides?: Overrides) {
  const flags = permsOf(role, overrides);
  const rows = PERM_MATRIX_ROWS.map((r) => ({ ...r, allowed: allowedFor(flags, r.perm) }));
  const { possible, locked } = permCounts(role, overrides);
  const roleLabel = ROLE_LABEL[role];
  // 역할은 넷 — 힘이 센 쪽부터(원문 상자의 차례 · 대표가 맨 위)
  const roleNotes = [...ROLES].reverse().map((r) => {
    const c = permCounts(r, null);
    return `${ROLE_LABEL[r]} · ${c.possible}가지 가능 / ${c.locked}가지 잠김`;
  });
  return {
    roleLabel, possible, locked,
    // 부제의 모양은 예전 화면 그대로다 — 권한 QA 스크립트(qa-l-perm)가 「N가지 가능 / M가지 잠김」을 읽는다
    sub: `지금 ${roleLabel} 화면입니다 · ${possible}가지 가능 / ${locked}가지 잠김`,
    rows, roleNotes,
  };
}
