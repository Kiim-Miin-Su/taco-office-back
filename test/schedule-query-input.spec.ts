/** @file-guide
 * 목적: schedule-query-input.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { ScheduleController } from '../src/modules/schedule/schedule.controller';
import { ScheduleService } from '../src/modules/schedule/schedule.service';
import { ScheduleWriteService } from '../src/modules/schedule/schedule.write.service';
import { ScheduleAttendanceService } from '../src/modules/schedule/schedule.attendance.service';
import { ApiErrorFilter } from '../src/common/filters/api-error.filter';
import { buildOpenApi } from '../src/openapi';

const date = '2026-09-11';
const range = { from: date, to: date };
const result = { effScope: 'this', log: [], projected: 0, serIds: [] };

describe('일정 조회/경로 → DTO → service 경계 (DB/인증은 통합 suite에서 검증)', () => {
  let app: INestApplication;
  let role = 'ceo';
  const list = jest.fn().mockResolvedValue([]);
  const write = { patch: jest.fn().mockResolvedValue(result), remove: jest.fn().mockResolvedValue(result), roster: jest.fn().mockResolvedValue(result) };
  const attendance = { save: jest.fn().mockResolvedValue({ attendance: null }), clear: jest.fn().mockResolvedValue({ attendance: null }) };
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [ScheduleController], providers: [
      { provide: ScheduleService, useValue: { list } },
      { provide: ScheduleWriteService, useValue: write },
      { provide: ScheduleAttendanceService, useValue: attendance },
    ] }).compile();
    app = mod.createNestApplication();
    app.use((req: Request & { user?: unknown }, _res: Response, next: NextFunction) => {
      req.user = { id: 11, role, perms: {} }; next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiErrorFilter());
    await app.listen(0, '127.0.0.1');
  });
  beforeEach(() => { role = 'ceo'; jest.clearAllMocks(); });
  afterAll(async () => { await app?.close(); });

  it.each(['from', 'to'])('%s는 실제 날짜이며 누락/중복/없는 날짜를 service 전에 거절한다', async key => {
    for (const value of [undefined, '', '0000-01-01', '2026-02-30', '2026-13-01', '2026-09-11T00:00:00Z', [date, date]]) {
      await request(app.getHttpServer()).get('/schedule/occurrences').query({ ...range, [key]: value }).expect(400);
      expect(list).not.toHaveBeenCalled();
    }
  });
  it.each(['teacherId', 'studentId', 'roomId'])('%s는 생략 또는 양의 안전한 정수만 허용한다', async key => {
    for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '0x10', '1e2', ' ', '9007199254740992', ['1', '2']]) {
      await request(app.getHttpServer()).get('/schedule/occurrences').query({ ...range, [key]: value }).expect(400);
      expect(list).not.toHaveBeenCalled();
    }
  });
  it('정상 query5필드는 숫자 ID로 service에 전달하고 날짜 응답을 보존한다', async () => {
    await request(app.getHttpServer()).get('/schedule/occurrences')
      .query({ ...range, teacherId: 1, studentId: 2, roomId: 3 }).expect(200).expect({ ...range, items: [] });
    expect(list).toHaveBeenCalledWith({ ...range, teacherId: 1, studentId: 2, roomId: 3, canCrudAttendance: true });
  });
  it('선택 필터 생략·윤년 날짜·안전 정수 상한을 허용한다', async () => {
    await request(app.getHttpServer()).get('/schedule/occurrences').query({ from: '2028-02-29', to: '2028-02-29' }).expect(200);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ teacherId: undefined, studentId: undefined, roomId: undefined }));
    await request(app.getHttpServer()).get('/schedule/occurrences').query({ ...range, teacherId: Number.MAX_SAFE_INTEGER }).expect(200);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ teacherId: Number.MAX_SAFE_INTEGER }));
  });
  it('강사는 다른 강사 필터를 보내도 본인 범위를 강제하고 출결 쓰기 권한은 없다', async () => {
    role = 'teacher';
    await request(app.getHttpServer()).get('/schedule/occurrences').query({ ...range, teacherId: 12, studentId: 2 }).expect(200);
    expect(list).toHaveBeenCalledWith({ ...range, teacherId: 11, studentId: 2, roomId: undefined, canCrudAttendance: false });
  });
  it('뒤집힌 날짜 범위는 기존 BAD_RANGE로 거절한다', async () => {
    const res = await request(app.getHttpServer()).get('/schedule/occurrences').query({ from: '2026-09-12', to: date }).expect(400);
    expect(res.body.code).toBe('BAD_RANGE'); expect(list).not.toHaveBeenCalled();
  });
  const mutations = [
    ['patch', '', { scope: 'this', onDate: date }, 'patch'],
    ['delete', '', { scope: 'all', onDate: date }, 'remove'],
    ['patch', '/roster', { op: 'dropAll', onDate: date, studentId: 1 }, 'roster'],
    ['put', `/${date}/attendance`, { result: 'completed' }, 'save'],
    ['delete', `/${date}/attendance`, {}, 'clear'],
  ] as const;
  it.each(mutations)('%s 일정 경로 %s도 양의 안전한 ID만 받는다', async (method, suffix, body) => {
    for (const id of ['0', '-1', '9007199254740992', '1e2', '1.5', 'abc']) {
      await request(app.getHttpServer())[method](`/schedule/${id}${suffix}`).send(body).expect(400);
      for (const fn of [...Object.values(write), ...Object.values(attendance)]) expect(fn).not.toHaveBeenCalled();
    }
  });
  it.each(['put', 'delete'] as const)('출결 %s의 onDate도 실제 날짜여야 한다', async method => {
    for (const invalid of ['2026-02-30', '0000-01-01', '2026-13-01']) {
      await request(app.getHttpServer())[method](`/schedule/1/${invalid}/attendance`).send({ result: 'completed' }).expect(400);
      expect(attendance.save).not.toHaveBeenCalled(); expect(attendance.clear).not.toHaveBeenCalled();
    }
  });
  it.each(mutations)('%s 정상 일정 경로 %s는 기존 service와 같은 인수를 쓴다', async (method, suffix, body, name) => {
    await request(app.getHttpServer())[method](`/schedule/1${suffix}`).send(body).expect(200);
    const fn = { ...write, ...attendance }[name];
    if (name === 'save') expect(fn).toHaveBeenCalledWith(1, date, expect.objectContaining(body), 11);
    else if (name === 'clear') expect(fn).toHaveBeenCalledWith(1, date, 11);
    else expect(fn).toHaveBeenCalledWith(1, expect.objectContaining(body));
  });
  it('OpenAPI query/path가 실제 날짜·정수 타입과 제한을 노출한다', () => {
    const doc = buildOpenApi(app);
    const params = doc.paths['/schedule/occurrences'].get!.parameters;
    expect(params).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'from', required: true, schema: expect.objectContaining({ type: 'string', format: 'date' }) }),
      expect.objectContaining({ name: 'to', required: true, schema: expect.objectContaining({ type: 'string', format: 'date' }) }),
      ...['teacherId', 'studentId', 'roomId'].map(name => expect.objectContaining({ name, required: false,
        schema: expect.objectContaining({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) })),
    ]));
    for (const [path, method] of [['/schedule/{serId}', 'patch'], ['/schedule/{serId}', 'delete'],
      ['/schedule/{serId}/roster', 'patch'], ['/schedule/{serId}/{onDate}/attendance', 'put'],
      ['/schedule/{serId}/{onDate}/attendance', 'delete']] as const) {
      expect(doc.paths[path][method]!.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'serId', required: true, schema: expect.objectContaining({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }),
      ]));
    }
    for (const method of ['put', 'delete'] as const) {
      expect(doc.paths['/schedule/{serId}/{onDate}/attendance'][method]!.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'onDate', required: true, schema: expect.objectContaining({ type: 'string', format: 'date' }) }),
      ]));
    }
  });
});
