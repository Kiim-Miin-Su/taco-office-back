/** @file-guide
 * 목적: 실제 HTTP 성공/오류 형식과 OpenAPI 응답/인증 계약의 회귀.
 * 책임/재사용: 실제 controller·공용 filter·Swagger builder를 재사용하며 service만 격리한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { ArgumentsHost, BadRequestException, INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ApiCreatedResponse } from '@nestjs/swagger';
import request from 'supertest';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { HealthController } from '../src/health.controller';
import { DrawerController } from '../src/modules/drawer/drawer.controller';
import { DrawerService } from '../src/modules/drawer/drawer.service';
import { ScheduleController } from '../src/modules/schedule/schedule.controller';
import { ScheduleService } from '../src/modules/schedule/schedule.service';
import { ReportsController } from '../src/modules/reports/reports.controller';
import { buildOpenApi } from '../src/openapi';
import { ApiErrorFilter } from '../src/common/filters/api-error.filter';

describe('HTTP ↔ OpenAPI 형식 (DB/업무 정책 검증과 별도)', () => {
  // Derive the metadata key through the public decorator; do not import package-private paths.
  class MetadataProbe { action() {} }
  ApiCreatedResponse({ description: 'probe' })(MetadataProbe.prototype, 'action', Object.getOwnPropertyDescriptor(MetadataProbe.prototype, 'action')!);
  const responseKey = Reflect.getMetadataKeys(MetadataProbe.prototype.action).find(key =>
    Reflect.getMetadata(key, MetadataProbe.prototype.action)?.['201']?.description === 'probe');
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthController, HealthController, DrawerController],
      providers: [
        { provide: AuthService, useValue: {
          login: jest.fn().mockResolvedValue({ accessToken: 'test-access', refreshToken: 'test-refresh', user: {} }),
          refresh: jest.fn().mockResolvedValue({ accessToken: 'test-access' }),
        } },
        { provide: DrawerService, useValue: {} },
        { provide: ScheduleService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app?.close(); });

  it.each(['/auth/login', '/auth/refresh'])('%s 실제 201과 계약 상태가 같다', async path => {
    const res = await request(app.getHttpServer()).post(path).send({ email: 'test@example.com', password: 'test-password' }).expect(201);
    const response = buildOpenApi(app).paths[path].post?.responses;
    expect(response?.['201']).toBeDefined();
    expect(response?.['200']).toBeUndefined();
    expect(res.body.accessToken).toBe('test-access');
  });
  it('logout은 실제 204/본문 없음과 같은 계약을 사용한다', async () => {
    await request(app.getHttpServer()).post('/auth/logout').expect(204).expect('');
    const responses = buildOpenApi(app).paths['/auth/logout'].post?.responses;
    expect(responses?.['204']).toBeDefined();
    expect(responses?.['201']).toBeUndefined();
  });
  it.each([AuthController, ScheduleController, ReportsController])('%p Swagger 성공 코드가 HTTP method 기본값과 같다', controller => {
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const method = controller.prototype[name as keyof typeof controller.prototype];
      if (typeof method !== 'function' || name === 'logout') continue;
      const verb = Reflect.getMetadata(METHOD_METADATA, method);
      if (verb === undefined) continue;
      const responses = Reflect.getMetadata(responseKey, method);
      expect({ name, status: Object.keys(responses ?? {}).filter(k => /^2/.test(k)) }).toEqual({ name, status: [verb === RequestMethod.POST ? '201' : '200'] });
    }
  });
  it('health와 서랍 수정 2개가 공용 성공 DTO를 참조한다', async () => {
    await request(app.getHttpServer()).get('/health').expect(200).expect({ ok: true });
    const doc = buildOpenApi(app);
    for (const [path, method] of [['/health', 'get'], ['/drawer/todos/{id}', 'patch'], ['/drawer/notis/{id}/read', 'patch']] as const) {
      expect(doc.paths[path][method]?.responses['200']).toMatchObject({
        content: { 'application/json': { schema: { $ref: '#/components/schemas/OkDto' } } },
      });
    }
  });
  it('공용 오류 DTO는 실제 filter의 code/message만 노출한다', () => {
    const doc = buildOpenApi(app);
    const schema = doc.components?.schemas?.ApiErrorDto;
    expect(schema).toMatchObject({ required: ['code', 'message'] });
    if (!schema || '$ref' in schema) throw Error('ApiErrorDto missing');
    expect(Object.keys(schema.properties ?? {})).toEqual(['code', 'message']);
    expect(doc.paths['/drawer/todos/{id}'].patch?.responses['400']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorDto' } } },
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host = { switchToHttp: () => ({ getResponse: () => res }) } as ArgumentsHost;
    new ApiErrorFilter().catch(new BadRequestException({ code: 'INVALID', message: '잘못된 입력', detail: 'private' }), host);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ code: 'INVALID', message: '잘못된 입력' });
  });
  it('Bearer 기본 요구와 Public 예외를 같은 decorator에서 파생한다', () => {
    const doc = buildOpenApi(app);
    expect(doc.security).toEqual([{ bearer: [] }]);
    for (const path of ['/auth/login', '/auth/logout']) expect(doc.paths[path].post?.security).toEqual([{}]);
    expect(doc.paths['/auth/refresh'].post?.security).toEqual([{ taco_rt: [] }]);
    expect(doc.components?.securitySchemes?.taco_rt).toMatchObject({ type: 'apiKey', in: 'cookie', name: 'taco_rt' });
    expect(doc.paths['/health'].get?.security).toEqual([{}]);
    expect(doc.paths['/auth/me'].get?.security ?? doc.security).toEqual([{ bearer: [] }]);
  });
});
