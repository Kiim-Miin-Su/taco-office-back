/** @file-guide
 * 목적: 자료 등록 멱등 재시도에서 현재 리포트 열람 권한이 유지되는지 검증한다.
 * 책임/재사용: 실제 ReportsService와 응답 projection을 사용하고 DB 질의·트랜잭션만 대역으로 둔다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { createHash } from 'node:crypto';
import { ReportsService } from '../src/modules/reports/reports.service';
import type { ReportMaterialCreateDto } from '../src/modules/reports/reports.dto';

const ACTOR = 7;
const dto: ReportMaterialCreateDto = {
  expectedVersion: 0, kind: 'regular', title: '권한 재검증 교재',
  requestKey: '00000000-0000-4000-8000-000000000118',
};

function setup(teacherId = ACTOR, state = 'draft') {
  const row = {
    id: '20', ser_id: '10', on_date: '2026-10-01', date: '2026-10-01',
    start_min: 540, end_min: 600, mode: 'offline', end_min_utc: '2026-10-01T01:00:00Z',
    kind_key: 'class', sub_key: 'math', teacher_id: String(teacherId), teacher_name: '담당 강사',
    state, reportable: true, canceled: false, ended: true,
    body: { content: '권한이 필요한 합성 본문', progress: '1쪽', homework: '2쪽' },
    format_version: 0, row_version: 1, kinder_marker_version: null, book_options: [],
    subject_name: '수학', students: [{ id: 30, name: '합성 학생', grade: 'G1' }],
  };
  const fingerprint = createHash('sha256').update(JSON.stringify({
    serId: 10, onDate: '2026-10-01', expectedVersion: dto.expectedVersion, kind: dto.kind, title: dto.title,
  })).digest('hex');
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('FROM report_material_req')) {
      return [{ actor_id: String(ACTOR), rep_id: row.id, fingerprint, selected_issue_id: '40' }];
    }
    if (sql.includes('r.body, r.format_version')) {
      return [row];
    }
    return [];
  });
  const runner = {
    isTransactionActive: true,
    connect: jest.fn().mockResolvedValue(undefined), startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined), rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined), query,
  };
  const service = new ReportsService({ query, createQueryRunner: () => runner } as never, {} as never);
  return { service, runner, query };
}

describe('T11 자료 등록 재시도의 현재 열람 권한', () => {
  it.each(['draft', 'wait', 'ok'])('담당 변경 뒤 %s 리포트는 원래 작성자의 성공 키로도 읽지 못한다', async (state) => {
    const { service, runner } = setup(8, state);
    await expect(service.detail(10, '2026-10-01', ACTOR, false, false))
      .rejects.toMatchObject({ response: { code: 'REPORT_FORBIDDEN' } });
    await expect(service.createMaterial(10, '2026-10-01', dto, ACTOR, false, false))
      .rejects.toMatchObject({ response: { code: 'REPORT_FORBIDDEN' } });
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('작성 권한이 회수된 관리자도 승인 권한만으로 타 강사의 초안을 replay하지 못한다', async () => {
    const { service } = setup(8, 'draft');
    await expect(service.createMaterial(10, '2026-10-01', dto, ACTOR, false, true))
      .rejects.toMatchObject({ response: { code: 'REPORT_FORBIDDEN' } });
  });

  it.each([
    { teacherId: ACTOR, canCrudAll: false, canApprove: false, label: '담당 강사' },
    { teacherId: 8, canCrudAll: true, canApprove: false, label: '전체 작성 관리자' },
    { teacherId: 8, canCrudAll: false, canApprove: true, label: '제출 리포트 승인자' },
  ])('$label 는 승인 뒤에도 이미 성공한 요청을 중복 쓰기 없이 재조회한다', async ({ teacherId, canCrudAll, canApprove }) => {
    const { service, runner, query } = setup(teacherId, 'ok');
    await expect(service.createMaterial(10, '2026-10-01', dto, ACTOR, canCrudAll, canApprove))
      .resolves.toMatchObject({ selectedIssueId: 40, detail: { teacherId, body: { content: '권한이 필요한 합성 본문' } } });
    expect(query.mock.calls.some(([sql]) => /INSERT|UPDATE lib|UPDATE issue/.test(sql))).toBe(false);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
  });
});
