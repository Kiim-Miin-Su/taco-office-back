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
/**
 * 종류 이름 — 원본 §29 칩 그대로. 가운뎃점은 **앞뒤를 띄운다**(「편입 · 전학」 · 「비자 · 서류」 · 29-02).
 * 화면(front `lib/consulting.ts`)이 같은 표를 따로 들고 있다가 이 표와 갈렸다 — 이제 화면은 목록 응답의
 * `types` · 줄마다의 `typeLabel` 만 읽는다 (D-R18).
 */
export const CONSULTING_TYPE_LABEL: Record<ConsultingType, string> = {
  admissions: '국제학교 지원',
  boarding: '미국 보딩스쿨',
  transfer: '편입 · 전학',
  essay: '에세이 지도',
  interview: '인터뷰 대비',
  exam: '입학시험 대비',
  roadmap: '연간 로드맵',
  college: '대학 지원',
  portfolio: '포트폴리오',
  visa: '비자 · 서류',
};
/** 모르는(옛) 종류 코드는 코드 그대로 둔다 — 조회는 저장 값을 줄이지 않는다 */
export const consultingTypeLabel = (type: string): string =>
  CONSULTING_TYPE_LABEL[type as ConsultingType] ?? type;
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
 * §29 고르개의 낱말 두 벌 — 종류 10 · 요청자 2. 목록 응답(`ConsultingListDto.types · requesters`)이 이 차례 그대로 싣는다.
 * 화면이 같은 표를 들고 있으면 이름이 갈린다(29-02 가운뎃점이 실제로 갈렸다 · D-R18).
 */
export const consultingTypeWords = (): Array<{ key: string; label: string }> =>
  CONSULTING_TYPES.map((key) => ({ key, label: CONSULTING_TYPE_LABEL[key] }));
export const consultingRequesterWords = (): Array<{ key: string; label: string }> =>
  CONSULTING_REQUESTERS.map((key) => ({ key, label: CONSULTING_REQUESTER_LABEL[key] }));

/**
 * §30 계약 5단계의 이름 — 원본 그대로 「계약서 준비 · 피드백 · 전달 · 서명 · 수납」.
 * 한동안 **화면 파일만** 이 표를 들고 있었다(`front/src/lib/consulting.ts`) — 단계 이름이
 * §26 카드의 칩에도 쓰이는데, 서버가 단계 수를 말하고 화면이 이름을 붙이면 둘이 갈린다 (D-R18).
 */
export const CONSULTING_CONTRACT_STEPS = ['계약서 준비', '피드백', '전달', '서명', '수납'] as const;

/**
 * 단계마다 한 줄 — 원본 §30 스테퍼의 이름 아래 글 그대로 (30-07). 이름과 같은 자리에 둔다 — 화면이 짝을 맞추지 않는다 (D-R18).
 */
export const CONSULTING_CONTRACT_STEP_SUB = ['초안을 올립니다', '누구나 의견을 답니다', '학부모께 보냅니다', '스캔본을 받습니다', '계약금을 받습니다'] as const;

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

/**
 * §26 카드의 공개 칩 낱말 — 원본은 「**수납만**」(짧은 낱말)이다 (26-08 · D-R44).
 * 원본 카드에 보이는 제한 범위는 수납만 하나라, 나머지(지정 공개 · 전체 비공개)는 **지어내지 않고** 이름 그대로 둔다.
 * 머리·배너·고르개는 계속 긴 이름(`CONS_SHARE_LABEL`)이다 — 칩 한 자리만 짧다.
 */
export const CONS_SHARE_CHIP_LABEL: Record<string, string> = { money_only: '수납만' };
export const consShareChipLabel = (share: string): string => CONS_SHARE_CHIP_LABEL[share] ?? consShareLabel(share);

/**
 * 공개 범위의 뜻 한 줄 — 슬라이드 32 설명 넷 그대로. §29 칩 아래 · §30·§31 공개 범위 한 줄 배너가 같이 쓴다 (29-06 · 30-06).
 */
export const CONS_SHARE_MEANING: Record<string, string> = {
  all: '관리자 누구나 봅니다',
  money_only: '금액만 보이고 내용은 숨깁니다',
  picked: '고른 사람만 봅니다',
  private: '담당자와 대표만 봅니다',
};
export const consShareMeaning = (share: string): string | null => CONS_SHARE_MEANING[share] ?? null;
/** `item` — §31 항목 파일(N-63). 계약 파일(초안·수정본·서명본)과 같은 표에 있지만 따로 센다 */
export const CONSULTING_FILE_ROLES = ['draft', 'revision', 'signed', 'item'] as const;
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

/**
 * §26 카드 · §30 머리의 「N일 지남」 — **계약 시작일(`cons.start_on`)부터 오늘까지** (DTO 설명 「시작한 지 며칠」 그대로).
 *
 * 예전에는 `created_at`(건이 생긴 날)으로 셌다 — 시드와 새 건이 모두 「0일 지남」이 되어(qa-w3 관찰) 말할 것이 없었다.
 * 시작일이 없거나(옛 건) **아직 시작 전**(계약 단계의 예정 시작일)이면 null — 「−5일 지남」이나 「0일 지남」을 지어내지 않는다.
 * 원본 컷의 수(60 · 50)는 「종료일 − 오늘」과 맞아 산식 자체는 확인이 필요하다(26-10) — 바꿀 자리는 이 함수 하나다.
 */
export function consultingAgeDays(startOn: string | null | undefined, today: string): number | null {
  if (!startOn || startOn > today) return null;
  return Math.round((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${startOn}T00:00:00Z`).getTime()) / 86400000);
}

/** 회차 기록의 「이미 한 회차」 — 날짜가 오늘 이하(또는 미정)인 행. 앞으로 잡아 둔 날짜는 아직 한 것이 아니다 (기록 ≠ 완료 · N-18). */
export function consultingSessionDone(onDate: string | null, today: string): boolean {
  return onDate === null || onDate <= today;
}

/**
 * 같은 판정의 SQL 조각 — `cons_sess` 별칭과 「오늘」 파라미터를 받는다. 상세·학생별·회차 잡기·종료가 **이 한 조각**으로 센다
 * (27-04 — §27 학생별이 기록 행 수를 적어 §26·§30 과 다른 수를 말했다 · D-R37).
 */
export const consSessDoneSql = (alias: string, todayParam: string): string =>
  `(${alias}.on_date IS NULL OR ${alias}.on_date <= ${todayParam}::date)`;

/**
 * 회차 본문이 다 적혔는가 — 원본 §31 회차 머리의 「기록됨」 (31-07). 무엇을 · 왜 · 어떻게가 다 차면 그 회차의 할 일도 접힌다
 * (`ConsultingSessionService.writeSession` 과 같은 조건 — 화면이 네 칸을 다시 세지 않는다).
 */
export function consultingSessionRecorded(s: { what?: string | null; why?: string | null; how?: string | null }): boolean {
  return Boolean(s.what && s.why && s.how);
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
 * 막힌 이유를 문장으로 돌려 화면이 그대로 말한다. 필수 항목·약정 회차가 남은 건의 **예외 종료**(사유 · 승인)는
 * 아래 `consultingExceptionCloseIssue` 가 이 판정 위에서 가른다(N-18-a · W11).
 */
export function consultingCloseIssue(input: ConsultingCloseInput): { code: string; message: string } | null {
  if (input.stage === 'done') return { code: 'CONS_ALREADY_DONE', message: '이미 종료된 컨설팅입니다' };
  if (input.stage !== 'running') return { code: 'CONS_NOT_RUNNING', message: '수납이 끝나 진행 중인 컨설팅만 종료할 수 있습니다' };
  if (input.requiredLeft > 0) {
    return { code: 'CONS_ITEMS_LEFT', message: `필수 항목 ${input.requiredLeft}개가 남아 있습니다 — 끝내야 종료할 수 있습니다` };
  }
  if (input.sessions !== null && input.sessionsDone < input.sessions) {
    return {
      code: 'CONS_SESSIONS_LEFT',
      message: `약정 ${input.sessions}회 중 ${input.sessionsDone}회를 했습니다 — 남은 ${input.sessions - input.sessionsDone}회를 마쳐야 종료할 수 있습니다`,
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

/* ══ W11 결정 채택 — 받은 돈 한 조각(N-33 ②) · 예외 종료(N-18-a) · 항목 수정 · 항목 파일(N-63) · 지우기 조건(PB-11) ══ */

/**
 * 받은 돈 = `cons_pay` 누계 + **살아 있는 전환 청구서에 붙은 입금**(`pay`) — SQL 조각 **한 벌**이다 (N-33 ② · PB-03 · D-R22).
 *
 * 계약 → 진행 전이(`ConsultingService.promoteWhenPaid`)와 §28 회계 · §26 카드 · §27 학생별 · §30 상세의 「받은 돈」이
 * 이 조각 하나를 읽는다. 전에는 전이만 두 원장을 합쳐 읽고 §28 은 `cons_pay` 만 세어, 전환 청구서로 다 낸 건이
 * 진행으로 넘어갔는데도 §28 은 「남은 돈」을 그대로 보였다.
 * 두 원장은 같은 돈을 담지 않는다 — 전환은 남은 돈으로만 내고, 전환 뒤에는 `cons_pay` 를 막는다(`CONS_PAY_INVOICED`).
 * 그래서 더해도 두 번 세지 않는다. **읽기만 한다** — 한 원장의 돈을 다른 원장으로 옮겨 적지 않는다.
 *
 * @param cons 바깥 질의의 `cons` 별칭(예: `c`)
 */
export const consPaidSql = (cons: string): string =>
  `(COALESCE((SELECT sum(cp.amount) FROM cons_pay cp WHERE cp.cons_id = ${cons}.id), 0)
      + COALESCE((SELECT sum(ip.amount) FROM pay ip JOIN inv ii ON ii.id = ip.inv_id
                   WHERE ii.cs_id = ${cons}.id AND ii.state <> 'void'), 0))`;

/**
 * 예외 종료를 할 수 있는가 — N-18-a 채택(DQ6 권장안 「관리 권한자가 사유를 남기고 승인한 뒤 예외 종료」).
 *
 * 여는 것은 **필수 항목이 남았거나(`CONS_ITEMS_LEFT`) 약정 회차가 모자란(`CONS_SESSIONS_LEFT`)** 진행 중인 건뿐이다.
 * 그 밖의 막힘은 정상 종료와 같은 문장으로 그대로 막는다 — 계약 단계 · 이미 종료 · **앞으로 잡아 둔 회차**
 * (시간표를 조용히 접지 않는다 — 시간표에서 접거나 날짜가 지나야 한다).
 * 정상 종료가 되는 건에는 예외가 필요 없다 — 사유가 사실과 다른 기록이 되지 않게 막는다.
 * 승인 권한(`perm.ts` `canCeoApproveConsultingClose`)은 부르는 쪽이 따로 본다 — 여기는 건의 상태만 본다.
 */
export function consultingExceptionCloseIssue(input: ConsultingCloseInput): { code: string; message: string } | null {
  const issue = consultingCloseIssue(input);
  if (issue === null) {
    return { code: 'CONS_CLOSE_EXCEPTION_NOT_NEEDED', message: '필수 항목과 약정 회차를 다 마쳤습니다 — 예외 없이 종료하세요' };
  }
  if (issue.code !== 'CONS_ITEMS_LEFT' && issue.code !== 'CONS_SESSIONS_LEFT') return issue;
  // 항목·회차 뒤에 가려진 「잡아 둔 회차」도 막는다 — 같은 판정을 항목·회차 조건 없이 한 번 더 본다
  return consultingCloseIssue({ ...input, requiredLeft: 0, sessions: null });
}

/** 항목 파일 한도 — 원문 §31 항목 줄의 「파일」 · 항목마다 6개(N-63). 계약 파일 10개(`CONSULTING_FILE_MAX`)와 따로 센다 */
export const CONS_ITEM_FILE_MAX = 6;
/** 한 컨설팅의 항목 수 상한 — 「항목 수정」으로 더할 수 있는 끝(원문 기본 항목 6~12개의 두 배 남짓 · smallint 순번) */
export const CONS_ITEM_MAX = 30;

export interface ConsItemFacts {
  /** 건의 단계 — 종료된 건의 항목은 바꾸지 않는다 */
  stage: string;
  done: boolean;
  /** template(§29 기본 항목) | manual(「항목 수정」으로 더한 것) */
  source: string;
  /** 이 항목에 붙은 파일 수 */
  files: number;
}

/**
 * 항목 하나에 대한 쓰기가 막히는 까닭 — 「항목 수정」(이름 바꾸기 · 빼기)과 항목 「파일」 올리기가 **같은 함수**를 본다.
 * 화면의 단추(`ConsItemDto.canRename · canRemove · canAddFile`)도 이 함수에서 나온다 — 단추와 쓰기가 다른 답을 하지 않게 (D-R39 · D-R22).
 *
 * - 끝낸 항목은 이름을 바꾸거나 빼지 않는다 — 「누가 언제 무엇을 끝냈다」는 기록의 뜻이 바뀐다(먼저 완료를 풀면 그 풂도 원장에 남는다).
 * - **기본 항목(template)은 빼지 않는다** — 필수 기본 항목은 종료 조건(N-18)이다. 빼서 종료를 여는 길을 두면
 *   예외 종료(사유 · 승인 · N-18-a)를 거치지 않고 같은 일이 된다. 못 끝내면 예외 종료로 닫는다.
 * - 파일이 붙은 항목은 빼지 않는다 — 파일을 먼저 뺀다(FK 가 마지막에 막는다).
 */
export function consItemEditIssue(op: 'rename' | 'remove' | 'file', i: ConsItemFacts): { code: string; message: string } | null {
  if (i.stage === 'done') return { code: 'ITEM_LOCKED', message: '종료된 컨설팅의 항목은 바꿀 수 없습니다' };
  if (op === 'file') {
    return i.files >= CONS_ITEM_FILE_MAX
      ? { code: 'CONS_ITEM_FILE_LIMIT', message: `항목마다 파일은 최대 ${CONS_ITEM_FILE_MAX}개입니다` }
      : null;
  }
  if (i.done) return { code: 'CONS_ITEM_DONE', message: '끝낸 항목은 이름을 바꾸거나 뺄 수 없습니다 — 먼저 완료를 풀어 주세요' };
  if (op === 'remove' && i.source !== 'manual') {
    return { code: 'CONS_ITEM_TEMPLATE', message: '기본 항목은 뺄 수 없습니다 — 끝내지 못하면 예외 종료로 닫습니다' };
  }
  if (op === 'remove' && i.files > 0) {
    return { code: 'CONS_ITEM_HAS_FILES', message: '파일이 붙은 항목은 뺄 수 없습니다 — 파일을 먼저 빼 주세요' };
  }
  return null;
}

export interface ConsultingArchiveInput {
  /** `cons_pay` 줄 수 */
  payments: number;
  /** 살아 있는(취소 아닌) 전환 청구서가 있는가 */
  liveInvoice: boolean;
  /** 회차 기록(`cons_sess`) 줄 수 — 잡아 둔 날짜 포함 */
  sessions: number;
}

/**
 * 「지우기」(보관 · soft delete)가 막히는 까닭 — PB-11 권고 「수납/청구서/회차가 있으면 409」.
 *
 * 지우면 `deleted_at` 으로 목록 · §28 합계에서 빠지는데, 받은 돈 · 전환 청구서 · 시간표 회차 · 할 일은 남는다 —
 * 돈과 일정이 남은 건이 화면에서만 사라진다. 그래서 그 셋이 있으면 막는다. 막힌 이유는 단추(`canArchive` ·
 * `archiveBlockedReason`)와 쓰기(409 `CONS_ARCHIVE_BLOCKED`)가 **같은 문장**을 쓴다.
 */
export function consultingArchiveIssue(input: ConsultingArchiveInput): { code: string; message: string } | null {
  if (input.payments > 0) return { code: 'CONS_ARCHIVE_BLOCKED', message: '받은 돈이 있는 컨설팅은 지울 수 없습니다' };
  if (input.liveInvoice) {
    return { code: 'CONS_ARCHIVE_BLOCKED', message: '청구서로 전환한 컨설팅은 지울 수 없습니다 — 청구서를 먼저 취소해야 합니다' };
  }
  if (input.sessions > 0) return { code: 'CONS_ARCHIVE_BLOCKED', message: '회차 기록이 있는 컨설팅은 지울 수 없습니다' };
  return null;
}
