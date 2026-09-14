/** @file-guide
 * 목적: §38 진도와 §41 전달 상태의 공용 순수 방어함수를 회귀 검증한다.
 * 책임/재사용: 제품 함수만 호출하고 HTTP·DB 규칙을 테스트에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { issueTransitionIssue, packTransitionIssue, progressIssue, progressPercent } from '../src/lib/book';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  BookHistoryQueryDto, BookIssueCreateDto, BookIssueReturnDto, BookPackPatchDto,
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

describe('교재 배부 자동 전이', () => {
  it('wait→auto→ok 한 방향만 허용한다', () => {
    expect(issueTransitionIssue('wait', 'auto')).toBeNull();
    expect(issueTransitionIssue('auto', 'ok')).toBeNull();
    expect(issueTransitionIssue('wait', 'ok')).toContain('바꿀 수 없습니다');
    expect(issueTransitionIssue('ok', 'auto')).toContain('바꿀 수 없습니다');
    expect(issueTransitionIssue('returned', 'ok')).toContain('바꿀 수 없습니다');
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
