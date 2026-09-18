/** @file-guide
 * 목적: complaint-words.ts — CPL_STAGES, CplStage, CPL_STAGE_LABEL, CPL_STAGE_SUB, CPL_OPEN_STAGES 등 (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 컴플레인 단계 셋 — **낱말과 순서가 사는 단 하나의 자리** (원본 §67).
 *
 * **이 파일이 생긴 이유는 한 낱말 때문이다.** DBML 의 `CPL.stage` 주석과 entity 주석은
 * 둘 다 「open | acting | done」이라 적어 두었는데 **실제로 저장되는 말은
 * `received | acting | closed`** 다. 셋 중 둘은 아무 일도 안 했지만
 * `lib/exec-areas` 의 컴플레인 판정이 그 선언을 **믿고** `stage <> 'done'` 으로 세는 바람에
 * **끝난 건까지 전부 세어** 대표 보고의 배지가 「8」이 됐다(열린 건은 5다).
 * **선언과 데이터가 다르면, 그 차이를 읽은 쪽이 조용히 틀린다.**
 *
 * 그래서 판정도 낱말도 여기서만 나온다. `CPL_OPEN_STAGES` 를 쓰는 한 이 값들이 바뀌어도
 * 세는 쪽이 따라온다.
 */

export const CPL_STAGES = ['received', 'acting', 'closed'] as const;
export type CplStage = (typeof CPL_STAGES)[number];

export const CPL_STAGE_LABEL: Record<CplStage, string> = {
  received: '접수',
  acting: '대응',
  closed: '결과',
};

/**
 * 칸 이름 아래 한 줄 — 원본 §67 의 칸마다 있다.
 * **무엇인지가 아니라 다음에 무엇을 하는지**를 적는다: 「받았습니다 · 담당을 정해야 합니다」.
 */
export const CPL_STAGE_SUB: Record<CplStage, string> = {
  received: '받았습니다 · 담당을 정해야 합니다',
  acting: '연락하고 조치하는 중입니다',
  closed: '마무리했습니다',
};

/** 아직 안 끝난 것 — 대표 보고의 컴플레인 배지가 세는 집합 (§69) */
export const CPL_OPEN_STAGES: readonly CplStage[] = ['received', 'acting'];

export const cplStageLabel = (stage: string): string =>
  CPL_STAGE_LABEL[stage as CplStage] ?? stage;

/** 갈래 다섯 — `cpl_area_t` 의 낱말. 화면이 제 표를 들면 §67 칩과 §69 줄이 갈린다 (D-R18) */
export const CPL_AREA_LABEL: Record<string, string> = {
  lesson: '수업',
  intake: '상담',
  book: '교재',
  schedule: '스케줄',
  teacher: '선생님',
};

export const cplAreaLabel = (area: string): string => CPL_AREA_LABEL[area] ?? area;

/** 갈래 다섯의 순서 — 「+ 접수」 폼과 칩 줄이 같은 순서로 선다 (원본 §67 「전체 · 수업 · 상담 · 교재 · 스케줄 · 선생님」) */
export const CPL_AREAS = ['lesson', 'intake', 'book', 'schedule', 'teacher'] as const;
export type CplArea = (typeof CPL_AREAS)[number];

/** 심각도 셋 — 원본 §67 카드의 「가벼움 · 보통 · 심각」. 표의 `cpl_severity_words` 가 같은 셋을 지킨다 (v4.32 · C93) */
export const CPL_SEVERITIES = ['light', 'normal', 'severe'] as const;
export type CplSeverity = (typeof CPL_SEVERITIES)[number];
export const CPL_SEVERITY_LABEL: Record<CplSeverity, string> = {
  light: '가벼움',
  normal: '보통',
  severe: '심각',
};
export const cplSeverityLabel = (severity: string | null | undefined): string | null =>
  severity ? (CPL_SEVERITY_LABEL[severity as CplSeverity] ?? severity) : null;
