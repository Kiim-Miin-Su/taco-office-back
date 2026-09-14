/** @file-guide
 * 목적: §41 자료 전달 API가 화면과 같은 두 권한을 실제 HTTP guard에서 요구하는지 검증한다.
 * 책임/재사용: 실제 BooksController·PermGuard를 사용하고 BooksService만 대역한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import type { INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { PERM_KEY, PermGuard, type RequestUser } from '../src/common/perm';
import { BooksController } from '../src/modules/books/books.controller';
import { BooksService } from '../src/modules/books/books.service';
import { buildOpenApi } from '../src/openapi';

describe('§41 자료 전달 HTTP 권한 계약', () => {
  let app: INestApplication;
  let user: RequestUser | undefined;
  const service = {
    packs: jest.fn(), createPack: jest.fn(), patchPack: jest.fn(), transitionPack: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BooksController],
      providers: [
        { provide: BooksService, useValue: service },
        { provide: APP_GUARD, useClass: PermGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => { req.user = user; next(); });
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    user = undefined;
    for (const fn of Object.values(service)) fn.mockReset();
  });
  afterAll(async () => { await app?.close(); });

  it('다섯 handler 모두 canAdminPage와 canGpaPack을 함께 요구한다', () => {
    const reflector = app.get(Reflector);
    for (const handler of ['deliveries', 'createDelivery', 'patchDelivery', 'deliver', 'receive'] as const) {
      expect(reflector.get(PERM_KEY, BooksController.prototype[handler]))
        .toEqual(['canAdminPage', 'canGpaPack']);
    }
  });

  it('C77 요청·응답 날짜는 OpenAPI date 형상을 공유한다', () => {
    const schemas = buildOpenApi(app).components?.schemas;
    for (const [name, field] of [
      ['BookVersionCreateDto', 'fromDate'], ['BookVersionDto', 'fromDate'],
      ['BookIssueCreateDto', 'issuedOn'],
      ['BookIssueReturnDto', 'returnedOn'], ['BookIssueDto', 'issuedOn'], ['BookIssueDto', 'returnedOn'],
      ['BookPackWriteDto', 'effectiveOn'], ['BookPackPatchDto', 'effectiveOn'], ['BookPackDto', 'effectiveOn'],
    ] as const) {
      const schema = schemas?.[name];
      if (!schema || '$ref' in schema) throw new Error(`${name} schema 누락`);
      expect(schema.properties?.[field]).toMatchObject({
        type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      });
    }
    const anchor = buildOpenApi(app).paths['/books/history'].get?.parameters?.find(
      (parameter) => 'name' in parameter && parameter.name === 'anchor',
    );
    expect(anchor).toMatchObject({
      name: 'anchor', in: 'query', schema: { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    });
  });

  const calls = [
    ['get', '/books/deliveries'],
    ['post', '/books/deliveries'],
    ['patch', '/books/deliveries/1'],
    ['post', '/books/deliveries/1/deliver'],
    ['post', '/books/deliveries/1/receive'],
  ] as const;

  it.each([
    { label: '강사 canGpaPack=true', value: { id: 1, name: '강사', role: 'teacher', perms: { canGpaPack: true } } },
    { label: '매니저 canGpaPack=false', value: { id: 2, name: '매니저', role: 'manager', perms: { canGpaPack: false } } },
  ])('$label도 다섯 경로에서 service 호출 전에 403이다', async ({ value }) => {
    user = value;
    for (const [method, path] of calls) {
      await request(app.getHttpServer())[method](path).send({}).expect(403);
    }
    expect(service.packs).not.toHaveBeenCalled();
    expect(service.createPack).not.toHaveBeenCalled();
    expect(service.patchPack).not.toHaveBeenCalled();
    expect(service.transitionPack).not.toHaveBeenCalled();
  });
});
