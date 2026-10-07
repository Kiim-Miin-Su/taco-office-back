/** @file-guide
 * 목적: students-read.spec.ts — 학생 목록·상세 읽기의 필터/계약/노출 경계 회귀
 * 책임/재사용: 실제 StudentsService와 DTO를 사용한다. SQL 대역 시험이며 실제 DB 정렬/연결 검증과 구분한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { DataSource } from 'typeorm';
import { StudentHubQueryDto, StudentListQueryDto, StudentReadParamsDto } from '../src/modules/students/students.dto';
import { StudentsService } from '../src/modules/students/students.service';
import { GRADE_CODES_V1 } from '../src/migrations/data/student-catalog-v1';

const educationGrades = Object.entries(GRADE_CODES_V1).flatMap(([educationSystem, codes]) =>
  codes.map((code) => ({ educationSystem, code, active: true })));

const row = { id: '21', name: '동명학생', grade: null, school: null, gender: null, tag: null,
  created_at: '2026-09-30T12:00:00+09:00', guardian_names: ['보호자'], education_grades: educationGrades,
  password_hash: 'PRIVATE', phone: 'PRIVATE' };
function fixture(rows: unknown[][]) {
  const query = jest.fn();
  rows.forEach(result => query.mockResolvedValueOnce(result));
  const transaction = jest.fn(async (_isolation: string, run: (manager: { query: typeof query }) => Promise<unknown>) => run({ query }));
  return { query, transaction, service: new StudentsService({ query, transaction } as unknown as DataSource) };
}

describe('학생 읽기 — 현재 DB 사실만', () => {
  it('최신10명 기본값·학년 필터·literal 검색을 바인딩하고 유출 칸을 버린다', async () => {
    const { query, service } = fixture([[{ items: [row], total: 21, grades: ['G8'], education_grades: educationGrades }]]);
    const result = await service.list({ q: "%' OR true --", grade: 'G8', page: 2 });
    expect(query.mock.calls[0][1]).toEqual(["%' OR true --", 'G8', 10, 10]);
    expect(query.mock.calls[0][0]).toContain('ORDER BY s.created_at DESC NULLS LAST, s.id DESC');
    expect(query.mock.calls[0][0]).not.toContain("%' OR true --");
    expect(result).toMatchObject({ total: 21, page: 2, pageSize: 10, grades: ['G8'], educationGrades: expect.any(Array),
      items: [{ id: 21, grade: null, gradeDisplay: null, school: null, createdAt: row.created_at }] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|password|phone/);
  });

  it('빈 페이지도 전체 total을 잃지 않는다', async () => {
    const { service } = fixture([[{ items: [], total: 21, grades: [], education_grades: educationGrades }]]);
    expect(await service.list({ page: 99 })).toMatchObject({ items: [], total: 21, page: 99 });
  });

  it('없는 학생은 빈 성공 상세가 아니라404다', async () => {
    const { query, service } = fixture([[]]);
    await expect(service.detail({ id: 42 })).rejects.toMatchObject({ status: 404 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('상세는 같은 읽기 snapshot에서 보호자/수강/연결 감사만 투영한다', async () => {
    const { service, query, transaction } = fixture([
      [{ ...row, started_on: null, target_exam: null, guidance: null, lang: null }],
      [{ id: '7', name: '보호자', relation: '어머니', active: true, is_primary: true, total: '1', phone: 'PRIVATE' }],
      [{ id: '8', kind_name: '영어', sub_name: null, sessions: 4, started_on: '2026-09-01', ended_on: null, total: '1', amount: 987654 }],
      [{ id: '9', entity: 'LEAD', entity_id: '3', action: 'enroll', actor_id: '2', actor_name: '담당자', at: row.created_at, total: '51', before: { secret: 'PRIVATE' }, after: { amount: 987654 } }],
    ]);
    const result = await service.detail({ id: 21 });
    expect(transaction.mock.calls[0][0]).toBe('REPEATABLE READ');
    expect(result).toMatchObject({ id: 21, startedOn: null, guardianTotal: 1, enrollmentTotal: 1, historyTotal: 51, historyLimit: 50,
      history: [{ entity: 'LEAD', action: 'enroll', actorId: 2, actorName: '담당자' }] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|987654|phone|before|after/);
    expect(query.mock.calls[3][0]).toContain("a.entity = 'LEAD'");
    expect(query.mock.calls[3][0]).toContain("a.entity = 'STU' AND a.entity_id = $1");
    expect(query.mock.calls[3][0]).toContain('l.student_id = $1');
    expect(query.mock.calls[3][0]).toContain('g.student_id = $1');
    expect(query.mock.calls.every(([sql]) => !/\b(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(true);
  });

  it('기존 직접 학생 퇴원 감사도 금액이나 사유 없이 표시한다', async () => {
    const { service } = fixture([[row], [], [], [{ id: '12', entity: 'STU', entity_id: '21', action: 'withdraw',
      actor_id: '2', actor_name: '담당자', at: row.created_at, total: '1', after: { refundTotal: 987654, reason: 'PRIVATE' } }]]);
    const result = await service.detail({ id: 21 });
    expect(result.history[0]).toMatchObject({ entity: 'STU', actionLabel: '퇴원 처리' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|987654/);
  });

  it('생성 시각/학교/학년 미상은 수강 시작일로 복구하지 않는다', async () => {
    const { service } = fixture([[{ items: [{ ...row, created_at: null }], total: 1, grades: [], education_grades: educationGrades }]]);
    expect((await service.list({})).items[0]).toMatchObject({ createdAt: null, grade: null, school: null });
  });

  it('안전 정수를 벗어난 식별자는 다른 학생으로 반올림하지 않는다', async () => {
    const { service } = fixture([[{ items: [{ ...row, id: '9007199254740993' }], total: 1, grades: [], education_grades: educationGrades }]]);
    await expect(service.list({})).rejects.toMatchObject({ status: 500 });
  });

  it('학생 허브는 exact student 원장·독립 cursor·금액/컨설팅 공개 범위를 서버에서 적용한다', async () => {
    const { service, query, transaction } = fixture([
      [{ id: '21', schedule_count: '2', billing_count: '1', book_count: '3', guide_count: '1', lead_count: '1' }],
      [
        { id: '30', share: 'private', owner_id: '9', is_picked: false },
        { id: '31', share: 'money_only', owner_id: '9', is_picked: false },
      ],
      [{ total: 2 }],
      [
        { id: '12', on_date: '2026-10-07', cursor_date: '2026-10-07', kind_name: '수업', subject_name: '영어', teacher_name: '강사', stored_state: 'wait', reportable: true, ended: true, submitted_at: '2026-10-07T04:00:00Z', body: 'PRIVATE' },
        { id: '11', on_date: '2026-10-06', cursor_date: '2026-10-06', kind_name: '수업', subject_name: '영어', teacher_name: '강사', stored_state: 'ok', reportable: true, ended: true, submitted_at: '2026-10-06T04:00:00Z' },
      ],
      [{ total: 2 }],
      [
        { id: '22', ser_id: '5', author_id: '2', author_name: '관리자', body: '인수인계', cursor_date: '2026-10-07T01:02:03.123456Z', created_at: '2026-10-07T01:02:03Z' },
        { id: '21', ser_id: null, author_id: '2', author_name: '관리자', body: '이전 메모', cursor_date: '2026-10-06T01:02:03.123456Z', created_at: '2026-10-06T01:02:03Z' },
      ],
      [{ total: 2 }],
      [
        { id: '32', cursor_date: '2026-10', year_month: '2026-10', inv_type: 'tuition', title: '10월 수업료', state: 'partial', due_on: '2026-10-10', amount: 100000, paid_amount: 30000, proof_url: 'PRIVATE' },
        { id: '31', cursor_date: '2026-09', year_month: '2026-09', inv_type: 'tuition', title: '9월 수업료', state: 'paid', due_on: null, amount: 90000, paid_amount: 90000 },
      ],
    ]);
    const result = await service.hub({ id: 21 }, { limit: 1 }, 2, false, false);
    expect(transaction.mock.calls[0][0]).toBe('REPEATABLE READ');
    expect(result.nextActions.map(item => [item.key, item.count])).toEqual([
      ['schedule', 2], ['billing', 1], ['consulting', 1], ['books', 3], ['guides', 1], ['lead', 1],
    ]);
    expect(result.nextActions.find(item => item.key === 'billing')?.href).toBe('/students/21?tab=billing');
    expect(result.nextActions.find(item => item.key === 'lead')?.href).toBe('/intake');
    expect(result.reports).toMatchObject({ total: 2, items: [{ id: 12, state: 'wait', stateLabel: '승인 대기' }] });
    expect(result.comments).toMatchObject({ total: 2, items: [{ id: 22, body: '인수인계' }] });
    expect(result.invoices).toMatchObject({ total: 2, items: [{ id: 32, amount: null, paidAmount: null, remainingAmount: null }] });
    expect(['reports', 'comments', 'invoices'].map((kind) => {
      const token = result[kind as 'reports'].nextCursor!;
      return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')).k;
    })).toEqual(['reports', 'comments', 'invoices']);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|proofUrl|body.*PRIVATE/);
    expect(query.mock.calls[2][0]).toContain('FROM rep_stu WHERE student_id=$1');
    expect(query.mock.calls[4][0]).toContain('FROM note WHERE student_id=$1');
    expect(query.mock.calls[6][0]).toContain('FROM inv WHERE student_id=$1');
    expect(query.mock.calls.every(([sql]) => !/\b(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(true);
  });

  it('학생 허브 cursor는 목록 사이 재사용과 비정규 token을 거절한다', async () => {
    const { service, transaction } = fixture([]);
    const reportsCursor = Buffer.from(JSON.stringify({ v: 1, k: 'reports', d: '2026-10-07', i: 12 })).toString('base64url');
    await expect(service.hub({ id: 21 }, { commentsCursor: reportsCursor }, 2, true, true)).rejects.toMatchObject({ status: 400 });
    await expect(service.hub({ id: 21 }, { reportsCursor: 'not-canonical==' }, 2, true, true)).rejects.toMatchObject({ status: 400 });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('학생 조회 HTTP 입력 계약', () => {
  it.each(['0', '-1', '1.5', '1e2', '0x10', '1000001', ['1', '2']])('잘못된 page %p를 거절한다', async page => {
    expect(await validate(plainToInstance(StudentListQueryDto, { page }))).not.toHaveLength(0);
  });
  it.each(['0', '1e2', '9007199254740993', 'abc'])('잘못된 id %s를 거절한다', async id => {
    expect(await validate(plainToInstance(StudentReadParamsDto, { id }))).not.toHaveLength(0);
  });
  it('q/grade 최대 길이 및 기본 조회를 검증한다', async () => {
    expect(await validate(plainToInstance(StudentListQueryDto, {}))).toHaveLength(0);
    expect(await validate(plainToInstance(StudentListQueryDto, { q: 'x'.repeat(81), grade: 'x'.repeat(11) }))).toHaveLength(2);
  });
  it('학생 허브 limit과 불투명 cursor 입력을 검증한다', async () => {
    expect(await validate(plainToInstance(StudentHubQueryDto, { limit: '50', reportsCursor: 'abc_DEF-123' }))).toHaveLength(0);
    expect(await validate(plainToInstance(StudentHubQueryDto, { limit: '51', commentsCursor: 'bad=' }))).toHaveLength(2);
  });
});
