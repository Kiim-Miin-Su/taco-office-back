/** @file-guide
 * 목적: report-state.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { addD } from '../src/lib/recurrence';
import {
  REPORT_ACTION_REQUIRED_DB, REPORT_UNWRITTEN_CANDIDATE_DB,
  canExportReport, effectiveRepState, effectiveRepStateFromEnded, needsReportActionDbState,
  reportPngFileName, reportReviewIssue,
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
  it('§47 조치 대상은 미제출 초안과 반려를 포함하되 일정 재투영 후보는 바꾸지 않는다', () => {
    expect(REPORT_ACTION_REQUIRED_DB).toEqual(['none', 'draft', 'rej']);
    expect(REPORT_UNWRITTEN_CANDIDATE_DB).toEqual(['na', 'plan', 'none', 'draft']);
    expect(['none', 'draft', 'rej'].map(needsReportActionDbState)).toEqual([true, true, true]);
    expect(['na', 'plan', 'wait', 'ok'].map(needsReportActionDbState)).toEqual([false, false, false, false]);
  });

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
    })).toBe('20260827_김-민준_학년미정_AP-Chemistry_16-30.png');
  });

  // 콜론이 남으면 브라우저가 `_` 로 바꿔 저장해 파일 이름과 원장 이름이 갈린다 (QA-b · G-71)
  it('파일 이름에는 Windows 가 거절하는 글자가 하나도 남지 않는다', () => {
    const made = reportPngFileName({
      date: '2026-08-27', studentName: '김민준', studentGrade: '고2', subjectName: 'AP Chemistry', startMin: 990,
    });
    expect(/[<>:"/\\|?*]/.test(made)).toBe(false);
    expect(made.endsWith('.png')).toBe(true);
  });

  /**
   * C86-g 의 교훈 — **제약을 새긴 뒤에는 시드를 다시 돌려 봐야 한다.** 표가 맞는 것과 데이터가
   * 들어가는 것은 다른 일이고, `NOT VALID` 는 기존 행만 봐주지 **새 INSERT 인 시드는 그대로 검사한다.**
   * 이 검사는 **DB 없이** 돈다 — 시드가 만든 값을 직접 세어 `rep_no_self_review` 를 미리 잡는다.
   */
  it('시드가 만든 리포트 중 쓴 사람이 결재한 것은 하나도 없다 (rep_no_self_review)', () => {
    // 김범준(3)은 결재자이면서 강사이기도 하다 — 그가 맡은 회차가 자기 결재가 되면 안 된다
    const days = Array.from({ length: 30 }, (_, i) => addD(SEED_TODAY, -(i + 1)));
    const occs = days.flatMap((onDate, i) => [
      occurrence({ serId: 100 + i, onDate, teacherId: 3 }),
      occurrence({ serId: 200 + i, onDate, teacherId: 7 }),
    ]);
    const reports = buildReports(occs, () => 'ko', 23 * 60);

    const reviewed = reports.filter((r) => r.reviewerId !== null);
    expect(reviewed.length).toBeGreaterThan(0);           // 결재된 표본이 실제로 있어야 의미가 있다
    expect(reviewed.filter((r) => r.reviewerId === r.teacherId)).toEqual([]);
    // 김범준이 맡은 회차도 결재는 되어야 한다 — 「막느라 아예 안 함」이 아니다
    expect(reviewed.some((r) => r.teacherId === 3)).toBe(true);
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
