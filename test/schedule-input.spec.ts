/** @file-guide
 * 목적: schedule-input.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ValidationPipe, type INestApplication, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import {
  OccurrenceCreateDto, OccurrenceDeleteDto, OccurrenceMoveDto, OccurrenceMoveItemDto,
  OccurrencePasteDto, OccurrencePatchDto, OccurrenceRefDto, RosterPatchDto,
} from '../src/modules/schedule/schedule.dto';
import { ScheduleWriteService } from '../src/modules/schedule/schedule.write.service';
import { ScheduleController } from '../src/modules/schedule/schedule.controller';
import { ScheduleService } from '../src/modules/schedule/schedule.service';
import { ScheduleAttendanceService } from '../src/modules/schedule/schedule.attendance.service';
import { buildOpenApi } from '../src/openapi';
import { isIsoDate } from '../src/lib/kst';

const date = '2026-09-11';
const ref = { serId: 1, date, onDate: date };
const create = {
  kindKey: 'class', subKey: null, mode: 'offline', fromDate: date, toDate: date,
  rrule: 'ONCE', startMin: 600, endMin: 660, teacherId: null, roomId: null,
  title: null, studentIds: [1, 2],
};
const patch = { scope: 'this', onDate: date };
const item = { source: ref, date, startMin: 600, endMin: 660 };
const paste = { sources: [ref], scope: 'this', targetDate: date, targetStartMin: 600 };
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const parse = (dto: Type<unknown>, body: object) => pipe.transform(body, { type: 'body', metatype: dto });

describe('스케줄 CRUD 입력 형식', () => {
  const dateCases: Array<[Type<unknown>, object, string]> = [
    [OccurrenceCreateDto, create, 'fromDate'], [OccurrenceCreateDto, create, 'toDate'],
    [OccurrencePatchDto, patch, 'onDate'], [OccurrencePatchDto, patch, 'date'],
    [OccurrenceRefDto, ref, 'date'], [OccurrenceRefDto, ref, 'onDate'],
    [OccurrencePasteDto, paste, 'targetDate'], [OccurrenceMoveItemDto, item, 'date'],
    [OccurrenceDeleteDto, patch, 'onDate'],
    [RosterPatchDto, { op: 'add', onDate: date, studentId: 1 }, 'onDate'],
  ];
  it.each(dateCases)('%p 날짜 필드 실제 달력 날짜만 허용한다', async (dto, body, key) => {
    for (const invalid of ['2026-02-30', '0000-01-01', '2026-13-01', '2026-09-11T00:00:00Z']) {
      await expect(parse(dto, { ...body, [key]: invalid })).rejects.toMatchObject({ status: 400 });
    }
    await expect(parse(dto, { ...body, [key]: '2028-02-29' })).resolves.toMatchObject({ [key]: '2028-02-29' });
  });
  it.each([['1'], [1.5], [0], [-1], [null], [Number.MAX_SAFE_INTEGER + 1], [1, 1], null].map(studentIds => ({ studentIds })))(
    'studentIds=$studentIds 는 양의 안전한 정수의 중복 없는 배열이어야 한다', async ({ studentIds }) => {
      await expect(parse(OccurrenceCreateDto, { ...create, studentIds })).rejects.toMatchObject({ status: 400 });
    },
  );
  it.each([
    [OccurrenceCreateDto, create], [OccurrencePatchDto, patch],
    [OccurrencePasteDto, paste], [OccurrenceMoveItemDto, item],
  ] as Array<[Type<unknown>, object]>)('%p 자원 ID는 미지정 또는 양의 안전한 정수다', async (dto, body) => {
    for (const key of ['teacherId', 'roomId']) {
      for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
        await expect(parse(dto, { ...body, [key]: invalid })).rejects.toMatchObject({ status: 400 });
      }
      await expect(parse(dto, { ...body, [key]: null })).resolves.toMatchObject({ [key]: null });
    }
  });
  it.each([['kindKey', 16], ['subKey', 20], ['rrule', 80], ['title', 80]] as const)(
    '%s의 DB varchar(%i) 초과는 저장 전에 400이다', async (key, length) => {
      await expect(parse(OccurrenceCreateDto, { ...create, [key]: 'a'.repeat(length + 1) }))
        .rejects.toMatchObject({ status: 400 });
    },
  );
  it.each([undefined, null, [], 'not-a-reference'].map(source => ({ source })))('이동 원본 $source는 필수 객체다', async ({ source }) => {
    await expect(parse(OccurrenceMoveItemDto, { ...item, source })).rejects.toMatchObject({ status: 400 });
  });
  it('배치의 원소도 객체이어야 하고 배열/null을 원본으로 받지 않는다', async () => {
    for (const invalid of [[], null]) {
      await expect(parse(OccurrencePasteDto, { ...paste, sources: [invalid] })).rejects.toMatchObject({ status: 400 });
      await expect(parse(OccurrenceMoveDto, { scope: 'this', items: [invalid] })).rejects.toMatchObject({ status: 400 });
    }
  });
  it('빈 명단·생략·이번 회차의 nullable 예외 초기화는 유지한다', async () => {
    await expect(parse(OccurrenceCreateDto, { ...create, studentIds: [] })).resolves.toMatchObject({ studentIds: [] });
    const withoutRoster: Partial<typeof create> = { ...create };
    delete withoutRoster.studentIds;
    await expect(parse(OccurrenceCreateDto, withoutRoster)).resolves.toBeInstanceOf(OccurrenceCreateDto);
    await expect(parse(OccurrencePatchDto, { ...patch, startMin: null, endMin: null, date: null }))
      .resolves.toMatchObject({ startMin: null, endMin: null, date: null });
  });
  it('반복 종료일이 시작일보다 앞서면 transaction을 열기 전에 거절한다', async () => {
    const ds = { createQueryRunner: jest.fn() };
    const service = new ScheduleWriteService(ds as unknown as DataSource);
    await expect(service.create({ ...create, rrule: 'DAILY', toDate: '2026-09-10' }))
      .rejects.toMatchObject({ response: { code: 'BAD_RANGE' } });
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
  });
  it('잘라내기 boolean은 생략/false/true만 허용한다', async () => {
    await expect(parse(OccurrencePasteDto, { ...paste, cut: null })).rejects.toMatchObject({ status: 400 });
    for (const cut of [false, true]) await expect(parse(OccurrencePasteDto, { ...paste, cut })).resolves.toMatchObject({ cut });
  });
  it('날짜 공용 함수는 잘못된 원시값과 JS 날짜 보정을 거절한다', () => {
    for (const value of [undefined, null, 20260911, '', '0000-01-01', '2026-02-29', '1900-02-29']) {
      expect(isIsoDate(value)).toBe(false);
    }
    for (const value of ['0001-01-01', '2000-02-29', '2028-02-29', '9999-12-31']) expect(isIsoDate(value)).toBe(true);
  });
});

describe('스케줄 OpenAPI/실제 HTTP 경계 (권한/DB 검증은 별도)', () => {
  let app: INestApplication;
  const write = { create: jest.fn().mockResolvedValue({ effScope: 'this', log: [], projected: 1, serIds: [1] }), moveMany: jest.fn() };
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [ScheduleController], providers: [
      { provide: ScheduleService, useValue: {} }, { provide: ScheduleWriteService, useValue: write },
      { provide: ScheduleAttendanceService, useValue: {} },
    ] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(pipe);
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => { await app?.close(); });
  it('Swagger가 날짜/ID/배열/문자열의 실제 형식 제한을 노출한다', () => {
    const document = buildOpenApi(app);
    const schemas = document.components!.schemas!;
    expect(document.paths['/schedule'].post!.responses['400']).toMatchObject({
      description: expect.stringContaining('REFERENCE_NOT_FOUND'),
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorDto' } } },
    });
    const createSchema = schemas.OccurrenceCreateDto;
    if ('$ref' in createSchema) throw Error('missing create schema');
    expect(createSchema.properties).toMatchObject({
      fromDate: { type: 'string', format: 'date' }, title: { maxLength: 80 },
      kindKey: { minLength: 1, maxLength: 16 }, subKey: { maxLength: 20 }, rrule: { maxLength: 80 },
      teacherId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, nullable: true },
      studentIds: { type: 'array', uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
      startMin: { type: 'integer', minimum: 0, maximum: 1439 }, endMin: { type: 'integer', maximum: 1440 },
    });
    expect(schemas.OccurrenceMoveItemDto).toMatchObject({ required: expect.arrayContaining(['source']) });
    expect(schemas.OccurrencePasteDto).toMatchObject({ properties: { sources: { minItems: 1, maxItems: 50 } } });
  });
  it('실 HTTP에서도 형식 오류는 쓰기 service 진입 전에 400으로 거절한다', async () => {
    write.create.mockClear();
    for (const body of [{ ...create, studentIds: ['1'] }, { ...create, fromDate: '2026-02-30' }]) {
      await request(app.getHttpServer()).post('/schedule').send(body).expect(400);
    }
    expect(write.create).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post('/schedule/move')
      .send({ scope: 'this', items: [{ date, startMin: 600, endMin: 660 }] }).expect(400);
    expect(write.moveMany).not.toHaveBeenCalled();
  });
  it('프론트의 유효 생성 payload는 손실 없이 기존 service로 전달한다', async () => {
    await request(app.getHttpServer()).post('/schedule').send(create).expect(201);
    expect(write.create).toHaveBeenCalledWith(expect.objectContaining(create));
  });
});
