/** §23·§24 기존 LEAD 읽기 계약. DB query/인증 사용자만 대역이며 실제 DB·JWT QA는 아니다. */
import { INestApplication, InternalServerErrorException } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { Repository } from 'typeorm';
import type { Lead } from '../src/entities';
import { PERM_KEY, PermGuard, ROLES, permsOf, type RequestUser } from '../src/common/perm';
import { OpsController } from '../src/modules/ops/ops.controller';
import { LeadDto, type OpsDto } from '../src/modules/ops/ops.dto';
import { OpsService } from '../src/modules/ops/ops.service';

type Row = Record<string, unknown>;
const row = (over: Row = {}): Row => ({
  id: '1', name: '상담 계약 테스트', school: '학교', stage: 'failed',
  owner_id: '9', student_id: '11', owner_name: '담당', stop_at: 'after_second',
  reason: '사유', created_at: '2026-09-07', ...over,
});

function service(rows: Row[]) {
  const query = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
  return { svc: new OpsService({ query } as unknown as Repository<Lead>), query };
}

describe('§23·§24 LEAD 응답 projection', () => {
  beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-10T00:00:00+09:00')); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('기존 DB 연결 ID를 선택하고 raw 추가 열 없이 LeadDto만 반환한다', async () => {
    const { svc, query } = service([row({ private_note: '비공개 값', password_hash: '노출 금지' })]);
    const result = await svc.all(false);
    expect(query.mock.calls[0][0]).toMatch(/SELECT[^]*l\.owner_id[^]*l\.student_id[^]*FROM lead l/);
    expect(result.leads).toEqual([{
      id: 1, name: '상담 계약 테스트', school: '학교', stage: 'failed',
      ownerId: 9, studentId: 11, ownerName: '담당', stopAt: 'after_second',
      reason: '사유', createdAt: '2026-09-07', ageDays: 3,
    }]);
    expect(query).toHaveBeenCalledTimes(7);
  });

  it.each(['ownerId', 'studentId'])('%s는 Swagger에서 optional·nullable number다', (field) => {
    expect(Reflect.getMetadata('swagger/apiModelProperties', LeadDto.prototype, field)).toMatchObject({
      type: Number, nullable: true, required: false,
    });
  });

  it.each([1, '1', '01', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)])('안전한 양의 ID %p를 숫자로 투영한다', async (id) => {
    const { svc } = service([row({ id, owner_id: id, student_id: id })]);
    expect((await svc.all(false)).leads[0]).toMatchObject({
      id: Number(id), ownerId: Number(id), studentId: Number(id),
    });
  });

  it.each([null, undefined])('연결 ID가 %p이면 0이 아닌 null로 유지한다', async (id) => {
    const { svc } = service([row({ owner_id: id, student_id: id })]);
    expect((await svc.all(false)).leads[0]).toMatchObject({ id: 1, ownerId: null, studentId: null });
  });

  const invalidIds = [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
    '', ' ', '0', '-1', '1.5', '1e2', '0x10', ' 1 ', 'abc', '9007199254740993', true, [], {}, 1n];
  it.each(['id', 'owner_id', 'student_id'].flatMap((field) => invalidIds.map((value) => ({ field, value }))))(
    '오염/정밀도 손실 ID $field=$value를 공통 서버 오류로 막는다', async ({ field, value }) => {
      const { svc, query } = service([row({ [field]: value })]);
      await expect(svc.all(false)).rejects.toThrow(new InternalServerErrorException('상담 데이터 무결성 오류'));
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it.each([null, undefined])('필수 LEAD id=%p는 연결 ID와 달리 허용하지 않는다', async (id) => {
    const { svc } = service([row({ id })]);
    await expect(svc.all(false)).rejects.toThrow(new InternalServerErrorException('상담 데이터 무결성 오류'));
  });

  it.each([
    { stage: 'first', stop_at: null }, { stage: 'wait2nd', stop_at: null },
    { stage: 'second', stop_at: null }, { stage: 'hold', stop_at: null },
    { stage: 'enrolled', stop_at: null }, { stage: 'failed', stop_at: 'before_first' },
    { stage: 'failed', stop_at: 'after_first' }, { stage: 'failed', stop_at: 'before_book' },
    { stage: 'failed', stop_at: 'after_second' }, { stage: 'future_stage', stop_at: 'future_stop' },
  ])('기존 단계/중단 코드를 정규화하거나 새 정책으로 막지 않는다: %p', async (over) => {
    const { svc } = service([row(over)]);
    expect((await svc.all(false)).leads[0]).toMatchObject({ stage: over.stage, stopAt: over.stop_at });
  });

  it.each([['2026-09-07', 3], ['2026-09-10', 0], ['2026-09-11', 0]])('접수일 %s와 KST 경과 %i일의 기존 의미를 유지한다', async (createdAt, ageDays) => {
    const { svc } = service([row({ created_at: createdAt, failed_at: '2026-09-09' })]);
    const [lead] = (await svc.all(false)).leads;
    expect(lead).toMatchObject({ createdAt, ageDays });
    expect(lead).not.toHaveProperty('failedAt');
    expect(lead).not.toHaveProperty('failed_at');
  });
});

describe('GET /ops — 실제 controller·Reflector·PermGuard, 인증 사용자와 service만 대역', () => {
  let app: INestApplication;
  let user: RequestUser | undefined;
  const all = jest.fn<ReturnType<OpsService['all']>, Parameters<OpsService['all']>>();
  const empty: OpsDto = {
    leads: [], complaints: [], todos: [], plans: [], meetings: [], marketing: [], suggestions: [], canSeeAmounts: false,
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [OpsController],
      providers: [{ provide: OpsService, useValue: { all } }, { provide: APP_GUARD, useClass: PermGuard }],
    }).compile();
    app = mod.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => { req.user = user; next(); });
    // 요청마다 ephemeral 포트를 닫고 다시 열지 않는다. 모든 권한 조합이 같은 서버를 검증한다.
    await app.listen(0, '127.0.0.1');
  });
  beforeEach(() => { user = undefined; all.mockReset().mockResolvedValue(empty); });
  afterAll(async () => { await app?.close(); });

  it('실제 GET handler에 프론트와 동일한 두 권한이 모두 선언되어 있다', () => {
    expect(app.get(Reflector).get(PERM_KEY, OpsController.prototype.all)).toEqual(['canAdminPage', 'canCrudAll']);
  });

  async function checkAccess(allowed: boolean) {
    const res = await request(app.getHttpServer()).get('/ops')
      .timeout({ response: 2000, deadline: 4000 }).expect(allowed ? 200 : 403);
    if (allowed) {
      expect(res.body).toEqual(empty);
      expect(all).toHaveBeenCalledTimes(1);
    } else {
      expect(all).not.toHaveBeenCalled();
    }
  }

  it.each(ROLES)('기본 역할 %s의 접근을 HTTP에서 판정한다', async (role) => {
    user = { id: 1, name: '권한 테스트', role };
    const flags = permsOf(role);
    await checkAccess(flags.canAdminPage && flags.canCrudAll);
    if (flags.canAdminPage && flags.canCrudAll) expect(all).toHaveBeenCalledWith(flags.canMoney);
  });

  const overrides = [true, false, null, undefined] as const;
  const cases = ROLES.flatMap((role) => overrides.flatMap((canAdminPage) => overrides.map((canCrudAll) => ({
    role, canAdminPage, canCrudAll,
  }))));
  it.each(cases)('$role / canAdminPage=$canAdminPage / canCrudAll=$canCrudAll 전 조합', async ({ role, canAdminPage, canCrudAll }) => {
    user = { id: 1, name: '권한 테스트', role, perms: { canAdminPage, canCrudAll } };
    const flags = permsOf(role, user.perms);
    await checkAccess(flags.canAdminPage && flags.canCrudAll);
  });

  it.each([true, false])('통과한 요청의 기존 canMoney=%s override는 그대로 전달한다', async (canMoney) => {
    user = { id: 1, name: '권한 테스트', role: 'manager', perms: { canMoney } };
    await checkAccess(true);
    expect(all).toHaveBeenCalledWith(canMoney);
  });

  it('사용자가 없으면 403이며 service를 호출하지 않는다', async () => { await checkAccess(false); });
  it('알 수 없는 역할은 두 권한을 켜도 403이다', async () => {
    user = { id: 1, name: '권한 테스트', role: 'unknown', perms: { canAdminPage: true, canCrudAll: true } };
    await checkAccess(false);
  });
});
