/** @file-guide
 * 목적: BOC-01D-01 과목→프로그램의 HTTP 권한·DTO·OpenAPI 계약을 실제 guard/pipe로 검증한다.
 * 책임/재사용: CatalogController와 생성 DTO를 사용하고 서비스만 대역한다. DB 관계·중복·trigger는 catalog-db.spec.ts가 소유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-01D1-SUBJECT-PROGRAM-CONTRACT-2026-10-08.md · docs/contracts/FILE-GUIDE.md
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { ApiErrorFilter } from '../src/common/filters/api-error.filter';
import { PermGuard, type RequestUser } from '../src/common/perm';
import { CatalogController } from '../src/modules/catalog/catalog.controller';
import { SUBJECT_COLORS } from '../src/modules/catalog/catalog.dto';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { buildOpenApi } from '../src/openapi';

describe('BOC-01D-01 프로그램·과목 HTTP 계약', () => {
  let app: INestApplication;
  const service = {
    all: jest.fn(async () => ({ kinds: [], subs: [], subjectColors: [...SUBJECT_COLORS] })),
    createKind: jest.fn(), patchKind: jest.fn(),
    createSub: jest.fn(async (_actorId: number, dto: Record<string, unknown>) => ({
      ...dto, active: true, sort: null, serCount: 0,
    })),
    patchSub: jest.fn(async (_actorId: number, key: string, dto: Record<string, unknown>) => ({
      key, name: 'AP Biology', color: SUBJECT_COLORS[0], active: true, sort: null, kindKey: 'class', serCount: 0, ...dto,
    })),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CatalogController], providers: [{ provide: CatalogService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.use((req: Request & { user?: RequestUser }, _res: Response, next: NextFunction) => {
      if (req.headers['x-fixture-role']) {
        req.user = { id: 77, name: 'fixture', role: String(req.headers['x-fixture-role']) } as RequestUser;
      }
      next();
    });
    app.useGlobalGuards(new PermGuard(app.get(Reflector)));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiErrorFilter());
    await app.init();
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app?.close());

  it.each(['manager', 'admin', 'ceo'])('%s는 목록과 과목 writer를 사용한다', async (role) => {
    await request(app.getHttpServer()).get('/catalog').set('x-fixture-role', role).expect(200)
      .expect(({ body }) => expect(body.subjectColors).toEqual(SUBJECT_COLORS));
    await request(app.getHttpServer()).post('/catalog/subs').set('x-fixture-role', role)
      .send({ key: `ap-bio-${role}`, name: `AP Biology ${role}`, kindKey: 'class', color: '#4A7FB5' }).expect(201);
    expect(service.createSub).toHaveBeenLastCalledWith(77, {
      key: `ap-bio-${role}`, name: `AP Biology ${role}`, kindKey: 'class', color: '#4A7FB5',
    });
  });

  it('강사는 목록·생성·수정의 service에 도달하지 않는다', async () => {
    await request(app.getHttpServer()).get('/catalog').set('x-fixture-role', 'teacher').expect(403);
    await request(app.getHttpServer()).post('/catalog/subs').set('x-fixture-role', 'teacher')
      .send({ key: 'ap-bio', name: 'AP Biology', kindKey: 'class', color: '#4A7FB5' }).expect(403);
    await request(app.getHttpServer()).patch('/catalog/subs/ap-bio').set('x-fixture-role', 'teacher')
      .send({ kindKey: 'intake' }).expect(403);
    expect(service.all).not.toHaveBeenCalled();
    expect(service.createSub).not.toHaveBeenCalled();
    expect(service.patchSub).not.toHaveBeenCalled();
  });

  it.each([
    { key: 'ap-bio', name: 'AP Biology', color: '#4A7FB5' },
    { key: 'ap-bio', name: '   ', kindKey: 'class', color: '#4A7FB5' },
    { key: 'ap-bio', name: 'AP Biology', kindKey: 'class', color: '#123456' },
    { key: 'ap-bio', name: 'AP Biology', kindKey: 'class', color: '#4A7FB5', extra: true },
  ])('누락·팔레트 밖·추가 입력은 service 전 400이다', async (body) => {
    await request(app.getHttpServer()).post('/catalog/subs').set('x-fixture-role', 'admin').send(body).expect(400);
    expect(service.createSub).not.toHaveBeenCalled();
  });

  it('OpenAPI가 단일 프로그램·8색·오류 몸통을 생성 계약으로 공개한다', () => {
    const doc = buildOpenApi(app);
    expect(doc.components?.schemas?.SubCreateDto).toMatchObject({
      required: expect.arrayContaining(['key', 'name', 'kindKey', 'color']),
      properties: { color: { enum: [...SUBJECT_COLORS] }, kindKey: { type: 'string' } },
    });
    expect(doc.components?.schemas?.SubRowDto).toHaveProperty('properties.kindKey');
    expect(doc.components?.schemas?.KindRowsDto).toHaveProperty('properties.subjectAssignable');
    expect(doc.components?.schemas?.CatalogDto).toHaveProperty('properties.subjectColors');
    expect(doc.paths['/catalog/subs'].post?.responses['400']).toHaveProperty('content.application/json.schema.$ref', '#/components/schemas/ApiErrorDto');
    expect(doc.paths['/catalog/subs'].post?.responses['409']).toHaveProperty('content.application/json.schema.$ref', '#/components/schemas/ApiErrorDto');
  });
});
