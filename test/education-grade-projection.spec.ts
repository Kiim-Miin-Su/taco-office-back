/** @file-guide
 * 목적: BOC-01D-02 영속 46행에서 활성 39개 UI 학년 계약을 만드는 회귀 시험.
 * 책임/재사용: 실제 projection 함수를 검증하며 migration 자체나 학생 writer 완료를 주장하지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-01-SCENARIOS-2026-10-06.md · docs/AGENT.md
 */
import { educationGradeDisplay, projectEducationGrades, type EducationGradeSourceRow } from '../src/lib/education-grade-projection';
import { GRADE_CODES_V1 } from '../src/migrations/data/student-catalog-v1';

const rows = Object.entries(GRADE_CODES_V1).flatMap(([educationSystem, codes]) =>
  codes.map((code) => ({ educationSystem, code, active: true }))) as EducationGradeSourceRow[];

describe('BOC-01D-02 교육체계별 학년 projection', () => {
  it('46개 영속 행을 바꾸지 않고 US/GB/KR 각 13개, 총 39개로 투영한다', () => {
    expect(rows).toHaveLength(46);
    const options = projectEducationGrades(rows);
    expect(options).toHaveLength(39);
    expect(options.filter(({ system }) => system === 'US')).toHaveLength(13);
    expect(options.filter(({ system }) => system === 'GB')).toHaveLength(13);
    expect(options.filter(({ system }) => system === 'KR')).toHaveLength(13);
    expect(options.map(({ value }) => value)).not.toEqual(expect.arrayContaining(['pre-kinder', 'other', 'repeat']));
  });

  it('Y6와 대응 학년의 문구·미국 기준 sort를 서버에서 확정한다', () => {
    const options = projectEducationGrades(rows);
    expect(options.find(({ value }) => value === 'Y6')).toEqual({
      value: 'Y6', system: 'GB', systemLabel: '영국 Year', optionLabel: 'Y6 (= G5)',
      equivalenceHint: '= G5 · 초5', listLabel: 'Y6 · G5', sort: 5,
    });
    expect(options.find(({ value }) => value === '초5')).toMatchObject({
      optionLabel: '초5 (= G5 · Y6)', equivalenceHint: '= G5 · Y6', listLabel: '초5 · G5 · Y6', sort: 5,
    });
  });

  it('legacy 원문은 자동 변환하지 않고 정확한 신규값만 listLabel로 표시한다', () => {
    const options = projectEducationGrades(rows);
    expect(educationGradeDisplay('Y6', options)).toBe('Y6 · G5');
    expect(educationGradeDisplay('Yr6', options)).toBe('Yr6');
    expect(educationGradeDisplay('9학년', options)).toBe('9학년');
    expect(educationGradeDisplay(null, options)).toBeNull();
  });

  it('필수 카탈로그 행이 비활성이면 39개 정상 계약을 가장하지 않는다', () => {
    expect(projectEducationGrades(rows.map((row) => row.educationSystem === 'GB' && row.code === 'Yr6'
      ? { ...row, active: false } : row))).toHaveLength(38);
  });
});
