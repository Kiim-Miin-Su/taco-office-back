/** @file-guide
 * 목적: BO-Q13 회의 사전 안건의 DTO/OpenAPI 계약과 입력 경계를 검증한다.
 * 책임/재사용: DTO 단계의 생성 계약만 검증하며 endpoint/service/DB 구현 완료를 주장하지 않는다.
 * 검증/작업 지침: docs/decisions/PLANNING-REQUIRED.md BO-Q13 · docs/sprint/TBO-55/features/BOC-12-MEETING-OPS-EXEC-FRONT-2026-10-07.md
 */

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  MeetingAgendaImportDto,
  MeetingAgendaWriteDto,
} from '../src/modules/ops/ops.dto';
import { buildOpenApi } from '../src/openapi';

describe('BO-Q13 회의 사전 안건 DTO/OpenAPI 계약', () => {
  let app: INestApplication;
  let schemas: NonNullable<ReturnType<typeof buildOpenApi>['components']>['schemas'];

  beforeAll(async () => {
    const module = await Test.createTestingModule({}).compile();
    app = module.createNestApplication();
    await app.init();
    schemas = buildOpenApi(app).components?.schemas;
  });

  afterAll(async () => { await app?.close(); });

  const schema = (name: string) => {
    const value = schemas?.[name];
    if (!value || '$ref' in value) throw new Error(`${name} schema 누락`);
    return value;
  };

  it('별도 agenda의 본문·version·최초/수정 actor·잠금·capability를 한 응답으로 생성한다', () => {
    const agenda = schema('MeetingAgendaDto');
    expect(agenda.required).toEqual([
      'meetingId', 'content', 'version',
      'createdAt', 'createdById', 'createdByName',
      'updatedAt', 'updatedById', 'updatedByName',
      'locked', 'lockedAt', 'canEdit', 'editBlockedReason', 'canImportToMinutes',
    ]);
    expect(agenda.properties?.content).toMatchObject({ type: 'string', maxLength: 8000 });
    expect(agenda.properties?.version).toMatchObject({ type: 'integer', minimum: 1 });
    for (const field of ['createdAt', 'updatedAt', 'lockedAt']) {
      expect(agenda.properties?.[field]).toMatchObject({ type: 'string', format: 'date-time' });
    }
    expect(agenda.properties?.lockedAt).toMatchObject({ nullable: true });
    expect(agenda.properties?.editBlockedReason).toMatchObject({ type: 'string', nullable: true });
  });

  it('목록과 상세가 같은 agenda summary/full schema를 선택적으로 싣는다', () => {
    const meeting = schema('MeetingDto');
    const detail = schema('MeetingDetailDto');
    expect(meeting.properties?.agenda).toMatchObject({
      nullable: true,
      allOf: [{ $ref: '#/components/schemas/MeetingAgendaSummaryDto' }],
    });
    expect(detail.properties?.agenda).toMatchObject({
      nullable: true,
      allOf: [{ $ref: '#/components/schemas/MeetingAgendaDto' }],
    });
    expect(meeting.required ?? []).not.toContain('agenda');
    expect(detail.required ?? []).not.toContain('agenda');
    expect(meeting.properties?.minutesSummary).toMatchObject({
      nullable: true,
      allOf: [{ $ref: '#/components/schemas/MeetingMinutesSummaryDto' }],
    });
  });

  it('write는 create=null/update=양의 version을 구분하고 누락·공백·범위 밖을 거절한다', async () => {
    for (const body of [
      { content: '첫 안건', expectedVersion: null },
      { content: '수정 안건', expectedVersion: 1 },
    ]) {
      expect(await validate(plainToInstance(MeetingAgendaWriteDto, body))).toHaveLength(0);
    }
    for (const body of [
      { content: '안건' },
      { content: '   ', expectedVersion: null },
      { content: '안건', expectedVersion: 0 },
      { content: '안건', expectedVersion: 1.5 },
      { content: 'x'.repeat(8001), expectedVersion: 1 },
    ]) {
      expect(await validate(plainToInstance(MeetingAgendaWriteDto, body))).not.toHaveLength(0);
    }
    const write = schema('MeetingAgendaWriteDto');
    expect(write.required).toEqual(['content', 'expectedVersion']);
    expect(write.properties?.expectedVersion).toMatchObject({ type: 'integer', minimum: 1, nullable: true });
  });

  it('안건 가져오기는 본 version을 요구하고 저장되지 않은 minutes draft임을 응답에 고정한다', async () => {
    expect(await validate(plainToInstance(MeetingAgendaImportDto, { expectedVersion: 3 }))).toHaveLength(0);
    for (const body of [{}, { expectedVersion: null }, { expectedVersion: 0 }, { expectedVersion: 2.5 }]) {
      expect(await validate(plainToInstance(MeetingAgendaImportDto, body))).not.toHaveLength(0);
    }
    const result = schema('MeetingAgendaImportResultDto');
    expect(result.properties?.saved).toMatchObject({ type: 'boolean', enum: [false] });
    expect(result.properties?.minutesDraft).toMatchObject({ type: 'string', maxLength: 8000 });
    expect(result.required).toEqual([
      'meetingId', 'agendaVersion', 'minutesDraft',
      'sourceUpdatedAt', 'sourceUpdatedById', 'sourceUpdatedByName', 'saved',
    ]);
  });
});
