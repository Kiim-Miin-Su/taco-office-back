/** @file-guide
 * 목적: lead-plan.dto.ts — LeadPlanLineDto, LeadApptDto, LeadPlanWriteDto, LeadApptWriteDto, LeadApptParamsDto (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 상담 배치안 초안 · 2차/진단 일정 · 보류 연장 (wave3 g3 · 23-15 · 23-16 · 24-07).
 *
 * - 배치안 줄은 **과목 · 주 N회 · 강사**만 적는다. 단가는 단가표(RATE)가 정본이라 받지 않고, 읽을 때 적은 날의 단가를 붙인다(금액 권한만).
 * - 일정은 종류(진단 · 2차)마다 한 줄 — 날짜 · 시각 · 강의실/온라인. 시간표 회차가 이어지면 「미생성」이 풀린다.
 * 이 파일은 ops.dto 를 import 하지 않는다 — LeadDto 가 여기 것을 한 방향으로 가져간다(lead-diag.dto 와 같은 규약 · 순환 import 방지).
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { DATE_SCHEMA, ID_SCHEMA, IsCalendarDate, ToHttpInteger } from '../../common/validation';
import { LEAD_APPT_KINDS } from '../../lib/intake-words';
import { SCHEDULE_INPUT_LIMITS } from '../schedule/schedule.dto';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;
/** 배치안 줄 수의 위 끝 — DB CHECK(lead_plan_seq_range 1~8)와 같은 수 */
export const LEAD_PLAN_MAX_LINES = 8;

/** 배치안 한 줄 — 원본 §23 「SAT Reading 주2 · Rebecca」 · §24 「MAP Reading 주2 · Allissa · ₩90,000」 */
export class LeadPlanLineDto {
  @ApiProperty({ description: '줄 차례 1~8' }) seq!: number;
  @ApiProperty() kindKey!: string;
  @ApiProperty({ description: '종류 이름 (코드표)' }) kindLabel!: string;
  @ApiPropertyOptional(S) subKey?: string | null;
  @ApiPropertyOptional({ ...S, description: '과목 이름 (코드표)' }) subLabel?: string | null;
  @ApiProperty({ description: '주 N회 (1~7)' }) perWeek!: number;
  @ApiPropertyOptional(N) teacherId?: number | null;
  @ApiPropertyOptional(S) teacherName?: string | null;
  @ApiProperty({ description: '한 줄 낱말 — 「SAT Reading 주2 · Rebecca」. 서버가 만든다 (D-R18)' }) label!: string;
  @ApiPropertyOptional({
    ...N,
    description: '회당 단가 — 줄을 적은 날의 단가표(RATE · 1인 구간 · 과목 단가 우선). 금액을 볼 수 없는 사람·단가표에 없는 과목은 null (D-R39 · 짓지 않는다)',
  })
  unitPrice?: number | null;
}

/** 2차 · 진단 일정 한 줄 — 원본 §23 「진단 08-24 10:00 · 본원 [미생성]」 */
export class LeadApptDto {
  @ApiProperty({ enum: [...LEAD_APPT_KINDS], description: 'diag(진단고사) | second(2차 상담)' }) kind!: string;
  @ApiProperty({ description: '「진단」 · 「2차」 (서버 낱말)' }) kindLabel!: string;
  @ApiProperty({ ...DATE_SCHEMA, description: '날짜 — 시간표에 만든 뒤에는 그 회차의 날짜(시간표가 정본)' }) onDate!: string;
  @ApiProperty({ description: '시작 분' }) startMin!: number;
  @ApiProperty({ description: '끝 분' }) endMin!: number;
  @ApiProperty({ enum: ['offline', 'online'] }) mode!: string;
  @ApiPropertyOptional(N) roomId?: number | null;
  @ApiProperty({ description: '장소 한 마디 — 강의실 이름 · 「온라인 줌」 · 「장소 미정」' }) placeLabel!: string;
  @ApiPropertyOptional({ ...N, description: '시간표 회차 — 없으면 「미생성」' }) serId?: number | null;
  @ApiProperty({ description: '시간표에 만들었는가 — false 면 카드에 「미생성」' }) scheduled!: boolean;
}

/** 배치안 한 줄 쓰기 — 과목 · 주 N회 · 강사. 단가는 받지 않는다(RATE 가 정본) */
export class LeadPlanLineWriteDto {
  @ApiProperty({ minLength: 1, maxLength: SCHEDULE_INPUT_LIMITS.kindKey, description: '종류 — 코드표(KIND)' })
  @IsString() @MinLength(1, { message: '줄마다 종류를 고르세요' }) @MaxLength(SCHEDULE_INPUT_LIMITS.kindKey)
  kindKey!: string;

  @ApiPropertyOptional({ ...S, maxLength: SCHEDULE_INPUT_LIMITS.subKey, description: '과목 — 코드표(SUB) · 비우면 종류 이름으로 부른다' })
  @IsOptional() @IsString() @MaxLength(SCHEDULE_INPUT_LIMITS.subKey)
  subKey?: string | null;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 7, description: '주 N회' })
  @IsInt({ message: '주 몇 회인지 적어 주세요' }) @Min(1, { message: '주 1~7회입니다' }) @Max(7, { message: '주 1~7회입니다' })
  perWeek!: number;

  @ApiPropertyOptional({ ...N, description: '강사 — 비워도 된다(초안)' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  teacherId?: number | null;
}

/** 배치안 통째로 바꾸기 — 빈 배열이면 초안을 비운다 */
export class LeadPlanWriteDto {
  @ApiProperty({ type: () => [LeadPlanLineWriteDto], maxItems: LEAD_PLAN_MAX_LINES })
  @IsArray() @ArrayMaxSize(LEAD_PLAN_MAX_LINES, { message: `배치안 줄은 ${LEAD_PLAN_MAX_LINES}줄까지입니다` })
  @ValidateNested({ each: true }) @Type(() => LeadPlanLineWriteDto)
  lines!: LeadPlanLineWriteDto[];
}

/** 2차 · 진단 일정 한 줄 쓰기 — 종류마다 한 줄이라 같은 종류를 다시 보내면 고쳐 적는다 */
export class LeadApptWriteDto {
  @ApiProperty({ enum: [...LEAD_APPT_KINDS], description: 'diag(진단고사) | second(2차 상담)' })
  @IsIn([...LEAD_APPT_KINDS], { message: '일정 종류는 진단 또는 2차입니다' })
  kind!: string;

  @ApiProperty({ ...DATE_SCHEMA, description: '날짜' })
  @IsCalendarDate()
  onDate!: string;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1439, description: '시작 분 (0~1439 · 시간표 회차와 같은 범위)' })
  @IsInt() @Min(0) @Max(1439)
  startMin!: number;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1440, description: '끝 분 — 시작보다 뒤' })
  @IsInt() @Min(0) @Max(1440)
  endMin!: number;

  @ApiProperty({ enum: ['offline', 'online'], description: '현장이면 강의실, 온라인이면 강의실 없음' })
  @IsIn(['offline', 'online'], { message: '현장 또는 온라인입니다' })
  mode!: string;

  @ApiPropertyOptional({ ...N, description: '강의실 — 현장일 때(비우면 「장소 미정」)' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  roomId?: number | null;
}

/** DELETE /ops/leads/{id}/appts/{kind} 경로 — 일정 한 줄 지우기 (23-15 · impl3-w8) */
export class LeadApptParamsDto {
  @ApiProperty(ID_SCHEMA)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  id!: number;

  @ApiProperty({ enum: [...LEAD_APPT_KINDS], description: 'diag(진단고사) | second(2차 상담)' })
  @IsIn([...LEAD_APPT_KINDS], { message: '일정 종류는 진단 또는 2차입니다' })
  kind!: string;
}
