/** @file-guide
 * 목적: intake-words.ts — INTAKE_STAGES, IntakeStage, INTAKE_STAGE_LABEL, intakeStageLabel (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 상담 단계 여섯 — **낱말과 순서가 사는 단 하나의 자리** (원본 §23).
 *
 * 컷의 퍼널은 `1차 상담 › 2차 대기 › 2차 상담 › 보류 ⇒ 등록 | 등록 실패` 로 읽힌다.
 * 화살표가 `›` 에서 **`⇒` 로 바뀌는 자리**에 뜻이 있다 — 앞 넷은 **아직 깔때기 안**이고
 * 뒤 둘은 **끝난 결과**다. 그래서 `funnel` 이 단계마다 붙는다.
 *
 * 여섯째 칸의 이름은 「실패」가 아니라 **「등록 실패」**다 (컷 §23 의 여섯째 레인 머리).
 * 화면이 제 표를 들면 보드 머리와 퍼널이 다른 낱말을 쓰게 된다 (D-R18).
 */
export const INTAKE_STAGES = ['first', 'wait2nd', 'second', 'hold', 'enrolled', 'failed'] as const;
export type IntakeStage = (typeof INTAKE_STAGES)[number];

export const INTAKE_STAGE_LABEL: Record<IntakeStage, string> = {
  first: '1차 상담',
  wait2nd: '2차 대기',
  second: '2차 상담',
  hold: '보류',
  enrolled: '등록',
  failed: '등록 실패',
};

/** 아직 깔때기 안인 단계 — 등록·등록 실패는 결과라 빠진다 */
export const INTAKE_FUNNEL_STAGES: readonly IntakeStage[] = ['first', 'wait2nd', 'second', 'hold'];

export const intakeStageLabel = (stage: string): string =>
  INTAKE_STAGE_LABEL[stage as IntakeStage] ?? stage;

export const isIntakeFunnel = (stage: string): boolean =>
  (INTAKE_FUNNEL_STAGES as readonly string[]).includes(stage);
