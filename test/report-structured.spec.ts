/** @file-guide
 * 목적: BOC-07 구조화 리포트의 양식 판정과 진단 평균 계산 회귀를 검증한다.
 * 책임/재사용: 제품의 순수 판정 함수를 직접 호출하며 테스트에 계산식을 복제하지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-07-REPORT-DIAGNOSTIC-FRONT-2026-10-07.md
 */

import { diagnosticReportAverages, reportFormKind } from '../src/modules/reports/report-structured';

describe('BOC-07 구조화 리포트 판정', () => {
  it('Kinder 표시는 일반 class 한 명일 때만 Kinder 양식을 선택한다', () => {
    expect(reportFormKind('class', 1, false)).toBe('individual');
    expect(reportFormKind('class', 2, false)).toBe('group');
    expect(reportFormKind('class', 1, true)).toBe('kinder');
    expect(reportFormKind('class', 2, true)).toBeNull();
  });

  it('진단·모의 종류는 Kinder 표시와 별개인 명세 종류를 유지한다', () => {
    expect(reportFormKind('diagx', 2, true)).toBe('diagnostic');
    expect(reportFormKind('mock', 1, true)).toBe('mock');
  });

  it('인터뷰 3점 평균 뒤 Math·English·Interview 세 영역을 같은 비중으로 평균한다', () => {
    expect(diagnosticReportAverages({
      mathScore: 90,
      englishScore: 80,
      interview: { fluency: 70, vocabulary: 80, grammar: 90 },
    })).toEqual({ interviewAverage: 80, totalAverage: 83.3 });
  });
});
