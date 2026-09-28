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
import { Staff } from '../src/entities';
import { AuthService } from '../src/auth/auth.service';
import { JwtStrategy, type JwtPayload } from '../src/auth/jwt.strategy';
import { PERM_KEY, PermGuard, ROLES, canCeoApprovePlan, canCeoComment, permsOf, type RequestUser, type Role } from '../src/common/perm';
import { OpsController } from '../src/modules/ops/ops.controller';
import { LeadDto, type OpsDto } from '../src/modules/ops/ops.dto';
import { OpsService } from '../src/modules/ops/ops.service';
import { makeOpsService } from './ops-svc';
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
  return { svc: makeOpsService({ query }), query };
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
      // C90: 옛 건은 유입 경로 NULL(보정 0) · 끝난 결과라 다음 단계 없음 · 접촉 없음 → 칩 없음
      source: null, sourceLabel: null, nextStages: [], touches: [], lastTouchAt: null, nextOn: null, nextLabel: null, nextTone: null,
      // DQ1: 최신 진단은 같은 SELECT 의 LATERAL 로 붙는다(왕복 수 그대로) — 적은 적이 없으면 null
      latestDiag: null,
      // wave 3 (23-10 · 23-12 · 24-04~06) — 옛 실패 건: 도달 기록이 없어 실패일·재연락·단계 기한을 **짓지 않는다**(N-25) · 학년·사유 분류 NULL
      grade: null, reasonKind: null, reasonKindLabel: null, failedAt: null, recontact: null, stageDue: null,
      // wave 3 (23-15 · 23-16) — 배치안 초안 · 2차/진단 일정은 같은 SELECT 의 JSON 칸(왕복 수 그대로) · 적은 적이 없으면 [] · 보류가 아니면 재확인 날짜 null
      plan: [], appts: [], recheckOn: null,
      // wave 5 (23-18) — 등록 카드의 사후 관리 줄은 등록 건에만 선다. 실패 건은 null
      aftercare: null,
      // wave 6 (23-11) — 「등록 수업」 줄도 등록 건에만(같은 SELECT 의 JSON 칸 · 왕복 수 그대로) · (23-14) 실패 카드의 단추 줄은 서버 표 그대로
      lessons: null,
      cardActions: [{ key: 'detail', label: '내역 · 상태', to: null }, { key: 'resume', label: '되살리기', to: null }],
      // W11 · N-87 — §24 중단 지점은 실패 당시 단계에서 읽는다: 명시값도 도달 기록도 없는 옛 실패는 「미분류」(대응표 이관 없음) ·
      // 옛 중단 지점은 읽기 전용 낱말로 곁에 선다
      failStopKey: 'none', failStopLabel: '미분류', stopAtLabel: '2차 후 미등록',
    }]);
    // 7 고정 목록 + 접촉 원장 1회(lead_id = ANY — 건마다 묻지 않는다 · C90) + 명시값 없는 failed 건이 있을 때만 도달 기록 판정 1회 (N-25 · C35)
    // + §60 대표 피드백 글타래 1회 (C53) + §62 기획 기한 1회 (C56)
    // + §23 경고 셋을 **한 문장으로 묶은** 1회 (C86-a — 따로 물으면 왕복이 셋 는다) + 도달 기록 시작일 1회 (C90 · funnelSince)
    // + C96 갈래 칩 둘 — 컴플레인 영역·회의 종류를 **서버가 센다**(D-R37). 화면이 목록을 다시 세지 않는다
    expect(query).toHaveBeenCalledTimes(15);
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
    const { svc } = service([row({ created_at: createdAt, failed_at: '2026-09-09T15:20:00+09:00' })]);
    const [lead] = (await svc.all(1, false, false)).leads;
    // 경과일은 여전히 접수일에서 센다 — 실패한 날로 바꿔 세지 않는다
    expect(lead).toMatchObject({ createdAt, ageDays });
    // wave 3 (24-04) — 실패한 날은 도달 기록의 「등록 실패」 줄에서 **날짜만** 내려간다. 날 열(raw)은 새지 않는다
    expect(lead.failedAt).toBe('2026-09-09');
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
    // W8 — 첫 설정 잠금도 현재 STAFF 에서 투영한다(Me 는 늘 싣고 · 요청 사용자는 가드가 읽는다). 잠기지 않은 계정은 false
    expect(me).toEqual({ id: 17, name: '권한 검수', title: null, role, roleLabel: roleLabel(role), ...expected, mustChangeCredentials: false });
    expect(user).toEqual({ id: 17, name: '권한 검수', role, perms: payload.perms, mustChange: false });
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
    // C96 — 기간·갈래는 **서버가 말한다**(D-R18·D-R37). 빈 응답도 그 모양을 갖춰야 계약이다
    range: { from: null, to: null, label: '전체' },
    areaCounts: [], mtTypeCounts: [], todoOwnerCounts: [], todoDoneOwnerCounts: [], mtTypes: [],
    canCreateMeeting: false, canCreatePlan: false,
    // w5 — 탭 동그라미·§63 머리 칩의 수도 서버가 센다 (C-4 · 67-2 · 63-5 · 63-6)
    cplOverdue: 0, planPending: 0, mtMyWaiting: 0, mtMinutesCount: 0,
    // W11 · N-96 회의 탭 동그라미(지난 회의 중 속기록 빈 수) · N-72 공개 범위 두 값의 낱말 — 서버가 센다/준다
    mtNeedsMinutes: 0, planShares: [],
    // x5 — §59 「+ 오늘 한 것」 폼 낱말·단추와 필터 띠·범례의 수도 서버가 준다 (59-3 · 59-4 · 59-5)
    mktChannels: [], mktItems: [], canCreateMarketing: false,
    mktChannelCounts: [], mktByCounts: [], mktItemCounts: [], mktDays: 0,
    // wave 6 — §67 문의자 관계 낱말도 서버가 준다 (67-5)
    cplRequesters: [],
    intakeHead: { funnel: [], enrollRate: 0, owners: [], alerts: [], stops: [], sources: [], touchKinds: [], followUpSoon: 0, funnelSince: null, failReasons: [] },
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
      'all', 'createLead', 'patchLead', 'moveLeadStage', 'addLeadTouch', 'failLead', 'resumeLead', 'comment', 'reply', 'editPost',
      'planDetail', 'decidePlanDue', 'reviewPlan',
      'sendMeetingNotice', 'writeMinutes', 'assignMeetingTask',
      'createComplaint', 'patchComplaint', 'teacherChangePreview', 'teacherChange',
    ] as const) {
      expect(app.get(Reflector).get(PERM_KEY, OpsController.prototype[handler])).toEqual(['canAdminPage', 'canCrudAll']);
    }
  });

  it('회의 상세 · 참석 응답은 역할 가드가 없다 — 참석자 본인(강사 포함)이 여는 곳이고 거르기는 서비스가 한다 (W11 · N-32)', () => {
    for (const handler of ['meetingDetail', 'respondMeeting'] as const) {
      expect(app.get(Reflector).get(PERM_KEY, OpsController.prototype[handler])).toBeUndefined();
    }
  });

  it('실제 OpenAPI에 FQ 네 문자열의 원문·nullable 계약을 38필드로 명시한다 (11 + N-25 실패 이력 3 + C90 유입·접촉·다음 단계 8 + DQ1 최신 진단 1 + wave 3 여섯 + 배치안·일정·재확인 셋 + wave 5 사후 관리 줄 + wave 6 등록 수업 · 카드 단추 줄 + W11 N-87 중단 지점 셋)', () => {
    const schema = openApi.components?.schemas?.LeadDto;
    if (!schema || '$ref' in schema) throw new Error('LeadDto schema 누락');
    expect(Object.keys(schema.properties ?? {})).toHaveLength(38);
    // W11 · N-87 — 중단 지점 키 · 낱말(실패 건만) · 옛 중단 지점 낱말(읽기 전용)은 더해진 칸이고 선택이다(기존 소비자를 깨지 않는다)
    for (const field of ['failStopKey', 'failStopLabel', 'stopAtLabel']) {
      expect(schema.required ?? []).not.toContain(field);
      expect(schema.properties?.[field]).toMatchObject({ type: 'string', nullable: true });
    }
    // wave 3 — 학년 · 사유 분류 · 실패일 · 재연락 · 단계 기한은 더해진 칸이고 옛 건은 null 이다(선택 · 기존 소비자를 깨지 않는다) · wave 5 사후 관리 줄 · wave 6 등록 수업 · 단추 줄도 같다
    for (const field of ['grade', 'reasonKind', 'reasonKindLabel', 'failedAt', 'recontact', 'stageDue', 'plan', 'appts', 'recheckOn', 'aftercare', 'lessons', 'cardActions']) {
      expect(schema.required ?? []).not.toContain(field);
    }
    // DQ1 — 최신 진단 한 줄은 더해진 칸이고 없으면 null 이다(선택 · 기존 소비자를 깨지 않는다)
    expect(schema.required).not.toContain('latestDiag');
    // C90 — 판정·낱말은 서버 (D-R18 · D-R37): 다음 단계 목록과 접촉 원장은 필수 배열, 칩 한 줄과 색은 nullable
    expect(schema.required).toEqual(expect.arrayContaining(['nextStages', 'touches']));
    for (const field of ['source', 'sourceLabel', 'lastTouchAt', 'nextOn', 'nextLabel', 'nextTone']) {
      expect(schema.properties?.[field]).toMatchObject({ type: 'string', nullable: true });
      expect(schema.required).not.toContain(field);
    }
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
      '/ops',
      // 「+ 회의 잡기」 · 「+ 기획 올리기」 (C96 · N-46 ②③). 검색 GET·query 계약은 여전히 0이다
      '/ops/meetings', '/ops/plans',
      // 「+ 신규 문의」 · 단계 이동 · 접촉 기록 (C90 · N-45 · N-44). 검색 GET·query 계약은 여전히 0이다
      '/ops/leads', '/ops/leads/{id}', '/ops/leads/{id}/stage', '/ops/leads/{id}/touches',
      '/ops/leads/{id}/fail', '/ops/leads/{id}/resume',
      // 등록 확정 — 미리보기·실제 (C91 · A-05). 검색 GET·query 계약은 여전히 0이다
      '/ops/leads/{id}/enroll/preview', '/ops/leads/{id}/enroll',
      // §67 컴플레인 접수·처리 · 강사 교체 미리보기·실제 (C93 · J-96 · J-97). 검색 GET·query 계약은 그대로 0이다
      '/ops/complaints', '/ops/complaints/{id}', '/ops/teacher-change/preview', '/ops/teacher-change',
      // §60 대표 피드백 — 코멘트·답변·답 고치기 (C53). 검색 GET·query 계약은 그대로 0이다.
      // §59 「+ 오늘 한 것」·활동 수정 (x5 · 59-3) — 쓰기 경로다. 검색 GET·query 계약은 여전히 0이다
      '/ops/marketing', '/ops/marketing/{id}',
      '/ops/marketing/{id}/comments', '/ops/marketing/{id}/replies', '/ops/marketing/feedback/{id}',
      // §65 기획 보고서 — 상세·본문/담당 고치기·단계 이동·기한 결재·최종 결재 (C56 · S6)
      // 늘어난 둘은 **결재까지 가는 길**이지 검색이 아니다 — stage='review' 로 가는 길이 없어
      // §69 「결재 대기」 배지가 구조적으로 0 이었고, research 를 쓰는 API 도 없었다 (전수 검수 §5).
      '/ops/plans/{id}', '/ops/plans/{id}/owner',
      // 관리자 건의 답변 — 기존 `/ops` 읽기 모델 한 줄을 갱신한다. 별도 검색 GET은 만들지 않는다.
      '/ops/suggestions/{id}/reply',
      '/ops/plans/{id}/stage', '/ops/plans/{id}/due', '/ops/plans/{id}/review',
      // §65 「+ 대표 지시」 (w5 · 65-4) — 과제(TODO) 한 줄을 쓰는 길이지 검색이 아니다
      '/ops/plans/{id}/tasks',
      // §66 회의 상세 — 상세·속기록·할 일 배정 (C57)
      '/ops/meetings/{id}',
      // 「안내 보내기」 · 본인 참석 응답 (W11 · N-32) — 쓰기 경로다. 검색 GET·query 계약은 여전히 0이다
      '/ops/meetings/{id}/notice', '/ops/meetings/{id}/attend',
      '/ops/meetings/{id}/minutes', '/ops/meetings/{id}/todos',
    ]);
    expect(Object.keys(path)).toEqual(['get']);
    expect(path.get?.description).toMatch(/name.*school.*ownerName.*reason/);
    expect(path.get?.description).toMatch(/클라이언트.*추가 GET.*0/);
    /*
     * C96 — `/ops` 가 query 를 **셋** 받는다(`from`·`to`·`area`). 이 가드가 지키던 것은
     * 「**검색**을 서버로 보내지 않는다」이지 「query 가 0 이다」가 아니다 — §24 FQ 는 받은 목록에서 거르고,
     * 기간·갈래는 **무엇을 받을지**를 정한다(J-102 「지난달 컴플레인만」). 세는 일도 거기 딸려 서버가 한다(D-R37).
     * 그래서 이름을 못 박아 둔다 — 자유 문자열 검색 인자가 하나라도 늘면 여기서 걸린다.
     */
    expect((path.get?.parameters ?? []).map((prm) => (prm as { name: string }).name))
      .toEqual(['from', 'to', 'area']);
    expect((path.get?.parameters ?? []).every((prm) => (prm as { required?: boolean }).required !== true)).toBe(true);
    expect(path.get?.requestBody).toBeUndefined();
  });

  it.each([
    ['/ops/leads/{id}/fail', 'LeadFailDto'],
    ['/ops/leads/{id}/resume', 'LeadResumeDto'],
    ['/ops/leads/{id}/touches', 'LeadTouchWriteDto'],
  ] as const)('상담 쓰기 %s는 POST 하나·경로 id·%s 본문으로만 계약한다 (N-25 · C35 · C90)', (route, dtoName) => {
    const path = openApi.paths[route];
    expect(Object.keys(path)).toEqual(['post']);
    expect((path.post?.parameters ?? []).map((p) => 'name' in p && p.name)).toEqual(['id']);
    const body = path.post?.requestBody;
    if (!body || '$ref' in body) throw new Error(route + ' requestBody 누락');
    expect(JSON.stringify(body.content)).toContain(`#/components/schemas/${dtoName}`);
    expect(path.post?.responses?.['409']).toBeDefined();
  });

  it('A-08 실패 DTO는 재연락일을 선택값으로 공개하고 접촉 원장의 날짜 계약을 그대로 쓴다', () => {
    const fail = openApi.components?.schemas?.LeadFailDto;
    const touch = openApi.components?.schemas?.LeadTouchWriteDto;
    if (!fail || '$ref' in fail || !touch || '$ref' in touch) throw new Error('상담 실패/접촉 DTO schema 누락');
    expect(Object.keys(fail.properties ?? {})).toEqual(['reason', 'reasonKind', 'nextOn']);
    expect(fail.required ?? []).not.toContain('nextOn');
    expect(fail.properties?.nextOn).toMatchObject({ type: 'string', format: 'date', nullable: true });
    expect(touch.properties?.nextOn).toMatchObject({ type: 'string', format: 'date', nullable: true });
  });

  it('「+ 신규 문의」는 POST /ops/leads 에 LeadCreateDto(단계 없음 · 유입 경로 필수), 단계 이동은 PATCH …/stage 에 LeadStageMoveDto 하나다 (C90 · N-45 · N-44)', () => {
    const create = openApi.paths['/ops/leads'];
    expect(Object.keys(create)).toEqual(['post']);
    expect(JSON.stringify(create.post?.requestBody)).toContain('#/components/schemas/LeadCreateDto');
    const createDto = openApi.components?.schemas?.LeadCreateDto;
    if (!createDto || '$ref' in createDto) throw new Error('LeadCreateDto schema 누락');
    // wave 3 (23-10) — 학년은 더해진 선택 칸이다(필수 둘은 그대로)
    expect(Object.keys(createDto.properties ?? {})).toEqual(['name', 'school', 'source', 'ownerId', 'note', 'grade']);
    expect(createDto.required).toEqual(['name', 'source']);
    expect(createDto.properties?.source).toMatchObject({ enum: ['kakao', 'phone', 'blog', 'instagram', 'referral', 'walkin'] });
    const move = openApi.paths['/ops/leads/{id}/stage'];
    expect(Object.keys(move)).toEqual(['patch']);
    expect((move.patch?.parameters ?? []).map((p) => 'name' in p && p.name)).toEqual(['id']);
    expect(JSON.stringify(move.patch?.requestBody)).toContain('#/components/schemas/LeadStageMoveDto');
    const moveDto = openApi.components?.schemas?.LeadStageMoveDto;
    if (!moveDto || '$ref' in moveDto) throw new Error('LeadStageMoveDto schema 누락');
    expect(Object.keys(moveDto.properties ?? {})).toEqual(['to']);
    // 깔때기 안 넷만 — 등록·등록 실패는 각자의 길이다
    expect(moveDto.properties?.to).toMatchObject({ enum: ['first', 'wait2nd', 'second', 'hold'] });
    expect(move.patch?.responses?.['409']).toBeDefined();
  });

  it('비공개 두 비용은 기존 MarketingDto의 optional nullable number이며 응답 권한은 boolean이다', () => {
    const marketing = openApi.components?.schemas?.MarketingDto;
    const ops = openApi.components?.schemas?.OpsDto;
    if (!marketing || '$ref' in marketing || !ops || '$ref' in ops) throw new Error('Ops 비용 schema 누락');
    // 기존 10 + C53 의 6 — channelLabel · itemLabel · title · name · byId · byName + x5 의 1 — onDate(§59 「+ 오늘 한 것」 응답·기간)
    // + W11 N-29 ② 의 1 — memo(카드 제목 아래 한 줄 · 선택 · 옛 행 null)
    expect(Object.keys(marketing.properties ?? {})).toHaveLength(18);
    expect(marketing.required ?? []).not.toContain('memo');
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
    // 네 번째는 기간·갈래다 — 아무것도 안 보내면 빈 객체 (C96)
    // 셋째는 **코멘트 권한**이다. `role === 'ceo'` 를 박아 두면 그 판정이 움직일 때(대표 결정
    // 2026-09-21) 이 줄이 무엇을 지키던 것인지 알 수 없다 — 컨트롤러가 **그 selector 에 위임하는지**를 센다
    // 다섯째는 **기획 결재권자**다 — 지정 공개 기획이 보이는 셋 중 하나(W11 · N-72). 같은 이유로 selector 에 위임하는지를 센다
    if (flags.canAdminPage && flags.canCrudAll) expect(all).toHaveBeenCalledWith(1, flags.canMoney, canCeoComment(role), {}, canCeoApprovePlan(role));
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
      expect(all).toHaveBeenCalledWith(1, canMoney, canCeoComment(role), {}, canCeoApprovePlan(role));
      expect(res.body.canSeeAmounts).toBe(canMoney);
      expect(res.body.marketing).toEqual(samples.map((sample, index) => ({
        id: index + 1, channel: 'naver', item: 'ads', url: null,
        // 모르는 코드값은 코드값 그대로 보인다 — 비어 보이느니 낯설게 보이는 편이 낫다
        channelLabel: '네이버', itemLabel: 'ads', name: '네이버 · ads',
        // 한 날 — 대역 행에 on_date 칸이 없어 null (x5 · 목록과 「+ 오늘 한 것」 응답이 같은 변환)
        // 메모 한 줄(W11 · N-29 ②) — 대역 행에 memo 칸이 없어 null(적은 적이 없다)
        title: null, memo: null, onDate: null, byId: null, byName: null,
        ...(sample.result === null ? { impressions: null, clicks: null, inquiries: null } : metrics),
        enrolled: sample.enrolled,
        cost: canMoney ? sample.cost : null,
        costPerEnroll: canMoney ? sample.costPerEnroll : null,
      })));
      expect(res.body.leads).toMatchObject([{ id: 1, name: '상담 계약 테스트' }]);
      expect(Object.keys(res.body).sort()).toEqual(Object.keys(empty).sort());
      // 7 목록 + 접촉 원장 1회 (C90) + N-25 도달 기록 + §60 피드백 + §62 기한 (C53·C56) + §23 경고 묶음 1회 (C86-a) + 도달 기록 시작일 1회 (C90)
      // + C96 갈래 칩 둘 — 컴플레인 영역·회의 종류를 **서버가 센다**(D-R37). 화면이 목록을 다시 세지 않는다
    expect(query).toHaveBeenCalledTimes(15);
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
  type Touch = { kind: string; nextOn: string | null };
  const head = (leads: Array<{ stage: string; ownerId?: number | null; ownerName?: string | null; source?: string | null; touches?: Touch[] }>) => {
    const svc = makeOpsService({ query: jest.fn().mockResolvedValue([]) });
    return (svc as unknown as {
      intakeHead: (l: unknown, m: boolean, today?: string) => Promise<{
        funnel: Array<{ key: string; label: string; count: number; funnel: boolean; sub: string }>;
        enrollRate: number;
        owners: Array<{ id: number | null; name: string; count: number }>;
        alerts: Array<{ key: string; label: string; count: number; amount: number | null }>;
        stops: Array<{ key: string; label: string }>;
        sources: Array<{ key: string; label: string; count: number }>;
        touchKinds: Array<{ key: string; label: string }>;
        followUpSoon: number;
        funnelSince: string | null;
      }>;
    }).intakeHead(leads, true, '2026-09-18');
  };

  it('유입 경로 칩은 여섯이 어휘라 0 이어도 서고, 「경로 없음」은 옛 건이 있을 때만 붙는다 (C90 · N-44 · N-25 보정 0)', async () => {
    const none = await head([{ stage: 'first', source: 'kakao' }]);
    expect(none.sources.map((s) => [s.key, s.count])).toEqual([['kakao', 1], ['phone', 0], ['blog', 0], ['instagram', 0], ['referral', 0], ['walkin', 0]]);
    expect(none.sources.map((s) => s.label)).toEqual(['카카오채널', '전화', '블로그', '인스타그램', '소개', '워크인']);
    const legacy = await head([{ stage: 'first', source: 'kakao' }, { stage: 'hold', source: null }, { stage: 'failed' }]);
    expect(legacy.sources.at(-1)).toEqual({ key: 'none', label: '경로 없음', count: 2 });
    expect(legacy.touchKinds.map((k) => k.key)).toEqual(['call', 'kakao', 'sms', 'visit', 'book', 'noshow', 'memo']);
  });

  it('「상담 오늘·지남」·「사후 관리 밀림」·「임박」은 마지막 접촉의 다음 예정일로 센다 — 실패 건은 재촉하지 않는다 (C90 · N-44)', async () => {
    const out = await head([
      { stage: 'wait2nd', touches: [{ kind: 'book', nextOn: '2026-09-18' }] },            // 상담 오늘
      { stage: 'wait2nd', touches: [{ kind: 'book', nextOn: '2026-09-16' }] },            // 상담 2일 지남
      { stage: 'enrolled', touches: [{ kind: 'call', nextOn: '2026-09-15' }] },           // 사후 관리 3일 밀림 (등록 건도 센다)
      { stage: 'first', touches: [{ kind: 'kakao', nextOn: '2026-09-20' }] },             // 사후 관리 D-2 (임박)
      { stage: 'first', touches: [{ kind: 'memo', nextOn: '2026-09-18' }] },              // 사후 관리 오늘 (임박)
      { stage: 'first', touches: [{ kind: 'sms', nextOn: '2026-09-25' }] },               // 아직 멀다
      { stage: 'failed', touches: [{ kind: 'book', nextOn: '2026-09-10' }] },             // 끝난 결과 — 세지 않는다
      { stage: 'hold', touches: [{ kind: 'memo', nextOn: null }, { kind: 'book', nextOn: '2026-09-10' }] }, // 마지막 접촉에 날짜가 없다
    ]);
    const at = (key: string) => out.alerts.find((a) => a.key === key)!;
    expect([at('consultDue').label, at('consultDue').count]).toEqual(['상담 오늘·지남 2', 2]);
    expect([at('followUpLate').label, at('followUpLate').count]).toEqual(['사후 관리 밀림 1', 1]);
    expect(out.followUpSoon).toBe(2);
    // 차례는 원본 §23 경고 줄 그대로 (wave3 23-08)
    expect(out.alerts.map((a) => a.key)).toEqual(['consultDue', 'followUpLate', 'unpaid', 'noSchedule', 'noInvoice']);
  });

  it('퍼널은 여섯 칸이고 등록·등록 실패만 결과 칸이다 — 순서와 낱말이 서버에 있다', async () => {
    const out = await head([]);
    expect(out.funnel.map((f) => f.key)).toEqual(['first', 'wait2nd', 'second', 'hold', 'enrolled', 'failed']);
    // 컷 §23 의 여섯째 레인 머리는 「실패」가 아니라 「등록 실패」다
    expect(out.funnel.map((f) => f.label)).toEqual(['1차 상담', '2차 대기', '2차 상담', '보류', '등록', '등록 실패']);
    expect(out.funnel.filter((f) => f.funnel).map((f) => f.key)).toEqual(['first', 'wait2nd', 'second', 'hold']);
  });

  it('등록률은 등록 / (등록 + 등록 실패)다 — 원본 §23 「등록 3 · 실패 6 · 33%」 · 진행 중인 건은 분모에 넣지 않는다 · 끝난 건이 없으면 0 (23-19)', async () => {
    expect((await head([])).enrollRate).toBe(0);
    // 원본 §23 의 퍼널 그대로 — 1차 4 · 2차 대기 2 · 2차 상담 1 · 보류 2 · 등록 3 · 등록 실패 6 (전체 18)
    const cut = await head([
      ...Array.from({ length: 4 }, () => ({ stage: 'first' })), ...Array.from({ length: 2 }, () => ({ stage: 'wait2nd' })),
      { stage: 'second' }, ...Array.from({ length: 2 }, () => ({ stage: 'hold' })),
      ...Array.from({ length: 3 }, () => ({ stage: 'enrolled' })), ...Array.from({ length: 6 }, () => ({ stage: 'failed' })),
    ]);
    expect(cut.enrollRate).toBe(33);
    // 진행 중인 건만 있으면 아직 결과가 없다 — 실패처럼 세지 않는다
    const open = await head([{ stage: 'first' }, { stage: 'first' }, { stage: 'enrolled' }]);
    expect(open.enrollRate).toBe(100);
    expect(open.funnel.find((f) => f.key === 'first')!.count).toBe(2);
    expect((await head([{ stage: 'first' }, { stage: 'hold' }])).enrollRate).toBe(0);
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

  it('중단 지점은 깔때기 순 넷이고 낱말이 서버에 있다 — 건수는 싣지 않는다 (W11 · N-87 원문 넷 · 실패 당시 단계가 키)', async () => {
    const out = await head([]);
    expect(out.stops.map((s) => s.key)).toEqual(['first', 'wait2nd', 'second', 'hold']);
    expect(out.stops.map((s) => s.label))
      .toEqual(['1차 상담 중단', '2차 안 옴', '2차 상담 중단', '보류 후 무산']);
    // §24 표는 **검색으로 걸러진 행**을 세므로 건수는 화면의 몫이다
    expect(out.stops.every((s) => !('count' in s))).toBe(true);
  });

  it('금액을 못 보는 사람에게는 금액이 null 이고 문장에도 안 실린다 (D-R39)', async () => {
    const svc = makeOpsService({ query: jest.fn().mockResolvedValue([
      { key: 'unpaid', n: 6, amount: '4006600' },
      { key: 'noSchedule', n: 9, amount: '0' },
      { key: 'noInvoice', n: 2, amount: '0' },
    ]) });
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
