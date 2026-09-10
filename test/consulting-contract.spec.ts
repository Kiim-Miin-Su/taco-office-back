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
  const empty = { items: [], canSeeAmounts: false };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ConsultingController],
      providers: [{ provide: ConsultingService, useValue: { all } }, { provide: APP_GUARD, useClass: PermGuard }],
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
  it('기존 stage enum과 클라이언트 필터만 명시하며 새 endpoint/query/input을 만들지 않는다', () => {
    const api = buildOpenApi(app);
    expect(Object.keys(api.paths)).toEqual(['/consulting']);
    const get = api.paths['/consulting'].get;
    expect(get?.description).toMatch(/클라이언트.*추가 GET.*0/);
    expect(get?.parameters ?? []).toEqual([]);
    expect(get?.requestBody).toBeUndefined();
    const schema = api.components?.schemas?.ConsultingDto;
    if (!schema || '$ref' in schema) throw new Error('ConsultingDto 누락');
    expect(schema.properties?.stage).toMatchObject({ enum: ['contract', 'running', 'done'] });
  });
});
