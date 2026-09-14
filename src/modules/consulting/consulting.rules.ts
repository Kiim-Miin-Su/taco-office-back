/** @file-guide
 * 목적: consulting.rules.ts — CONSULTING_STAGES, CONSULTING_STAGE_LABEL, consultingStageLabel, ConsultingStage, CONTRACT_STEP_MAX 등 (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/** §26 읽기 보드의 불변식. 상태 전이·수납 판정(csPaid)은 별도 쓰기 계약이다. */
export const CONSULTING_STAGES = ['contract', 'running', 'done'] as const;

/**
 * 단계 이름 — 원문 §26 머리글 「계약 → 진행 → 종료」 그대로 (D-R18 · C58).
 * 한동안 화면 파일이 이 표를 따로 들고 있었고, §28 회계 표가 생기면서 두 곳이 될 뻔했다.
 */
export const CONSULTING_STAGE_LABEL: Record<ConsultingStage, string> = {
  contract: '계약',
  running: '진행',
  done: '종료',
};

export const consultingStageLabel = (stage: string): string =>
  CONSULTING_STAGE_LABEL[stage as ConsultingStage] ?? stage;
export type ConsultingStage = (typeof CONSULTING_STAGES)[number];
export const CONTRACT_STEP_MAX = 5;
export const CONSULTING_SESSION_MAX = 32767; // DB smallint 양수 범위

/** §29 생성 화면의 10종. 기존 레거시 cons_type은 조회에서 그대로 보존한다. */
export const CONSULTING_TYPES = [
  'admissions', 'boarding', 'transfer', 'essay', 'interview',
  'exam', 'roadmap', 'college', 'portfolio', 'visa',
] as const;
export type ConsultingType = (typeof CONSULTING_TYPES)[number];
export const CONSULTING_TYPE_LABEL: Record<ConsultingType, string> = {
  admissions: '국제학교 지원',
  boarding: '미국 보딩스쿨',
  transfer: '편입·전학',
  essay: '에세이 지도',
  interview: '인터뷰 대비',
  exam: '입학시험 대비',
  roadmap: '연간 로드맵',
  college: '대학 지원',
  portfolio: '포트폴리오',
  visa: '비자·서류',
};
export const INTERNATIONAL_SCHOOL_ITEMS = [
  '지원서 작성', '학업 성적 공증', '추천서 2부', '자기소개 에세이',
  '활동 증빙 자료', '여권 사본', '재학 증명서',
] as const;
export const CONSULTING_REQUESTERS = ['mother', 'father'] as const;
export type ConsultingRequester = (typeof CONSULTING_REQUESTERS)[number];
export const CONSULTING_FILE_ROLES = ['draft', 'revision', 'signed'] as const;
export type ConsultingFileRole = (typeof CONSULTING_FILE_ROLES)[number];
export const CONSULTING_FILE_MAX = 10;

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
