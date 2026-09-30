/** @file-guide
 * 목적: students-read-http.spec.ts — 신규 학생 GET의 실제 HTTP/Perm/DTO/OpenAPI 경계
 * 책임/재사용: 실제 controller/PermGuard/ValidationPipe를 사용한다. 인증 사용자 주입·service 대역이므로 JWT/DB 검증과 구분한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { PermGuard, type RequestUser } from '../src/common/perm';
import { ApiErrorFilter } from '../src/common/filters/api-error.filter';
import { StudentsController } from '../src/modules/students/students.controller';
import { StudentsService } from '../src/modules/students/students.service';
import { buildOpenApi } from '../src/openapi';

describe('학생 목록/상세 HTTP 계약', () => {
  let app: INestApplication;
  const service = { list: jest.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 10, grades: [] })),
    detail: jest.fn(async () => ({ id: 7 })) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [StudentsController], providers: [{ provide: StudentsService, useValue: service }] }).compile();
    app = module.createNestApplication();
    app.use((req: Request & { user?: RequestUser }, _res: Response, next: NextFunction) => {
      if (req.headers['x-fixture-role']) req.user = { id: 1, name: 'fixture', role: String(req.headers['x-fixture-role']) };
      next();
    });
    app.useGlobalGuards(new PermGuard(app.get(Reflector)));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiErrorFilter());
    await app.init();
  });
  beforeEach(() => { jest.clearAllMocks(); });
  afterAll(async () => { await app?.close(); });

  it.each(['manager', 'admin', 'ceo'])('%s가 실제 두 GET을 사용할 수 있다', async role => {
    await request(app.getHttpServer()).get('/students?q=fixture&page=2&grade=G8').set('x-fixture-role', role).expect(200);
    expect(service.list).toHaveBeenCalledWith({ q: 'fixture', page: 2, grade: 'G8' });
    await request(app.getHttpServer()).get('/students/7').set('x-fixture-role', role).expect(200);
    expect(service.detail).toHaveBeenCalledWith({ id: 7 });
  });

  it.each(['/students', '/students/7'])('강사 및 확인 불가 역할은 %s의 service에 도달하지 않는다', async url => {
    await request(app.getHttpServer()).get(url).set('x-fixture-role', 'teacher').expect(403);
    await request(app.getHttpServer()).get(url).set('x-fixture-role', 'unknown').expect(403);
    await request(app.getHttpServer()).get(url).expect(403);
    expect(service.list).not.toHaveBeenCalled();
    expect(service.detail).not.toHaveBeenCalled();
  });

  it.each(['/students?page=0', '/students?page=1e2', '/students?page=1&page=2', '/students?status=active', '/students/0', '/students/9007199254740993'])('지원하지 않는 입력 %s는400이다', async url => {
    await request(app.getHttpServer()).get(url).set('x-fixture-role', 'manager').expect(400);
    expect(service.list).not.toHaveBeenCalled();
    expect(service.detail).not.toHaveBeenCalled();
  });

  it('OpenAPI는 두 GET만 열고 전체 감사/등록 writer를 가장하지 않는다', () => {
    const doc = buildOpenApi(app);
    expect(doc.paths['/students'].get?.responses['200']).toBeDefined();
    expect(doc.paths['/students/{id}'].get?.responses['200']).toBeDefined();
    expect(doc.paths['/students'].post).toBeUndefined();
    expect(doc.paths['/students/{id}'].delete).toBeUndefined();
    expect(doc.components?.schemas?.StudentAuditSummaryDto).not.toHaveProperty('properties.before');
    expect(doc.components?.schemas?.StudentAuditSummaryDto).not.toHaveProperty('properties.after');
    expect(doc.components?.schemas?.StudentReadDto).not.toHaveProperty('properties.phone');
  });
});
