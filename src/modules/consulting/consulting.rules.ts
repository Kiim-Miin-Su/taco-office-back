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

/**
 * 칸 이름 아래 한 줄 — 원본 §26 의 칸마다 있다.
 * **무엇인지가 아니라 다음에 무엇을 하는지**를 적는다: 「계약서 만들고 서명받기」.
 */
export const CONSULTING_STAGE_SUB: Record<ConsultingStage, string> = {
  contract: '계약서 만들고 서명받기',
  running: '회차별로 만나고 기록',
  done: '마무리하고 안내',
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

/** 요청자 — 원본 §26 카드의 「어머니 · 김범준」 왼쪽 반 */
export const CONSULTING_REQUESTER_LABEL: Record<ConsultingRequester, string> = {
  mother: '어머니',
  father: '아버지',
};
export const consultingRequesterLabel = (v: string | null | undefined): string | null =>
  v == null ? null : (CONSULTING_REQUESTER_LABEL[v as ConsultingRequester] ?? v);

/**
 * §30 계약 5단계의 이름 — 원본 그대로 「계약서 준비 · 피드백 · 전달 · 서명 · 수납」.
 * 한동안 **화면 파일만** 이 표를 들고 있었다(`front/src/lib/consulting.ts`) — 단계 이름이
 * §26 카드의 칩에도 쓰이는데, 서버가 단계 수를 말하고 화면이 이름을 붙이면 둘이 갈린다 (D-R18).
 */
export const CONSULTING_CONTRACT_STEPS = ['계약서 준비', '피드백', '전달', '서명', '수납'] as const;

/** 1~5 밖은 이름이 없다 — 미정(null)과 잘못된 값을 같은 자리에서 막는다 */
export const consultingContractStepLabel = (step: number | null | undefined): string | null =>
  typeof step === 'number' && Number.isInteger(step) && step >= 1 && step <= CONTRACT_STEP_MAX
    ? CONSULTING_CONTRACT_STEPS[step - 1]
    : null;

/**
 * 공개 범위 이름 — 역할 권한과 **독립된 두 번째 층**의 낱말 (DEV-SPEC §4.4).
 * 화면 파일이 들고 있던 표를 **옮긴 것이고 바꾼 것이 아니다.**
 */
export const CONS_SHARE_LABEL: Record<string, string> = {
  all: '전체 공개',
  money_only: '수납만 공개',
  picked: '지정 공개',
  private: '전체 비공개',
};
export const consShareLabel = (share: string): string => CONS_SHARE_LABEL[share] ?? share;
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

/* ══ §31 회차 · 종료 — C95 (테스트 시나리오 I-91 · I-95 · N-18 채택 「필수 항목 + 약정 회차 후 명시 종료」) ══ */

/** 회차 기록의 「이미 한 회차」 — 날짜가 오늘 이하(또는 미정)인 행. 앞으로 잡아 둔 날짜는 아직 한 것이 아니다 (기록 ≠ 완료 · N-18). */
export function consultingSessionDone(onDate: string | null, today: string): boolean {
  return onDate === null || onDate <= today;
}

export interface ConsultingCloseInput {
  stage: string;
  /** 약정 회차 — null 이면 회차 조건 없음 */
  sessions: number | null;
  /** 오늘까지 한 회차 수 */
  sessionsDone: number;
  /** 아직 안 끝낸 필수 항목 수 */
  requiredLeft: number;
  /**
   * 앞으로 잡아 둔 회차 수 — 오늘보다 뒤인 `cons_sess` 행.
   *
   * **이 칸이 없어서 단추가 헛섰다**(S5). 판정은 여기 한 곳인데 「잡아 둔 날짜」만 쓰기 쪽
   * (`ConsultingSessionService.close`)에서 따로 던져서, 필수 항목과 약정 회차를 다 채운 건은
   * `canClose === true` 로 단추가 서고 **미리 보기를 눌러야 409** 를 받았다.
   */
  sessionsPlanned: number;
}

/**
 * 종료할 수 있는가 — **N-18 채택문 그대로**: 「필수 항목과 약정 회차 완료 후 명시 종료」.
 * 예외 종료(사유·승인)는 N-18-a 가 아직 열려 있어 만들지 않는다 — 막힌 이유를 문장으로 돌려 화면이 그대로 말한다.
 */
export function consultingCloseIssue(input: ConsultingCloseInput): { code: string; message: string } | null {
  if (input.stage === 'done') return { code: 'CONS_ALREADY_DONE', message: '이미 종료된 컨설팅입니다' };
  if (input.stage !== 'running') return { code: 'CONS_NOT_RUNNING', message: '수납이 끝나 진행 중인 컨설팅만 종료할 수 있습니다' };
  if (input.requiredLeft > 0) {
    return { code: 'CONS_ITEMS_LEFT', message: `필수 항목 ${input.requiredLeft}개가 남아 있습니다 — 끝내야 종료할 수 있습니다 (N-18)` };
  }
  if (input.sessions !== null && input.sessionsDone < input.sessions) {
    return {
      code: 'CONS_SESSIONS_LEFT',
      message: `약정 ${input.sessions}회 중 ${input.sessionsDone}회를 했습니다 — 남은 ${input.sessions - input.sessionsDone}회를 마쳐야 종료할 수 있습니다 (예외 종료는 N-18-a)`,
    };
  }
  /* 앞으로 잡아 둔 회차 — 종료 뒤에 남으면 시간표가 끝난 컨설팅을 계속 부른다.
     접는 정책(사유·처리)을 지어내지 않고 막는다. 순서는 쓰기 쪽과 같다(항목 → 약정 회차 → 잡아 둔 날짜). */
  if (input.sessionsPlanned > 0) {
    return {
      code: 'CONS_SESSIONS_PLANNED',
      message: `앞으로 잡아 둔 회차 ${input.sessionsPlanned}개가 있습니다 — 시간표에서 접거나 날짜가 지나야 종료할 수 있습니다`,
    };
  }
  return null;
}

/** 회차를 더 잡을 수 있는가 — 진행 중인 건만. 종료·계약 단계는 이유를 돌려준다 */
export function consultingSessionAddIssue(stage: string): { code: string; message: string } | null {
  if (stage === 'done') return { code: 'CONS_LOCKED', message: '종료된 컨설팅에는 회차를 더할 수 없습니다' };
  if (stage !== 'running') return { code: 'CONS_NOT_RUNNING', message: '수납이 끝나야 회차를 기록할 수 있습니다 (계약 → 진행)' };
  return null;
}

/**
 * 「남은 금액」 한 문장 (S5 · D-R22).
 *
 * 단추가 미리 말하는 이유(`payGate` 의 `payBlockedReason`)와 눌렀을 때의 거절(409 `OVERPAY`)이
 * **같은 말이어야 한다.** 두 벌로 적어 두었더니 화면은 「남은 금액이 없습니다」라 적고 서버는
 * 「남은 금액은 0원입니다 — …」라 답했다. 같은 사실을 두 곳에 적지 않는다.
 *
 * 음수는 0 으로 접는다 — 이미 더 받은 건이라도 「남은 금액은 −3만원」이라 적지 않는다.
 */
export const consultingRemainingMessage = (remaining: number): string =>
  `남은 금액은 ${Math.max(0, remaining)}원입니다 — 그보다 많이 적을 수 없습니다`;
