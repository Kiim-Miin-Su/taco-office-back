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
  ATTENDANCE_CANCEL_REASONS, ATTENDANCE_RESULTS, CANCEL_TREATS,
  type AttendanceCancelReason, type AttendanceResult, type CancelTreat,
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
  /* 휴강의 사유와 처리 — 낱말은 서버가 만든다 (D-R18 · C92). 옛 휴강 행은 넷 다 null 이며 기본 정책(이월)이다 */
  @ApiPropertyOptional({ enum: ATTENDANCE_CANCEL_REASONS, nullable: true, description: '휴강 사유 코드 — 취소된 회차만' })
  cancelKind?: AttendanceCancelReason | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: '휴강 사유 이름' }) cancelKindLabel?: string | null;
  @ApiPropertyOptional({ enum: CANCEL_TREATS, nullable: true, description: 'carry 이월 · deduct 차감 · makeup 보강 이관' })
  cancelTreat?: CancelTreat | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: '처리 이름 — 「이월」 「차감」 「보강 이관」' })
  cancelTreatLabel?: string | null;
  /* 보강 링크 (C92-b · C-34) — 원래 회차는 보강이 언제인지, 보강 회차는 어느 회차의 보강인지 */
  @ApiPropertyOptional({ type: Number, nullable: true, description: '보강 이관이면 보강 회차의 SER id' })
  makeupSerId?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: '보강 회차의 날짜 YYYY-MM-DD' })
  makeupDate?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '보강 회차의 시작 (KST 분)' })
  makeupStartMin?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: '이 회차가 보강이면 원래 회차의 날짜 YYYY-MM-DD' })
  makeupOfDate?: string | null;
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

  @ApiProperty({
    description:
      '이 회차가 **이미 끝났는가** — 서버 시각 기준 사실 하나. 리포트 상태(plan/none)와 같은 값에서 나온다. '
      + '화면의 기간 집계는 이 값으로 「리포트 미제출」을 센다: 「썼다」는 제출부터라서 **끝난 수업의 초안**도 미제출이다 (N-19)',
  })
  ended!: boolean;

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

/**
 * 휴강 · 취소 (§12 「휴강 · 수정」 · 테스트 시나리오 C-30 ~ C-32).
 *
 * `scope='this'` 가 휴강이다. 사유와 처리를 함께 보내면 서버가 정책(학원 사정은 차감 불가)을
 * 판정하고 EXC 에 새긴다. 둘 다 비우면 옛 방식 그대로 취소만 남긴다(기본 정책 = 이월).
 * `future`·`all` 은 휴강이 아니라 **수업 종료**라 사유·처리를 받지 않는다.
 */
/** 보강 회차 — 원래 회차의 종류·과목·명단·강사·강의실을 물려받고 날짜·시각만 새로 정한다 (C92-b · C-34) */
export class MakeupDto {
  @ApiProperty({ ...DATE_SCHEMA, description: '보강 날짜 (실제 달력 날짜)' }) @IsCalendarDate() date!: string;
  @ApiProperty({ description: 'KST 0~1439 분' }) @IsInt() @Min(0) @Max(1439) startMin!: number;
  @ApiProperty({ description: 'KST 분 · 시작보다 뒤 · 24:00 = 1440' }) @IsInt() @Min(1) @Max(1440) endMin!: number;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '비우면 원래 회차의 강사 · null 이면 미지정' })
  @ValidateIf((_o, v) => v !== undefined && v !== null) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  teacherId?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '비우면 원래 회차의 강의실 · null 이면 미지정' })
  @ValidateIf((_o, v) => v !== undefined && v !== null) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  roomId?: number | null;
}

export class OccurrenceDeleteDto {
  @ApiProperty({ enum: SCOPES }) @IsIn(SCOPES as unknown as string[])
  scope!: 'this' | 'future' | 'all';

  @ApiProperty(DATE_SCHEMA) @IsCalendarDate() onDate!: string;

  @ApiPropertyOptional({ enum: ATTENDANCE_CANCEL_REASONS, description: '휴강 사유 — 처리를 보내면 필수' })
  @IsOptional() @IsIn(ATTENDANCE_CANCEL_REASONS as unknown as string[])
  cancelKind?: AttendanceCancelReason;

  @ApiPropertyOptional({ enum: CANCEL_TREATS, description: 'carry 이월(기본) · deduct 차감(학생 결석만) · makeup 보강 이관' })
  @IsOptional() @IsIn(CANCEL_TREATS as unknown as string[])
  cancelTreat?: CancelTreat;

  @ApiPropertyOptional({ description: '메모 — 「아침에 발열로 연락」 (500자)', maxLength: 500 })
  @IsOptional() @IsString() @MaxLength(500)
  memo?: string;

  @ApiPropertyOptional({ type: () => MakeupDto, description: '처리가 makeup 이면 필수 — 보강 회차의 날짜·시각 (C-34)' })
  @IsOptional() @IsObject() @ValidateNested() @Type(() => MakeupDto)
  makeup?: MakeupDto;
}

/** 그날 전체 휴강 (테스트 시나리오 C-33 · N-133) — 그날의 취소 아닌 회차 전부를 같은 사유·처리로 */
export class DayCancelDto {
  @ApiProperty({ ...DATE_SCHEMA, description: '휴강할 날짜 (실제 달력 날짜)' }) @IsCalendarDate() date!: string;

  @ApiProperty({ enum: ATTENDANCE_CANCEL_REASONS, description: '학원 사정 · 공휴일 … (차감은 학생 결석에만)' })
  @IsIn(ATTENDANCE_CANCEL_REASONS as unknown as string[])
  cancelKind!: AttendanceCancelReason;

  @ApiPropertyOptional({ enum: CANCEL_TREATS, description: '비우면 이월 (기본) — 회차 하나의 휴강과 같은 규칙' })
  @IsOptional() @IsIn(CANCEL_TREATS as unknown as string[])
  cancelTreat?: CancelTreat;

  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @IsString() @MaxLength(500)
  memo?: string;
}

/** §12 수강 학생 — 넣고 빼기도 3범위다 (D-R21) */
export class RosterPatchDto {
  @ApiProperty({ enum: ['add', 'dropOnce', 'undoOnce', 'dropAll'] })
  @IsIn(['add', 'dropOnce', 'undoOnce', 'dropAll'])
  op!: 'add' | 'dropOnce' | 'undoOnce' | 'dropAll';

  @ApiProperty(DATE_SCHEMA) @IsCalendarDate() onDate!: string;
  @ApiProperty(ID_SCHEMA) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) studentId!: number;
}

/**
 * 저장은 됐지만 **강사가 못 한다고 적어 둔 시간**에 걸쳤다 (원본 §15·§16 불가 시간).
 *
 * 막지 않는다 — 불가 시간은 DB 제약이 아니라 강사가 미리 낸 사정이고, 급하면 관리자가
 * 그 위에 잡는 일이 실제로 있다. 다만 **말은 해야 한다**: 지금까지 관리자 화면은 UNAV 를
 * 어디에서도 보여 주지 않아 **적어 낸 사람만 알고 잡는 사람은 몰랐다.**
 */
export class UnavWarnDto {
  @ApiProperty() serId!: number;
  @ApiProperty({ description: '회차가 실제로 놓인 달력 날짜' }) date!: string;
  @ApiProperty() teacherId!: number;
  @ApiProperty() teacherName!: string;
  @ApiProperty() startMin!: number;
  @ApiProperty() endMin!: number;
  @ApiProperty({ description: '강사가 적은 사유 — 화면이 그대로 보여 준다' }) reason!: string;
}

export class WriteResultDto {
  @ApiProperty({ description: '실제로 적용된 범위 — 「향후」가 「모두」로 강등되면 여기서 드러난다 (D-R17)' })
  effScope!: string;

  @ApiProperty({ type: [String], description: '사람이 읽는 변경 기록. 화면이 그대로 보여 준다' })
  log!: string[];

  @ApiProperty({ description: '다시 펼친 회차 수' }) projected!: number;

  @ApiProperty({ type: [Number], description: '영향받은 규칙 — 화면은 이 범위만 다시 읽으면 된다' })
  serIds!: number[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: '직전 일정 쓰기 실행 취소 토큰. 같은 수업이 다시 바뀌지 않은 때만 10분 안에 한 번 사용한다.',
  })
  undoToken!: string | null;

  @ApiProperty({
    type: [UnavWarnDto],
    description: '강사 불가 시간과 겹친 회차 — **막지 않고 알린다.** 오늘 이후·취소 아닌 것만, 최대 10줄',
  })
  unavailable!: UnavWarnDto[];
}

/** 그날 전체 휴강의 결과 — 몇 회차를 접었는지 서버가 센다 (D-R37) */
export class DayCancelResultDto extends WriteResultDto {
  @ApiProperty({ description: '이번에 휴강 처리한 회차 수' }) count!: number;
  @ApiProperty({ description: '이미 휴강이라 건너뛴 회차 수' }) skipped!: number;
}

export class ScheduleUndoDto {
  @ApiProperty({ minLength: 32, maxLength: 100000, description: '직전 WriteResult.undoToken 그대로' })
  @IsString() @MinLength(32) @MaxLength(100000) token!: string;
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

  /* N-17 채택(§4-17 ①) — 가격은 서버 한 곳(lib/rules.rosterPricing)만 계산한다 (§54 · D-R22). */
  @ApiProperty({ description: '해당 종류·과목의 인원 구간 단가표 존재 여부 — false 면 아래 3필드는 null' })
  priced!: boolean;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '대표 1인 단가 — 적용 구간(tierHeads)의 RATE 단가, 예외 학생 제외 기준 (N-17-a 표본)' })
  unitPrice?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '수업당 총액 — Σ(학생별 STURATE 예외 ?? 구간 단가)' })
  total?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '적용된 인원 구간 (변경 후 인원 이하의 최대 heads)' })
  tierHeads?: number | null;
  @ApiProperty({ description: '단가 예외(STURATE) 적용 학생 수' })
  overrideCount!: number;
}

export class HorizonDto {
  @ApiProperty({ description: '펼쳐 둔 기간의 시작' }) from!: string;
  @ApiProperty({ description: '펼쳐 둔 기간의 끝' }) to!: string;
  @ApiProperty({ description: '요청 범위가 이 밖으로 나갔는가 — 화면이 「비었다」와 「아직 안 펼쳤다」를 구분한다' })
  clamped!: boolean;
}

/* ══ §79 수강 학생 — 학생 트래킹 (C55) ═══════════════════════════════════
   원문 §79 는 수업 상세의 「수강 학생」 단계 오른쪽에 학생마다 카드 넉 장과
   최신 리포트 3건을 둔다. 회차 목록(`GET /schedule/occurrences`)에 실으면
   한 주치 회차마다 학생별 질의가 붙는다 — 창을 열 때만 따로 부른다.        */

/** §79 카드의 리포트 한 줄 */
export class TrackedReportDto {
  @ApiProperty() repId!: number;
  @ApiProperty({ example: '2026-08-19' }) onDate!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) subjectName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) teacherName?: string | null;
  /**
   * 「정시 / 지연」 — 판정은 `lib/rules.tierFor` 한 곳이다. 제출 시각과 수업 종료 시각을
   * 화면에서 견주면 여기 칩과 강사 화면의 차감액이 갈린다 (D-R32 · D-R39).
   */
  @ApiProperty({ description: '기한 안에 냈는가 — 차감 0 이면 정시' }) onTime!: boolean;
  @ApiProperty({ description: '칩에 쓰는 이름 — 낱말은 서버가 만든다 (D-R18)' }) onTimeLabel!: string;
  @ApiPropertyOptional({ ...{ type: String, nullable: true }, description: '본문 발췌 — 원문 카드의 두 줄' })
  excerpt?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: '숙제 줄' }) homework?: string | null;
}

/** §79 오른쪽의 학생 카드 한 장 */
export class TrackedStudentDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) grade?: string | null;
  @ApiProperty({ description: '그날만 빠진 학생인가 (D-R21)' }) droppedOnce!: boolean;

  @ApiProperty({ description: '반납하지 않은 배부 교재 수 — 원문 「교재 N」' }) bookCount!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '배부 완료 교재 중 진도 쪽수와 전체 쪽수가 모두 있는 책의 동일가중 평균. 알 수 있는 책이 없으면 null',
  })
  progressAverage!: number | null;
  @ApiProperty({ description: '진도 평균에 포함된 교재 수. 0이면 0%가 아니라 미확인이다' })
  progressKnownBooks!: number;
  @ApiProperty({ description: '이 수업의 안내가 나갔는가 — 원문 「안내 됨 / 안내 없음」' }) guided!: boolean;

  /** 원문 「13/13 · 30일 출결」 — 확정된 출결만 센다. 아직 확정 안 한 회차는 분모에도 없다 */
  @ApiProperty({ description: '최근 30일 중 진행된 회차 수' }) attendDone!: number;
  @ApiProperty({ description: '최근 30일 중 출결이 확정된 회차 수' }) attendTotal!: number;

  /**
   * 미수 — **금액이라 대표만 본다** (D-R39). 못 보는 사람에게는 서버가 `null` 을 보낸다.
   * 0 원과 「가려짐」을 화면이 구분할 수 있도록 0 을 null 로 바꾸지 않는다.
   */
  @ApiPropertyOptional({ type: Number, nullable: true, description: '미수 합계 — 볼 수 없으면 null' })
  unpaid?: number | null;

  @ApiProperty({ type: [TrackedReportDto], description: '최신 리포트 3건 — 쓴 것만' })
  reports!: TrackedReportDto[];
}

/** `GET /schedule/tracking` — §79 수강 학생 단계의 오른쪽 칸 */
/**
 * §12 준비 한 줄 — **낱말도 판정도 횟수도 서버가 만든다** (D-R18 · D-R39 · D-R37).
 *
 * 전에는 화면이 `doneOf()` 로 스스로 판정하고 줄 이름을 자기 파일에 적고 있었다.
 * 그러면 현황판이 「됐다」는 회차를 상세는 「아직」이라 말할 수 있다.
 */
export class LessonPrepRowDto {
  @ApiProperty({ description: '줄을 가리키는 열쇠 — 화면이 비교하지 않고 그리기만 한다' }) key!: string;
  @ApiProperty({ description: '줄 이름 — 원문 §12·§79 의 낱말 그대로' }) label!: string;
  @ApiProperty({ description: '됐는가' }) done!: boolean;
  @ApiProperty({ type: String, nullable: true, description: '줄 밑의 값 — 「1명 / 정원 4명 · 이담흔」 같은 것' })
  detail!: string | null;
}

export class LessonTrackingDto {
  @ApiProperty() serId!: number;
  @ApiProperty({ example: '2026-08-21' }) onDate!: string;
  @ApiProperty({ description: 'KIND.cap — 정원' }) cap!: number;
  @ApiProperty({ description: '지금 인원 — 그날 빠진 학생은 빼고 센다 (D-R21)' }) count!: number;
  @ApiProperty({ description: '몇 명 더 넣을 수 있는가 — 화면이 cap − count 를 다시 하지 않는다' })
  canAdd!: number;
  @ApiProperty({ description: '머리줄 문장 — 원문 「정원 4명 · 1명 더 넣을 수 있습니다」' }) capLabel!: string;

  /* 가격은 명단 쓰기 응답(RosterResultDto)과 **같은 함수**에서 나온다 (lib/rules.rosterPricing · §54) */
  @ApiProperty({ description: '인원 구간 단가표가 있는가' }) priced!: boolean;
  @ApiPropertyOptional({ type: Number, nullable: true }) unitPrice?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) total?: number | null;
  @ApiProperty({ description: '금액을 볼 수 있는가 — 단가·총액·미수가 이 값에 따라 null 이 된다' })
  canSeeAmounts!: boolean;

  @ApiProperty({ type: [TrackedStudentDto] }) students!: TrackedStudentDto[];

  /* ── §12 준비 ────────────────────────────────────────────────────
     원문은 온라인 아홉 줄(§12)·현장 일곱 줄(§79)이다. 기본 일곱에 온라인이면 「줌 안내」가,
     그 회차에 걸린 대표 지시가 있으면 「대표 지시 할 일」이 더 선다 (C82-b 원장). */
  @ApiProperty({ type: [LessonPrepRowDto] }) prep!: LessonPrepRowDto[];
  @ApiProperty({ description: '된 줄 수 — 화면이 prep 를 다시 세지 않는다' }) prepDone!: number;
  @ApiProperty({ description: '전체 줄 수' }) prepTotal!: number;
  @ApiProperty({ description: '머리 문장 — 원문 「3가지 남았습니다」 · 다 됐으면 「다 됐습니다」' })
  prepRemainLabel!: string;
}

/** 창을 열 때만 부른다 */
export class LessonTrackingQueryDto {
  @ApiProperty(ID_SCHEMA) @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  serId!: number;

  @ApiProperty({ ...DATE_SCHEMA, description: 'EXC 키와 같은 규칙상 날짜' })
  @IsCalendarDate()
  onDate!: string;
}

/**
 * 겹침 미리보기 한 줄 — **막는 것은 DB 의 EXCLUDE 이고 이것은 설명만 한다** (D-R43 · §19).
 *
 * 409 만 던지면 화면은 「안 됩니다」밖에 못 쓴다. 사람이 시간을 고치려면 *무엇과* 겹치는지를
 * 알아야 한다. 이 모양은 §19 변경 요청과 §07~§11 일정 이동이 **같은 것**을 쓴다 —
 * 두 곳이 다른 모양을 쓰면 같은 겹침이 화면마다 다르게 읽힌다.
 */
export class ConflictRowDto {
  @ApiProperty() serId!: number;
  @ApiProperty() onDate!: string;
  @ApiProperty() startMin!: number;
  @ApiProperty() endMin!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) title?: string | null;
  @ApiProperty({ enum: ['teacher', 'room', 'zoom'], description: '무엇이 겹치는가' }) with!: string;
  @ApiPropertyOptional({ type: String, nullable: true, description: '누구와 겹치는가 — 이름을 보여 준다' })
  whoName?: string | null;
}

/**
 * GET /schedule/conflicts 의 물음 — 자원을 하나도 안 주면 겹칠 대상이 없어 빈 배열이다.
 *
 * `date` 는 **실제로 놓일 달력 날짜**다. `ser_occ.span` 이 그 날짜로 만들어지므로
 * 겹침도 그 날짜로 본다 — 옮긴 회차의 `on_date`(규칙이 원래 찍은 날)와는 다를 수 있다.
 */
export class ConflictQueryDto {
  @ApiProperty({ ...DATE_SCHEMA, example: '2026-08-27', description: '놓일 달력 날짜 — EXC 키가 아니라 span 을 만드는 날짜다' })
  @IsCalendarDate() date!: string;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1439 })
  @ToHttpInteger() @IsInt() @Min(0) @Max(1439) startMin!: number;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 1440 })
  @ToHttpInteger() @IsInt() @Min(1) @Max(1440) endMin!: number;

  @ApiPropertyOptional(ID_SCHEMA)
  @ValidateIf((_object, value) => value !== undefined)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) teacherId?: number;

  @ApiPropertyOptional(ID_SCHEMA)
  @ValidateIf((_object, value) => value !== undefined)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) roomId?: number;

  @ApiPropertyOptional(ID_SCHEMA)
  @ValidateIf((_object, value) => value !== undefined)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) zaccId?: number;

  @ApiPropertyOptional({ ...ID_SCHEMA, description: '자기 자신과는 겹치지 않는다 — 옮기는 회차의 SER' })
  @ValidateIf((_object, value) => value !== undefined)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) exceptSerId?: number;
}

export class ConflictPreviewDto {
  @ApiProperty({ type: [ConflictRowDto], description: '비어 있어도 **저장을 건너뛰지 않는다** — 그 사이에 남이 그 자리를 잡을 수 있다' })
  conflicts!: ConflictRowDto[];
}
