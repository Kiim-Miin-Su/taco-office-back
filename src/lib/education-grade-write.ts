/** @file-guide
 * 목적: 신규 학생/상담 학년 쓰기를 BOC-01 활성 39개 선택지에 맞춘다.
 * 책임/재사용: 상담 생성·수정과 등록 확정이 같은 DB 카탈로그와 오류 계약을 사용한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-01D2-EDUCATION-GRADE-CONTRACT-2026-10-07.md · docs/AGENT.md
 */

import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { projectEducationGrades, type EducationGradeSourceRow } from './education-grade-projection';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

const ACTIVE_EDUCATION_GRADE_COUNT = 39;

/**
 * 권고안 채택(2026-10-07, BOC-01D-02b): 신규/변경 학년은 활성 39개만 허용한다.
 * 단, 기존 레거시 원문은 다른 필드만 고칠 때 현재값과 정확히 같으면 보존한다.
 * 정책을 바꾸려면 이 함수와 BOC-01D2 계약 문서의 「쓰기 호환 규칙」을 함께 고친다.
 */
export async function assertEducationGradeWrite(
  q: Queryable,
  next: string | null,
  previous?: string | null,
): Promise<void> {
  if (next === null || (previous !== undefined && next === previous)) return;

  const rows = await q.query(
    `SELECT education_system AS "educationSystem", code, active
       FROM education_grade ORDER BY education_system, sort`,
  ) as EducationGradeSourceRow[];
  const options = projectEducationGrades(rows);
  if (options.length !== ACTIVE_EDUCATION_GRADE_COUNT) {
    throw new InternalServerErrorException('교육 학년 카탈로그 무결성 오류');
  }
  if (!options.some(({ value }) => value === next)) {
    throw new BadRequestException({
      code: 'EDUCATION_GRADE_INVALID',
      message: '학년은 미국 K~G12 · 영국 Y1~Y13 · 한국 유치원~고3 중 하나를 골라 주세요',
    });
  }
}
