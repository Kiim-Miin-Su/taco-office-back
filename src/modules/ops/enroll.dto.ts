/** @file-guide
 * 목적: enroll.dto.ts — LeadEnrollDto, EnrollLineDto, EnrollStudentDto, EnrollResultDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 등록 확정 — 테스트 시나리오 A-05 「배치안을 만들고 등록을 확정함 — 한 번에 일곱 가지」 (C91).
 *
 * 화면이 보내는 것은 **학생 칸 · 시작일 · 배치안 줄들**이고, 그 뒤의 일곱(STU · ENR · SER+SER_STU · INV · ISSUE · GUIDE · NOTI)은
 * 서버가 **한 트랜잭션**에서 기존 쓰기를 순서대로 부른다. 새 규칙은 하나도 없다 — 시간표는 `ScheduleWriteService.create`,
 * 청구서는 `AccountingService.issueWithin`(§53), 교재 요청은 `BooksService.createIssueWithin`, 안내 초안은 `GuidesService.draftsForStudent`.
 * 겹침은 시간표가 막고(EXCLUDE · 409) 불가 시간은 응답으로 알린다(A-06 · A-07). 미리보기는 같은 트랜잭션을 돌리고 되돌린다(D-R37).
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString,
  Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { DATE_SCHEMA, IsCalendarDate } from '../../common/validation';
import { InvoiceDto } from '../accounting/accounting.dto';
import { BookIssueDto } from '../books/books.dto';
import { SCHEDULE_INPUT_LIMITS, UnavWarnDto } from '../schedule/schedule.dto';

const ID_MAX = Number.MAX_SAFE_INTEGER;

/** 새 학생 칸 — 비우면 상담 카드의 이름·학교를 쓴다. 동명이인은 학년·학교로 갈린다 (N-137) */
export class EnrollStudentDto {
  @ApiPropertyOptional({ description: '비우면 상담 카드의 이름', maxLength: 40 })
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40)
  name?: string;

  @ApiPropertyOptional({ maxLength: 10, description: '학년 — 동명이인을 가르는 칸 (N-137)' })
  @IsOptional() @IsString() @MaxLength(10)
  grade?: string;

  @ApiPropertyOptional({ maxLength: 60, description: '비우면 상담 카드의 학교' })
  @IsOptional() @IsString() @MaxLength(60)
  school?: string;

  @ApiPropertyOptional({ maxLength: 40 }) @IsOptional() @IsString() @MaxLength(40) targetExam?: string;
  @ApiPropertyOptional({ maxLength: 20, description: '지도 강도 낱말 — STU.guidance' }) @IsOptional() @IsString() @MaxLength(20) guidance?: string;
  @ApiPropertyOptional({ maxLength: 20, description: '수업 언어 — STU.lang' }) @IsOptional() @IsString() @MaxLength(20) lang?: string;
}

/** 배치안 한 줄 — 시간표 규칙 하나 + 등록(ENR) 한 줄 + (있으면) 교재 요청 */
export class EnrollLineDto {
  @ApiProperty({ minLength: 1, maxLength: SCHEDULE_INPUT_LIMITS.kindKey })
  @IsString() @MinLength(1) @MaxLength(SCHEDULE_INPUT_LIMITS.kindKey) kindKey!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: SCHEDULE_INPUT_LIMITS.subKey })
  @IsOptional() @IsString() @MaxLength(SCHEDULE_INPUT_LIMITS.subKey) subKey?: string | null;

  @ApiProperty({ enum: ['offline', 'online'] }) @IsIn(['offline', 'online']) mode!: string;

  @ApiProperty({ description: "ONCE | DAILY[/n] | WEEKLY:MO,WE[/n] — 시작일 이후 첫 요일이 첫 수업이다 (A-14)", maxLength: SCHEDULE_INPUT_LIMITS.rrule })
  @IsString() @MinLength(1) @MaxLength(SCHEDULE_INPUT_LIMITS.rrule) rrule!: string;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1439 }) @IsInt() @Min(0) @Max(1439) startMin!: number;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1440 }) @IsInt() @Min(0) @Max(1440) endMin!: number;

  @ApiPropertyOptional({ type: Number, nullable: true }) @IsOptional() @IsInt() @Min(1) @Max(ID_MAX) teacherId?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) @IsOptional() @IsInt() @Min(1) @Max(ID_MAX) roomId?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: SCHEDULE_INPUT_LIMITS.title })
  @IsOptional() @IsString() @MaxLength(SCHEDULE_INPUT_LIMITS.title) title?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '등록 회차 수 — ENR.sessions (비우면 정하지 않음)' })
  @IsOptional() @IsInt() @Min(1) @Max(999) sessions?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '교재 — 서가(LIB) id. 있으면 배부 요청(wait)이 남고, 없으면 「교재 배정이 필요합니다」 알림이 간다' })
  @IsOptional() @IsInt() @Min(1) @Max(ID_MAX) libId?: number | null;
}

export class LeadEnrollDto {
  @ApiPropertyOptional({ type: Number, nullable: true, description: '이미 있는 학생에게 붙일 때 — 형제·재등록. 비우면 새 학생을 만든다' })
  @IsOptional() @IsInt() @Min(1) @Max(ID_MAX)
  studentId?: number | null;

  @ApiPropertyOptional({ type: EnrollStudentDto, description: '새 학생 칸 — studentId 가 있으면 무시' })
  @IsOptional() @IsObject() @ValidateNested() @Type(() => EnrollStudentDto)
  student?: EnrollStudentDto;

  @ApiProperty({ ...DATE_SCHEMA, description: '시작일 — ENR.started_on · STU.started_on · 각 줄의 첫 회차 하한' })
  @IsCalendarDate()
  startedOn!: string;

  @ApiProperty({ type: [EnrollLineDto], minItems: 1, maxItems: 10, description: '배치안 줄 — 줄마다 시간표 규칙 하나(SER+SER_STU)와 ENR 한 줄' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => EnrollLineDto)
  lines!: EnrollLineDto[];

  @ApiPropertyOptional({ description: '첫 달 수업료 청구서를 함께 낸다 (기본 true · §53 발행 그대로 — 단가 없으면 건너뛰고 이유를 돌려준다)', default: true })
  @IsOptional() @IsBoolean()
  issueInvoice?: boolean;

  /**
   * 함께 내는 청구서의 **납부 기한** — 낱장 발행과 같은 규약이다(기본값 없음 · 대표 결정 2026-09-20 · S3).
   * 청구서를 안 낼 때(`issueInvoice: false`)는 받지 않는다 — 없는 청구서의 기한을 물을 이유가 없다.
   */
  @ApiPropertyOptional({ ...DATE_SCHEMA, description: '납부 기한 — YYYY-MM-DD. issueInvoice 가 false 가 아니면 필수' })
  @ValidateIf((o: LeadEnrollDto) => o.issueInvoice !== false)
  @IsCalendarDate()
  dueOn?: string;

  @ApiPropertyOptional({ description: '메모 — LEAD.reason 에 남는다', maxLength: 300 })
  @IsOptional() @IsString() @MaxLength(300)
  memo?: string;

  @ApiPropertyOptional({ description: '이미 있는 학생과 이름이 같아도 새 학생으로 만든다 (동명이인 · N-137) — 학년·학교가 같으면 그래도 409' })
  @IsOptional() @IsBoolean()
  allowSameName?: boolean;
}

export class EnrollSeriesDto {
  @ApiProperty() serId!: number;
  @ApiProperty() kindKey!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) subKey?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) subName?: string | null;
  @ApiProperty() title!: string;
  @ApiProperty({ description: '규칙 — 「매주 월·수」 같은 사람 말' }) ruleLabel!: string;
  @ApiProperty() startMin!: number;
  @ApiProperty() endMin!: number;
  @ApiPropertyOptional({ type: Number, nullable: true }) teacherId?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) teacherName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: '첫 수업일 — 시작일 이후 첫 회차 (A-14). 투영 범위 안에 없으면 null' }) firstLessonOn?: string | null;
  @ApiProperty({ description: '이번 달(첫 수업이 든 달)의 회차 수' }) monthCount!: number;
}

export class EnrollEnrollmentDto {
  @ApiProperty() id!: number;
  @ApiProperty() kindKey!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) subKey?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) sessions?: number | null;
  @ApiProperty() startedOn!: string;
}

export class EnrollSkipDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
}

export class EnrollMissingBookDto {
  @ApiProperty() kindKey!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) subKey?: string | null;
  @ApiProperty({ description: '과목 이름(없으면 종류 이름)' }) label!: string;
}

/** `POST /ops/leads/{id}/enroll(/preview)` 의 결과 — 일곱 가지가 무엇이 됐는지 줄마다 */
export class EnrollResultDto {
  @ApiProperty() leadId!: number;
  @ApiProperty({ description: '미리보기였는가 — true 면 아무것도 쓰지 않았다' }) preview!: boolean;
  @ApiProperty() studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiProperty({ description: '새로 만든 학생인가 (false 면 있는 학생에게 붙였다)' }) studentCreated!: boolean;
  @ApiProperty() startedOn!: string;
  @ApiProperty({ type: [EnrollEnrollmentDto] }) enrollments!: EnrollEnrollmentDto[];
  @ApiProperty({ type: [EnrollSeriesDto] }) series!: EnrollSeriesDto[];
  @ApiPropertyOptional({ type: InvoiceDto, nullable: true, description: '첫 달 청구서 — 안 냈으면 null 이고 invoiceSkipped 가 이유' }) invoice?: InvoiceDto | null;
  @ApiPropertyOptional({ type: EnrollSkipDto, nullable: true }) invoiceSkipped?: EnrollSkipDto | null;
  @ApiProperty({ type: [BookIssueDto], description: '교재 요청(wait) — 줄에 libId 가 있던 것' }) bookIssues!: BookIssueDto[];
  @ApiProperty({ type: [EnrollMissingBookDto], description: '교재가 정해지지 않은 줄 — 「교재 배정이 필요합니다」 알림이 갔다' }) booksMissing!: EnrollMissingBookDto[];
  @ApiProperty({ description: '남긴 첫 수업 안내 초안 수' }) guideDrafts!: number;
  @ApiProperty({ description: '알림을 받은 강사 수' }) notifiedTeachers!: number;
  @ApiProperty({ description: '알림을 받은 관리자 수' }) notifiedStaff!: number;
  @ApiProperty({ type: [UnavWarnDto], description: '강사 불가 시간에 걸친 회차 — 막지 않고 알린다 (A-07)' }) unavailable!: UnavWarnDto[];
  @ApiProperty({ description: '상담 단계 — 언제나 enrolled' }) stage!: string;
}
