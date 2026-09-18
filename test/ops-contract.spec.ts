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
import { LeadEnrollService } from '../src/modules/ops/enroll.service';
import { TeacherChangeService } from '../src/modules/ops/teacher-change.service';
import { buildOpenApi } from '../src/openapi';
import { roleLabel } from '../src/lib/role-words';

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
    const result = await svc.all(1, false, false);
    expect(query.mock.calls[0][0]).toMatch(/SELECT[^]*l\.owner_id[^]*l\.student_id[^]*FROM lead l/);
    expect(result.leads).toEqual([{
      id: 1, name: '상담 계약 테스트', school: '학교', stage: 'failed',
      ownerId: 9, studentId: 11, ownerName: '담당', stopAt: 'after_second',
      reason: '사유', createdAt: '2026-09-07', ageDays: 3,
      // N-25 (C35): 명시값 없는 레거시 failed 건은 로그로도 판정 안 되면 미분류 그대로 — 추정 이관 없음
      failFrom: null, revivalStage: null, revivalSource: null,
    }]);
    // 7 고정 목록 + 명시값 없는 failed 건이 있을 때만 도달 기록 판정 1회 (N-25 · C35)
    // + §60 대표 피드백 글타래 1회 (C53) + §62 기획 기한 1회 (C56)
    // + §23 경고 셋을 **한 문장으로 묶은** 1회 (C86-a — 따로 물으면 왕복이 셋 는다)
    expect(query).toHaveBeenCalledTimes(11);
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
      expect((await svc.all(1, false, false)).leads[0][field]).toBe(value);
    },
  );

  it.each(searchFields.filter(([column]) => column !== 'name').flatMap(([column, field]) =>
    [null, undefined].map((value) => ({ column, field, value }))))(
    'nullable FQ 대상 $field=$value를 null로 투영하며 빈 문자열과 구분한다', async ({ column, field, value }) => {
      const { svc } = service([row({ [column]: value })]);
      expect((await svc.all(1, false, false)).leads[0][field]).toBeNull();
    },
  );

  it.each([1, '1', '01', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)])('안전한 양의 ID %p를 숫자로 투영한다', async (id) => {
    const { svc } = service([row({ id, owner_id: id, student_id: id })]);
    expect((await svc.all(1, false, false)).leads[0]).toMatchObject({
      id: Number(id), ownerId: Number(id), studentId: Number(id),
    });
  });

  it.each([null, undefined])('연결 ID가 %p이면 0이 아닌 null로 유지한다', async (id) => {
    const { svc } = service([row({ owner_id: id, student_id: id })]);
    expect((await svc.all(1, false, false)).leads[0]).toMatchObject({ id: 1, ownerId: null, studentId: null });
  });

  const invalidIds = [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
    '', ' ', '0', '-1', '1.5', '1e2', '0x10', ' 1 ', 'abc', '9007199254740993', true, [], {}, 1n];
  it.each(['id', 'owner_id', 'student_id'].flatMap((field) => invalidIds.map((value) => ({ field, value }))))(
    '오염/정밀도 손실 ID $field=$value를 공통 서버 오류로 막는다', async ({ field, value }) => {
      const { svc, query } = service([row({ [field]: value })]);
      await expect(svc.all(1, false, false)).rejects.toThrow(new InternalServerErrorException('상담 데이터 무결성 오류'));
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it.each([null, undefined])('필수 LEAD id=%p는 연결 ID와 달리 허용하지 않는다', async (id) => {
    const { svc } = service([row({ id })]);
    await expect(svc.all(1, false, false)).rejects.toThrow(new InternalServerErrorException('상담 데이터 무결성 오류'));
  });

  it.each([
    { stage: 'first', stop_at: null }, { stage: 'wait2nd', stop_at: null },
    { stage: 'second', stop_at: null }, { stage: 'hold', stop_at: null },
    { stage: 'enrolled', stop_at: null }, { stage: 'failed', stop_at: 'before_first' },
    { stage: 'failed', stop_at: 'after_first' }, { stage: 'failed', stop_at: 'before_book' },
    { stage: 'failed', stop_at: 'after_second' }, { stage: 'future_stage', stop_at: 'future_stop' },
  ])('기존 단계/중단 코드를 정규화하거나 새 정책으로 막지 않는다: %p', async (over) => {
    const { svc } = service([row(over)]);
    expect((await svc.all(1, false, false)).leads[0]).toMatchObject({ stage: over.stage, stopAt: over.stop_at });
  });

  it.each([['2026-09-07', 3], ['2026-09-10', 0], ['2026-09-11', 0]])('접수일 %s와 KST 경과 %i일의 기존 의미를 유지한다', async (createdAt, ageDays) => {
    const { svc } = service([row({ created_at: createdAt, failed_at: '2026-09-09' })]);
    const [lead] = (await svc.all(1, false, false)).leads;
    expect(lead).toMatchObject({ createdAt, ageDays });
    expect(lead).not.toHaveProperty('failedAt');
    expect(lead).not.toHaveProperty('failed_at');
  });
});

describe('STAFF 예외 → MeDto / Access 발급·현재 사용자 투영 (DB·서명 검증 아님)', () => {
  const noOverrides = { canMoney: null, canWage: null, canApprove: null, canHide: null, canGpaPack: null };
  type Overrides = Partial<Record<keyof typeof noOverrides, boolean | null>>;

  async function snapshot(role: Role, overrides: Overrides = {}) {
    const findOne = jest.fn();
    const sign = jest.fn<string, [JwtPayload]>().mockReturnValue('unit-access-token');
    const auth = new AuthService({ findOne } as unknown as Repository<Staff>, { sign } as unknown as JwtService);
    const staff = Object.assign(new Staff(), { id: 17, name: '권한 검수', title: null, role, ...noOverrides, ...overrides });
    const me = auth.toMe(staff);
    expect(auth.signAccess(staff)).toBe('unit-access-token');
    expect(sign).toHaveBeenCalledTimes(1);
    const payload = sign.mock.calls[0][0];
    findOne.mockResolvedValue(staff);
    const user = await new JwtStrategy(auth).validate(payload);
    const expected = permsOf(role, overrides);

    // C73 — 역할의 낱말도 서버가 싣는다 (D-R18). 화면이 제 표를 들면 서랍 §17 과 머리 배지가 갈린다
    expect(me).toEqual({ id: 17, name: '권한 검수', title: null, role, roleLabel: roleLabel(role), ...expected });
    expect(user).toEqual({ id: 17, name: '권한 검수', role, perms: payload.perms });
    expect(permsOf(role, user.perms)).toEqual(expected);
    expect(findOne).toHaveBeenCalledTimes(1);
    return { me, payload };
  }

  it.each(ROLES)('%s 기본 STAFF는 예외를 null로 싣고 MeDto와 같은 판정을 낸다', async (role) => {
    expect((await snapshot(role)).payload.perms).toBeNull();
  });

  const flags = Object.keys(noOverrides) as Array<keyof typeof noOverrides>;
  it.each(flags.flatMap((field) => [true, false].map((value) => ({ field, value }))))(
    '명시적 $field=$value 한 칸만 role 기본값을 덮으며 다른 플래그는 보존한다', async ({ field, value }) => {
      // true는 전부 닫힌 강사, false는 전부 열린 대표에서 검사해 role-only 회귀를 잡는다.
      const { me, payload } = await snapshot(value ? 'teacher' : 'ceo', { [field]: value });
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
    leads: [], complaints: [], todos: [], plans: [], meetings: [], marketing: [], suggestions: [],
    feedback: [], feedbackNeedsFix: 0, canComment: false, canSeeAmounts: false,
    planDues: [], planOverdue: 0, planStages: [], cplStages: [], cplAreas: [], cplSeverities: [],
    intakeHead: { funnel: [], enrollRate: 0, owners: [], alerts: [], stops: [] },
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [OpsController],
      // 등록 확정(C91)·강사 교체(C93)는 다른 service 다 — 이 스위트는 GET /ops 계약만 보므로 대역으로 채운다
      providers: [{ provide: OpsService, useValue: { all } }, { provide: LeadEnrollService, useValue: {} }, { provide: TeacherChangeService, useValue: {} }, { provide: APP_GUARD, useClass: PermGuard }],
    }).compile();
    app = mod.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => { req.user = user; next(); });
    // 요청마다 ephemeral 포트를 닫고 다시 열지 않는다. 모든 권한 조합이 같은 서버를 검증한다.
    await app.listen(0, '127.0.0.1');
    openApi = buildOpenApi(app);
  });
  beforeEach(() => { user = undefined; all.mockReset().mockResolvedValue(empty); });
  afterAll(async () => { await app?.close(); });

  it('실제 handler에 프론트와 동일한 두 권한이 모두 선언되어 있다 — 읽기와 실패/되살리기 쓰기 동일', () => {
    for (const handler of [
      'all', 'failLead', 'resumeLead', 'comment', 'reply', 'editPost',
      'planDetail', 'decidePlanDue', 'reviewPlan',
      'meetingDetail', 'writeMinutes', 'assignMeetingTask',
      'createComplaint', 'patchComplaint', 'teacherChangePreview', 'teacherChange',
    ] as const) {
      expect(app.get(Reflector).get(PERM_KEY, OpsController.prototype[handler])).toEqual(['canAdminPage', 'canCrudAll']);
    }
  });

  it('실제 OpenAPI에 FQ 네 문자열의 원문·nullable 계약을 14필드로 명시한다 (11 + N-25 실패 이력 3)', () => {
    const schema = openApi.components?.schemas?.LeadDto;
    if (!schema || '$ref' in schema) throw new Error('LeadDto schema 누락');
    expect(Object.keys(schema.properties ?? {})).toHaveLength(14);
    for (const field of ['failFrom', 'revivalStage', 'revivalSource']) {
      expect(schema.properties?.[field]).toMatchObject({ type: 'string', nullable: true });
      expect(schema.required).not.toContain(field);
    }
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

  it('실제 OpenAPI는 FQ 클라이언트 검색/추가 GET 0을 명시하고 검색 query endpoint를 추가하지 않는다', () => {
    const path = openApi.paths['/ops'];
    // C5-a의 「/ops 단일 경로」 가드는 N-25 채택(2026-09-12 §4-17)·C35로 실패/되살리기 2경로까지 확장
    // — C32 consulting-contract 갱신과 같은 선례. 검색 GET·query 계약이 늘지 않는 것은 그대로 지킨다.
    expect(Object.keys(openApi.paths)).toEqual([
      '/ops', '/ops/leads/{id}/fail', '/ops/leads/{id}/resume',
      // 등록 확정 — 미리보기·실제 (C91 · A-05). 검색 GET·query 계약은 여전히 0이다
      '/ops/leads/{id}/enroll/preview', '/ops/leads/{id}/enroll',
      // §67 컴플레인 접수·처리 · 강사 교체 미리보기·실제 (C93 · J-96 · J-97). 검색 GET·query 계약은 그대로 0이다
      '/ops/complaints', '/ops/complaints/{id}', '/ops/teacher-change/preview', '/ops/teacher-change',
      // §60 대표 피드백 — 코멘트·답변·답 고치기 (C53). 검색 GET·query 계약은 그대로 0이다.
      '/ops/marketing/{id}/comments', '/ops/marketing/{id}/replies', '/ops/marketing/feedback/{id}',
      // §65 기획 보고서 — 상세·기한 결재·최종 결재 (C56)
      '/ops/plans/{id}', '/ops/plans/{id}/due', '/ops/plans/{id}/review',
      // §66 회의 상세 — 상세·속기록·할 일 배정 (C57)
      '/ops/meetings/{id}', '/ops/meetings/{id}/minutes', '/ops/meetings/{id}/todos',
    ]);
    expect(Object.keys(path)).toEqual(['get']);
    expect(path.get?.description).toMatch(/name.*school.*ownerName.*reason/);
    expect(path.get?.description).toMatch(/클라이언트.*추가 GET.*0/);
    expect(path.get?.parameters ?? []).toEqual([]);
    expect(path.get?.requestBody).toBeUndefined();
  });

  it.each([
    ['/ops/leads/{id}/fail', 'LeadFailDto'],
    ['/ops/leads/{id}/resume', 'LeadResumeDto'],
  ] as const)('실패 이력 쓰기 %s는 POST 하나·경로 id·%s 본문으로만 계약한다 (N-25 · C35)', (route, dtoName) => {
    const path = openApi.paths[route];
    expect(Object.keys(path)).toEqual(['post']);
    expect((path.post?.parameters ?? []).map((p) => 'name' in p && p.name)).toEqual(['id']);
    const body = path.post?.requestBody;
    if (!body || '$ref' in body) throw new Error(route + ' requestBody 누락');
    expect(JSON.stringify(body.content)).toContain(`#/components/schemas/${dtoName}`);
    expect(path.post?.responses?.['409']).toBeDefined();
  });

  it('비공개 두 비용은 기존 MarketingDto의 optional nullable number이며 응답 권한은 boolean이다', () => {
    const marketing = openApi.components?.schemas?.MarketingDto;
    const ops = openApi.components?.schemas?.OpsDto;
    if (!marketing || '$ref' in marketing || !ops || '$ref' in ops) throw new Error('Ops 비용 schema 누락');
    // 기존 10 + C53 의 6 — channelLabel · itemLabel · title · name · byId · byName
    expect(Object.keys(marketing.properties ?? {})).toHaveLength(16);
    // 낱말은 서버가 만든다 — 화면이 코드를 옮기지 않는다 (D-R18)
    for (const field of ['channelLabel', 'itemLabel', 'name']) {
      expect(marketing.properties?.[field]).toMatchObject({ type: 'string' });
      expect(marketing.required).toContain(field);
    }
    expect(ops.properties?.canComment).toMatchObject({ type: 'boolean' });
    expect(ops.properties?.feedbackNeedsFix).toMatchObject({ type: 'number' });
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
    if (flags.canAdminPage && flags.canCrudAll) expect(all).toHaveBeenCalledWith(1, flags.canMoney, role === 'ceo');
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
      all.mockImplementation((viewerId, canSeeAmounts, canComment) => svc.all(viewerId, canSeeAmounts, canComment));
      user = { id: 1, name: '권한 테스트', role, perms: { canMoney } };

      const res = await request(app.getHttpServer()).get('/ops')
        .timeout({ response: 2000, deadline: 4000 }).expect(200);
      expect(all).toHaveBeenCalledTimes(1);
      expect(all).toHaveBeenCalledWith(1, canMoney, role === 'ceo');
      expect(res.body.canSeeAmounts).toBe(canMoney);
      expect(res.body.marketing).toEqual(samples.map((sample, index) => ({
        id: index + 1, channel: 'naver', item: 'ads', url: null,
        // 모르는 코드값은 코드값 그대로 보인다 — 비어 보이느니 낯설게 보이는 편이 낫다
        channelLabel: '네이버', itemLabel: 'ads', name: '네이버 · ads',
        title: null, byId: null, byName: null,
        ...(sample.result === null ? { impressions: null, clicks: null, inquiries: null } : metrics),
        enrolled: sample.enrolled,
        cost: canMoney ? sample.cost : null,
        costPerEnroll: canMoney ? sample.costPerEnroll : null,
      })));
      expect(res.body.leads).toMatchObject([{ id: 1, name: '상담 계약 테스트' }]);
      expect(Object.keys(res.body).sort()).toEqual(Object.keys(empty).sort());
      // 7 목록 + N-25 도달 기록 + §60 피드백 + §62 기한 (C53·C56) + §23 경고 묶음 1회 (C86-a)
      expect(query).toHaveBeenCalledTimes(11);
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

/**
 * §23 상담 머리 — **화면은 아무것도 세지 않는다** (D-R37 · N-19 의 교훈).
 * 퍼널의 순서·낱말과 「등록 전/후」 경계까지 서버가 갖는다.
 */
describe('§23 상담 머리 (C86-a)', () => {
  const head = (leads: Array<{ stage: string; ownerId?: number | null; ownerName?: string | null }>) => {
    const svc = new OpsService({ query: jest.fn().mockResolvedValue([]) } as never);
    return (svc as unknown as {
      intakeHead: (l: unknown, m: boolean) => Promise<{
        funnel: Array<{ key: string; label: string; count: number; funnel: boolean; sub: string }>;
        enrollRate: number;
        owners: Array<{ id: number | null; name: string; count: number }>;
        alerts: Array<{ key: string; label: string; count: number; amount: number | null }>;
        stops: Array<{ key: string; label: string }>;
      }>;
    }).intakeHead(leads, true);
  };

  it('퍼널은 여섯 칸이고 등록·등록 실패만 결과 칸이다 — 순서와 낱말이 서버에 있다', async () => {
    const out = await head([]);
    expect(out.funnel.map((f) => f.key)).toEqual(['first', 'wait2nd', 'second', 'hold', 'enrolled', 'failed']);
    // 컷 §23 의 여섯째 레인 머리는 「실패」가 아니라 「등록 실패」다
    expect(out.funnel.map((f) => f.label)).toEqual(['1차 상담', '2차 대기', '2차 상담', '보류', '등록', '등록 실패']);
    expect(out.funnel.filter((f) => f.funnel).map((f) => f.key)).toEqual(['first', 'wait2nd', 'second', 'hold']);
  });

  it('등록률은 등록 / 전체다 — 빈 목록이면 0 이고 나눗셈이 터지지 않는다', async () => {
    expect((await head([])).enrollRate).toBe(0);
    const some = await head([
      { stage: 'first' }, { stage: 'first' }, { stage: 'enrolled' },
    ]);
    expect(some.enrollRate).toBe(33);
    expect(some.funnel.find((f) => f.key === 'first')!.count).toBe(2);
  });

  it('담당 칩은 많은 순이고 담당 없는 줄도 이름을 갖는다 (D-R18)', async () => {
    const out = await head([
      { stage: 'first', ownerId: 3, ownerName: '김범준' },
      { stage: 'hold', ownerId: null, ownerName: null },
      { stage: 'first', ownerId: 3, ownerName: '김범준' },
    ]);
    expect(out.owners.map((o) => [o.name, o.count])).toEqual([['김범준', 2], ['담당 없음', 1]]);
  });

  /**
   * §24 의 중단 지점 낱말도 서버가 쥔다 — 같은 화면 안에서 퍼널과 갈래가 다른 표를 들면
   * 한쪽을 고쳤을 때 다른 쪽이 조용히 낡는다 (C86-b).
   */
  it('퍼널 칸마다 **다음에 무엇을 하는지** 한 줄이 따라온다 (§23 · C86-d)', async () => {
    const out = await head([]);
    expect(out.funnel.map((f) => f.sub)).toEqual([
      '2차 일정 + 진단고사 잡기', '예정일에 2차 상담 진행', '보류 · 등록 · 등록 실패 중 선택',
      'D+2에 수락 여부 확인', '해피콜 → 월간 상담', '사유 기록',
    ]);
  });

  it('중단 지점은 깔때기 순 넷이고 낱말이 서버에 있다 — 건수는 싣지 않는다', async () => {
    const out = await head([]);
    expect(out.stops.map((s) => s.key)).toEqual(['before_book', 'before_first', 'after_first', 'after_second']);
    expect(out.stops.map((s) => s.label))
      .toEqual(['상담 예약 전 이탈', '1차 상담 전 이탈', '1차 후 미진행', '2차 후 미등록']);
    // §24 표는 **검색으로 걸러진 행**을 세므로 건수는 화면의 몫이다
    expect(out.stops.every((s) => !('count' in s))).toBe(true);
  });

  it('금액을 못 보는 사람에게는 금액이 null 이고 문장에도 안 실린다 (D-R39)', async () => {
    const svc = new OpsService({ query: jest.fn().mockResolvedValue([
      { key: 'unpaid', n: 6, amount: '4006600' },
      { key: 'noSchedule', n: 9, amount: '0' },
      { key: 'noInvoice', n: 2, amount: '0' },
    ]) } as never);
    const call = (money: boolean) => (svc as unknown as {
      intakeHead: (l: unknown, m: boolean) => Promise<{ alerts: Array<{ key: string; label: string; amount: number | null }> }>;
    }).intakeHead([], money);

    const seen = await call(true);
    expect(seen.alerts.find((a) => a.key === 'unpaid')).toMatchObject({ amount: 4006600 });
    expect(seen.alerts.find((a) => a.key === 'unpaid')!.label).toContain('₩4,006,600');
    expect(seen.alerts.find((a) => a.key === 'noSchedule')!.label).toBe('스케줄 미생성 9');

    const hidden = await call(false);
    expect(hidden.alerts.find((a) => a.key === 'unpaid')).toMatchObject({ amount: null });
    // 가려야 할 값이 문장 안에 남아 있으면 가린 것이 아니다
    expect(hidden.alerts.find((a) => a.key === 'unpaid')!.label).not.toContain('4,006,600');
    expect(hidden.alerts.find((a) => a.key === 'unpaid')!.label).toBe('미수 6명');
  });
});
