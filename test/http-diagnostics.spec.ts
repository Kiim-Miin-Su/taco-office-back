/** @file-guide
 * 목적: 모든 HTTP CRUD의 값 없는 서버 진단과 오류·부팅 로그의 비밀값 차단 회귀.
 * 책임/재사용: 실제 Nest route/filter와 공용 HTTP middleware를 조립하되 DB·외부 발송은 사용하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { ArgumentsHost, BadRequestException, Body, Controller, Get, INestApplication, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { ApiErrorFilter } from '../src/common/filters/api-error.filter';
import { httpDiagnostics } from '../src/common/http-diagnostics';
import { logBootFailure } from '../src/serverless';

const PRIVATE = '홍길동 900101-1234567 SECRET_TOKEN';

@Controller('diagnostic-probe')
class DiagnosticProbeController {
  @Post(':id')
  create(@Req() req: Request, @Body() body: { residentNo: string }) {
    (req as Request & { user: { id: number } }).user = { id: 42 };
    return { name: PRIVATE, residentNo: body.residentNo };
  }

  @Get('bad/:id')
  bad() {
    throw new Error(PRIVATE);
  }

  @Get('pg/:id')
  pg() {
    throw { code: '23505', constraint: 'SECRET_TOKEN' };
  }

  @Get('rejected/:id')
  rejected() {
    throw new BadRequestException({ code: 'BAD_REQUEST', message: PRIVATE });
  }

  @Get('contaminated/:id')
  contaminated() {
    throw new BadRequestException({ code: 'SECRET_TOKEN', message: PRIVATE });
  }

  @Get('unauthorized/:id')
  unauthorized() {
    throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: PRIVATE });
  }
}

describe('공용 서버 HTTP 진단', () => {
  let app: INestApplication;
  let logged: jest.SpyInstance;
  let errors: jest.SpyInstance;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [DiagnosticProbeController] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(httpDiagnostics);
    app.enableCors({ origin: 'https://front.example.test', exposedHeaders: ['X-Request-Id'] });
    app.useGlobalFilters(new ApiErrorFilter());
    await app.init();
  });

  beforeEach(() => {
    logged = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    logged.mockRestore();
    errors.mockRestore();
  });

  afterAll(async () => {
    await app?.close();
  });

  function trace(): Array<Record<string, unknown>> {
    return logged.mock.calls.flatMap(([entry]) => {
      if (typeof entry !== 'string' || !entry.startsWith('{"event":"http.')) return [];
      return [JSON.parse(entry) as Record<string, unknown>];
    });
  }

  it('CRUD 요청과 응답을 같은 ID·route template로 각각 한 번 기록하고 원문·query·header를 제외한다', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/diagnostic-probe/17?email=private@example.test')
      .set('Authorization', 'Bearer SECRET_TOKEN')
      .set('X-Request-Id', 'SECRET_TOKEN')
      .send({ residentNo: PRIVATE })
      .expect(201);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const entries = trace();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.event)).toEqual(['http.request', 'http.response']);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        method: 'POST',
        route: '/api/v1/diagnostic-probe/:id',
        status: 201,
        code: 'OK',
        requestId: res.headers['x-request-id'],
        actorId: 42,
      });
      expect(entry.durationMs).toEqual(expect.any(Number));
    }
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/홍길동|900101|SECRET_TOKEN|private@example\.test|residentNo|"17"/);
  });

  it('예상 밖 500에서도 응답 본문·스택 원문 없이 INTERNAL 코드를 같은 ID로 남긴다', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/diagnostic-probe/bad/17').expect(500);
    expect(res.body).toEqual({ code: 'INTERNAL', message: '처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요' });
    expect(trace()).toHaveLength(2);
    expect(trace()[1]).toMatchObject({
      method: 'GET',
      route: '/api/v1/diagnostic-probe/bad/:id',
      status: 500,
      code: 'INTERNAL',
      requestId: res.headers['x-request-id'],
      actorId: null,
    });
    expect(errors).toHaveBeenCalledWith(`INTERNAL unexpected error requestId=${res.headers['x-request-id']}`);
    expect(JSON.stringify([...logged.mock.calls, ...errors.mock.calls])).not.toContain(PRIVATE);
  });

  it('미들웨어 밖 필터와 오염된 locals는 임의 ID를 로그로 신뢰하지 않는다', () => {
    for (const locals of [undefined, { httpDiagnosticRequestId: 'SECRET_TOKEN' }]) {
      const res = { locals, status: jest.fn().mockReturnThis(), json: jest.fn() };
      const host = { switchToHttp: () => ({ getResponse: () => res }) } as ArgumentsHost;
      new ApiErrorFilter().catch(new Error(PRIVATE), host);
    }
    expect(errors.mock.calls).toEqual([
      ['INTERNAL unexpected error requestId=unavailable'],
      ['INTERNAL unexpected error requestId=unavailable'],
    ]);
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/SECRET_TOKEN|홍길동|900101/);
  });

  it('매칭되지 않는 URL은 경로 원문 대신 안전한 식별자만 남긴다', async () => {
    await request(app.getHttpServer()).get('/api/v1/SECRET_TOKEN/private@example.test').expect(404);
    expect(trace()).toHaveLength(2);
    expect(trace()[1]).toMatchObject({ route: '[unmatched]', status: 404, code: 'NOT_FOUND' });
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/SECRET_TOKEN|private@example\.test/);
  });

  it('예상한 DB 코드라도 원시 constraint는 로그로 전달하지 않는다', async () => {
    const warns = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      await request(app.getHttpServer()).get('/api/v1/diagnostic-probe/pg/17').expect(409);
      expect(trace()[1]).toMatchObject({ status: 409, code: 'DUPLICATE' });
      expect(JSON.stringify(warns.mock.calls)).not.toContain('SECRET_TOKEN');
    } finally {
      warns.mockRestore();
    }
  });

  it('4xx 응답 문구에 개인정보가 있어도 서버 진단에는 안정된 코드만 남긴다', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/diagnostic-probe/rejected/17').expect(400);
    expect(res.body.message).toBe(PRIVATE);
    expect(trace()).toHaveLength(2);
    expect(trace()[1]).toMatchObject({ status: 400, code: 'BAD_REQUEST',
      route: '/api/v1/diagnostic-probe/rejected/:id' });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(PRIVATE);
  });

  it('대문자 형태라도 미승인 오류 코드는 원문 대신 HTTP 상태로 남긴다', async () => {
    await request(app.getHttpServer()).get('/api/v1/diagnostic-probe/contaminated/17').expect(400);
    expect(trace()[1]).toMatchObject({ status: 400, code: 'HTTP_400' });
    expect(JSON.stringify(logged.mock.calls)).not.toContain('SECRET_TOKEN');
  });

  it('401도 요청 ID·안전 route/code를 남기고 응답 ID를 교차 출처에 노출한다', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/diagnostic-probe/unauthorized/17')
      .set('Origin', 'https://front.example.test').expect(401);
    expect(res.headers['access-control-expose-headers']).toContain('X-Request-Id');
    expect(trace()).toHaveLength(2);
    expect(trace()[1]).toMatchObject({ status: 401, code: 'UNAUTHORIZED',
      route: '/api/v1/diagnostic-probe/unauthorized/:id', requestId: res.headers['x-request-id'] });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(PRIVATE);
  });

  it('CORS OPTIONS도 응답 완료를 한 번 기록하고 원시 URL은 남기지 않는다', async () => {
    const res = await request(app.getHttpServer()).options('/api/v1/diagnostic-probe/17?email=private@example.test')
      .set('Origin', 'https://front.example.test').set('Access-Control-Request-Method', 'POST').expect(204);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(trace()).toHaveLength(2);
    expect(trace()[1]).toMatchObject({ method: 'OPTIONS', route: '[unmatched]', status: 204, code: 'OK' });
    expect(JSON.stringify(logged.mock.calls)).not.toContain('private@example.test');
  });
});

it('서버리스 부팅 실패는 오류 원문·스택을 콘솔에 남기지 않는다', () => {
  const spy = jest.spyOn(console, 'error').mockImplementation();
  try {
    logBootFailure(Object.assign(new Error(PRIVATE), { code: '28P01' }));
    expect(JSON.stringify(spy.mock.calls)).not.toContain(PRIVATE);
    expect(JSON.stringify(spy.mock.calls)).toContain('28P01');
    logBootFailure({ code: 'SECRET_TOKEN', message: PRIVATE });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/SECRET_TOKEN|홍길동|900101/);
  } finally {
    spy.mockRestore();
  }
});
