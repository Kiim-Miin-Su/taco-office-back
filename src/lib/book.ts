/** @file-guide
 * 목적: §38~§41 교재 상태·진도·자료 전달 전이와 §39 두 층 분류(레벨 · 학년 범위 · 시험 태그) 낱말을 한 곳에서 검증한다.
 * 책임/재사용: 순수 업무 방어만 소유한다. HTTP 예외·SQL·화면 문구 조립은 호출자가 맡는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { LEAD_DIAG_LEVELS, LEAD_DIAG_LEVEL_LABEL, type LeadDiagLevel } from './lead-diag-words';

export const ISSUE_STATES = ['wait', 'auto', 'ok', 'returned'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];
export const ISSUE_CREATE_STATES = ['wait', 'auto', 'ok'] as const;
export const ISSUE_TRANSITION_STATES = ['auto', 'ok'] as const;
export const ISSUE_STATE_LABEL: Record<IssueState, string> = {
  wait: '승인 대기', auto: '전달 대기', ok: '배부 완료', returned: '회수 완료',
};

/** §38 배부는 승인 대기 → 전달 대기 → 배부 완료의 한 방향으로만 흐른다. */
/**
 * 배부 형태 — 원문 §38 교재 칸 아래 칩 「PDF」 · 「실물 책」(7-3 §38-2 · 리드 채택 W11 A'). 배부 창에서 고른다(선택).
 * 저장값은 `issue.form`(issue_form_words CHECK) · NULL = 고르지 않음 = 칩 없음(옛 줄 전부).
 */
export const ISSUE_FORMS = ['pdf', 'print'] as const;
export type IssueForm = (typeof ISSUE_FORMS)[number];
export const ISSUE_FORM_LABEL: Record<IssueForm, string> = { pdf: 'PDF', print: '실물 책' };
export const issueFormLabel = (form: string | null | undefined): string | null =>
  form == null ? null : (ISSUE_FORM_LABEL[form as IssueForm] ?? null);

export function issueTransitionIssue(from: IssueState, to: 'auto' | 'ok'): string | null {
  if (from === 'wait' && to === 'auto') return null;
  if (from === 'auto' && to === 'ok') return null;
  return `${ISSUE_STATE_LABEL[from]}에서 ${ISSUE_STATE_LABEL[to]} 상태로 바꿀 수 없습니다`;
}

export const PACK_TYPES = ['exam', 'self'] as const;
export type PackType = (typeof PACK_TYPES)[number];
export const PACK_TYPE_LABEL: Record<PackType, string> = { exam: '시험 대비 자료', self: '자습 자료' };

export const PACK_STATES = ['pending', 'delivered', 'received'] as const;
export type PackState = (typeof PACK_STATES)[number];
export const PACK_STATE_LABEL: Record<PackState, string> = {
  pending: '준비 중', delivered: '전달 완료', received: '수령 확인',
};

export function progressPercent(page: number | null, pages: number | null): number | null {
  if (page === null || pages === null || pages <= 0) return null;
  return Math.min(100, Math.round((page / pages) * 100));
}

export function progressIssue(page: number, pages: number | null): string | null {
  if (!Number.isInteger(page) || page < 0) return '진도 쪽수는 0 이상의 정수입니다';
  if (pages !== null && page > pages) return `진도 쪽수는 교재 전체 ${pages}쪽을 넘을 수 없습니다`;
  return null;
}

export function packTransitionIssue(from: PackState, to: PackState): string | null {
  if (from === 'pending' && to === 'delivered') return null;
  if (from === 'delivered' && to === 'received') return null;
  return `${PACK_STATE_LABEL[from]}에서 ${PACK_STATE_LABEL[to]} 상태로 바꿀 수 없습니다`;
}

/* ══ §39 교재 두 층 분류 (N-47 채택 · W11) ══════════════════════════════════
 * 과목(`book_subject`) → 소분류(`book_category`)는 **코드표**다(마이그레이션이 원문 §39 컷의 값만 넣는다).
 * 여기는 코드표가 아닌 세 축 — 레벨 · 학년 범위 · 시험 태그 — 의 낱말과 검사만 둔다. 표의 CHECK 와 같은 값이다.
 * 옛 칸(`lib.level` · `lib.grade` · `lib.sub_key`)은 **그대로 둔다**(N-25 · 보정 0) — 새 칸이 비어 있으면 옛 원문을 보여 준다.
 */

/**
 * 레벨 셋 — 원문 §39 필터 「Foundation · Practice · Master」. 상담 진단 레벨(A-04)과 **같은 낱말 · 같은 순서**라
 * 낱말이 사는 한 자리(`lead-diag-words`)를 그대로 쓴다 — 두 벌을 두면 한쪽만 고쳐져 §23 과 §39 가 갈린다.
 */
export const BOOK_LEVELS = LEAD_DIAG_LEVELS;
export type BookLevel = LeadDiagLevel;

export const bookLevelLabel = (level: string | null | undefined): string | null =>
  level == null ? null : (LEAD_DIAG_LEVEL_LABEL[level as BookLevel] ?? null);

/**
 * 카드 · 트래킹 · 자료 전달이 **보여 주는** 레벨 — 코드표 레벨을 사람이 골랐으면 그 낱말, 아직이면 옛 원문(`lib.level`) 그대로.
 * 옛 값을 F/P/M 으로 짐작해 바꾸지 않는다(N-25) — 화면은 모르는 원문을 중립색으로 그린다.
 */
export function bookLevelShown(bookLevel: string | null | undefined, legacyLevel: string | null | undefined): string | null {
  return bookLevelLabel(bookLevel) ?? (legacyLevel?.trim() || null);
}

/** 학년 — K = 0 · G1~G12 = 1~12 (원문 §39 학년 칩 「K · G1 … G12」). 저장은 범위 두 칸(`grade_from` · `grade_to`) */
export const BOOK_GRADE_MIN = 0;
export const BOOK_GRADE_MAX = 12;
export const BOOK_GRADES: readonly number[] = Array.from({ length: BOOK_GRADE_MAX - BOOK_GRADE_MIN + 1 }, (_, n) => BOOK_GRADE_MIN + n);

export const bookGradeKey = (grade: number): string => (grade === 0 ? 'K' : `G${grade}`);

/** 칩 키(K · G1 … G12) → 숫자. 모르는 키는 null */
export function bookGradeFromKey(key: string): number | null {
  const n = BOOK_GRADES.find((grade) => bookGradeKey(grade) === key);
  return n === undefined ? null : n;
}

/** 카드의 학년 칩 — 원문 「G9·G10」「G2·G3·G4·G5」처럼 범위의 학년을 하나씩 적는다 */
export function bookGradeRangeLabel(from: number | null | undefined, to: number | null | undefined): string | null {
  if (from == null || to == null || from > to) return null;
  return BOOK_GRADES.filter((grade) => grade >= from && grade <= to).map(bookGradeKey).join('·');
}

/** 범위가 이 학년을 덮는가 — 학년 칩의 건수와 거르기가 같은 함수를 쓴다(「G9·G10」 교재는 G9 칩에도 G10 칩에도 든다) */
export function bookGradeCovers(from: number | null | undefined, to: number | null | undefined, grade: number): boolean {
  return from != null && to != null && from <= grade && grade <= to;
}

/** 학년 범위 검사 — 둘 다 비었거나(아직 안 정함) 둘 다 있고 앞이 뒤보다 크지 않아야 한다. 표의 `lib_grade_range` 와 같은 규칙 */
export function bookGradeRangeIssue(from: number | null, to: number | null): string | null {
  if (from === null && to === null) return null;
  if (from === null || to === null) return '학년은 시작과 끝을 함께 정해 주세요';
  if (from < BOOK_GRADE_MIN || to > BOOK_GRADE_MAX) return '학년은 K 부터 G12 까지입니다';
  if (from > to) return '학년 범위의 시작이 끝보다 뒤일 수 없습니다';
  return null;
}

/** 시험 태그 — 원문 §39 카드 칩 「SAT · MAP · ISEE / SSAT」. 한 교재에 하나(원문 카드에 둘인 곳이 없다) */
export const BOOK_EXAM_TAGS = ['sat', 'map', 'isee_ssat'] as const;
export type BookExamTag = (typeof BOOK_EXAM_TAGS)[number];
export const BOOK_EXAM_TAG_LABEL: Record<BookExamTag, string> = { sat: 'SAT', map: 'MAP', isee_ssat: 'ISEE / SSAT' };

export const bookExamTagLabel = (tag: string | null | undefined): string | null =>
  tag == null ? null : (BOOK_EXAM_TAG_LABEL[tag as BookExamTag] ?? null);

/**
 * 과목을 아직 사람이 정하지 않은 교재 — 옛 교재가 모두 여기서 시작한다(N-47 「기존 교재는 NULL(「미분류」 묶음)」).
 * 필터 칩의 키이기도 하다(`?subject=none`). 코드표의 키와 겹치지 않는 낱말이다.
 */
export const BOOK_UNCLASSIFIED = { key: 'none', label: '미분류' } as const;
