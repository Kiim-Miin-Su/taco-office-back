/** @file-guide
 * 목적: report-reminder-service.spec.ts — §47 독촉 빈 집합·권한 트랜잭션 방어
 * 책임/재사용: 외부 DB 기록 없이 ReportsService의 공개 경계와 commit/rollback만 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ReportsService } from '../src/modules/reports/reports.service';

const requestKey = '00000000-0000-4000-8000-000000000247';

function setup() {
  const query = jest.fn().mockResolvedValue([]);
  const runner = {
    isTransactionActive: false,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn().mockResolvedValue(undefined),
    query,
  };
  runner.startTransaction.mockImplementation(async () => { runner.isTransactionActive = true; });
  runner.commitTransaction.mockImplementation(async () => { runner.isTransactionActive = false; });
  runner.rollbackTransaction.mockImplementation(async () => { runner.isTransactionActive = false; });
  const ds = { createQueryRunner: jest.fn(() => runner) };
  const service = new ReportsService(ds as never, {} as never);
  return { service, ds, runner, query };
}

describe('§47 독촉 service 방어', () => {
  it('전체 실행의 현재 대상 0명은 items=[]로 commit한다', async () => {
    const { service, runner } = setup();
    await expect(service.reminders({ requestKey }, 7, true)).resolves.toEqual({ requestKey, items: [] });
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('명시 강사의 현재 대상 0건은 rollback과 stale 409로 끝난다', async () => {
    const { service, runner } = setup();
    await expect(service.reminders({ requestKey, teacherId: 17 }, 7, true))
      .rejects.toMatchObject({ response: { code: 'REPORT_REMINDER_STALE' } });
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).not.toHaveBeenCalled();
  });

  it('권한이 없으면 connection/transaction을 열지 않는다', async () => {
    const { service, ds } = setup();
    await expect(service.reminders({ requestKey }, 7, false))
      .rejects.toMatchObject({ response: { code: 'REPORT_REMINDER_FORBIDDEN' } });
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
  });

  it.each(['connect', 'startTransaction'] as const)('%s 실패도 runner를 해제한다', async (stage) => {
    const { service, runner } = setup();
    runner[stage].mockRejectedValueOnce(new Error(`${stage} failed`));
    await expect(service.reminders({ requestKey }, 7, true)).rejects.toThrow(`${stage} failed`);
    expect(runner.release).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it.each([
    { savedScope: null, request: { requestKey, teacherId: 17 }, label: '전체→선택' },
    { savedScope: '17', request: { requestKey }, label: '선택→전체' },
  ])('$label payload 변경은 같은 requestKey라도 409다', async ({ savedScope, request }) => {
    const { service, query, runner } = setup();
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{
      id: '1', to_id: '17', from_id: '7', request_teacher_id: savedScope,
      teacher_name: '강사', category: 'report_due', count: '1', created_at: '2026-09-14T00:00:00Z',
    }]);
    await expect(service.reminders(request, 7, true))
      .rejects.toMatchObject({ response: { code: 'REPORT_REMINDER_REQUEST_KEY_REUSED' } });
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });
});
