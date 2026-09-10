/** @file-guide
 * 목적: schedule.dto.ts — AttendanceDto, OccStudentDto, OccurrenceDto, OccurrenceListDto, SCHEDULE_INPUT_LIMITS 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 스케줄 — 탭 01 의 여섯 화면(§07~§12)이 전부 이 한 모양을 쓴다.
 * 일간·주간·월간·학생별·선생님별이 다른 DTO 를 쓰면 색과 상태가 갈린다.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ATTENDANCE_CANCEL_REASONS, ATTENDANCE_RESULTS,
  type AttendanceCancelReason, type AttendanceResult,
} from '../../lib/rules';

export class AttendanceDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: ATTENDANCE_RESULTS }) result!: AttendanceResult;
  @ApiPropertyOptional({ enum: ATTENDANCE_CANCEL_REASONS, nullable: true })
  reason!: AttendanceCancelReason | null;
  @ApiProperty() confirmedBy!: number;
  @ApiProperty() confirmedByName!: string;
  @ApiProperty({ format: 'date-time' }) confirmedAt!: string;
  @ApiProperty({ description: 'completed=true, canceled=false. 정산 소비자가 문자열을 다시 비교하지 않는다' })
  countsForPay!: boolean;
}

export class OccStudentDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) grade?: string | null;
  @ApiProperty({ description: '그날만 빠진 학생인가 (D-R21)' }) droppedOnce!: boolean;
}

export class OccurrenceDto {
  @ApiProperty({ description: '반복 규칙 id' }) serId!: number;
  @ApiProperty({ example: '2026-08-28', description: '화면에 그려질 날짜' }) date!: string;

  @ApiProperty({
    example: '2026-08-28',
    description: '규칙상 원래 날짜 — **EXC 의 키**다. 쓰기(PATCH·DELETE)는 이 값으로 회차를 찾는다',
  })
  onDate!: string;
  @ApiProperty({ description: '자정부터 분' }) startMin!: number;
  @ApiProperty() endMin!: number;
  @ApiProperty() kindKey!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) subKey?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) title?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) teacherId?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) teacherName?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) roomId?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) roomName?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) zaccId?: number | null;
  @ApiProperty({ enum: ['offline', 'online'] }) mode!: string;
  @ApiProperty() canceled!: boolean;
  @ApiProperty({ description: '이 회차에 예외가 붙었는가' }) hasException!: boolean;

  @ApiProperty({
    description:
      '편집할 때 범위를 물어야 하는가 — rrule≠ONCE 이고 남은 회차≥2 (CALENDAR §5A.0). 판정은 서버 한 곳이다',
  })
  recurring!: boolean;

  @ApiProperty({
    enum: ['na', 'plan', 'none', 'draft', 'wait', 'ok', 'rej'],
    description:
      '현재 시각 기준 유효 리포트 상태. 비대상 na · 종료 전 plan · 종료 후 none이며 캘린더 블록 색이 이 값에서 나온다 (D-R7 · V26 §2.3)',
  })
  repState!: string;

  @ApiProperty({ description: '리포트를 썼는가 — 정산에 들어가는 조건 하나 (D-R7)' })
  written!: boolean;

  @ApiProperty({
    enum: ['unavailable', 'readonly', 'manage'],
    description: '출결 동작은 이 서버 판정만 소비한다. 종료 전/관리 취소=unavailable, 강사=readonly, 관리자 이상=manage',
  })
  attendanceMode!: 'unavailable' | 'readonly' | 'manage';

  @ApiProperty({ type: AttendanceDto, nullable: true })
  attendance!: AttendanceDto | null;

  @ApiProperty({ type: [OccStudentDto] }) students!: OccStudentDto[];
}

export class OccurrenceListDto {
  @ApiProperty({ example: '2026-08-24' }) from!: string;
  @ApiProperty({ example: '2026-08-30' }) to!: string;
  @ApiProperty({ type: [OccurrenceDto] }) items!: OccurrenceDto[];
}

/* ══ 쓰기 ═══════════════════════════════════════════════════════════════
   저장은 **자원 + scope** 한 형태로만 받는다. 엔드포인트를 동작마다 만들면
   같은 3범위 판정이 여러 곳에 흩어진다 (D-R16 · D-R21).                     */

import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsDefined, IsIn, IsInt, IsObject, IsOptional, IsString,
  Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { PASTE_MAX } from '../../lib/recurrence';

import { DATE_SCHEMA, ID_SCHEMA, IsCalendarDate, ToHttpInteger } from '../../common/validation';
/** SER varchar 길이와 대응한다. 변경 시 migration/DBML을 같은 청크에서 검증한다. */
export const SCHEDULE_INPUT_LIMITS = { kindKey: 16, subKey: 20, rrule: 80, title: 80 } as const;

/** 조회 필터는 영속 필드가 아니다. 모든 캘린더가 같은 계약과 생성 타입을 소비한다. */
export class OccurrenceQueryDto {
  @ApiProperty({ ...DATE_SCHEMA, example: '2026-08-24' })
  @IsCalendarDate() from!: string;

  @ApiProperty({ ...DATE_SCHEMA, example: '2026-08-30' })
  @IsCalendarDate() to!: string;

  @ApiPropertyOptional({ ...ID_SCHEMA, description: '생략하면 전체. 강사는 유효한 값이어도 서버가 본인 ID를 강제한다' })
  @ValidateIf((_object, value) => value !== undefined)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) teacherId?: number;

  @ApiPropertyOptional(ID_SCHEMA)
  @ValidateIf((_object, value) => value !== undefined)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) studentId?: number;

  @ApiPropertyOptional(ID_SCHEMA)
  @ValidateIf((_object, value) => value !== undefined)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) roomId?: number;
}

/** URL의 식별자는 body와 동일한 안전 정수 범위다. 다섯 쓰기 경로가 재사용한다. */
export class ScheduleParamsDto {
  @ApiProperty(ID_SCHEMA)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) serId!: number;
}

export class AttendanceParamsDto extends ScheduleParamsDto {
  @ApiProperty({ ...DATE_SCHEMA, example: '2026-08-27', description: 'SER_OCC의 원래 날짜 키' })
  @IsCalendarDate() onDate!: string;
}

export class AttendanceWriteDto {
  @ApiProperty({ enum: ATTENDANCE_RESULTS })
  @IsIn(ATTENDANCE_RESULTS as unknown as string[])
  result!: AttendanceResult;

  @ApiPropertyOptional({ enum: ATTENDANCE_CANCEL_REASONS, nullable: true })
  @IsOptional()
  @IsIn(ATTENDANCE_CANCEL_REASONS as unknown as string[])
  reason?: AttendanceCancelReason | null;
}

export class AttendanceMutationResultDto {
  @ApiProperty({ type: AttendanceDto, nullable: true })
  attendance!: AttendanceDto | null;
}

/** 반복 편집 범위 — 단발이면 화면이 묻지 않고 'this' 를 보낸다 */
export const SCOPES = ['this', 'future', 'all'] as const;

export class OccurrencePatchDto {
  @ApiProperty({ enum: SCOPES, description: '이번만 · 향후 · 모두 (D-R16). 첫 회차의 future 는 all 로 강등된다 (D-R17)' })
  @IsIn(SCOPES as unknown as string[])
  scope!: 'this' | 'future' | 'all';

  @ApiProperty({ ...DATE_SCHEMA, description: '규칙상 원래 날짜 — EXC 의 키다. 옮긴 회차도 이 값으로 찾는다' })
  @IsCalendarDate()
  onDate!: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 1439, nullable: true, description: '0~1439' })
  @IsOptional() @IsInt() @Min(0) @Max(1439)
  startMin?: number | null;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 1440, nullable: true })
  @IsOptional() @IsInt() @Min(0) @Max(1440)
  endMin?: number | null;

  @ApiPropertyOptional({ ...ID_SCHEMA, nullable: true })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  teacherId?: number | null;

  @ApiPropertyOptional({ ...ID_SCHEMA, nullable: true })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  roomId?: number | null;

  @ApiPropertyOptional({ ...DATE_SCHEMA, nullable: true, description: '다른 날로 옮길 때만' })
  @IsOptional() @IsCalendarDate()
  date?: string | null;

}

export class OccurrenceCreateDto {
  @ApiProperty({ minLength: 1, maxLength: SCHEDULE_INPUT_LIMITS.kindKey })
  @IsString() @MinLength(1) @MaxLength(SCHEDULE_INPUT_LIMITS.kindKey) kindKey!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: SCHEDULE_INPUT_LIMITS.subKey })
  @IsOptional() @IsString() @MaxLength(SCHEDULE_INPUT_LIMITS.subKey) subKey?: string | null;

  @ApiProperty({ enum: ['offline', 'online'] })
  @IsIn(['offline', 'online']) mode!: string;

  @ApiProperty({ ...DATE_SCHEMA, description: '첫 회차 날짜' }) @IsCalendarDate() fromDate!: string;

  @ApiPropertyOptional({ ...DATE_SCHEMA, nullable: true, description: '없으면 열린 반복' })
  @IsOptional() @IsCalendarDate() toDate?: string | null;

  @ApiProperty({ minLength: 1, maxLength: SCHEDULE_INPUT_LIMITS.rrule, description: "ONCE | DAILY[/n] | WEEKLY:MO,WE[/n]. 요일 SU/MO/TU/WE/TH/FR/SA, n은 양의 안전한 십진 정수. 전체 문법 검증 후 대소문자·바깥 공백·요일 순서·간격1을 formatRule() 형식으로 정규화하며 잘못된 토큰은 BAD_RRULE400" })
  @IsString() @MinLength(1) @MaxLength(SCHEDULE_INPUT_LIMITS.rrule) rrule!: string;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1439 }) @IsInt() @Min(0) @Max(1439) startMin!: number;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1440 }) @IsInt() @Min(0) @Max(1440) endMin!: number;

  @ApiPropertyOptional({ ...ID_SCHEMA, nullable: true })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) teacherId?: number | null;

  @ApiPropertyOptional({ ...ID_SCHEMA, nullable: true })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) roomId?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: SCHEDULE_INPUT_LIMITS.title })
  @IsOptional() @IsString() @MaxLength(SCHEDULE_INPUT_LIMITS.title) title?: string | null;

  @ApiPropertyOptional({ type: 'array', items: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, uniqueItems: true, description: '정식 명단. 생략/빈 배열 허용, null과 중복 ID는 거절' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray() @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true }) @Max(Number.MAX_SAFE_INTEGER, { each: true })
  studentIds?: number[];
}

/** 붙여넣기 원본은 식별자만 받는다. 원본 내용은 트랜잭션 안에서 occ()로 다시 읽는다. */
export class OccurrenceRefDto {
  @ApiProperty(ID_SCHEMA) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) serId!: number;
  @ApiProperty({ ...DATE_SCHEMA, description: '화면에 보이던 날짜. 이동 EXC를 찾고 상대 날짜 간격을 보존한다' })
  @IsCalendarDate() date!: string;
  @ApiProperty({ ...DATE_SCHEMA, description: '규칙상 원래 날짜 — EXC 키' }) @IsCalendarDate() onDate!: string;
}

/** Ctrl+드래그와 Ctrl/⌘+C/X/V가 공유하는 일괄 복제 계약 (D-R19). */
export class OccurrencePasteDto {
  @ApiProperty({ type: [OccurrenceRefDto], minItems: 1, maxItems: PASTE_MAX })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(PASTE_MAX) @IsObject({ each: true })
  @ValidateNested({ each: true }) @Type(() => OccurrenceRefDto)
  sources!: OccurrenceRefDto[];

  @ApiProperty({ enum: SCOPES }) @IsIn(SCOPES as unknown as string[])
  scope!: 'this' | 'future' | 'all';

  @ApiProperty(DATE_SCHEMA) @IsCalendarDate() targetDate!: string;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1439, description: '붙여넣기 기준 시각 — 자정부터 분' })
  @IsInt() @Min(0) @Max(1439) targetStartMin!: number;

  @ApiPropertyOptional({ ...ID_SCHEMA, nullable: true, description: '대상 강사 축이면 덮어쓴다' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) teacherId?: number | null;

  @ApiPropertyOptional({ ...ID_SCHEMA, nullable: true, description: '대상 강의실 축이면 덮어쓴다' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) roomId?: number | null;

  @ApiPropertyOptional({ default: false, description: 'true면 붙여넣기 성공과 같은 트랜잭션에서 원본 회차를 취소한다' })
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() cut?: boolean;
}

/** 다중 이동 한 건 — 원본 참조와 바뀐 위치를 분리해 원본 식별자를 덮어쓰지 않는다. */
export class OccurrenceMoveItemDto {
  @ApiProperty({ type: OccurrenceRefDto })
  @IsDefined() @IsObject() @ValidateNested() @Type(() => OccurrenceRefDto)
  source!: OccurrenceRefDto;

  @ApiProperty(DATE_SCHEMA) @IsCalendarDate() date!: string;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1439 }) @IsInt() @Min(0) @Max(1439) startMin!: number;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 1440 }) @IsInt() @Min(1) @Max(1440) endMin!: number;

  @ApiPropertyOptional({ ...ID_SCHEMA, nullable: true })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) teacherId?: number | null;

  @ApiPropertyOptional({ ...ID_SCHEMA, nullable: true })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) roomId?: number | null;
}

/** 다중 선택 드래그를 한 트랜잭션으로 저장한다 (C-7). */
export class OccurrenceMoveDto {
  @ApiProperty({ type: [OccurrenceMoveItemDto], minItems: 1, maxItems: PASTE_MAX })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(PASTE_MAX) @IsObject({ each: true })
  @ValidateNested({ each: true }) @Type(() => OccurrenceMoveItemDto)
  items!: OccurrenceMoveItemDto[];

  @ApiProperty({ enum: SCOPES }) @IsIn(SCOPES as unknown as string[])
  scope!: 'this' | 'future' | 'all';
}

export class OccurrenceDeleteDto {
  @ApiProperty({ enum: SCOPES }) @IsIn(SCOPES as unknown as string[])
  scope!: 'this' | 'future' | 'all';

  @ApiProperty(DATE_SCHEMA) @IsCalendarDate() onDate!: string;
}

/** §12 수강 학생 — 넣고 빼기도 3범위다 (D-R21) */
export class RosterPatchDto {
  @ApiProperty({ enum: ['add', 'dropOnce', 'undoOnce', 'dropAll'] })
  @IsIn(['add', 'dropOnce', 'undoOnce', 'dropAll'])
  op!: 'add' | 'dropOnce' | 'undoOnce' | 'dropAll';

  @ApiProperty(DATE_SCHEMA) @IsCalendarDate() onDate!: string;
  @ApiProperty(ID_SCHEMA) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) studentId!: number;
}

export class WriteResultDto {
  @ApiProperty({ description: '실제로 적용된 범위 — 「향후」가 「모두」로 강등되면 여기서 드러난다 (D-R17)' })
  effScope!: string;

  @ApiProperty({ type: [String], description: '사람이 읽는 변경 기록. 화면이 그대로 보여 준다' })
  log!: string[];

  @ApiProperty({ description: '다시 펼친 회차 수' }) projected!: number;

  @ApiProperty({ type: [Number], description: '영향받은 규칙 — 화면은 이 범위만 다시 읽으면 된다' })
  serIds!: number[];
}

/** 명단 변경 직후 서버가 같은 트랜잭션 스냅숏에서 계산한 후속 작업 (D-R22). */
export class RosterResultDto extends WriteResultDto {
  @ApiProperty({ description: '그 회차의 변경 후 실제 인원' })
  count!: number;

  @ApiProperty({ description: 'KIND.cap — 정원' })
  cap!: number;

  @ApiProperty({ type: [String], description: '아직 발송된 수업 안내가 없는 학생' })
  needGuide!: string[];

  @ApiProperty({ type: [String], description: '해당 과목의 활성 배부 교재가 없는 학생' })
  needBook!: string[];
}

export class HorizonDto {
  @ApiProperty({ description: '펼쳐 둔 기간의 시작' }) from!: string;
  @ApiProperty({ description: '펼쳐 둔 기간의 끝' }) to!: string;
  @ApiProperty({ description: '요청 범위가 이 밖으로 나갔는가 — 화면이 「비었다」와 「아직 안 펼쳤다」를 구분한다' })
  clamped!: boolean;
}
