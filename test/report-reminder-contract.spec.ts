/** @file-guide
 * 목적: report-reminder-contract.spec.ts — §47 리포트 독촉 HTTP/권한/DTO 계약
 * 책임/재사용: 실제 controller·PermGuard·ValidationPipe를 사용하고 service만 대역한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { PERM_KEY, PermGuard, type RequestUser } from '../src/common/perm';
import { buildOpenApi } from '../src/openapi';
import { ReportsController } from '../src/modules/reports/reports.controller';
import { ReportsService } from '../src/modules/reports/reports.service';

describe('§47 리포트 독촉 HTTP 계약', () => {
  let app: INestApplication;
  let user: RequestUser | undefined;
  const reminders = jest.fn();
  const requestKey = '00000000-0000-4000-8000-000000000047';

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        { provide: ReportsService, useValue: { reminders } },
        { provide: APP_GUARD, useClass: PermGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => { req.user = user; next(); });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    user = undefined;
    reminders.mockReset().mockResolvedValue({ requestKey, items: [] });
  });

  afterAll(async () => { await app?.close(); });

  it('canCrudAll 한 칸으로 대표·관리자·매니저만 독촉한다', async () => {
    expect(app.get(Reflector).get(PERM_KEY, ReportsController.prototype.reminders)).toEqual(['canCrudAll']);
    for (const [role, status] of [['teacher', 403], ['manager', 201], ['admin', 201], ['ceo', 201]] as const) {
      user = { id: 47, name: '계약 검수', role };
      await request(app.getHttpServer()).post('/reports/reminders').send({ requestKey }).expect(status);
    }
    expect(reminders).toHaveBeenCalledTimes(3);
    expect(reminders).toHaveBeenLastCalledWith({ requestKey }, 47, true);
  });

  it('선택 강사 ID와 requestKey를 DB 조회 전에 검증한다', async () => {
    user = { id: 47, name: '매니저', role: 'manager' };
    for (const body of [
      { requestKey: 'not-a-uuid' },
      { requestKey, teacherId: 0 },
      { requestKey, teacherId: '1e2' },
      { requestKey, extra: true },
    ]) {
      await request(app.getHttpServer()).post('/reports/reminders').send(body).expect(400);
    }
    expect(reminders).not.toHaveBeenCalled();
  });

  it('Swagger에 선택 teacherId·UUID·201/403/409를 노출한다', () => {
    const api = buildOpenApi(app);
    const operation = api.paths['/reports/reminders'].post!;
    expect(operation.responses['201']).toBeDefined();
    expect(operation.responses['403']).toBeDefined();
    expect(operation.responses['409']).toBeDefined();
    const schema = api.components?.schemas?.ReportReminderCreateDto;
    if (!schema || '$ref' in schema) throw new Error('ReportReminderCreateDto 누락');
    expect(schema.required).toEqual(['requestKey']);
    expect(schema.properties?.requestKey).toMatchObject({ type: 'string', format: 'uuid' });
    expect(schema.properties?.teacherId).toMatchObject({ type: 'integer', minimum: 1 });
    const result = api.components?.schemas?.ReportReminderResultDto;
    const recipient = api.components?.schemas?.ReportReminderRecipientDto;
    if (!result || '$ref' in result || !recipient || '$ref' in recipient) {
      throw new Error('ReportReminder 응답 DTO 누락');
    }
    expect(result.required).toEqual(['requestKey', 'items']);
    expect(Object.keys(recipient.properties ?? {})).toEqual([
      'teacherId', 'teacherName', 'count', 'createdAt',
    ]);
    expect(recipient.required).toEqual(['teacherId', 'teacherName', 'count', 'createdAt']);
  });
});
