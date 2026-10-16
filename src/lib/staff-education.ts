/** @file-guide
 * 목적: 강사 학력 요약의 학위·상태 코드표와 저장 판정 — 10/14 PPTX p8 결정(2026-10-16).
 * 책임/재사용: 서랍 응답(드롭다운 선택지)과 구성원 만들기·수정 판정이 같은 표를 쓴다(D-R18). DB에는 낱말 그대로 저장한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/** 학위 — 화면 드롭다운 차례 그대로 */
export const STAFF_EDUCATION_DEGREES = ['전문학사', '학사', '석사', '박사', '기타'] as const;
/** 상태 — 화면 드롭다운 차례 그대로 */
export const STAFF_EDUCATION_STATUSES = ['재학', '휴학', '수료', '졸업', '중퇴'] as const;

export interface EducationCodeRow { degree: string | null; status: string | null }

/**
 * 코드표 밖 값을 고른다. migration 127 시절 자유 입력으로 이미 저장된 값(`kept`)은 고치지 않고 다시 보낼 수 있다 —
 * 학력 배열은 통째로 대체되므로, 다른 줄만 고쳐도 옛 줄이 함께 다시 온다. 새 자유 입력만 막는다(N-25: 옛 값을 추정 변환하지 않는다).
 * 반환: 막을 낱말 목록(없으면 빈 배열).
 */
export function educationCodeIssues(rows: readonly EducationCodeRow[], kept: readonly EducationCodeRow[] = []): string[] {
  const keptDegrees = new Set(kept.map((row) => row.degree).filter((value): value is string => !!value));
  const keptStatuses = new Set(kept.map((row) => row.status).filter((value): value is string => !!value));
  const issues: string[] = [];
  for (const row of rows) {
    if (row.degree && !(STAFF_EDUCATION_DEGREES as readonly string[]).includes(row.degree) && !keptDegrees.has(row.degree)) {
      issues.push(row.degree);
    }
    if (row.status && !(STAFF_EDUCATION_STATUSES as readonly string[]).includes(row.status) && !keptStatuses.has(row.status)) {
      issues.push(row.status);
    }
  }
  return issues;
}
