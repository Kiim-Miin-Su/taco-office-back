/** @file-guide
 * 목적: consulting.rules.ts — CONSULTING_STAGES, ConsultingStage, CONTRACT_STEP_MAX, CONSULTING_SESSION_MAX, ConsultingRecord 등 (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/** §26 읽기 보드의 불변식. 상태 전이·수납 판정(csPaid)은 별도 쓰기 계약이다. */
export const CONSULTING_STAGES = ['contract', 'running', 'done'] as const;
export type ConsultingStage = (typeof CONSULTING_STAGES)[number];
export const CONTRACT_STEP_MAX = 5;
export const CONSULTING_SESSION_MAX = 32767; // DB smallint 양수 범위

export interface ConsultingRecord {
  stage: ConsultingStage;
  contractStep: number | null;
  sessions: number | null;
}

function positiveInteger(value: unknown, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

/** null은 계약 단계/전체 회차 미확정에만 허용한다. 오류에는 개인정보를 넣지 않는다. */
export function consultingRecordIssue(record: { stage: unknown; contractStep: unknown; sessions: unknown }): string | null {
  if (!CONSULTING_STAGES.some((stage) => stage === record.stage)) return 'invalid_stage';
  if (record.contractStep !== null && !positiveInteger(record.contractStep, CONTRACT_STEP_MAX)) return 'invalid_contract_step';
  if (record.stage !== 'contract' && record.contractStep !== CONTRACT_STEP_MAX) return 'unpaid_stage';
  if (record.sessions !== null && !positiveInteger(record.sessions, CONSULTING_SESSION_MAX)) return 'invalid_sessions';
  return null;
}

/** 건별 순번만 검사한다. seq ≤ sessions 같은 미확정 업무 규칙은 추가하지 않는다. */
export function consultingSessionIssue(sequences: readonly unknown[]): string | null {
  if (sequences.some((seq) => !positiveInteger(seq, CONSULTING_SESSION_MAX))) return 'invalid_session_seq';
  if (new Set(sequences).size !== sequences.length) return 'duplicate_session_seq';
  return null;
}
