/** @file-guide
 * 목적: EDUCATION_GRADE 영속 행을 최종 관리자 p19~22의 활성 39개 선택지로 투영한다.
 * 책임/재사용: 값·대응 문구·정렬의 단일 소유자다. 기존 46행과 STU.grade 원문은 수정하지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-01C-EDUCATION-GRADE-FRONT-2026-10-06.md · docs/AGENT.md
 */

export type EducationGradeSystem = 'US' | 'GB' | 'KR';

export interface EducationGradeSourceRow {
  educationSystem: string;
  code: string;
  active: boolean;
}

export interface EducationGradeProjection {
  value: string;
  system: EducationGradeSystem;
  systemLabel: string;
  optionLabel: string;
  equivalenceHint: string;
  listLabel: string;
  sort: number;
}

const SYSTEM_LABEL: Readonly<Record<EducationGradeSystem, string>> = {
  US: '미국 Grade',
  GB: '영국 Year',
  KR: '한국 학년',
};

const koreanValue = (sort: number): string => {
  if (sort === 0) return '유치원';
  if (sort <= 6) return `초${sort}`;
  if (sort <= 9) return `중${sort - 6}`;
  return `고${sort - 9}`;
};

const sourceCode = (system: EducationGradeSystem, sort: number): string => {
  if (system === 'US') return sort === 0 ? 'kinder' : `G${sort}`;
  if (system === 'GB') return `Yr${sort + 1}`;
  if (sort === 0) return 'kinder';
  if (sort <= 6) return `E${sort}`;
  if (sort <= 9) return `M${sort - 6}`;
  return `H${sort - 9}`;
};

/**
 * 권고안 채택(2026-10-07, BOC-01D-02): 영속 46행을 삭제하거나 재번호화하지 않고
 * US K~G12, GB Y1~Y13, KR 유치원~고3만 활성 UI 계약으로 투영한다.
 * 범위를 바꾸려면 이 함수와 BOC-01C 문서의 원문 대조표를 함께 고친다.
 */
export function projectEducationGrades(rows: readonly EducationGradeSourceRow[]): EducationGradeProjection[] {
  const active = new Set(rows.filter((row) => row.active).map((row) => `${row.educationSystem}:${row.code}`));
  const result: EducationGradeProjection[] = [];

  for (const system of ['US', 'GB', 'KR'] as const) {
    for (let sort = 0; sort < 13; sort += 1) {
      if (!active.has(`${system}:${sourceCode(system, sort)}`)) continue;
      const us = sort === 0 ? 'K' : `G${sort}`;
      const gb = `Y${sort + 1}`;
      const kr = koreanValue(sort);
      if (system === 'US') {
        result.push({ value: us, system, systemLabel: SYSTEM_LABEL[system], optionLabel: `${us} (= ${gb})`,
          equivalenceHint: `= ${gb} · ${kr}`, listLabel: `${us} · ${gb}`, sort });
      } else if (system === 'GB') {
        result.push({ value: gb, system, systemLabel: SYSTEM_LABEL[system], optionLabel: `${gb} (= ${us})`,
          equivalenceHint: `= ${us} · ${kr}`, listLabel: `${gb} · ${us}`, sort });
      } else {
        result.push({ value: kr, system, systemLabel: SYSTEM_LABEL[system], optionLabel: `${kr} (= ${us} · ${gb})`,
          equivalenceHint: `= ${us} · ${gb}`, listLabel: `${kr} · ${us} · ${gb}`, sort });
      }
    }
  }
  return result;
}

/** 기존 원문과 정확히 일치할 때만 대응 표시한다. legacy 값을 추정·자동 변환하지 않는다. */
export function educationGradeDisplay(
  raw: string | null,
  options: readonly EducationGradeProjection[],
): string | null {
  if (raw === null) return null;
  return options.find((option) => option.value === raw)?.listLabel ?? raw;
}
