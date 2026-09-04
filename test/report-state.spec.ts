import { addD } from '../src/lib/recurrence';
import {
  canExportReport, effectiveRepState, effectiveRepStateFromEnded, reportPngFileName, reportReviewIssue,
} from '../src/lib/rules';
import { SEED_TODAY } from '../src/seed/base';
import { buildReports } from '../src/seed/outputs';
import type { OccSeed } from '../src/seed/schedule';

const occurrence = (over: Partial<OccSeed> = {}): OccSeed => ({
  serId: 1,
  onDate: SEED_TODAY,
  teacherId: 6,
  roomId: 1,
  zaccId: null,
  canceled: false,
  startMin: 16 * 60,
  endMin: 17 * 60,
  kindKey: 'class',
  subKey: 'ap-chem',
  students: [1],
  ...over,
});

describe('리포트 상태 — 캘린더 색상의 단일 진실원', () => {
  it('오래된 미작성 상태는 현재 시각으로 방어하고 작성 상태는 보존한다', () => {
    const session = { date: SEED_TODAY, startMin: 16 * 60, durationMin: 60 };

    expect(effectiveRepState('na', session, true, SEED_TODAY, 15 * 60)).toBe('plan');
    expect(effectiveRepState('none', session, true, SEED_TODAY, 17 * 60)).toBe('none');
    expect(effectiveRepState('wait', session, true, SEED_TODAY, 15 * 60)).toBe('wait');
    expect(effectiveRepState('plan', session, false, SEED_TODAY, 15 * 60)).toBe('na');
    expect(effectiveRepStateFromEnded('plan', true, true)).toBe('none');
    expect(effectiveRepStateFromEnded('none', true, false)).toBe('plan');
  });

  it('승인·반려는 wait에서만 열리고 반려 사유를 한 함수가 강제한다', () => {
    expect(reportReviewIssue({ canApprove: false, state: 'wait', decision: 'approve' }))
      .toBe('REPORT_REVIEW_FORBIDDEN');
    expect(reportReviewIssue({ canApprove: true, state: 'draft', decision: 'approve' }))
      .toBe('REPORT_NOT_WAITING');
    expect(reportReviewIssue({ canApprove: true, state: 'wait', decision: 'reject', reason: '  ' }))
      .toBe('REJECT_REASON_REQUIRED');
    expect(reportReviewIssue({ canApprove: true, state: 'wait', decision: 'approve', reason: '불필요' }))
      .toBe('APPROVE_REASON_FORBIDDEN');
    expect(reportReviewIssue({ canApprove: true, state: 'wait', decision: 'approve' })).toBeNull();
    expect(reportReviewIssue({ canApprove: true, state: 'wait', decision: 'reject', reason: '보완' })).toBeNull();
  });

  it('저장된 리포트 출력은 담당 강사·전체 관리자에게만 열리고 파일명은 서버 한 곳에서 만든다', () => {
    expect(canExportReport({ actorId: 6, teacherId: 6, canCrudAll: false, state: 'draft' })).toBe(true);
    expect(canExportReport({ actorId: 1, teacherId: 6, canCrudAll: true, state: 'ok' })).toBe(true);
    expect(canExportReport({ actorId: 7, teacherId: 6, canCrudAll: false, state: 'wait' })).toBe(false);
    expect(canExportReport({ actorId: 6, teacherId: 6, canCrudAll: false, state: 'none' })).toBe(false);

    expect(reportPngFileName({
      date: '2026-08-27',
      studentName: '김_민준',
      studentGrade: null,
      subjectName: 'AP/Chemistry',
      startMin: 16 * 60 + 30,
    })).toBe('20260827_김-민준_학년미정_AP-Chemistry_16:30.png');
  });

  it('미래 수업은 예정(plan)이다', () => {
    const [report] = buildReports(
      [occurrence({ onDate: addD(SEED_TODAY, 1) })],
      () => 'ko',
      10 * 60,
    );

    expect(report?.state).toBe('plan');
    expect(report?.body).toEqual({});
  });

  it('오늘 수업은 종료 전 plan, 종료 후 none으로 전이한다', () => {
    const before = buildReports([occurrence()], () => 'ko', 15 * 60);
    const after = buildReports([occurrence()], () => 'ko', 17 * 60);

    expect(before[0]?.state).toBe('plan');
    expect(after[0]?.state).toBe('none');
  });

  it('리포트 대상 여부는 종류 코드표를 따른다', () => {
    const reports = buildReports([
      occurrence({ serId: 1, kindKey: 'class' }),
      occurrence({ serId: 2, kindKey: 'consult' }),
      occurrence({ serId: 3, kindKey: 'study' }),
      occurrence({ serId: 4, kindKey: 'meeting' }),
    ], () => 'ko', 15 * 60);

    expect(reports.map((report) => report.serId)).toEqual([1]);
  });
});
