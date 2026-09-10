/** @file-guide
 * 목적: ops-contract.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/** §23·§24 LEAD / §59 비용 읽기 계약. DB query·인증 사용자 대역이며 실제 DB·JWT 서명 QA는 아니다. */
import { INestApplication, InternalServerErrorException } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { Repository } from 'typeorm';
import { Staff, type Lead } from '../src/entities';
import { AuthService } from '../src/auth/auth.service';
import { JwtStrategy, type JwtPayload } from '../src/auth/jwt.strategy';
import { PERM_KEY, PermGuard, ROLES, permsOf, type RequestUser, type Role } from '../src/common/perm';
import { OpsController } from '../src/modules/ops/ops.controller';
import { LeadDto, type OpsDto } from '../src/modules/ops/ops.dto';
import { OpsService } from '../src/modules/ops/ops.service';
import { buildOpenApi } from '../src/openapi';

type Row = Record<string, unknown>;
const row = (over: Row = {}): Row => ({
  id: '1', name: '상담 계약 테스트', school: '학교', stage: 'failed',
  owner_id: '9', student_id: '11', owner_name: '담당', stop_at: 'after_second',
  reason: '사유', created_at: '2026-09-07', ...over,
});

function service(rows: Row[], marketingRows: Row[] = []) {
  const query = jest.fn().mockResolvedValueOnce(rows)
    .mockImplementation((sql: string) => Promise.resolve(/\bFROM mkt\b/.test(sql) ? marketingRows : []));
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

  const searchFields = [
    ['name', 'name'], ['school', 'school'], ['owner_name', 'ownerName'], ['reason', 'reason'],
  ] as const;
  const originalTexts = ['  상담 Alpha  ', '', '\t문자\n원문', '비용 · 타 학원 등록', '김서우'];
  it.each(searchFields.flatMap(([column, field]) => originalTexts.map((value) => ({ column, field, value }))))(
    'FQ 검색 대상 $field 원문을 trim·기본 문구·정규화 없이 보존한다: $value', async ({ column, field, value }) => {
      const { svc } = service([row({ [column]: value })]);
      expect((await svc.all(false)).leads[0][field]).toBe(value);
    },
  );

  it.each(searchFields.filter(([column]) => column !== 'name').flatMap(([column, field]) =>
    [null, undefined].map((value) => ({ column, field, value }))))(
    'nullable FQ 대상 $field=$value를 null로 투영하며 빈 문자열과 구분한다', async ({ column, field, value }) => {
      const { svc } = service([row({ [column]: value })]);
      expect((await svc.all(false)).leads[0][field]).toBeNull();
    },
  );

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

describe('STAFF 예외 → MeDto / Access payload 권한 snapshot (DB·서명 검증 아님)', () => {
  const noOverrides = { canMoney: null, canWage: null, canApprove: null, canHide: null, canGpaPack: null };
  type Overrides = Partial<Record<keyof typeof noOverrides, boolean | null>>;

  function snapshot(role: Role, overrides: Overrides = {}) {
    const findOne = jest.fn();
    const sign = jest.fn<string, [JwtPayload]>().mockReturnValue('unit-access-token');
    const auth = new AuthService({ findOne } as unknown as Repository<Staff>, { sign } as unknown as JwtService);
    const staff = Object.assign(new Staff(), { id: 17, name: '권한 검수', title: null, role, ...noOverrides, ...overrides });
    const me = auth.toMe(staff);
    expect(auth.signAccess(staff)).toBe('unit-access-token');
    expect(sign).toHaveBeenCalledTimes(1);
    const payload = sign.mock.calls[0][0];
    const user = new JwtStrategy().validate(payload);
    const expected = permsOf(role, overrides);

    expect(me).toEqual({ id: 17, name: '권한 검수', title: null, role, ...expected });
    expect(user).toEqual({ id: 17, name: '권한 검수', role, perms: payload.perms });
    expect(permsOf(role, user.perms)).toEqual(expected);
    expect(findOne).not.toHaveBeenCalled();
    return { me, payload };
  }

  it.each(ROLES)('%s 기본 STAFF는 예외를 null로 싣고 MeDto와 같은 판정을 낸다', (role) => {
    expect(snapshot(role).payload.perms).toBeNull();
  });

  const flags = Object.keys(noOverrides) as Array<keyof typeof noOverrides>;
  it.each(flags.flatMap((field) => [true, false].map((value) => ({ field, value }))))(
    '명시적 $field=$value 한 칸만 role 기본값을 덮으며 다른 플래그는 보존한다', ({ field, value }) => {
      // true는 전부 닫힌 강사, false는 전부 열린 대표에서 검사해 role-only 회귀를 잡는다.
      const { me, payload } = snapshot(value ? 'teacher' : 'ceo', { [field]: value });
      expect(me[field]).toBe(value);
      expect(payload.perms).toEqual({ ...noOverrides, [field]: value });
    },
  );
});

describe('GET /ops — 실제 controller·Reflector·PermGuard, 인증 사용자와 service만 대역', () => {
  let app: INestApplication;
  let openApi: ReturnType<typeof buildOpenApi>;
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
    openApi = buildOpenApi(app);
  });
  beforeEach(() => { user = undefined; all.mockReset().mockResolvedValue(empty); });
  afterAll(async () => { await app?.close(); });

  it('실제 GET handler에 프론트와 동일한 두 권한이 모두 선언되어 있다', () => {
    expect(app.get(Reflector).get(PERM_KEY, OpsController.prototype.all)).toEqual(['canAdminPage', 'canCrudAll']);
  });

  it('실제 OpenAPI에 FQ 네 문자열의 원문·nullable 계약을 기존 11필드로 명시한다', () => {
    const schema = openApi.components?.schemas?.LeadDto;
    if (!schema || '$ref' in schema) throw new Error('LeadDto schema 누락');
    expect(Object.keys(schema.properties ?? {})).toHaveLength(11);
    for (const field of ['name', 'school', 'ownerName', 'reason']) {
      expect(schema.properties?.[field]).toMatchObject({
        type: 'string', description: expect.stringMatching(/FQ.*원문/),
      });
      if (field === 'name') {
        expect(schema.required).toContain(field);
        expect(schema.properties?.[field]).not.toMatchObject({ nullable: true });
      } else {
        expect(schema.properties?.[field]).toMatchObject({ nullable: true });
        expect(schema.required).not.toContain(field);
      }
    }
  });

  it('실제 OpenAPI는 FQ 클라이언트 검색/추가 GET 0을 명시하고 검색 query·쓰기 endpoint를 추가하지 않는다', () => {
    const path = openApi.paths['/ops'];
    expect(Object.keys(openApi.paths)).toEqual(['/ops']);
    expect(Object.keys(path)).toEqual(['get']);
    expect(path.get?.description).toMatch(/name.*school.*ownerName.*reason/);
    expect(path.get?.description).toMatch(/클라이언트.*추가 GET.*0/);
    expect(path.get?.parameters ?? []).toEqual([]);
    expect(path.get?.requestBody).toBeUndefined();
  });

  it('비공개 두 비용은 기존 MarketingDto의 optional nullable number이며 응답 권한은 boolean이다', () => {
    const marketing = openApi.components?.schemas?.MarketingDto;
    const ops = openApi.components?.schemas?.OpsDto;
    if (!marketing || '$ref' in marketing || !ops || '$ref' in ops) throw new Error('Ops 비용 schema 누락');
    expect(Object.keys(marketing.properties ?? {})).toHaveLength(10);
    for (const field of ['cost', 'costPerEnroll']) {
      expect(marketing.properties?.[field]).toMatchObject({ type: 'number', nullable: true });
      expect(marketing.required).not.toContain(field);
    }
    expect(ops.properties?.canSeeAmounts).toMatchObject({ type: 'boolean' });
    expect(ops.required).toContain('canSeeAmounts');
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

  it.each<[Role, boolean]>([['manager', true], ['ceo', false]])(
    '%s의 명시적 canMoney=%s로 실제 집행 비용/등록당 비용만 투영한다', async (role, canMoney) => {
      // null/누락 비용의 기존 ?? 0을 유지하는 특성 검사다. 미기록=무료라는 신규 정책이 아니다.
      const samples: Array<{ result: Row | null; cost: number; enrolled: number; costPerEnroll: number | null }> = [
        { result: { cost: 100001, enrolled: 3 }, cost: 100001, enrolled: 3, costPerEnroll: 33334 },
        { result: { cost: 0, enrolled: 2 }, cost: 0, enrolled: 2, costPerEnroll: 0 },
        { result: { cost: 450, enrolled: 0 }, cost: 450, enrolled: 0, costPerEnroll: null },
        { result: { cost: null, enrolled: 2 }, cost: 0, enrolled: 2, costPerEnroll: 0 },
        { result: { enrolled: 2 }, cost: 0, enrolled: 2, costPerEnroll: 0 },
        { result: null, cost: 0, enrolled: 0, costPerEnroll: null },
      ];
      const metrics = { impressions: 0, clicks: 7, inquiries: 2 };
      const marketingRows = samples.map((sample, index) => ({
        id: String(index + 1), channel: 'naver', item: 'ads', url: null, private_note: 'raw 열 노출 금지',
        result: sample.result === null ? null : { ...metrics, ...sample.result, private_cost: 999999 },
      }));
      const before = structuredClone(marketingRows);
      const { svc, query } = service([row()], marketingRows);
      all.mockImplementation((canSeeAmounts) => svc.all(canSeeAmounts));
      user = { id: 1, name: '권한 테스트', role, perms: { canMoney } };

      const res = await request(app.getHttpServer()).get('/ops')
        .timeout({ response: 2000, deadline: 4000 }).expect(200);
      expect(all).toHaveBeenCalledTimes(1);
      expect(all).toHaveBeenCalledWith(canMoney);
      expect(res.body.canSeeAmounts).toBe(canMoney);
      expect(res.body.marketing).toEqual(samples.map((sample, index) => ({
        id: index + 1, channel: 'naver', item: 'ads', url: null,
        ...(sample.result === null ? { impressions: null, clicks: null, inquiries: null } : metrics),
        enrolled: sample.enrolled,
        cost: canMoney ? sample.cost : null,
        costPerEnroll: canMoney ? sample.costPerEnroll : null,
      })));
      expect(res.body.leads).toMatchObject([{ id: 1, name: '상담 계약 테스트' }]);
      expect(Object.keys(res.body).sort()).toEqual(Object.keys(empty).sort());
      expect(query).toHaveBeenCalledTimes(7);
      expect(query.mock.calls.every(([sql]) => /^SELECT\b/.test(sql))).toBe(true);
      expect(marketingRows).toEqual(before);
    },
  );

  it('사용자가 없으면 403이며 service를 호출하지 않는다', async () => { await checkAccess(false); });
  it('알 수 없는 역할은 두 권한을 켜도 403이다', async () => {
    user = { id: 1, name: '권한 테스트', role: 'unknown', perms: { canAdminPage: true, canCrudAll: true } };
    await checkAccess(false);
  });
});
