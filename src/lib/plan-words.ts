/** @file-guide
 * 목적: plan-words.ts — PLAN_STAGES, PlanStage, PLAN_STAGE_LABEL, planStageLabel, PLAN_OPEN_STAGES 등 (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §61 기획 단계 · §62 기획 기한 · §65 기획 보고서의 **낱말 한 벌**.
 *
 * 단계 이름은 원문 §61 머리글 그대로다 — 「작성 중 → 검토 요청 → 보완 요청 → 승인 → 완료」.
 * 한동안 이 표가 **화면에만** 있었다(`app/ops/page.tsx`). §62 기한 표와 §65 보고서가 같은
 * 낱말을 쓰는데 각자 적으면 세 곳이 갈린다 (D-R18).
 */
export const PLAN_STAGES = ['draft', 'review', 'rework', 'approved', 'done'] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];

export const PLAN_STAGE_LABEL: Record<PlanStage, string> = {
  draft: '작성 중',
  review: '검토 요청',
  rework: '보완 요청',
  approved: '승인',
  done: '완료',
};

/** 모르는 코드값이면 코드값을 그대로 보인다 — 비어 보이느니 낯설게 보이는 편이 낫다 */
export const planStageLabel = (stage: string): string =>
  PLAN_STAGE_LABEL[stage as PlanStage] ?? stage;

/** 아직 돌고 있는 기획 — 기한이 지났다고 붉게 칠할 대상이다 */
/**
 * 칸 이름 아래 한 줄 — 원본 §61 의 칸마다 있다.
 * **무엇인지가 아니라 다음에 무엇을 하는지**를 적는다: 「아직 대표께 안 올렸습니다」.
 */
export const PLAN_STAGE_SUB: Record<PlanStage, string> = {
  draft: '아직 대표께 안 올렸습니다',
  review: '대표 확인을 기다립니다',
  rework: '고쳐서 다시 올려야 합니다',
  approved: '진행해도 됩니다',
  done: '끝났습니다',
};

export const PLAN_OPEN_STAGES: readonly string[] = ['draft', 'review', 'rework'];

/**
 * 단계를 옮기는 표 **한 벌** — 원문 §61 「기획 결재 — 왼쪽에서 오른쪽으로 올립니다」.
 *
 * C90 의 `LEAD_NEXT_STAGES` 와 같은 규약이다: **제 길이 따로 있는 전이는 여기서 `[]`** 다.
 * 그래서 `review → approved | rework` 가 이 표에 없다 — 그것은 **대표의 결재**이고
 * `reviewPlan` 이 자기 결재 금지(S1)·기한 승인 선행(C56)·사유 필수를 지나서 옮긴다.
 * 여기에 넣으면 그 셋을 지나지 않는 **두 번째 승인 경로**가 생긴다 (D-R22).
 *
 * 나머지 셋은 **올린 쪽이 하는 일**이다 — 올리고(draft·rework → review), 다 하고(approved → done).
 * `done` 은 오래 아무도 안 쓰던 낱말이다: 마이그레이션 `1756700000000` 이 `ok`·`done` 을
 * 통째로 `approved` 로 접은 뒤 쓰는 코드가 0 이었다. §61 컷의 다섯째 칸이므로 길을 돌려준다.
 */
export const PLAN_NEXT_STAGES: Record<PlanStage, readonly PlanStage[]> = {
  draft: ['review'],
  review: [],
  rework: ['review'],
  approved: ['done'],
  done: [],
};

export const planNextStages = (stage: string): readonly PlanStage[] =>
  PLAN_NEXT_STAGES[stage as PlanStage] ?? [];

/**
 * 본문을 고칠 수 있는 단계 — RPT 의 `WRITABLE_RPT_STATES` 와 같은 모양이다.
 *
 * 올린 뒤(`review`)에 고치면 **대표가 보고 있는 것과 저장된 것이 갈리고**, 결재된 뒤
 * (`approved`·`done`)에 고치면 **승인 도장이 다른 글에 찍힌 것**이 된다.
 */
export const PLAN_WRITABLE_STAGES: readonly string[] = ['draft', 'rework'];

/**
 * 왜 못 고치는가 — **쓰기가 409 로 내는 그 문장**이 읽기의 `editBlockedReason` 으로도 간다
 * (S5 · D-R39 · D-R22). 단계마다 **다음에 할 일이 달라** 문장이 둘이다.
 */
export const planLockedMessage = (stage: string): string =>
  (stage === 'review'
    ? '대표 확인을 기다리는 중입니다 — 보완 요청을 받은 뒤에 고칠 수 있습니다'
    : '결재가 끝난 기획은 고칠 수 없습니다');

/* ── §62 기획 기한 ──────────────────────────────────────────────────── */

/**
 * 기한 표에 섞이는 두 갈래 — 원문 §62 의 「구분」 칸이다.
 * 기획 자체의 마감과, 그 기획에서 빠져나온 과제(TODO)의 기한이 **한 표에 날짜 순으로** 섞인다.
 */
export const PLAN_DUE_KINDS = ['plan', 'task'] as const;
export type PlanDueKind = (typeof PLAN_DUE_KINDS)[number];

export const PLAN_DUE_KIND_LABEL: Record<PlanDueKind, string> = {
  plan: '기획 마감',
  task: '과제',
};

export const planDueKindLabel = (kind: string): string =>
  PLAN_DUE_KIND_LABEL[kind as PlanDueKind] ?? kind;

/**
 * 「남은 날」 한 낱말 — 원문 §62 의 `D-2` · `1일 지남` · `오늘`.
 *
 * 화면이 날짜 두 개를 빼지 않는다. 지난 것을 붉게 칠하는 판정도 이 함수가 낸 `overdueDays`
 * 하나를 본다 (D-R37 · D-R39).
 */
export function dueLabel(daysLeft: number): string {
  if (daysLeft === 0) return '오늘';
  return daysLeft > 0 ? `D-${daysLeft}` : `${-daysLeft}일 지남`;
}

/* ── §65 기획 보고서 ────────────────────────────────────────────────── */

/**
 * 기한이 대표를 지나왔는가 — `due_approved_at` 한 칸에서 파생한다.
 * 상태를 따로 저장하지 않는다: 저장하면 승인 시각과 상태가 갈릴 수 있다 (D-R39).
 */
export const PLAN_DUE_STATES = ['none', 'proposed', 'approved'] as const;
export type PlanDueState = (typeof PLAN_DUE_STATES)[number];

export const PLAN_DUE_STATE_LABEL: Record<PlanDueState, string> = {
  none: '기한 없음',
  proposed: '기한 제안',
  approved: '기한 승인됨',
};

export function planDueState(dueOn: string | null, approvedAt: unknown): PlanDueState {
  if (!dueOn) return 'none';
  return approvedAt ? 'approved' : 'proposed';
}
