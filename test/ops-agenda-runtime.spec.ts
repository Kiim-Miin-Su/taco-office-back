/** @file-guide
 * 목적: BO-Q13 agenda runtime 경로의 권한 메타데이터·version·잠금·감사·미저장 import를 검증한다.
 * 책임/재사용: OpsController/OpenAPI와 OpsService의 실제 분기만 호출하며 제품 SQL 규칙을 별도 구현하지 않는다.
 * 검증/작업 지침: docs/decisions/PLANNING-REQUIRED.md BO-Q13 · docs/sprint/TBO-55/features/BOC-12-MEETING-OPS-EXEC-FRONT-2026-10-07.md
 */

import { ConflictException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { buildOpenApi } from '../src/openapi';
import { OpsController } from '../src/modules/ops/ops.controller';
import { OpsService } from '../src/modules/ops/ops.service';
import { LeadEnrollService } from '../src/modules/ops/enroll.service';
import { TeacherChangeService } from '../src/modules/ops/teacher-change.service';

describe('BO-Q13 agenda runtime 계약', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [OpsController],
      providers: [
        { provide: OpsService, useValue: {} },
        { provide: LeadEnrollService, useValue: {} },
        { provide: TeacherChangeService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => { await app?.close(); });

  it('PUT writer와 POST import를 별도 schema·409 계약으로 공개한다', () => {
    const paths = buildOpenApi(app).paths;
    expect(paths?.['/ops/meetings/{id}/agenda']?.put).toMatchObject({
      responses: { 200: expect.any(Object), 404: expect.any(Object), 409: expect.any(Object) },
      requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/MeetingAgendaWriteDto' } } } },
    });
    expect(paths?.['/ops/meetings/{id}/agenda/import']?.post).toMatchObject({
      responses: { 200: expect.any(Object), 404: expect.any(Object), 409: expect.any(Object) },
      requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/MeetingAgendaImportDto' } } } },
    });
  });
});

describe('BO-Q13 agenda service version·잠금·감사', () => {
  type AgendaState = { content: string; version: number; updatedBy: number } | null;

  function harness(initial: AgendaState, options: { locked?: boolean; startUnknown?: boolean } = {}) {
    let state = initial;
    const writes: string[] = [];
    const em = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM mtrec m') && sql.includes('FOR UPDATE OF m')) {
          return [{ id: '41', starts_at: options.startUnknown ? null : new Date('2099-01-01T00:00:00.000Z') }];
        }
        if (sql.includes('AS locked') && sql.includes('$1::timestamptz')) return [{ locked: options.locked === true }];
        if (sql.includes('SELECT content, version FROM mtagenda')) return state ? [{ content: state.content, version: state.version }] : [];
        if (sql.includes('INSERT INTO mtagenda')) {
          writes.push('insert');
          state = { content: String(params[1]), version: 1, updatedBy: Number(params[2]) };
          return [];
        }
        if (sql.includes('UPDATE mtagenda SET')) {
          writes.push('update');
          state = { content: String(params[1]), version: Number(params[2]), updatedBy: Number(params[3]) };
          return [];
        }
        if (sql.includes('INSERT INTO log')) { writes.push('audit'); return []; }
        throw new Error(`unexpected transaction query: ${sql}`);
      }),
    };
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FROM mtagenda ag JOIN mtrec m')) {
        if (!state) return [];
        return [{
          mt_id: '41', content: state.content, version: state.version,
          created_at: '2026-10-07T10:00:00+09:00', created_by: '7', created_by_name: '처음',
          updated_at: '2026-10-07T11:00:00+09:00', updated_by: String(state.updatedBy), updated_by_name: '수정',
          locked_at: options.startUnknown ? null : '2099-01-01T09:00:00+09:00', locked: options.locked === true,
        }];
      }
      if (sql.includes('FROM mtagenda ag JOIN staff s')) {
        if (!state) return [];
        return [{
          mt_id: '41', content: state.content, version: state.version,
          updated_at: '2026-10-07T11:00:00+09:00', updated_by: String(state.updatedBy), updated_by_name: '수정',
        }];
      }
      throw new Error(`unexpected read query: ${sql}`);
    });
    const repository = { query, manager: { transaction: (work: (manager: typeof em) => unknown) => work(em) } };
    return { service: new OpsService(repository as never, {} as never, {} as never), writes, query };
  }

  it('expectedVersion null은 처음 agenda와 감사 한 줄을 만들고 version 1을 재조회한다', async () => {
    const h = harness(null);
    const out = await h.service.writeMeetingAgenda(9, 41, { content: '  첫 안건  ', expectedVersion: null });
    expect(out).toMatchObject({ meetingId: 41, content: '첫 안건', version: 1, canEdit: true });
    expect(h.writes).toEqual(['insert', 'audit']);
  });

  it('현재 version만 수정하고 before/after 감사와 다음 version을 같은 트랜잭션에 남긴다', async () => {
    const h = harness({ content: '이전', version: 2, updatedBy: 8 });
    const out = await h.service.writeMeetingAgenda(9, 41, { content: '다음', expectedVersion: 2 });
    expect(out).toMatchObject({ content: '다음', version: 3, updatedById: 9 });
    expect(h.writes).toEqual(['update', 'audit']);
  });

  it('stale version은 MEETING_AGENDA_VERSION_CONFLICT이고 쓰기·감사0이다', async () => {
    const h = harness({ content: '최신', version: 4, updatedBy: 8 });
    await expect(h.service.writeMeetingAgenda(9, 41, { content: '옛 초안', expectedVersion: 3 }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'MEETING_AGENDA_VERSION_CONFLICT', actualVersion: 4 }) });
    expect(h.writes).toEqual([]);
  });

  it.each([
    ['시작됨', { locked: true }, 'MEETING_AGENDA_LOCKED'],
    ['시작 모름', { startUnknown: true }, 'MEETING_AGENDA_START_UNKNOWN'],
  ] as const)('%s이면 agenda를 읽거나 쓰기 전에 거절한다', async (_label, options, code) => {
    const h = harness(null, options);
    await expect(h.service.writeMeetingAgenda(9, 41, { content: '안건', expectedVersion: null }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code }) });
    expect(h.writes).toEqual([]);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('가져오기는 version을 확인해 saved=false 초안만 반환하고 쓰지 않는다', async () => {
    const h = harness({ content: '가져올 안건', version: 5, updatedBy: 8 });
    await expect(h.service.importMeetingAgenda(41, { expectedVersion: 4 }))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(h.service.importMeetingAgenda(41, { expectedVersion: 5 })).resolves.toMatchObject({
      meetingId: 41, agendaVersion: 5, minutesDraft: '가져올 안건', saved: false,
    });
    expect(h.writes).toEqual([]);
  });
});
