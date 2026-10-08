/** @file-guide
 * 목적: BOC-07 구조화 리포트의 양식 판정·제출 검사·진단 평균·출력 문자열을 한 곳에서 소유한다.
 * 책임/재사용: DTO는 입력 모양, service는 DB/권한을 맡고 이 파일은 순수 업무 규칙만 제공한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-07-REPORT-DIAGNOSTIC-FRONT-2026-10-07.md
 */

import { fromMin } from '../../lib/rules';
import type { ReportMaterialDto, ReportStructuredBodyDto } from './reports.dto';

export const REPORT_FORM_KINDS = ['individual', 'group', 'kinder', 'mock', 'diagnostic'] as const;
export type ReportFormKind = (typeof REPORT_FORM_KINDS)[number];

export const REPORT_DEVELOPMENT_AREAS = ['language', 'math', 'emotional', 'physical'] as const;
export type ReportDevelopmentArea = (typeof REPORT_DEVELOPMENT_AREAS)[number];
export const REPORT_DEVELOPMENT_LEVELS = ['needs', 'usual', 'excellent'] as const;
export type ReportDevelopmentLevel = (typeof REPORT_DEVELOPMENT_LEVELS)[number];

export type DiagnosticScoreSource = {
  mathScore: number;
  englishScore: number;
  interview: { fluency: number; vocabulary: number; grammar: number };
};

/**
 * 최종 강사 수정사항 p21·p79 권고안: Math·English·Interview 세 영역을 같은 비중으로 계산한다.
 * Interview 영역은 p68의 유창성·단어 다양성·어법 세 점수 평균이며 표시·저장은 소수 첫째 자리다.
 * 이 정책을 바꾸면 DTO/OpenAPI/generated Front·화면·시나리오·portfolio를 같은 청크에서 갱신한다.
 */
export function diagnosticReportAverages(source: DiagnosticScoreSource): {
  interviewAverage: number;
  totalAverage: number;
} {
  const round1 = (value: number): number => Math.round((value + Number.EPSILON) * 10) / 10;
  const interviewAverage = round1(
    (source.interview.fluency + source.interview.vocabulary + source.interview.grammar) / 3,
  );
  return {
    interviewAverage,
    totalAverage: round1((source.mathScore + source.englishScore + interviewAverage) / 3),
  };
}

/**
 * Kinder는 나이·학년·과목명이 아니라 실제 수업 시작 시각의 marker로만 판정한다.
 * 진단·모의는 별도 명세 종류이므로 Kinder marker가 있어도 각 종류 양식을 유지한다.
 */
export function reportFormKind(
  kindKey: string,
  studentCount: number,
  kinderMarked: boolean,
): ReportFormKind | null {
  if (kindKey === 'diagx') return studentCount > 0 ? 'diagnostic' : null;
  if (kindKey === 'mock') return studentCount > 0 ? 'mock' : null;
  if (kindKey !== 'class' || studentCount < 1) return null;
  if (kinderMarked) return studentCount === 1 ? 'kinder' : null;
  return studentCount === 1 ? 'individual' : 'group';
}

type StructuredPlainTextInput = {
  date: string;
  studentId: number;
  studentName: string;
  studentGrade?: string | null;
  subjectName?: string | null;
  startMin: number | null;
  endMin: number | null;
  body: ReportStructuredBodyDto;
};

const DEVELOPMENT_LABELS: Record<ReportDevelopmentArea, string> = {
  language: '언어 발달', math: '수학 발달', emotional: '정서적 발달', physical: '신체 발달',
};
const LEVEL_LABELS: Record<ReportDevelopmentLevel, string> = {
  needs: '보완 필요', usual: '보통', excellent: '우수',
};

function materialLine(material: ReportMaterialDto | null, includeAmount: boolean): string {
  if (!material) return '—';
  const book = `${material.title ?? material.code ?? `교재 #${material.issueId}`}${material.edition ? ` · ${material.edition}` : ''}`;
  return `${book} · p.${material.fromPage}–${material.toPage}${includeAmount && material.amount ? ` · ${material.amount}` : ''}`;
}

/** 승인·발송·클립보드가 공유할 구조화 리포트 전문. 저장 snapshot 이외의 현재 교재/marker를 다시 읽지 않는다. */
export function structuredReportPlainText(input: StructuredPlainTextInput): string {
  const time = input.startMin === null || input.endMin === null
    ? '시간 미정' : `${fromMin(input.startMin)}–${fromMin(input.endMin)}`;
  const header = [
    `① 학생: ${input.studentName}${input.studentGrade ? ` · ${input.studentGrade}` : ''}`,
    `② 수업: ${input.date} · ${input.subjectName ?? '과목미정'} · ${time}`,
  ];
  const body = input.body;
  if (body.kind === 'individual' || body.kind === 'group') {
    const studentComment = body.kind === 'group'
      ? body.students.find((student) => student.studentId === input.studentId)?.comment ?? '—'
      : null;
    return [
      ...header,
      `③ ${body.kind === 'group' ? '공통 수업 사항' : '수업 내용'}\n${body.content || '—'}`,
      `④ 진도 페이지\n${materialLine(body.progress, false)}`,
      `⑤ 숙제 페이지\n${materialLine(body.homework, true)}`,
      ...(studentComment === null ? [] : [`⑥ 학생별 의견\n${studentComment}`]),
    ].join('\n\n');
  }
  if (body.kind === 'kinder' || body.kind === 'mock') {
    return [
      ...header,
      ...REPORT_DEVELOPMENT_AREAS.map((key, index) => {
        const row = body.development[key];
        return `${index + 3}. ${DEVELOPMENT_LABELS[key]} · ${row.level ? LEVEL_LABELS[row.level] : '미평가'}\n${row.observation || '—'}`;
      }),
      `⑦ 종합 소견\n${body.overall || '—'}`,
    ].join('\n\n');
  }
  const student = body.students.find((row) => row.studentId === input.studentId);
  if (!student) return [...header, '③ 진단 결과\n—'].join('\n\n');
  return [
    ...header,
    `③ Math\n${student.mathScore ?? '—'}점 · ${student.mathMistakes || '—'}`,
    `④ English\n${student.englishScore ?? '—'}점 · ${student.englishMistakes || '—'}`,
    `⑤ Interview\n유창성 ${student.interview.fluency ?? '—'} · 단어 다양성 ${student.interview.vocabulary ?? '—'} · 어법 ${student.interview.grammar ?? '—'} · 평균 ${student.interview.average ?? '—'}`,
    `⑥ 전체 평균\n${student.totalAverage ?? '—'}`,
    `⑦ 종합 소견\n${student.overall || '—'}`,
  ].join('\n\n');
}
