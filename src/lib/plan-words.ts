/** @file-guide
 * 목적: plan-words.ts — PLAN_STAGES, PLAN_STAGE_LABEL, planStageLabel 등 (util)
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
export const PLAN_OPEN_STAGES: readonly string[] = ['draft', 'review', 'rework'];

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
