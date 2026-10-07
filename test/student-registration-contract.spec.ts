/** @file-guide
 * 목적: BOC-03D-01/02 학생 신규 등록·재활성화 DTO/OpenAPI 생성 계약을 검증한다.
 * 책임/재사용: endpoint/service/DB 없이 입력 형상·중첩·version/error·extraModels만 검사한다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/sprint/TBO-55/BOC-03-SCENARIOS-2026-10-06.md
 */

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { buildOpenApi } from '../src/openapi';
import {
  StudentCreateDto,
  StudentReactivationDto,
  StudentSchoolCreateDto,
} from '../src/modules/students/student-registration.dto';

const KEY = '00000000-0000-4000-8000-000000000301';
const period = { from: '2026-10-07', fromPrecision: 'day', to: null, toPrecision: null, memo: undefined };
const valid = {
  requestKey: KEY,
  entrySource: 'students',
  leadId: null,
  name: '등록 학생',
  englishName: null,
  gender: 'female',
  schoolHistory: [],
  gradeHistory: [{ ...period, educationSystem: 'KR', gradeCode: 'E6' }],
  residenceHistory: [{ ...period, countryCode: 'KR', timezone: 'Asia/Seoul' }],
  textHistory: [],
  contacts: [],
  birthDate: null,
  hasCitizenship: null,
  guardians: [{
    relation: 'mother', relationOther: null, name: null, countryCode: 'KR', isPrimary: false, isPayer: false,
    contacts: [{ kind: 'phone', value: '01012345678', label: null }],
  }],
  cashReceiptNumber: null,
  siblingIds: [],
  source: null,
  assigneeIds: [],
  notes: null,
  allowSameName: false,
};

describe('BOC-03D-01 학생 신규 등록 DTO/OpenAPI 계약', () => {
  let app: INestApplication;
  let schemas: NonNullable<ReturnType<typeof buildOpenApi>['components']>['schemas'];

  beforeAll(async () => {
    const module = await Test.createTestingModule({}).compile();
    app = module.createNestApplication();
    await app.init();
    const doc = buildOpenApi(app);
    schemas = doc.components?.schemas;
    expect(doc.paths['/students']?.post).toBeUndefined();
  });

  afterAll(async () => { await app?.close(); });

  const schema = (name: string) => {
    const value = schemas?.[name];
    if (!value || '$ref' in value) throw new Error(`${name} schema 누락`);
    return value;
  };

  it('15절 최소 입력은 통과하고 공용 writer 전에는 runtime POST path를 열지 않는다', async () => {
    expect(await validate(plainToInstance(StudentCreateDto, valid))).toHaveLength(0);
    const create = schema('StudentCreateDto');
    expect(create.required).toEqual([
      'requestKey', 'entrySource', 'leadId', 'name', 'englishName', 'gender',
      'schoolHistory', 'gradeHistory', 'residenceHistory', 'textHistory', 'contacts',
      'birthDate', 'hasCitizenship', 'guardians', 'cashReceiptNumber', 'siblingIds',
      'source', 'assigneeIds', 'notes', 'allowSameName',
    ]);
    expect(create.properties?.gradeHistory).toMatchObject({ minItems: 1, maxItems: 50 });
    expect(create.properties?.residenceHistory).toMatchObject({ minItems: 1, maxItems: 50 });
    expect(create.properties?.guardians).toMatchObject({ minItems: 1, maxItems: 20 });
  });

  it('상담 진입 identity·필수 관계·기간 끝쌍·중복 FK를 DTO에서 먼저 거절한다', async () => {
    const invalid = [
      { ...valid, entrySource: 'intake', leadId: null },
      { ...valid, entrySource: 'students', leadId: 7 },
      { ...valid, gradeHistory: [] },
      { ...valid, residenceHistory: [] },
      { ...valid, guardians: [] },
      { ...valid, siblingIds: [7, 7] },
      { ...valid, assigneeIds: [9, 9] },
      { ...valid, gradeHistory: [{ ...period, to: '2026-12-31', toPrecision: null, educationSystem: 'KR', gradeCode: 'E6' }] },
      { ...valid, guardians: [{ ...valid.guardians[0], contacts: [] }] },
      { ...valid, guardians: [{ ...valid.guardians[0], relation: 'other', relationOther: null }] },
      { ...valid, guardians: [{ ...valid.guardians[0], contacts: [{ kind: 'other', value: '보호자 채널', label: null }] }] },
    ];
    for (const body of invalid) {
      expect(await validate(plainToInstance(StudentCreateDto, body))).not.toHaveLength(0);
    }
    expect(await validate(plainToInstance(StudentCreateDto, { ...valid, entrySource: 'intake', leadId: 18 }))).toHaveLength(0);
  });

  it('학생·보호자 연락과 학년·거주·학교는 자유 object가 아닌 생성 schema 참조다', () => {
    const create = schema('StudentCreateDto');
    expect(create.properties?.gradeHistory).toMatchObject({ items: { $ref: '#/components/schemas/StudentRegistrationGradePeriodDto' } });
    expect(create.properties?.residenceHistory).toMatchObject({ items: { $ref: '#/components/schemas/StudentRegistrationResidencePeriodDto' } });
    expect(create.properties?.schoolHistory).toMatchObject({ items: { $ref: '#/components/schemas/StudentRegistrationSchoolPeriodDto' } });
    expect(create.properties?.guardians).toMatchObject({ items: { $ref: '#/components/schemas/StudentRegistrationGuardianDto' } });
    expect(schema('StudentRegistrationGuardianDto').properties?.contacts).toMatchObject({ minItems: 1, items: { $ref: '#/components/schemas/StudentRegistrationContactDto' } });
  });

  it('옵션·학교·preview/result도 생성되며 preview는 saved=false와 DB identity null을 고정한다', async () => {
    for (const name of [
      'StudentRegistrationOptionsDto', 'StudentRegistrationCountryOptionDto', 'StudentSchoolOptionDto',
      'StudentSchoolSearchQueryDto', 'StudentSchoolCreateDto', 'StudentCreatePreviewDto', 'StudentCreateResultDto',
    ]) schema(name);
    expect(schema('StudentCreatePreviewDto').properties?.saved).toMatchObject({ type: 'boolean', enum: [false] });
    expect(schema('StudentCreatePreviewDto').properties?.studentId).toMatchObject({ nullable: true, enum: [null] });
    expect(schema('StudentCreateResultDto').properties?.profileVersion).toMatchObject({ type: 'string', pattern: '^[1-9][0-9]*$' });
    expect(await validate(plainToInstance(StudentSchoolCreateDto, {
      requestKey: KEY, name: '  국제 학교  ', countryCode: 'KR', region: null, campus: null,
    }))).toHaveLength(0);
    expect(await validate(plainToInstance(StudentSchoolCreateDto, {
      requestKey: 'bad', name: '', countryCode: 'KOR', region: null, campus: null,
    }))).not.toHaveLength(0);
  });
});

describe('BOC-03D-02 학생 재활성화·경합 오류 생성 계약', () => {
  let app: INestApplication;
  let doc: ReturnType<typeof buildOpenApi>;
  let schemas: NonNullable<ReturnType<typeof buildOpenApi>['components']>['schemas'];

  beforeAll(async () => {
    const module = await Test.createTestingModule({}).compile();
    app = module.createNestApplication();
    await app.init();
    doc = buildOpenApi(app);
    schemas = doc.components?.schemas;
  });

  afterAll(async () => { await app?.close(); });

  const schema = (name: string) => {
    const value = schemas?.[name];
    if (!value || '$ref' in value) throw new Error(`${name} schema 누락`);
    return value;
  };

  const reactivation = {
    requestKey: '00000000-0000-4000-8000-000000000302',
    studentId: 17,
    expectedProfileVersion: '3',
    entrySource: 'students',
    leadId: null,
    reactivateOn: '2026-10-07',
    consultation: { channel: 'phone', content: '복귀 상담 완료', nextOn: null },
  };

  it('같은 STU를 version과 새 상담으로 재활성화하되 runtime path는 아직 열지 않는다', async () => {
    expect(await validate(plainToInstance(StudentReactivationDto, reactivation))).toHaveLength(0);
    expect(schema('StudentReactivationDto').required).toEqual([
      'requestKey', 'studentId', 'expectedProfileVersion', 'entrySource', 'leadId',
      'reactivateOn', 'consultation',
    ]);
    expect(schema('StudentReactivationDto').properties?.expectedProfileVersion)
      .toMatchObject({ type: 'string', pattern: '^(0|[1-9][0-9]*)$' });
    expect(doc.paths['/students/reactivation-candidates']).toBeUndefined();
    expect(doc.paths['/students/{id}/reactivate']).toBeUndefined();
  });

  it('stale·잘못된 문맥·빈 상담을 DTO 경계에서 먼저 거절한다', async () => {
    for (const body of [
      { ...reactivation, studentId: 0 },
      { ...reactivation, expectedProfileVersion: '-1' },
      { ...reactivation, expectedProfileVersion: '1e2' },
      { ...reactivation, entrySource: 'intake', leadId: null },
      { ...reactivation, entrySource: 'students', leadId: 7 },
      { ...reactivation, reactivateOn: '2026-02-30' },
      { ...reactivation, consultation: { channel: 'phone', content: '   ', nextOn: null } },
      { ...reactivation, consultation: { channel: 'sms', content: '복귀', nextOn: null } },
    ]) expect(await validate(plainToInstance(StudentReactivationDto, body))).not.toHaveLength(0);
  });

  it('legacy 기존 학생의 profileVersion 0을 bigint decimal string으로 허용한다', async () => {
    expect(await validate(plainToInstance(StudentReactivationDto, {
      ...reactivation,
      expectedProfileVersion: '0',
    }))).toHaveLength(0);
  });

  it('후보·preview/result와 공용 두 필드 409 code 집합을 생성한다', () => {
    for (const name of [
      'StudentReactivationCandidateQueryDto', 'StudentReactivationCandidateDto',
      'StudentReactivationCandidatesDto', 'StudentReactivationConsultationDto',
      'StudentReactivationEffectsDto', 'StudentReactivationPreviewDto',
      'StudentReactivationResultDto', 'StudentRegistrationConflictDto',
    ]) schema(name);
    expect(schema('StudentReactivationPreviewDto').properties?.saved).toMatchObject({ enum: [false] });
    expect(schema('StudentReactivationPreviewDto').properties?.consultationId).toMatchObject({ nullable: true, enum: [null] });
    expect(schema('StudentReactivationEffectsDto').properties).toMatchObject({
      studentCreated: { type: 'boolean', enum: [false] },
      enrollmentCreated: { type: 'boolean', enum: [false] },
      lessonCreated: { type: 'boolean', enum: [false] },
      invoiceCreated: { type: 'boolean', enum: [false] },
    });
    expect(Object.keys(schema('StudentRegistrationConflictDto').properties ?? {})).toEqual(['code', 'message']);
    expect(schema('StudentRegistrationConflictDto').properties?.code).toMatchObject({
      enum: expect.arrayContaining([
        'STUDENT_CREATE_REQUEST_KEY_REUSED',
        'STUDENT_REACTIVATION_REQUEST_KEY_REUSED',
        'STUDENT_PROFILE_VERSION_CONFLICT',
        'STUDENT_REACTIVATION_STATUS_UNKNOWN',
      ]),
    });
  });
});
