/** @file-guide
 * 목적: student-registration.dto.ts — 학생 신규 등록 15절과 기존 학생 재활성화의 생성 DTO/OpenAPI 계약
 * 책임/재사용: P-STU15·P-REACT 입력 형상을 생성 타입의 단일 진실원으로 제공한다. endpoint/service/DB writer는 후속 단계가 소유한다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/sprint/TBO-55/BOC-03-SCENARIOS-2026-10-06.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiErrorDto } from '../../common/http.dto';
import { DATE_SCHEMA, ID_SCHEMA, IsCalendarDate, ToHttpInteger } from '../../common/validation';
import { EducationGradeOptionDto } from '../meta/meta.dto';

const ID_MAX = Number.MAX_SAFE_INTEGER;
const PERIOD_PRECISIONS = ['year', 'month', 'day'] as const;
const ENTRY_SOURCES = ['students', 'schedule', 'intake'] as const;
const CONTACT_KINDS = ['phone', 'kakao', 'email', 'other'] as const;
const GUARDIAN_RELATIONS = ['mother', 'father', 'aunt', 'driver', 'other'] as const;
const STUDENT_SOURCES = ['kakao', 'phone', 'blog', 'instagram', 'referral', 'walkin'] as const;
const PROFILE_TEXT_FIELDS = ['want', 'guidance', 'lang', 'target_exam'] as const;
const REACTIVATION_STATUSES = ['withdrawn', 'active', 'unknown'] as const;
const CONSULTATION_CHANNELS = ['visit', 'phone', 'kakao', 'other'] as const;
const REGISTRATION_CONFLICT_CODES = [
  'STUDENT_CREATE_REQUEST_KEY_REUSED',
  'STUDENT_REACTIVATION_REQUEST_KEY_REUSED',
  'STUDENT_PROFILE_VERSION_CONFLICT',
  'STUDENT_DUPLICATE',
  'STUDENT_SAME_NAME',
  'STUDENT_REGISTRATION_OPTION_INACTIVE',
  'STUDENT_REGISTRATION_REFERENCE_NOT_FOUND',
  'STUDENT_REGISTRATION_PERIOD_CONFLICT',
  'STUDENT_REACTIVATION_ACTIVE',
  'STUDENT_REACTIVATION_STATUS_UNKNOWN',
  'STUDENT_REACTIVATION_LEAD_CHANGED',
  'STUDENT_REACTIVATION_LEAD_LINKED',
] as const;

/** 종료값과 종료 정밀도는 둘 다 null이거나 둘 다 존재해야 한다. */
function IsPeriodEndPair(): PropertyDecorator {
  return ValidateBy({
    name: 'isPeriodEndPair',
    validator: {
      validate(value: unknown, args) {
        const to = (args?.object as { to?: unknown } | undefined)?.to;
        return to === null ? value === null : typeof to === 'string' && to.length > 0 && PERIOD_PRECISIONS.includes(value as never);
      },
      defaultMessage: () => '종료일과 종료 정밀도는 함께 입력하거나 함께 null이어야 합니다',
    },
  });
}

/** intake 진입은 lead id를 요구하고 다른 진입은 lead id를 받지 않는다. */
function IsRegistrationLeadContext(): PropertyDecorator {
  return ValidateBy({
    name: 'isRegistrationLeadContext',
    validator: {
      validate(value: unknown, args) {
        const source = (args?.object as { entrySource?: unknown } | undefined)?.entrySource;
        if (source === 'intake') return Number.isInteger(value) && Number(value) >= 1;
        return value === null || value === undefined;
      },
      defaultMessage: () => '상담 진입은 leadId가 필요하고 그 밖의 진입은 leadId를 보내지 않습니다',
    },
  });
}

/** other 관계는 설명을 요구하고 고정 관계는 설명을 받지 않는다. */
function IsGuardianRelationDetail(): PropertyDecorator {
  return ValidateBy({
    name: 'isGuardianRelationDetail',
    validator: {
      validate(value: unknown, args) {
        const relation = (args?.object as { relation?: unknown } | undefined)?.relation;
        return relation === 'other'
          ? typeof value === 'string' && value.trim().length > 0 && value.length <= 40
          : value === null || value === undefined;
      },
      defaultMessage: () => '기타 관계는 설명이 필요하고 고정 관계에는 설명을 보내지 않습니다',
    },
  });
}

/** other 연락처만 사람이 정한 표시 이름을 요구한다. */
function IsContactLabel(): PropertyDecorator {
  return ValidateBy({
    name: 'isContactLabel',
    validator: {
      validate(value: unknown, args) {
        const kind = (args?.object as { kind?: unknown } | undefined)?.kind;
        return kind === 'other'
          ? typeof value === 'string' && value.trim().length > 0 && value.length <= 80
          : value === null;
      },
      defaultMessage: () => '기타 연락처는 이름이 필요하고 고정 연락처 종류에는 이름을 보내지 않습니다',
    },
  });
}

/**
 * BOC-03D-01 권고안 채택(2026-10-07): 수업·청구를 만드는 LeadEnrollDto를 확장하지 않고
 * 학생 15절 전용 생성 계약을 분리한다. 정책 변경 시 P-STU15, BOC-03 시나리오,
 * Front StudentRegistrationForm과 이후 service/migration의 같은 ID 주석을 한 청크에서 수정한다.
 *
 * 배열 상한은 한 요청의 과도한 중첩을 막는 권고값이다. 실제 업무값을 줄이거나 자동 절단하지 않고
 * 초과 요청은 400으로 돌려 화면에서 명시적으로 분할·수정하게 한다.
 */
export class StudentRegistrationPeriodDto {
  @ApiProperty({ ...DATE_SCHEMA, description: '유효 시작 경계 — 종료와 모두 포함' })
  @IsCalendarDate()
  from!: string;

  @ApiProperty({ enum: PERIOD_PRECISIONS, description: '사용자가 알고 입력한 시작 정밀도' })
  @IsIn(PERIOD_PRECISIONS as unknown as string[])
  fromPrecision!: typeof PERIOD_PRECISIONS[number];

  @ApiProperty({ ...DATE_SCHEMA, nullable: true, description: '유효 종료 경계 — null이면 계속' })
  @ValidateIf((_object, value) => value !== null)
  @IsCalendarDate()
  to!: string | null;

  @ApiProperty({ type: String, enum: PERIOD_PRECISIONS, nullable: true, description: '종료가 있으면 사용자가 입력한 정밀도, 없으면 null' })
  @IsPeriodEndPair()
  toPrecision!: typeof PERIOD_PRECISIONS[number] | null;

  @ApiPropertyOptional({ maxLength: 500, description: '기간 기록 메모. 연락처·금액 원문 저장 용도가 아니다.' })
  @IsOptional() @IsString() @MaxLength(500)
  memo?: string;
}

export class StudentRegistrationSchoolPeriodDto extends StudentRegistrationPeriodDto {
  @ApiProperty(ID_SCHEMA)
  @IsInt() @Min(1) @Max(ID_MAX)
  schoolId!: number;
}

export class StudentRegistrationGradePeriodDto extends StudentRegistrationPeriodDto {
  @ApiProperty({ enum: ['US', 'GB', 'KR', 'OTHER'] })
  @IsIn(['US', 'GB', 'KR', 'OTHER'])
  educationSystem!: string;

  @ApiProperty({ maxLength: 16, description: 'GET /students/options의 활성 교육체계별 학년 code' })
  @IsString() @MinLength(1) @MaxLength(16)
  gradeCode!: string;
}

export class StudentRegistrationResidencePeriodDto extends StudentRegistrationPeriodDto {
  @ApiProperty({ pattern: '^[A-Z]{2}$', description: 'GET /students/options의 국가 code' })
  @Matches(/^[A-Z]{2}$/)
  countryCode!: string;

  @ApiProperty({ type: String, nullable: true, maxLength: 64, description: '그 국가의 IANA timezone. 복수 시간대 국가는 Backend가 필수로 검사한다.' })
  @ValidateIf((_object, value) => value !== null)
  @IsString() @MinLength(1) @MaxLength(64)
  timezone!: string | null;
}

export class StudentRegistrationTextPeriodDto extends StudentRegistrationPeriodDto {
  @ApiProperty({ enum: PROFILE_TEXT_FIELDS })
  @IsIn(PROFILE_TEXT_FIELDS as unknown as string[])
  field!: typeof PROFILE_TEXT_FIELDS[number];

  @ApiProperty({ maxLength: 2000 })
  @IsString() @MinLength(1) @Matches(/\S/) @MaxLength(2000)
  value!: string;
}

export class StudentRegistrationContactDto {
  @ApiProperty({ enum: CONTACT_KINDS })
  @IsIn(CONTACT_KINDS as unknown as string[])
  kind!: typeof CONTACT_KINDS[number];

  @ApiProperty({ minLength: 1, maxLength: 254, description: 'kind별 정규화·형식 검사는 공용 Backend validator가 다시 수행한다.' })
  @IsString() @MinLength(1) @Matches(/\S/) @MaxLength(254)
  value!: string;

  @ApiProperty({ type: String, nullable: true, maxLength: 80, description: 'kind=other일 때 필수. 나머지는 null.' })
  @IsContactLabel()
  label!: string | null;
}

export class StudentRegistrationGuardianDto {
  @ApiProperty({ enum: GUARDIAN_RELATIONS })
  @IsIn(GUARDIAN_RELATIONS as unknown as string[])
  relation!: typeof GUARDIAN_RELATIONS[number];

  @ApiProperty({ type: String, nullable: true, maxLength: 40 })
  @IsGuardianRelationDetail()
  relationOther!: string | null;

  @ApiProperty({ type: String, nullable: true, maxLength: 40, description: '이름을 모르면 null. 관계를 이름으로 복제하지 않는다.' })
  @ValidateIf((_object, value) => value !== null)
  @IsString() @MinLength(1) @MaxLength(40)
  name!: string | null;

  @ApiProperty({ type: String, nullable: true, pattern: '^[A-Z]{2}$' })
  @ValidateIf((_object, value) => value !== null)
  @Matches(/^[A-Z]{2}$/)
  countryCode!: string | null;

  @ApiProperty({ description: '0명 허용, 전체 guardians에서 최대 1명은 Backend가 검사한다.' })
  @IsBoolean()
  isPrimary!: boolean;

  @ApiProperty({ description: '납부자 선택은 강제하지 않는다.' })
  @IsBoolean()
  isPayer!: boolean;

  @ApiProperty({ type: [StudentRegistrationContactDto], minItems: 1, maxItems: 20 })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => StudentRegistrationContactDto)
  contacts!: StudentRegistrationContactDto[];
}

export class StudentCreateDto {
  @ApiProperty({ format: 'uuid', description: '같은 actor·같은 body 재시도는 기존 결과, 같은 key의 다른 body는 409' })
  @IsUUID()
  requestKey!: string;

  @ApiProperty({ enum: ENTRY_SOURCES, description: '공용 등록 화면의 실제 진입 문맥' })
  @IsIn(ENTRY_SOURCES as unknown as string[])
  entrySource!: typeof ENTRY_SOURCES[number];

  @ApiProperty({ type: Number, nullable: true, minimum: 1, description: 'entrySource=intake일 때만 상담 원천 id' })
  @IsRegistrationLeadContext()
  leadId!: number | null;

  @ApiProperty({ minLength: 1, maxLength: 40 })
  @IsString() @MinLength(1) @Matches(/\S/) @MaxLength(40)
  name!: string;

  @ApiProperty({ type: String, nullable: true, maxLength: 80 })
  @ValidateIf((_object, value) => value !== null)
  @IsString() @MinLength(1) @MaxLength(80)
  englishName!: string | null;

  @ApiProperty({ enum: ['male', 'female'], description: '신규 학생만 필수. 기존 NULL 학생을 재활성화할 때 소급 강제하지 않는다.' })
  @IsIn(['male', 'female'])
  gender!: 'male' | 'female';

  @ApiProperty({ type: [StudentRegistrationSchoolPeriodDto], maxItems: 50 })
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => StudentRegistrationSchoolPeriodDto)
  schoolHistory!: StudentRegistrationSchoolPeriodDto[];

  @ApiProperty({ type: [StudentRegistrationGradePeriodDto], minItems: 1, maxItems: 50, description: '등록일에 유효한 active 학년 행이 최소 하나 있어야 한다.' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => StudentRegistrationGradePeriodDto)
  gradeHistory!: StudentRegistrationGradePeriodDto[];

  @ApiProperty({ type: [StudentRegistrationResidencePeriodDto], minItems: 1, maxItems: 50, description: '등록일에 유효한 거주국 행이 최소 하나 있어야 한다.' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => StudentRegistrationResidencePeriodDto)
  residenceHistory!: StudentRegistrationResidencePeriodDto[];

  @ApiProperty({ type: [StudentRegistrationTextPeriodDto], maxItems: 100, description: '원하는 것·지도·언어·시험·주의사항의 초기 기간 이력' })
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => StudentRegistrationTextPeriodDto)
  textHistory!: StudentRegistrationTextPeriodDto[];

  @ApiProperty({ type: [StudentRegistrationContactDto], maxItems: 20, description: '학생 본인 연락처는 0개 허용' })
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => StudentRegistrationContactDto)
  contacts!: StudentRegistrationContactDto[];

  @ApiProperty({ ...DATE_SCHEMA, nullable: true, description: '미래 날짜는 Backend가 KST 오늘 기준으로 거절한다.' })
  @ValidateIf((_object, value) => value !== null)
  @IsCalendarDate()
  birthDate!: string | null;

  @ApiProperty({ type: Boolean, nullable: true, description: 'true/false/미상 null을 구분한다.' })
  @ValidateIf((_object, value) => value !== null)
  @IsBoolean()
  hasCitizenship!: boolean | null;

  @ApiProperty({ type: [StudentRegistrationGuardianDto], minItems: 1, maxItems: 20 })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => StudentRegistrationGuardianDto)
  guardians!: StudentRegistrationGuardianDto[];

  @ApiProperty({ type: String, nullable: true, maxLength: 40, description: '별도 PII key로 암호화하며 응답·LOG에 원문을 반환하지 않는다.' })
  @ValidateIf((_object, value) => value !== null)
  @IsString() @MinLength(1) @MaxLength(40)
  cashReceiptNumber!: string | null;

  @ApiProperty({ type: [Number], items: ID_SCHEMA, maxItems: 50, uniqueItems: true })
  @IsArray() @ArrayMaxSize(50) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true }) @Max(ID_MAX, { each: true })
  siblingIds!: number[];

  @ApiProperty({ type: String, enum: STUDENT_SOURCES, nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsIn(STUDENT_SOURCES as unknown as string[])
  source!: typeof STUDENT_SOURCES[number] | null;

  @ApiProperty({ type: [Number], items: ID_SCHEMA, maxItems: 50, uniqueItems: true })
  @IsArray() @ArrayMaxSize(50) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true }) @Max(ID_MAX, { each: true })
  assigneeIds!: number[];

  @ApiProperty({ type: String, nullable: true, maxLength: 2000, description: '15절 기타. 기간 notes와 중복 저장하지 않고 writer가 textHistory로 정규화한다.' })
  @ValidateIf((_object, value) => value !== null)
  @IsString() @MinLength(1) @MaxLength(2000)
  notes!: string | null;

  @ApiProperty({ description: '동명이인 후보 확인 뒤에도 새 학생으로 만들겠다는 명시값. 같은 이름·학년·학교 중복은 별도 409.' })
  @IsBoolean()
  allowSameName!: boolean;
}

export class StudentRegistrationTimezoneOptionDto {
  @ApiProperty({ maxLength: 64 }) timezone!: string;
  @ApiProperty({ maxLength: 80 }) label!: string;
  @ApiProperty() representative!: boolean;
}

export class StudentRegistrationCountryOptionDto {
  @ApiProperty({ pattern: '^[A-Z]{2}$' }) code!: string;
  @ApiProperty({ maxLength: 80 }) label!: string;
  @ApiProperty({ type: [StudentRegistrationTimezoneOptionDto] }) timezones!: StudentRegistrationTimezoneOptionDto[];
}

export class StudentRegistrationWordDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
}

export class StudentRegistrationOptionsDto {
  @ApiProperty({ type: [StudentRegistrationCountryOptionDto] }) countries!: StudentRegistrationCountryOptionDto[];
  @ApiProperty({ type: [EducationGradeOptionDto], description: 'active39 등록 선택지. 비활성·legacy 46행은 보존하되 신규 선택에서 제외한다.' })
  educationGrades!: EducationGradeOptionDto[];
  @ApiProperty({ type: [StudentRegistrationWordDto] }) guardianRelations!: StudentRegistrationWordDto[];
  @ApiProperty({ type: [StudentRegistrationWordDto] }) sources!: StudentRegistrationWordDto[];
}

export class StudentSchoolOptionDto {
  @ApiProperty(ID_SCHEMA) id!: number;
  @ApiProperty({ maxLength: 120 }) name!: string;
  @ApiProperty({ type: String, nullable: true }) countryCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) countryLabel!: string | null;
  @ApiProperty({ type: String, nullable: true }) region!: string | null;
  @ApiProperty({ type: String, nullable: true }) campus!: string | null;
  @ApiProperty() active!: boolean;
}

export class StudentSchoolSearchQueryDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString() @MinLength(1) @Matches(/\S/) @MaxLength(120)
  q!: string;
}

export class StudentSchoolCreateDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() requestKey!: string;
  @ApiProperty({ minLength: 1, maxLength: 120 }) @IsString() @MinLength(1) @Matches(/\S/) @MaxLength(120) name!: string;
  @ApiProperty({ type: String, nullable: true, pattern: '^[A-Z]{2}$' })
  @ValidateIf((_object, value) => value !== null) @Matches(/^[A-Z]{2}$/) countryCode!: string | null;
  @ApiProperty({ type: String, nullable: true, maxLength: 80 })
  @ValidateIf((_object, value) => value !== null) @IsString() @MinLength(1) @MaxLength(80) region!: string | null;
  @ApiProperty({ type: String, nullable: true, maxLength: 120 })
  @ValidateIf((_object, value) => value !== null) @IsString() @MinLength(1) @MaxLength(120) campus!: string | null;
}

export class StudentRegistrationSummaryDto {
  @ApiProperty({ type: 'integer', minimum: 0 }) schoolPeriods!: number;
  @ApiProperty({ type: 'integer', minimum: 1 }) gradePeriods!: number;
  @ApiProperty({ type: 'integer', minimum: 1 }) residencePeriods!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) textPeriods!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) studentContacts!: number;
  @ApiProperty({ type: 'integer', minimum: 1 }) guardians!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) siblingLinks!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) assignees!: number;
}

export class StudentCreatePreviewDto {
  @ApiProperty({ type: 'boolean', enum: [false], description: 'preview는 같은 writer를 끝까지 실행한 뒤 rollback한다.' }) saved!: false;
  @ApiProperty({ format: 'uuid' }) requestKey!: string;
  @ApiProperty({ type: Number, nullable: true, enum: [null] }) studentId!: null;
  @ApiProperty({ type: String, nullable: true, enum: [null] }) profileVersion!: null;
  @ApiProperty({ type: StudentRegistrationSummaryDto }) summary!: StudentRegistrationSummaryDto;
}

export class StudentCreateResultDto {
  @ApiProperty({ type: 'boolean', enum: [true] }) saved!: true;
  @ApiProperty({ format: 'uuid' }) requestKey!: string;
  @ApiProperty(ID_SCHEMA) studentId!: number;
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$', description: 'DB bigint를 JS number로 축소하지 않는 decimal string' }) profileVersion!: string;
  @ApiProperty({ description: '같은 requestKey·같은 body의 기존 결과인가' }) replayed!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: StudentRegistrationSummaryDto }) summary!: StudentRegistrationSummaryDto;
}

/**
 * BOC-03D-02 권고안 채택(2026-10-07): 재활성화는 신규 생성 DTO에 mode를 더하지 않고
 * 같은 STU identity를 대상으로 하는 별도 versioned command로 분리한다. 휴원·수강 종료를
 * 퇴원으로 추정하지 않고 Backend가 내려준 권위 상태가 withdrawn일 때만 허용한다.
 *
 * 오류 본문은 공용 ApiErrorDto의 code/message 두 필드만 유지한다. stale409에는 개인정보나
 * 서버의 현재 row를 싣지 않고 Front가 후보를 재조회한다. 정책 변경 시 P-REACT, BOC-03,
 * Front StudentRegistrationForm/api/students.ts와 이후 service/migration을 같은 청크에서 수정한다.
 */
export class StudentReactivationCandidateQueryDto {
  @ApiPropertyOptional({ maxLength: 80, description: '이름·영문명 literal 검색. 빈 값은 최신 후보 10명.' })
  @IsOptional() @IsString() @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 1000000, default: 1 })
  @IsOptional() @ToHttpInteger() @IsInt() @Min(1) @Max(1000000)
  page?: number;
}

export class StudentReactivationCandidateDto {
  @ApiProperty(ID_SCHEMA) studentId!: number;
  @ApiProperty({ maxLength: 40 }) name!: string;
  @ApiProperty({ type: String, nullable: true, maxLength: 80 }) englishName!: string | null;
  @ApiProperty({ type: String, nullable: true }) gradeLabel!: string | null;
  @ApiProperty({ type: String, nullable: true }) schoolLabel!: string | null;
  @ApiProperty({ enum: REACTIVATION_STATUSES, description: '권위 상태 projection. 휴원·수강 종료로 추정하지 않는다.' })
  status!: typeof REACTIVATION_STATUSES[number];
  @ApiProperty({ description: 'status=withdrawn이고 별도 차단 사유가 없을 때만 true' }) reactivatable!: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'ACTIVE_STUDENT | STATUS_UNKNOWN. 화면이 상태를 다시 계산하지 않는다.' })
  blockedCode!: 'ACTIVE_STUDENT' | 'STATUS_UNKNOWN' | null;
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$', description: '재활성화 expectedProfileVersion에 그대로 보내는 bigint decimal string' })
  profileVersion!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastConsultationAt!: string | null;
  @ApiProperty({ ...DATE_SCHEMA, nullable: true, description: '명시적으로 저장된 마지막 퇴원일. 수강 종료일 추정값이 아니다.' })
  withdrawnOn!: string | null;
}

export class StudentReactivationCandidatesDto {
  @ApiProperty({ type: [StudentReactivationCandidateDto] }) items!: StudentReactivationCandidateDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty({ type: 'integer', enum: [10] }) pageSize!: 10;
}

export class StudentReactivationConsultationDto {
  @ApiProperty({ enum: CONSULTATION_CHANNELS, description: '수동 상담 정보의 방문·전화·카카오톡·기타' })
  @IsIn(CONSULTATION_CHANNELS as unknown as string[])
  channel!: typeof CONSULTATION_CHANNELS[number];

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString() @MinLength(1) @Matches(/\S/) @MaxLength(2000)
  content!: string;

  @ApiProperty({ ...DATE_SCHEMA, nullable: true, description: '다음 일정은 선택. 작성자·작성시각은 서버가 기록한다.' })
  @ValidateIf((_object, value) => value !== null)
  @IsCalendarDate()
  nextOn!: string | null;
}

export class StudentReactivationDto {
  @ApiProperty({ format: 'uuid', description: '같은 actor·같은 정규화 body 재시도는 기존 결과, 다른 body는 409' })
  @IsUUID()
  requestKey!: string;

  @ApiProperty(ID_SCHEMA)
  @IsInt() @Min(1) @Max(ID_MAX)
  studentId!: number;

  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$', description: '후보 응답의 profileVersion. JS number로 변환하지 않는다.' })
  @IsString() @Matches(/^[1-9][0-9]*$/)
  expectedProfileVersion!: string;

  @ApiProperty({ enum: ENTRY_SOURCES })
  @IsIn(ENTRY_SOURCES as unknown as string[])
  entrySource!: typeof ENTRY_SOURCES[number];

  @ApiProperty({ type: Number, nullable: true, minimum: 1, description: 'intake 진입의 원천 lead. 재활성화 상담 record 자체의 identity는 아니다.' })
  @IsRegistrationLeadContext()
  leadId!: number | null;

  @ApiProperty({ ...DATE_SCHEMA, description: 'KST 업무 재활성화일. 과거/미래 허용 범위는 Backend가 검증한다.' })
  @IsCalendarDate()
  reactivateOn!: string;

  @ApiProperty({ type: StudentReactivationConsultationDto, description: '기존 접촉 원장을 오변환하지 않고 새 수동 상담 정보를 한 transaction에 기록한다.' })
  @ValidateNested() @Type(() => StudentReactivationConsultationDto)
  consultation!: StudentReactivationConsultationDto;
}

export class StudentReactivationEffectsDto {
  @ApiProperty({ type: 'boolean', enum: [false] }) studentCreated!: false;
  @ApiProperty({ type: 'boolean', enum: [false] }) enrollmentCreated!: false;
  @ApiProperty({ type: 'boolean', enum: [false] }) lessonCreated!: false;
  @ApiProperty({ type: 'boolean', enum: [false] }) invoiceCreated!: false;
  @ApiProperty({ type: 'boolean', enum: [false] }) bookIssueCreated!: false;
  @ApiProperty({ type: 'boolean', enum: [false] }) guideCreated!: false;
  @ApiProperty({ type: 'boolean', enum: [false] }) firstLessonTaskCreated!: false;
}

export class StudentReactivationPreviewDto {
  @ApiProperty({ type: 'boolean', enum: [false] }) saved!: false;
  @ApiProperty({ format: 'uuid' }) requestKey!: string;
  @ApiProperty(ID_SCHEMA) studentId!: number;
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$' }) profileVersion!: string;
  @ApiProperty({ type: Number, nullable: true, enum: [null] }) consultationId!: null;
  @ApiProperty({ type: StudentReactivationEffectsDto }) effects!: StudentReactivationEffectsDto;
}

export class StudentReactivationResultDto {
  @ApiProperty({ type: 'boolean', enum: [true] }) saved!: true;
  @ApiProperty({ format: 'uuid' }) requestKey!: string;
  @ApiProperty(ID_SCHEMA) studentId!: number;
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$' }) profileVersion!: string;
  @ApiProperty(ID_SCHEMA) consultationId!: number;
  @ApiProperty() replayed!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) reactivatedAt!: string;
  @ApiProperty({ type: StudentReactivationEffectsDto }) effects!: StudentReactivationEffectsDto;
}

/** ApiErrorFilter가 실제 반환하는 두 필드만 좁힌 학생 등록·재활성화 409 계약. */
export class StudentRegistrationConflictDto extends ApiErrorDto {
  @ApiProperty({ enum: REGISTRATION_CONFLICT_CODES })
  declare code: typeof REGISTRATION_CONFLICT_CODES[number];

  @ApiProperty({ description: '재조회·수정 방법을 설명하는 사용자 안내. PII·현재 row 원문은 포함하지 않는다.' })
  declare message: string;
}
