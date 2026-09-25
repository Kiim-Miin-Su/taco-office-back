/** @file-guide
 * 목적: lead-diag-words.ts — LEAD_DIAG_LEVELS, LeadDiagLevel, LEAD_DIAG_LEVEL_LABEL, leadDiagLevelLabel (util)
 * 책임/재사용: 상담 진단 레벨 낱말과 순서가 사는 단 하나의 자리다. 점수로 레벨을 정하는 계산은 두지 않는다(DQ1).
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 상담 단계 진단 레벨 셋 — **낱말과 순서가 사는 단 하나의 자리** (테스트 시나리오 A-04 · v2 §23 · DQ1).
 *
 * 대표 답변(2026-09-25) 「점수만 저장 + 담당자가 선택」 — 레벨은 **담당자가 고르는 값**이다.
 * 그래서 이 파일에는 만점도 경계(예: 60/80)도 점수 → 레벨 함수도 없다. 원문이 주지 않은 기준을 지어내면
 * 화면이 「자동 판정」처럼 보이고 학부모에게 근거 없는 레벨이 간다. A-04/A-05 의 「자동」은 **의도적 제외**다.
 *
 * 낱말은 PDF A-04 가 쓰는 영문 그대로다(Foundation · Practice · Master). 한국어 번역어는 원문에 없어 짓지 않는다.
 * 저장값은 `LEAD_DIAG.level`(`lead_diag_level_words` CHECK · NULL = 아직 고르지 않음).
 */
export const LEAD_DIAG_LEVELS = ['foundation', 'practice', 'master'] as const;
export type LeadDiagLevel = (typeof LEAD_DIAG_LEVELS)[number];

export const LEAD_DIAG_LEVEL_LABEL: Record<LeadDiagLevel, string> = {
  foundation: 'Foundation',
  practice: 'Practice',
  master: 'Master',
};

export const leadDiagLevelLabel = (level: string | null | undefined): string | null =>
  level == null ? null : (LEAD_DIAG_LEVEL_LABEL[level as LeadDiagLevel] ?? level);

/**
 * 점수 칸의 **저장 형식 한계** — PostgreSQL `integer` 의 끝이다. 만점이 아니다(만점은 정해지지 않았다 · DQ1).
 * DTO 가 이 값을 넘는 수를 400 으로 막아야 DB 가 넘침(500)으로 떨어지지 않는다.
 */
export const LEAD_DIAG_SCORE_STORAGE_MAX = 2_147_483_647;
