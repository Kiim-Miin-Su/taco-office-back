/** @file-guide
 * 목적: consulting-contract.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/** 실제 controller/PermGuard/OpenAPI 검사. 인증 사용자와 service는 대역이다. */
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { PERM_KEY, PermGuard, ROLES, permsOf, type RequestUser } from '../src/common/perm';
import { ConsultingController } from '../src/modules/consulting/consulting.controller';
import { ConsultingService } from '../src/modules/consulting/consulting.service';
import { buildOpenApi } from '../src/openapi';

describe('§26 단계 필터 조회 계약', () => {
  let app: INestApplication;
  let user: RequestUser | undefined;
  const all = jest.fn();
  const accounting = jest.fn();
  const addPayment = jest.fn();
  const toInvoice = jest.fn();
  const students = jest.fn();
  const empty = { items: [], canSeeAmounts: false };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ConsultingController],
      providers: [{ provide: ConsultingService, useValue: { all, accounting, addPayment, toInvoice, students } }, { provide: APP_GUARD, useClass: PermGuard }],
    }).compile();
    app = module.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => { req.user = user; next(); });
    await app.listen(0, '127.0.0.1');
  });
  beforeEach(() => { user = undefined; all.mockReset().mockResolvedValue(empty); });
  afterAll(async () => { await app?.close(); });

  it('페이지와 같은 최종 두 flag를 요구한다', () => {
    expect(app.get(Reflector).get(PERM_KEY, ConsultingController.prototype.all)).toEqual(['canAdminPage', 'canCrudAll']);
  });
  const overrides = [true, false, null, undefined] as const;
  const cases = ROLES.flatMap((role) => overrides.flatMap((canAdminPage) => overrides.map((canCrudAll) => ({ role, canAdminPage, canCrudAll }))));
  it.each(cases)('$role / canAdminPage=$canAdminPage / canCrudAll=$canCrudAll', async ({ role, canAdminPage, canCrudAll }) => {
    user = { id: 17, name: '계약 검수', role, perms: { canAdminPage, canCrudAll } };
    const flags = permsOf(role, user.perms);
    const allowed = flags.canAdminPage && flags.canCrudAll;
    const res = await request(app.getHttpServer()).get('/consulting').timeout({ response: 2000, deadline: 4000 }).expect(allowed ? 200 : 403);
    if (allowed) {
      expect(res.body).toEqual(empty);
      expect(all).toHaveBeenCalledTimes(1);
      expect(all).toHaveBeenCalledWith(17, flags.canMoney, flags.canHide);
    } else expect(all).not.toHaveBeenCalled();
  });
  it('인증 사용자가 없으면 조회를 실행하지 않는다', async () => {
    await request(app.getHttpServer()).get('/consulting').expect(403);
    expect(all).not.toHaveBeenCalled();
  });
  it('조회는 GET 셋·쓰기는 셋 — 그 밖의 endpoint 를 만들지 않는다 (47D-B)', () => {
    const api = buildOpenApi(app);
    // C5-a 의 「추가 endpoint 0」 가드는 N-18 채택(2026-09-12 §4-17)·47D-B 로 항목 토글 1개까지 늘었고,
    // C58 에서 §28 회계 화면(읽기 1 · 원문 동작 둘), C59 에서 §27 학생별(읽기 1)이 더 붙었다.
    // 「이력」 탭은 endpoint 를 늘리지 않는다 — 이미 받은 items 를 stage 로 거르는 화면 선택이다 (C5-a 선례).
    expect(Object.keys(api.paths)).toEqual([
      '/consulting', '/consulting/{id}/items/{itemId}',
      '/consulting/accounting', '/consulting/students',
      '/consulting/{id}/payments', '/consulting/{id}/invoice',
    ]);
    const patch = api.paths['/consulting/{id}/items/{itemId}'].patch;
    expect(patch?.description).toMatch(/진행률 숫자는 저장하지 않는다/);
    const get = api.paths['/consulting'].get;
    expect(get?.description).toMatch(/클라이언트.*추가 GET.*0/);
    expect(get?.parameters ?? []).toEqual([]);
    expect(get?.requestBody).toBeUndefined();
    const schema = api.components?.schemas?.ConsultingDto;
    if (!schema || '$ref' in schema) throw new Error('ConsultingDto 누락');
    expect(schema.properties?.stage).toMatchObject({ enum: ['contract', 'running', 'done'] });
  });

  it('§28 회계는 뺄셈을 서버가 한다고 계약에 적어 둔다 (D-R37)', () => {
    const api = buildOpenApi(app);
    const get = api.paths['/consulting/accounting'].get;
    expect(get?.description).toMatch(/서버가 뺀다/);
    expect(get?.parameters ?? []).toEqual([]);
    const post = api.paths['/consulting/{id}/invoice'].post;
    expect(post?.description).toMatch(/남은 돈으로/);
    const schema = api.components?.schemas?.ConsAccountRowDto;
    if (!schema || '$ref' in schema) throw new Error('ConsAccountRowDto 누락');
    // 남음은 서버가 내려보내는 값이다 — 화면이 만들 칸이 아니다
    expect(schema.properties?.due).toBeDefined();
    expect(schema.properties?.canInvoice).toBeDefined();
  });

  it('금액이 오가는 쓰기 둘은 canMoney 까지 요구한다', () => {
    const r = app.get(Reflector);
    expect(r.get(PERM_KEY, ConsultingController.prototype.accounting)).toEqual(['canAdminPage', 'canCrudAll']);
    expect(r.get(PERM_KEY, ConsultingController.prototype.addPayment)).toEqual(['canAdminPage', 'canCrudAll', 'canMoney']);
    expect(r.get(PERM_KEY, ConsultingController.prototype.toInvoice)).toEqual(['canAdminPage', 'canCrudAll', 'canMoney']);
  });

  it('§27 은 원문 규칙 줄을 계약에 그대로 적어 둔다 — 보이는 것만 집계한다', () => {
    const api = buildOpenApi(app);
    const get = api.paths['/consulting/students'].get;
    expect(get?.description).toMatch(/csCan\(\) 으로 볼 수 있는 것만 집계/);
    expect(get?.parameters ?? []).toEqual([]);
    const schema = api.components?.schemas?.ConsStudentCaseDto;
    if (!schema || '$ref' in schema) throw new Error('ConsStudentCaseDto 누락');
    // 세는 것은 서버다 — 화면이 배열 길이를 세지 않게 숫자를 내려보낸다 (D-R37)
    for (const k of ['sessionsLogged', 'itemsDone', 'itemsTotal']) expect(schema.properties?.[k]).toBeDefined();
  });
});
