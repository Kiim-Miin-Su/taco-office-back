/** @file-guide
 * 목적: acct-privacy.ts — ACCT_PRIVACY_KEYS, readAcctPrivacy, lineAmountVisible (lib)
 * 책임/재사용: 회계 비공개 스위치 두 개(시급 · 컨설팅)를 읽고 「이 줄 금액을 이 사람이 보는가」를 한 곳에서 판정한다. 회계 · 컨설팅 읽기가 같은 함수를 부른다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 회계 비공개 (N-94 채택 · W11 M2 · 원문 §53 · §55 컷 탭 줄 오른쪽 「시급 비공개 · 컨설팅 비공개」 · 슬라이드 57 · 77).
 *
 * - 켜고 끄는 사람은 대표 판정(`canCeoSetAcctPrivacy`)이다.
 * - 켜면 그 **줄 금액**은 비공개 열람 판정(`canHide`)을 지나는 사람에게만 보인다. **합계는 그대로다** — 머리 칸 · 달 합계는
 *   가리지 않는다(원문 결정 「합계는 유지하고 줄 금액만 가린다」).
 * - 강사 **본인의** 정산은 늘 본인에게 보인다(강사 히스토리 · 회계 시트에서 자기 줄).
 * - 컨설팅 건별 비공개는 기존 `cons.share`(csCan)가 따로 판정한다 — 이 스위치는 그 위에 한 층을 더할 뿐이다.
 * - 가리는 것은 **서버**다. 화면은 null 을 「비공개」로 적는다(D-R39).
 *
 * 표에 행이 없으면 꺼짐으로 읽는다 — 시드 초기화가 표를 비울 수 있고, 켠 적이 없는 것과 같다.
 */

export const ACCT_PRIVACY_KEYS = ['wage', 'consulting'] as const;
export type AcctPrivacyKey = (typeof ACCT_PRIVACY_KEYS)[number];

/** 탭 줄 단추의 낱말 — 원문 컷 그대로 (D-R18) */
export const ACCT_PRIVACY_LABEL: Record<AcctPrivacyKey, string> = {
  wage: '시급 비공개',
  consulting: '컨설팅 비공개',
};

/** 켰을 때 무엇이 가려지는가 — 한 문장 (화면이 짓지 않는다) */
export const ACCT_PRIVACY_SCOPE: Record<AcctPrivacyKey, string> = {
  wage: '강사료 정산 줄의 시급 · 금액과 시급 이력이 비공개 열람 권한자에게만 보입니다 — 합계는 그대로입니다',
  consulting: '컨설팅비 줄(청구서 · 입금 · 그 밖의 수입 · 컨설팅 회계)의 금액이 비공개 열람 권한자에게만 보입니다 — 합계는 그대로입니다',
};

export interface AcctPrivacySwitch {
  key: AcctPrivacyKey;
  private: boolean;
  setByName: string | null;
  setAt: string | null;
}

interface Queryable { query(sql: string, params?: unknown[]): Promise<unknown> }

/** 감사 줄의 entity_id — log.entity_id 는 숫자다. 스위치 이름의 차례(1 wage · 2 consulting)로 고정한다 */
export const acctPrivacyAuditId = (key: AcctPrivacyKey): number => ACCT_PRIVACY_KEYS.indexOf(key) + 1;

/** 두 스위치 — 행이 없으면 꺼짐 */
export async function readAcctPrivacy(q: Queryable): Promise<Record<AcctPrivacyKey, AcctPrivacySwitch>> {
  const rows = (await q.query(
    `SELECT a.key, a.private, s.name AS set_by_name,
            to_char(a.set_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS set_at
       FROM acct_privacy a LEFT JOIN staff s ON s.id = a.set_by`,
  )) as Array<{ key: string; private: boolean; set_by_name: string | null; set_at: string | null }>;
  const out = {} as Record<AcctPrivacyKey, AcctPrivacySwitch>;
  for (const key of ACCT_PRIVACY_KEYS) {
    const r = rows.find((x) => x.key === key);
    out[key] = { key, private: r?.private === true, setByName: r?.set_by_name ?? null, setAt: r?.set_at ?? null };
  }
  return out;
}

/**
 * 이 줄 금액이 보이는가 — 금액 권한(canMoney)이 먼저고, 스위치가 켜져 있으면 비공개 열람(canHide)이나 본인이어야 한다.
 * 합계 칸에는 쓰지 않는다(합계는 `canSeeAmounts` 만 본다).
 */
export const lineAmountVisible = (canSeeAmounts: boolean, privateOn: boolean, canHide: boolean, isSelf = false): boolean =>
  canSeeAmounts && (!privateOn || canHide || isSelf);
