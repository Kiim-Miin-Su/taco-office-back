/** @file-guide
 * 목적: approval.ts — AP_KINDS, ApKind, AP_KINDS_MISSING, AP_KIND_LABEL, REQ_TYPE_LABEL 등 (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 결재 흐름 — 공통 결재 다섯 갈래와 강사 리포트를 **한 모양으로** 만든다 (D-R26 · §14 · §75).
 *
 * 승인 대기함(§14)과 결재 흐름 오버레이(§75)는 **같은 데이터를 다르게 묶어 보여 줄 뿐**이다.
 * 두 화면이 각자 정규화하면 배지 숫자와 목록이 어긋난다 — 그래서 여기 한 곳에서만 만든다.
 *
 * 순수 함수다. 행을 읽어 오는 일은 서비스가 하고, 여기서는 모양만 바꾼다 —
 * DB 없이 테스트할 수 있어야 규칙이 굳는다.
 *
 * §75의 공통 다섯 갈래(RPT·PLAN·REQ·CHREQ·GPAPACK)에 §14의 강사 리포트(REP)를 더한다.
 * `ApFlow.missingKinds`는 저장소가 실제로 없는 종류가 생길 때만 쓴다.
 */

import type { ApprovalFlowScope } from '../common/perm';

/**
 * **올린 사람은 결재하지 못한다.** 결재라는 제도가 성립하는 유일한 조건이다.
 *
 * 이 규칙은 원래 지출에만 있었다 — `expense_no_self_review` DB CHECK(ACCOUNTING §4.3 A-5)와
 * REQ·CHREQ 의 `SELF_APPROVAL_FORBIDDEN`. 그런데 **리포트·대표 보고·기획·GPA 넷에는 한 줄도 없어서**
 * 자기가 쓴 것을 자기가 승인할 수 있었다 (2026-09-20 전수 검수). 규칙을 정해 놓고 한 곳에만 적용하면
 * 다음 사람도 똑같이 빠뜨리므로 **판정을 여기 하나로 모은다.**
 *
 * 왜 「없으면 통과」인가 — 올린 사람이 **누구인지 모르는** 옛 행이 있다(RPT 의 `sent_by` 는 C85-a 에서
 * 생겼고 그 전 행은 NULL 이다 · N-25 기존 행 보정 0). 모르는 것을 「같은 사람이 아니다」로도
 * 「같은 사람이다」로도 단정하지 않는다 — DB CHECK 도 같은 규약을 쓴다(`a IS NULL OR b IS NULL OR a <> b`).
 *
 * `authorId` 를 `unknown` 으로 받는 것은 **raw SQL 행에서 바로 오기 때문**이다 — pg 드라이버가
 * `bigint` 를 문자열로 주므로 호출부마다 캐스팅을 흩뿌리는 대신 여기서 한 번 좁힌다.
 * 숫자로 못 읽는 값은 **막지 않는다**(모르는 것을 같다고 단정하지 않는다).
 *
 * @param authorId 올린·쓴 사람 (REP teacher_id · RPT sent_by · PLAN owner_id · GPA coord_id)
 * @param actorId  지금 결재하려는 사람
 */
export function isSelfReview(authorId: unknown, actorId: number): boolean {
  if (authorId === null || authorId === undefined) return false;
  if (typeof authorId !== 'number' && typeof authorId !== 'string') return false;
  const n = Number(authorId);
  return Number.isFinite(n) && n === actorId;
}

/** 자기 결재 거절의 공통 코드. 예외 종류(409/403)는 각 도메인이 기존 규약대로 고른다. */
export const SELF_APPROVAL_CODE = 'SELF_APPROVAL_FORBIDDEN' as const;

/**
 * 자기 결재를 막는 자리 전부. **여기에 이름이 있는 것은 서버가 반드시 거절한다** —
 * 회귀(`test/self-approval.spec.ts`)가 이 목록을 돌며 확인하므로, 결재 갈래를 새로 만들 때
 * 여기 한 줄을 더하면 그 회귀가 빠진 방어를 바로 잡는다.
 */
export const SELF_APPROVAL_GUARDED = [
  'rep',      // 리포트 승인·반려      — reports.service.review
  'rpt',      // 대표 보고 결재        — exec.service.review
  'plan-due', // 기획 기한 승인        — ops.service.decidePlanDue
  'plan',     // 기획 최종 승인        — ops.service.reviewPlan
  'gpa-use',  // GPA 포인트 승인       — gpa.service.setUseState
  'req',      // 강사 요청 결재        — drawer.service.reviewRequest
  'chreq',    // 변경 요청 반영        — drawer.service.reviewChangeRequest
  'expense',  // 지출 심사             — accounting.service.reviewExpense (+ DB CHECK)
] as const;
export type SelfApprovalGuarded = (typeof SELF_APPROVAL_GUARDED)[number];

/** §75 공통 다섯 갈래 + §14 강사 리포트 (D-R26 · D-R34) */
export const AP_KINDS = ['rep', 'rpt', 'plan', 'req', 'chreq', 'gpapack', 'suggestion', 'missing'] as const;
export type ApKind = (typeof AP_KINDS)[number];

/** §75 중앙 결재 흐름의 정확한 다섯 갈래. §14 REP·건의·누락은 섞지 않는다. */
export const APPROVAL_FLOW_KINDS = ['rpt', 'plan', 'req', 'chreq', 'gpapack'] as const;
export type ApprovalFlowKind = (typeof APPROVAL_FLOW_KINDS)[number];
export const APPROVAL_FLOW_RECIPIENTS = ['ceo', 'head'] as const;
export type ApprovalFlowRecipient = (typeof APPROVAL_FLOW_RECIPIENTS)[number];

export const APPROVAL_FLOW_KIND_LABEL: Record<ApprovalFlowKind, string> = {
  rpt: '대표 보고', plan: '기획 결재', req: '강사 요청', chreq: '변경 요청', gpapack: '자료 요청',
};

export const APPROVAL_FLOW_RECIPIENT: Record<ApprovalFlowKind, ApprovalFlowRecipient> = {
  rpt: 'ceo', plan: 'ceo', req: 'head', chreq: 'head', gpapack: 'head',
};

export const APPROVAL_FLOW_RECIPIENT_NAMES = ['대표', '실장'] as const;
export const APPROVAL_FLOW_RECIPIENT_LABELS = ['대표에게', '실장에게'] as const;
export const APPROVAL_FLOW_RECIPIENT_NAME: Record<ApprovalFlowRecipient, (typeof APPROVAL_FLOW_RECIPIENT_NAMES)[number]> = {
  ceo: '대표', head: '실장',
};
export const APPROVAL_FLOW_RECIPIENT_LABEL: Record<ApprovalFlowRecipient, string> = {
  ceo: '대표에게', head: '실장에게',
};

/**
 * 아직 표가 없어 정규화하지 못하는 것 — **지금은 없다.**
 *
 * 한동안 여기에 `gpapack` 이 들어 있었는데 틀린 것이었다. 표는 처음부터 있었고
 * 시드만 비어 있었다. N-13 으로 막혀 있는 것은 GPA **점수 저장**(§82)이지
 * 자료 요청 결재가 아니다. 화면에 「못 셉니다」라고 적어 두면 아무도 다시 안 본다.
 */
export const AP_KINDS_MISSING: ApKind[] = [];

export const AP_KIND_LABEL: Record<ApKind, string> = {
  rep: '리포트',
  rpt: '대표 보고',
  plan: '기획',
  req: '요청',
  chreq: '변경 요청',
  gpapack: '자료 요청',
  suggestion: '건의 사항',
  missing: '빠진 것',
};

/** §14 필터 순서와 낱말. 화면은 이 표를 복제하지 않고 응답의 `categories`를 그린다. */
export const AP_INBOX_CATEGORIES = [
  'schedule_change', 'book_change', 'tz_change', 'wage_change', 'suggestion', 'gpa_request', 'missing', 'other',
] as const;
export type ApInboxCategory = (typeof AP_INBOX_CATEGORIES)[number];

export const AP_INBOX_CATEGORY_LABEL: Record<ApInboxCategory, string> = {
  schedule_change: '스케줄 변경',
  book_change: '교재 변경',
  tz_change: '시간대 변경',
  wage_change: '시급 변경',
  suggestion: '건의 사항',
  gpa_request: 'GPA 요청',
  missing: '빠진 것',
  other: '기타',
};

/**
 * 낱말 → 사람이 읽는 이름 (D-R18 · 이름의 출처는 하나여야 한다).
 *
 * 서버가 제목을 만들 때도, 화면이 이력 표를 그릴 때도 이 표를 본다.
 * 여기 없는 값은 **그대로 보여 준다** — 「기타」로 뭉개면 새 종류가 생긴 것을 아무도 모른다.
 */
export const REQ_TYPE_LABEL: Record<string, string> = {
  // REQ — 사람이 올리는 요청
  wage_change: '시급 변경', tz_change: '시간대 변경', unav_add: '불가 시간 추가', doc: '서류',
  // CHREQ — 수업을 바꿔 달라는 요청
  time: '시간 변경', time_move: '시간 이동', teacher: '강사 변경',
  // 컷 §19 의 갈래 이름 그대로다 — 「시간 옮기기 · 강사 바꾸기 · 강의실 바꾸기 · **휴강**」.
  // `cancel` 을 「취소」라 적던 동안, 같은 줄의 대상 칸(서버가 지은 문장)은 「휴강」이라
  // 적고 있었다 — 한 줄이 제 갈래를 두 이름으로 부르고 있었다 (`lib/change-request.ts`).
  room: '강의실 변경', off: '휴강', cancel: '휴강',
};

/**
 * 요청이 **무엇을 바라는가** — 낱말과 단위를 만드는 자리는 여기 하나다 (D-R18).
 *
 * 강사 홈(§8)은 바라는 값만 보여 주고, 승인 대기함(§14)은 「지금 → 바라는 것」으로 보여 준다.
 * 두 화면이 각자 숫자를 다듬으면 한쪽만 천 단위 쉼표가 빠지는 날이 온다.
 */
export function reqAsked(reqType: string, payload: unknown): { from: string | null; to: string | null } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const won = (v: unknown) =>
    v === null || v === undefined || v === '' ? null : `${Number(v).toLocaleString('ko-KR')}원/시간`;
  const text = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));

  if (reqType === 'wage_change') return { from: won(p.from), to: won(p.to) };
  if (reqType === 'tz_change') return { from: text(p.from), to: text(p.tz) };
  // 모르는 갈래는 **지어내지 않는다** — 사유가 있으면 그것만 보여 준다
  return { from: null, to: text(p.reason) };
}

/** §14 줄에 적는 한 문장 — 「지금 → 바라는 것」, 앞이 없으면 바라는 것만 */
export function reqAskedLine(reqType: string, payload: unknown): string | null {
  const { from, to } = reqAsked(reqType, payload);
  if (!to) return from;
  return from ? `${from} → ${to}` : to;
}

/** 기존 import 경로는 유지하되 종류의 정본은 변경요청 도메인 파일에 둔다. */
export { CHREQ_TYPES, type ChreqType } from './change-request';

export const GPAPACK_TYPE_LABEL: Record<string, string> = {
  exam: '시험 대비', self: '자습',
};

/**
 * 보고 주기의 이름 — 원문 §69 의 탭이 「**일일** · 주간 · 월간」이다.
 * 한동안 이 표만 「일간」이라 적어, §73 결재함과 §75 결재 흐름의 줄이 **탭과 다른 낱말**을 썼다
 * (화면은 제 표로 「일일」을 그린다 · QA-e 에서 드러났다). 낱말은 한 벌이어야 한다 (D-R18).
 */
export const RPT_TYPE_LABEL: Record<string, string> = {
  day: '일일', week: '주간', month: '월간',
};

/** 표에 없는 낱말은 감추지 않고 그대로 보여 준다 */
export const labelOf = (table: Record<string, string>, key: string): string => table[key] ?? key;

/**
 * 한 줄의 상태. 표마다 낱말이 다르므로 **여기서 세 가지로 좁힌다.**
 *   waiting  기다리는 것 — 내가 승인해야 하거나, 남이 승인해 주기를 기다리는 것
 *   back     되돌아온 것 — 반려. 목록 맨 위로 올라간다 (§75)
 *   done     끝난 것
 */
export type ApState = 'waiting' | 'back' | 'done';

/** §75 가 요구하는 한 줄 — `{k,id,t,s,by,at,st,why,go}` */
export interface ApRow {
  kind: ApKind;
  id: number;
  /** 사람이 읽는 제목 */
  title: string;
  /** 부제 — 종류나 날짜처럼 한 줄 더 */
  sub: string | null;
  /** 올린 사람 */
  byId: number | null;
  byName: string | null;
  at: string;
  state: ApState;
  /** 반려 사유 — `state==='back'` 이면 반드시 있다 (D-R13) */
  why: string | null;
  /** 누르면 갈 곳 — §75 결재 흐름은 여전히 이동만 한다 (D-R27) */
  go: string;
  /** REQ 갈래의 요청 종류 — 화면이 낱말을 만들지 않는다 (D-R18) */
  reqType?: string | null;
  /** 무엇을 바라는가 — 「42,000원/시간 → 45,000원/시간」처럼 이미 사람이 읽는 문장이다 */
  asked?: string | null;
  /**
   * 이 **줄**이 반영 가능한가 — 갈래가 아니라 줄이다.
   *
   * 줌 계정 변경처럼 같은 갈래 안에서도 반영 경로가 없는 것이 있다. `false` 면
   * 권한이 있어도 `canAct` 가 서지 않는다. 기본은 「가능」이다.
   */
  applicable?: boolean;
  /** 이 사람이 **지금** 이 줄을 처리할 수 있는가 — 판정은 서버가 한다 */
  canAct?: boolean;
  /** 못 하는 이유 문장 — 할 수 있으면 null. 쓰기가 내는 말과 같다 (S5) */
  actBlockedReason?: string | null;
  /** §14 필터 분류 — 서버가 만들고 화면은 비교만 한다 (D-R18). */
  category?: ApInboxCategory;
  /** 분류의 사람이 읽는 이름 — 서버 코드표의 값. */
  categoryLabel?: string;
}

export interface CategorizedApRow extends ApRow {
  category: ApInboxCategory;
  categoryLabel: string;
}

export interface ApInboxCategoryCount {
  key: ApInboxCategory;
  label: string;
  count: number;
}

/**
 * §14 승인 대기함에서 **여기서 바로 처리할 수 있는** 갈래.
 *
 * 원문 §14 는 줄마다 「반려」「승인」을 갖고 D-R13 의 절 칸에도 14 가 있다 —
 * 반려 사유가 필수인 화면이 곧 반려하는 화면이다. D-R27 의 「이동만」은 §75
 * 결재 흐름 오버레이의 규칙이다.
 *
 * 갈래마다 **승인이 무엇을 바꾸는가**가 다르고 충돌 검사도 다르다. 그래서 적용 경로가
 * 실제로 만들어진 갈래만 여기 들어온다 — 목록에 없는 갈래는 지금처럼 그 화면으로 보낸다.
 * 「승인 단추가 있는데 눌러도 아무 일이 없다」보다 「아직 저기서 합니다」가 정직하다.
 */
export const AP_ACTIONABLE_KINDS: ApKind[] = ['req', 'chreq'];

export interface ApFlow {
  /** 되돌아온 것 → 기다리는 것 → 내가 올린 것 순 (§75) */
  back: CategorizedApRow[];
  waiting: CategorizedApRow[];
  mine: CategorizedApRow[];
  /** §14 승인 대기함 — 요청·건의·GPA·DB에서 계산한 누락만, 완료 행은 제외한다. */
  inbox: CategorizedApRow[];
  /** §14 칩. 0건 갈래도 원문 순서를 유지해 화면이 누락 여부를 알 수 있다. */
  categories: ApInboxCategoryCount[];
  /** 배지 숫자 — `apCount()` */
  count: number;
  /** §14 우측 레일 배지 — `inbox.length`와 반드시 같다. */
  inboxCount: number;
  /** 아직 표가 없어 못 세는 갈래 */
  missingKinds: ApKind[];
}

export interface ApprovalFlowItem {
  kind: ApprovalFlowKind;
  kindLabel: string;
  id: number;
  title: string;
  sub: string | null;
  byId: number | null;
  byName: string;
  to: ApprovalFlowRecipient;
  /** 행의 '김범준 → 대표'에 쓰는 조사 없는 이름. */
  toName: string;
  /** 타일의 '대표에게'에 쓰는 완성된 이름. */
  toLabel: string;
  at: string;
  state: 'back' | 'waiting' | 'mine';
  why: string | null;
  go: string;
}

export interface ApprovalFlowTile {
  kind: ApprovalFlowKind;
  kindLabel: string;
  to: ApprovalFlowRecipient;
  toLabel: string;
  count: number;
}

export interface ApprovalFlowProjection {
  canView: boolean;
  tiles: ApprovalFlowTile[];
  /** 돌아온 건 → 기다리는 건 → 내가 올린 건 순서로 화면이 그린다. */
  back: ApprovalFlowItem[];
  waiting: ApprovalFlowItem[];
  mine: ApprovalFlowItem[];
  /** 원문 '지금 N건 대기' — waiting과 같은 배열에서 세다. */
  total: number;
  backCount: number;
}

/** §75 전용 읽기 projection. §14와 ApRow 원장을 공유하되 의미는 섞지 않는다. */
export function approvalFlowProjection(
  rows: readonly ApRow[], viewerId: number, scope: ApprovalFlowScope,
): ApprovalFlowProjection {
  if (scope === 'none') {
    return { canView: false, tiles: [], back: [], waiting: [], mine: [], total: 0, backCount: 0 };
  }

  const exact = rows.filter((row): row is ApRow & { kind: ApprovalFlowKind } =>
    (APPROVAL_FLOW_KINDS as readonly ApKind[]).includes(row.kind));
  const item = (row: ApRow & { kind: ApprovalFlowKind }, state: ApprovalFlowItem['state']): ApprovalFlowItem => {
    const to = APPROVAL_FLOW_RECIPIENT[row.kind];
    return {
      kind: row.kind, kindLabel: APPROVAL_FLOW_KIND_LABEL[row.kind], id: row.id,
      title: row.title, sub: row.sub, byId: row.byId,
      // RPT에는 아직 제출자 FK가 없다. 화면이 추정하지 않도록 경계를 값으로 내린다.
      byName: row.byName ?? '알 수 없음',
      to, toName: APPROVAL_FLOW_RECIPIENT_NAME[to], toLabel: APPROVAL_FLOW_RECIPIENT_LABEL[to],
      at: row.at, state, why: row.why, go: row.go,
    };
  };
  const byAtDesc = (a: ApprovalFlowItem, b: ApprovalFlowItem) =>
    (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
  // '돌아온 건'은 **내가 올렸다가** 반려된 건이다. 대표라도 남의 반려 이력을 여기 섞지 않는다.
  const back = exact
    .filter((row) => row.state === 'back' && row.byId === viewerId)
    .map((row) => item(row, 'back')).sort(byAtDesc);
  const waiting = exact
    .filter((row) => row.state === 'waiting' && row.byId !== viewerId)
    .filter((row) => scope === 'all' || APPROVAL_FLOW_RECIPIENT[row.kind] === 'head')
    .map((row) => item(row, 'waiting')).sort(byAtDesc);
  const mine = exact
    .filter((row) => row.state !== 'back' && row.byId === viewerId)
    .map((row) => item(row, 'mine')).sort(byAtDesc);
  const tiles = APPROVAL_FLOW_KINDS.map((kind) => {
    const to = APPROVAL_FLOW_RECIPIENT[kind];
    return {
      kind, kindLabel: APPROVAL_FLOW_KIND_LABEL[kind], to,
      toLabel: APPROVAL_FLOW_RECIPIENT_LABEL[to],
      count: waiting.filter((row) => row.kind === kind).length,
    };
  });
  return { canView: true, tiles, back, waiting, mine, total: waiting.length, backCount: back.length };
}

/** §14의 분류는 저장 표 이름이 아니라 업무 의미다. 이 함수 한 곳에서만 대응한다. */
export function approvalInboxCategory(row: ApRow): ApInboxCategory {
  if (row.kind === 'missing') return 'missing';
  if (row.kind === 'suggestion') return 'suggestion';
  if (row.kind === 'gpapack') return 'gpa_request';
  if (row.kind === 'chreq') return 'schedule_change';
  if (row.kind === 'req') {
    if (row.reqType === 'tz_change') return 'tz_change';
    if (row.reqType === 'wage_change') return 'wage_change';
    if (row.reqType === 'book_change') return 'book_change';
  }
  return 'other';
}

export const AP_STATE_WORDS: Record<ApState, readonly string[]> = {
  // 되돌아온 것 — PLAN.stage 의 rework 가 여기 붙는다
  back: ['rejected', 'rej', 'rework', 'denied', 'no', 'back'],
  // 끝난 것
  done: ['approved', 'ok', 'done', 'closed', 'applied', 'delivered', 'received'],
  /**
   * 기다리는 것 — 기본값이기도 하다.
   *
   * ⚠ `sent` 가 여기 있는 것이 중요하다. TBO-29 에서 「나갔으니 끝난 것」이라 보고
   * `done` 에 넣었는데 **틀렸다.** RPT 에서 `sent` 는 「대표께 올렸고 검토를 기다린다」는 뜻이다
   * (`erd.dbml` RPT: `draft | sent | ok | rej` · `reviewed_at` 이 그 뒤에 찍힌다).
   * 그래서 제출된 대표 보고 4건이 승인 대기함에서 통째로 빠져 있었다 — D-R34 가 말하는
   * 「전건이 뜬다」의 정반대다. 안내(GUIDE)의 `sent` 는 발송 완료지만, 그 표는 결재를 돌지 않는다.
   */
  waiting: ['pending', 'review', 'submitted', 'sent', 'wait', 'open', 'draft'],
};

/**
 * 표마다 다른 상태 낱말을 셋으로 좁힌다.
 *
 * 모르는 값은 **기다리는 것**으로 둔다 — 사라지는 것보다 낫다.
 * 다만 그 관대함이 낱말이 어긋난 것을 덮어 버리므로,
 * `test/approval.spec.ts` 가 **DB 에 실제로 있는 낱말이 전부 위 표에 있는지** 검사한다.
 */
export function toApState(raw: string | null | undefined): ApState {
  const v = String(raw ?? '').toLowerCase();
  if (AP_STATE_WORDS.back.includes(v)) return 'back';
  if (AP_STATE_WORDS.done.includes(v)) return 'done';
  return 'waiting';
}

/** 표에 없는 낱말인가 — 조용한 오분류를 잡으려고 테스트가 쓴다 */
export const isKnownApWord = (raw: string | null | undefined): boolean =>
  Object.values(AP_STATE_WORDS).some((ws) => ws.includes(String(raw ?? '').toLowerCase()));

/**
 * 공통 결재 다섯 갈래와 강사 리포트를 한 목록으로 묶는다.
 *
 * @param viewerId  「내가 올린 것」을 가르는 기준
 * @param canApprove 승인 권한이 있는가 — 없으면 `waiting` 에 남의 건이 들어가지 않는다 (D-R39)
 * @param canWage 시급을 다룰 수 있는가 — **시급 요청은 이것까지 있어야 승인된다**(S5).
 *   `reviewRequest` 가 403 `WAGE_REVIEW_FORBIDDEN` 로 막는데 `canAct` 가 그것을 몰라서
 *   단추가 선 채 눌러야만 거절당했다. 안 주면 예전처럼 **승인 권한만** 본다.
 */
export function apFlow(
  rows: ApRow[],
  viewerId: number,
  canApprove: boolean,
  canWage?: boolean,
): ApFlow {
  const back: CategorizedApRow[] = [];
  const waiting: CategorizedApRow[] = [];
  const mine: CategorizedApRow[] = [];

  /* §14와 §75가 같은 원장 행을 보되, §14의 필터 분류까지 서버가 붙인다.
     행 객체를 복제해 호출자가 넘긴 배열을 오염시키지 않는다. */
  const categorizedRows: CategorizedApRow[] = rows.map((source) => {
    const category = approvalInboxCategory(source);
    return { ...source, category, categoryLabel: AP_INBOX_CATEGORY_LABEL[category] };
  });

  for (const r of categorizedRows) {
    const isMine = r.byId !== null && r.byId === viewerId;
    // 처리할 수 있는가 — 권한이 있고, 남의 것이고, 아직 기다리는 중이고, 적용 경로가 있는 갈래
    const open = canApprove && !isMine && r.state === 'waiting'
      && AP_ACTIONABLE_KINDS.includes(r.kind) && r.applicable !== false;
    /* **시급 요청은 한 층이 더 있다**(S5) — `reviewRequest` 가 `canWage` 없이 승인하면 403 을 낸다.
       인자를 안 준 호출자에게는 예전 그대로다(모르는 쪽으로 닫지 않는다 — 그러면 §75 가 통째로 잠긴다). */
    const needsWage = open && r.kind === 'req' && r.reqType === 'wage_change' && canWage === false;
    r.canAct = open && !needsWage;
    r.actBlockedReason = needsWage ? '시급을 다룰 권한이 필요합니다' : null;
    // 남의 결재는 승인 권한이 있을 때만 **목록에서 아예 뺀다.**
    // 감추기만 하면 「있다」는 사실이 배지 숫자로 새어 나간다 (D-R39).
    if (!isMine && !canApprove) continue;

    // 되돌아온 것이 맨 위 — 내 것이든 남의 것이든 (§75)
    if (r.state === 'back') { back.push(r); continue; }
    if (r.state === 'done') { if (isMine) mine.push(r); continue; }
    // 기다리는 것 — 내가 올린 것은 「내가 올린 것」으로, 남의 것은 승인 대기로
    if (isMine) mine.push(r);
    else waiting.push(r);
  }

  const byAtDesc = (a: ApRow, b: ApRow) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
  back.sort(byAtDesc); waiting.sort(byAtDesc); mine.sort(byAtDesc);

  const inboxKinds: ApKind[] = ['req', 'chreq', 'gpapack', 'suggestion', 'missing'];
  const inbox = canApprove
    ? categorizedRows.filter((r) => inboxKinds.includes(r.kind) && r.state !== 'done').sort(byAtDesc)
    : [];
  const categories = AP_INBOX_CATEGORIES.map((key) => ({
    key,
    label: AP_INBOX_CATEGORY_LABEL[key],
    count: inbox.filter((row) => row.category === key).length,
  }));

  return {
    back, waiting, mine,
    inbox,
    categories,
    // §75 결재 흐름 숫자는 기존 의미를 유지한다.
    count: back.length + waiting.length,
    // §14 우측 레일은 실제 inbox 행과 같은 배열에서 센다.
    inboxCount: inbox.length,
    missingKinds: [...AP_KINDS_MISSING],
  };
}

/** 「김민선 → 대표」처럼 누가 누구에게를 한 문장으로 (§75 표시 규약) */
export function apSentence(r: ApRow, toName: string | null): string {
  const from = r.byName ?? '알 수 없음';
  return toName ? `${from} → ${toName}` : from;
}
