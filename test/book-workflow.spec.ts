/** @file-guide
 * 목적: §38 진도와 §41 전달 상태의 공용 순수 방어함수를 회귀 검증한다.
 * 책임/재사용: 제품 함수만 호출하고 HTTP·DB 규칙을 테스트에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { estimateBookCompletion, isIssueActive, isIssueTerminal, issueActiveSql, issueTransitionIssue, packTransitionIssue, progressIssue, progressPercent } from '../src/lib/book';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  BookAssignmentCreateDto, BookHistoryQueryDto, BookIssueCreateDto, BookIssueReturnDto, BookIssueTransitionDto, BookPackPatchDto,
  BookPackWriteDto, BookPatchDto, BookVersionCreateDto, BookWriteDto,
} from '../src/modules/books/books.dto';

describe('교재 진도 단일 판정', () => {
  it.each([
    [null, 100, null], [10, null, null], [0, 100, 0], [50, 100, 50], [200, 100, 100],
  ] as const)('%s / %s → %s', (page, pages, expected) => {
    expect(progressPercent(page, pages)).toBe(expected);
  });

  it('음수·소수·전체 쪽수 초과를 같은 방어함수에서 막는다', () => {
    expect(progressIssue(-1, 100)).toContain('0 이상의 정수');
    expect(progressIssue(1.5, 100)).toContain('0 이상의 정수');
    expect(progressIssue(101, 100)).toContain('100쪽');
    expect(progressIssue(100, 100)).toBeNull();
  });
});

describe('BO-Q08-ETA 완료 예상일', () => {
  const history = [
    { lessonOn: '2026-10-08', progressFromPage: 31, progressToPage: 40 },
    { lessonOn: '2026-10-01', progressFromPage: 21, progressToPage: 30 },
    { lessonOn: '2026-09-24', progressFromPage: 11, progressToPage: 20 },
  ];
  const upcomingLessonOn = ['2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31', '2026-11-07', '2026-11-14'];

  it('최근 양수 진도 3회와 실제 예정 회차로 완료일을 계산한다', () => {
    expect(estimateBookCompletion({ today: '2026-10-09', totalPages: 100, progressPage: 40, history, upcomingLessonOn }))
      .toEqual({ status: 'ready', sampleCount: 3, pagesPerLesson: 10, remainingLessons: 6, completionOn: '2026-11-14' });
  });

  it('표본이 3회 미만이면 예상치를 만들지 않는다', () => {
    expect(estimateBookCompletion({ today: '2026-10-09', totalPages: 100, progressPage: 40, history: history.slice(0, 2), upcomingLessonOn }))
      .toMatchObject({ status: 'insufficient_history', sampleCount: 2, completionOn: null });
  });

  it('필요 회차보다 실제 예정 회차가 적으면 날짜 대신 필요 회차를 반환한다', () => {
    expect(estimateBookCompletion({ today: '2026-10-09', totalPages: 100, progressPage: 40, history, upcomingLessonOn: upcomingLessonOn.slice(0, 1) }))
      .toEqual({ status: 'schedule_unavailable', sampleCount: 3, pagesPerLesson: 10, remainingLessons: 6, completionOn: null });
  });

  it('56일 밖 기록과 진도 누락은 표본에서 제외한다', () => {
    const result = estimateBookCompletion({
      today: '2026-10-09', totalPages: 100, progressPage: 40, upcomingLessonOn,
      history: [history[0], history[1], { lessonOn: '2026-08-01', progressFromPage: 1, progressToPage: 10 },
        { lessonOn: '2026-10-07', progressFromPage: null, progressToPage: null }],
    });
    expect(result).toMatchObject({ status: 'insufficient_history', sampleCount: 2 });
  });

  it('이미 끝난 교재는 오늘을 완료일로 반환한다', () => {
    expect(estimateBookCompletion({ today: '2026-10-09', totalPages: 100, progressPage: 100, history: [], upcomingLessonOn: [] }))
      .toEqual({ status: 'complete', sampleCount: 0, pagesPerLesson: null, remainingLessons: 0, completionOn: '2026-10-09' });
  });
});

describe('교재 배부 자동 전이', () => {
  it('wait→auto→ok 한 방향과 wait/auto의 명시적 종료만 허용한다', () => {
    expect(issueTransitionIssue('wait', 'auto')).toBeNull();
    expect(issueTransitionIssue('auto', 'ok')).toBeNull();
    expect(issueTransitionIssue('wait', 'ok')).toContain('바꿀 수 없습니다');
    expect(issueTransitionIssue('ok', 'auto')).toContain('바꿀 수 없습니다');
    expect(issueTransitionIssue('returned', 'ok')).toContain('바꿀 수 없습니다');
    expect(issueTransitionIssue('wait', 'rejected')).toBeNull();
    expect(issueTransitionIssue('auto', 'canceled')).toBeNull();
    expect(issueTransitionIssue('ok', 'canceled')).toContain('바꿀 수 없습니다');
    expect(issueTransitionIssue('canceled', 'auto')).toContain('바꿀 수 없습니다');
  });

  it('활성·종료 판정과 SQL은 같은 세 상태를 쓴다', () => {
    expect(['wait', 'auto', 'ok', 'returned', 'canceled', 'rejected'].map((state) => isIssueActive(state)))
      .toEqual([true, true, true, false, false, false]);
    expect(['wait', 'auto', 'ok', 'returned', 'canceled', 'rejected'].map((state) => isIssueTerminal(state)))
      .toEqual([false, false, false, true, true, true]);
    expect(issueActiveSql('i')).toBe("i.state IN ('wait','auto','ok')");
    expect(() => issueActiveSql('i;drop')).toThrow('Invalid ISSUE SQL alias');
  });
});

describe('교재 배부 종료 입력', () => {
  it.each(['canceled', 'rejected'] as const)('%s은 빈 사유를 거절하고 trim한다', async (state) => {
    expect(await validate(plainToInstance(BookIssueTransitionDto, { state, reason: '  ', expectedVersion: 1 }))).not.toHaveLength(0);
    const dto = plainToInstance(BookIssueTransitionDto, { state, reason: '  사유  ', expectedVersion: 1 });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.reason).toBe('사유');
  });
});

describe('BOC-04D-03b 교재 배정 입력 계약', () => {
  const valid = {
    libId: 4,
    versId: 11,
    studentId: 3,
    teacherId: 7,
    subKey: 'reading',
    requestKey: '00000000-0000-4000-8000-000000000001',
    reason: '  읽기 기초 보강  ',
    form: 'pdf',
  };

  it('강사·과목·학생·교재·정확한 판·UUID 요청 키를 모두 받고 사유를 trim한다', async () => {
    const dto = plainToInstance(BookAssignmentCreateDto, valid);
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.reason).toBe('읽기 기초 보강');
  });

  it.each(['teacherId', 'subKey', 'versId', 'requestKey'] as const)('%s가 빠진 배정은 거절한다', async (key) => {
    const body = { ...valid };
    delete body[key];
    expect(await validate(plainToInstance(BookAssignmentCreateDto, body))).not.toHaveLength(0);
  });

  it('UUID가 아닌 재시도 키와 빈 과목은 거절한다', async () => {
    expect(await validate(plainToInstance(BookAssignmentCreateDto, { ...valid, requestKey: 'retry', subKey: '' })))
      .not.toHaveLength(0);
  });
});

describe('자료 전달 자동 전이', () => {
  it('pending→delivered→received만 허용한다', () => {
    expect(packTransitionIssue('pending', 'delivered')).toBeNull();
    expect(packTransitionIssue('delivered', 'received')).toBeNull();
    expect(packTransitionIssue('pending', 'received')).toContain('바꿀 수 없습니다');
    expect(packTransitionIssue('received', 'delivered')).toContain('바꿀 수 없습니다');
  });
});

describe('C77 HTTP 입력 계약', () => {
  it.each([
    [BookVersionCreateDto, { edition: 'v1', fromDate: '2026-02-30' }],
    [BookHistoryQueryDto, { anchor: '2026-02-30' }],
    [BookIssueCreateDto, { libId: 1, studentId: 1, issuedOn: '2026-02-30' }],
    [BookIssueReturnDto, { returnedOn: '2026-02-30' }],
    [BookPackWriteDto, { packType: 'exam', title: '자료', effectiveOn: '2026-02-30', coordinatorId: 1, studentIds: [1], libIds: [1] }],
    [BookPackPatchDto, { effectiveOn: '2026-02-30' }],
  ])('%p의 달력에 없는 날짜를 거절한다', async (Dto, body) => {
    expect(await validate(plainToInstance(Dto as new () => object, body))).not.toHaveLength(0);
  });

  it.each([
    [BookWriteDto, { code: '  ', title: '정상' }],
    [BookWriteDto, { code: '정상', title: '  ' }],
    [BookPatchDto, { title: '  ' }],
    [BookPackWriteDto, { packType: 'exam', title: '  ', effectiveOn: '2026-09-14', coordinatorId: 1, studentIds: [1], libIds: [1] }],
    [BookPackPatchDto, { title: '  ' }],
  ])('%p의 공백뿐인 이름을 trim 후 거절한다', async (Dto, body) => {
    expect(await validate(plainToInstance(Dto as new () => object, body))).not.toHaveLength(0);
  });

  it('교재와 자료 이름은 검증 전에 trim한다', async () => {
    const book = plainToInstance(BookWriteDto, { code: ' A-1 ', title: ' 교재 ' });
    const pack = plainToInstance(BookPackPatchDto, { title: ' 자료 ' });
    expect(await validate(book)).toHaveLength(0);
    expect(await validate(pack)).toHaveLength(0);
    expect(book).toMatchObject({ code: 'A-1', title: '교재' });
    expect(pack.title).toBe('자료');
  });
});
