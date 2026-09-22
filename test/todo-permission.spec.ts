/** @file-guide
 * 목적: 할 일 PATCH의 완료 범위와 기한 편집 최종 권한을 HTTP 경계에서 분리 검증한다.
 * 책임/재사용: 실제 controller/DTO/ValidationPipe를 쓰고 인증 사용자·DB service만 대역으로 둔다.
 * 검증/작업 지침: docs/sprint/evidence/TBO-52/s2-ops-todos/plan.md · docs/AGENT.md
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { RequestUser } from '../src/common/perm';
import { DrawerController } from '../src/modules/drawer/drawer.controller';
import { DrawerService } from '../src/modules/drawer/drawer.service';
import { ScheduleService } from '../src/modules/schedule/schedule.service';

describe('§64 최종 flag와 기존 완료 권한 (인증/DB는 대역)', () => {
  let app: INestApplication;
  let user: RequestUser;
  const patchTodo = jest.fn().mockResolvedValue(true);
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [DrawerController],
      providers: [{ provide: DrawerService, useValue: { patchTodo } }, { provide: ScheduleService, useValue: {} }],
    }).compile();
    app = mod.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => { req.user = user; next(); });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
  });
  beforeEach(() => { patchTodo.mockClear(); });
  afterAll(async () => { await app.close(); });

  it.each([
    [false, false], [true, false], [false, true], [true, true],
  ])('관리자 화면=%s·전체 수정=%s의 기한 변경/삭제와 기존 완료 범위를 분리한다', async (canAdminPage, canCrudAll) => {
    user = { id: 55, name: '권한 시험', role: 'teacher', perms: { canAdminPage, canCrudAll } };
    for (const dueOn of ['2026-09-25', null]) {
      const allowed = canAdminPage && canCrudAll;
      patchTodo.mockClear();
      await request(app.getHttpServer()).patch('/drawer/todos/42').send({ done: true, dueOn }).expect(allowed ? 200 : 403);
      if (allowed) expect(patchTodo).toHaveBeenCalledWith(42, { done: true, dueOn }, 55, true);
      else expect(patchTodo).not.toHaveBeenCalled();
    }
    patchTodo.mockClear();
    await request(app.getHttpServer()).patch('/drawer/todos/42').send({ done: false }).expect(200);
    expect(patchTodo).toHaveBeenCalledWith(42, { done: false }, 55, canCrudAll);
  });
});
