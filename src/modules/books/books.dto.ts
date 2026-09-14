/** @file-guide
 * 목적: books.dto.ts — BookDto, BookVersionCreateDto, BookVersionDto, BookHistoryRowDto, BooksDto (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString,
  Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { DATE_SCHEMA, IsCalendarDate } from '../../common/validation';
import { HIST_ACTIONS } from '../../lib/history';
import { ISSUE_CREATE_STATES, ISSUE_STATES, ISSUE_TRANSITION_STATES, PACK_STATES, PACK_TYPES } from '../../lib/book';
import { FileUploadDto } from '../files/files.dto';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;

/** §36 교재 카드 — 코드 · 쪽수 · 과목 · SE/TE */
export class BookDto {
  @ApiProperty({ description: '교재 코드 — 카드에 그대로 보인다' }) code!: string;
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiPropertyOptional(S) subKey?: string | null;
  @ApiPropertyOptional(S) subName?: string | null;
  @ApiPropertyOptional(S) level?: string | null;
  @ApiPropertyOptional(S) grade?: string | null;
  @ApiPropertyOptional(N) pages?: number | null;
  @ApiPropertyOptional({ ...S, description: 'SE 학생용 · TE 교사용' }) seTe?: string | null;

  /* ── 판(VERS) — §39 카드의 판 배지 (C52) ───────────────────────────────── */

  /** 지금 쓰는 판 — 시작일이 오늘 이하인 것 중 가장 나중 것. 판이 없으면 null */
  @ApiPropertyOptional({ ...S, description: '지금 쓰는 판 (예: v2026.03)' }) edition?: string | null;
  /** 저장소에 있는 가장 나중 판. 아직 시작 안 한 판이 있으면 edition 과 다르다 */
  @ApiPropertyOptional({ ...S, description: '가장 나중 판' }) latestEdition?: string | null;
  /**
   * 「더 최신 판이 있다」 — 원본 §39 의 ⇧ 배지와 머리 띠가 이 값 하나를 본다.
   * **화면이 두 낱말을 비교하지 않는다** — 비교가 두 곳에 살면 배지와 띠가 갈린다 (D-R39).
   */
  @ApiProperty({ description: '더 나중 판이 있는가 — 판단은 서버가 한다' }) hasNewer!: boolean;
  @ApiPropertyOptional({ ...N, description: '지금 쓰는 판의 id' }) versId?: number | null;
  /**
   * 가장 나중 판의 id — ⇧ 를 누르면 **이 판으로** 간다.
   * 화면이 「가장 나중 것」을 스스로 고르면 서버가 판정한 `hasNewer` 와 갈릴 수 있다.
   */
  @ApiPropertyOptional({ ...N, description: '가장 나중 판의 id — ⇧ 가 가는 곳' }) latestVersId?: number | null;
  /** TE 파일이 없는 교재 — 원본 §39 의 「강사에게 보낼 파일이 없습니다」 띠 */
  @ApiProperty({ description: '지금 쓰는 판에 파일이 붙어 있는가' }) hasFile!: boolean;
  @ApiPropertyOptional(N) seFileId?: number | null;
  @ApiPropertyOptional(N) teFileId?: number | null;
  @ApiProperty({ description: '회수 완료를 포함한 누적 배부 횟수' }) issueCount!: number;
}

export class BookWriteDto {
  @ApiProperty({ minLength: 1, maxLength: 30 }) @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(1) @MaxLength(30) code!: string;
  @ApiProperty({ minLength: 1, maxLength: 120 }) @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(1) @MaxLength(120) title!: string;
  @ApiPropertyOptional({ maxLength: 20 }) @IsOptional() @IsString() @MaxLength(20) subKey?: string;
  @ApiPropertyOptional({ maxLength: 20 }) @IsOptional() @IsString() @MaxLength(20) level?: string;
  @ApiPropertyOptional({ maxLength: 10 }) @IsOptional() @IsString() @MaxLength(10) grade?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 32767 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(32767) pages?: number;
}

/** 교재 생성·수정 뒤 목록 캐시를 갱신하기 전에 쓰는 최소 식별 응답. */
export class BookWriteResultDto {
  @ApiProperty() id!: number;
  @ApiProperty() code!: string;
  @ApiProperty() title!: string;
}

export class BookPatchDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 30 }) @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(1) @MaxLength(30) code?: string;
  @ApiPropertyOptional({ minLength: 1, maxLength: 120 }) @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(1) @MaxLength(120) title?: string;
  @ApiPropertyOptional({ maxLength: 20 }) @IsOptional() @IsString() @MaxLength(20) subKey?: string;
  @ApiPropertyOptional({ maxLength: 20 }) @IsOptional() @IsString() @MaxLength(20) level?: string;
  @ApiPropertyOptional({ maxLength: 10 }) @IsOptional() @IsString() @MaxLength(10) grade?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 32767 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(32767) pages?: number;
}

/** §39 「+ 판 올리기」 — 새 판을 저장소에 넣는다 */
export class BookVersionCreateDto {
  @ApiProperty({ description: '판 이름 — 원본 배지 모양 그대로 (예: v2026.08)', example: 'v2026.08' })
  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/, { message: '판 이름은 영문·숫자·. _ - 로 20자까지입니다' })
  edition!: string;

  @ApiPropertyOptional({ type: FileUploadDto, description: '이 판과 같은 트랜잭션에 저장할 SE 파일' })
  @IsOptional() @ValidateNested() @Type(() => FileUploadDto)
  seFile?: FileUploadDto;

  @ApiPropertyOptional({ type: FileUploadDto, description: '이 판과 같은 트랜잭션에 저장할 TE 파일' })
  @IsOptional() @ValidateNested() @Type(() => FileUploadDto)
  teFile?: FileUploadDto;

  @ApiPropertyOptional({ ...DATE_SCHEMA, description: '이 판을 언제부터 쓰는가 — 비우면 오늘부터' })
  @IsOptional() @IsCalendarDate()
  fromDate?: string;
}

export class BookVersionDto {
  @ApiProperty() id!: number;
  @ApiProperty() libId!: number;
  @ApiProperty() edition!: string;
  @ApiPropertyOptional(S) fileUrl?: string | null;
  @ApiPropertyOptional(N) seFileId?: number | null;
  @ApiPropertyOptional(N) teFileId?: number | null;
  @ApiPropertyOptional({ ...DATE_SCHEMA, nullable: true }) fromDate?: string | null;
  @ApiProperty({ description: '지금 쓰는 판인가 — 판단은 서버가 한다' }) inUse!: boolean;
}

/** §40 교재 이력 한 줄 — **쓰는 화면이 없다.** 다른 쓰기의 부수효과로 쌓인다 */
export class BookHistoryRowDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: HIST_ACTIONS }) action!: string;
  @ApiProperty({ description: '칩과 줄에 쓰는 이름 — 낱말은 서버가 만든다 (D-R18)' }) actionLabel!: string;
  @ApiProperty({ description: '어느 표를 가리키는가' }) entity!: string;
  @ApiProperty() refId!: number;
  @ApiPropertyOptional({ ...S, description: '무엇에 대한 일인가 — 읽을 때 원본 표에서 이어 붙인다' }) subject?: string | null;
  @ApiPropertyOptional(S) code?: string | null;
  @ApiPropertyOptional(S) memo?: string | null;
  @ApiPropertyOptional(S) teacherName?: string | null;
  @ApiPropertyOptional(N) studentId?: number | null;
  @ApiPropertyOptional(S) byName?: string | null;
  @ApiProperty({ description: 'KST ISO' }) at!: string;
}

export class BookHistoryQueryDto {
  @ApiPropertyOptional({ enum: ['day', 'week', 'month', 'all'], default: 'month' })
  @IsOptional() @IsIn(['day', 'week', 'month', 'all']) span?: 'day' | 'week' | 'month' | 'all';
  @ApiPropertyOptional({ ...DATE_SCHEMA, example: '2026-09-14' }) @IsOptional() @IsCalendarDate() anchor?: string;
  @ApiPropertyOptional({ enum: HIST_ACTIONS }) @IsOptional() @IsIn(HIST_ACTIONS) action?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) studentId?: number;
  @ApiPropertyOptional({ maxLength: 80 }) @IsOptional() @IsString() @MaxLength(80) q?: string;
}

export class NamedCountDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() count!: number;
}

export class BookHistoryDto {
  @ApiProperty({ type: [BookHistoryRowDto] }) items!: BookHistoryRowDto[];
  @ApiProperty({ type: [NamedCountDto] }) actions!: NamedCountDto[];
  @ApiProperty({ type: [NamedCountDto] }) byStudent!: NamedCountDto[];
  @ApiProperty({ type: [NamedCountDto] }) byDay!: NamedCountDto[];
  @ApiProperty() total!: number;
  @ApiProperty() bookCount!: number;
  @ApiProperty() guideCount!: number;
}

export class BookIssueCreateDto {
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) libId!: number;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) studentId!: number;
  @ApiPropertyOptional({ enum: ISSUE_CREATE_STATES, default: 'ok' }) @IsOptional() @IsIn(ISSUE_CREATE_STATES) state?: string;
  @ApiPropertyOptional({ ...DATE_SCHEMA, example: '2026-09-14' }) @IsOptional() @IsCalendarDate() issuedOn?: string;
  @ApiPropertyOptional({ minimum: 0 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) progressPage?: number;
}

export class BookIssueTransitionDto {
  @ApiProperty({ enum: ISSUE_TRANSITION_STATES }) @IsIn(ISSUE_TRANSITION_STATES) state!: 'auto' | 'ok';
}

export class BookIssueProgressDto {
  @ApiProperty({ minimum: 0 }) @Type(() => Number) @IsInt() @Min(0) progressPage!: number;
}

export class BookIssueReturnDto {
  @ApiPropertyOptional({ ...DATE_SCHEMA, example: '2026-09-14' }) @IsOptional() @IsCalendarDate() returnedOn?: string;
}

export class BookIssueDto {
  @ApiProperty() id!: number;
  @ApiProperty() libId!: number;
  @ApiProperty() studentId!: number;
  @ApiPropertyOptional(N) versId?: number | null;
  @ApiPropertyOptional(S) edition?: string | null;
  @ApiPropertyOptional(S) fileUrl?: string | null;
  @ApiPropertyOptional(N) seFileId?: number | null;
  @ApiPropertyOptional(N) teFileId?: number | null;
  @ApiProperty({ enum: ISSUE_STATES }) state!: string;
  @ApiProperty() stateLabel!: string;
  @ApiPropertyOptional({ ...DATE_SCHEMA, nullable: true }) issuedOn?: string | null;
  @ApiPropertyOptional({ ...DATE_SCHEMA, nullable: true }) returnedOn?: string | null;
  @ApiPropertyOptional(N) progressPage?: number | null;
  @ApiPropertyOptional(N) progressPercent?: number | null;
}

export class BookTrackingStudentDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional(S) grade?: string | null;
  @ApiPropertyOptional(S) teacherName?: string | null;
  @ApiPropertyOptional(S) nextLesson?: string | null;
  @ApiProperty({ type: [BookIssueDto] }) issues!: BookIssueDto[];
  @ApiProperty({ type: [NamedCountDto], description: '행에 보일 할 일 칩 — 분류·건수는 서버가 계산' }) todos!: NamedCountDto[];
  @ApiProperty() todoLabel!: string;
}

export class BookProgressStudentDto {
  @ApiProperty() studentId!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional(N) percent?: number | null;
  @ApiPropertyOptional(N) elapsedDays?: number | null;
}

export class BookProgressDto {
  @ApiProperty() libId!: number;
  @ApiProperty() title!: string;
  @ApiProperty() studentCount!: number;
  @ApiPropertyOptional(N) minPercent?: number | null;
  @ApiPropertyOptional(N) maxPercent?: number | null;
  @ApiPropertyOptional(N) averagePercent?: number | null;
  @ApiPropertyOptional(N) pages?: number | null;
  @ApiProperty({ type: [BookProgressStudentDto] }) students!: BookProgressStudentDto[];
}

export class BookChangeRequestDto {
  @ApiProperty() id!: number;
  @ApiProperty() requesterName!: string;
  @ApiPropertyOptional(N) studentId?: number | null;
  @ApiPropertyOptional(S) studentName?: string | null;
  @ApiProperty() message!: string;
}

export class BookTrackingDto {
  @ApiProperty({ type: [BookTrackingStudentDto] }) students!: BookTrackingStudentDto[];
  @ApiProperty({ type: [BookProgressDto] }) books!: BookProgressDto[];
  @ApiProperty({ type: [NamedCountDto] }) states!: NamedCountDto[];
  @ApiProperty({ type: [BookChangeRequestDto] }) teacherRequests!: BookChangeRequestDto[];
}

export class BookPackWriteDto {
  @ApiProperty({ enum: PACK_TYPES }) @IsIn(PACK_TYPES) packType!: string;
  @ApiProperty({ minLength: 1, maxLength: 120 }) @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(1) @MaxLength(120) title!: string;
  @ApiPropertyOptional({ maxLength: 2000 }) @IsOptional() @IsString() @MaxLength(2000) memo?: string;
  @ApiProperty({ ...DATE_SCHEMA, example: '2026-09-14' }) @IsCalendarDate() effectiveOn!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) coordinatorId!: number;
  @ApiProperty({ type: [Number] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @Type(() => Number) @IsInt({ each: true }) @Min(1, { each: true }) studentIds!: number[];
  @ApiProperty({ type: [Number] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @Type(() => Number) @IsInt({ each: true }) @Min(1, { each: true }) libIds!: number[];
}

export class BookPackPatchDto {
  @ApiPropertyOptional({ enum: PACK_TYPES }) @IsOptional() @IsIn(PACK_TYPES) packType?: string;
  @ApiPropertyOptional({ minLength: 1, maxLength: 120 }) @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(1) @MaxLength(120) title?: string;
  @ApiPropertyOptional({ maxLength: 2000 }) @IsOptional() @IsString() @MaxLength(2000) memo?: string;
  @ApiPropertyOptional({ ...DATE_SCHEMA, example: '2026-09-14' }) @IsOptional() @IsCalendarDate() effectiveOn?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) coordinatorId?: number;
  @ApiPropertyOptional({ type: [Number] }) @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @Type(() => Number) @IsInt({ each: true }) @Min(1, { each: true }) studentIds?: number[];
  @ApiPropertyOptional({ type: [Number] }) @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @Type(() => Number) @IsInt({ each: true }) @Min(1, { each: true }) libIds?: number[];
}

export class BookPackStudentDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional(S) grade?: string | null;
}

export class BookPackLibDto {
  @ApiProperty() id!: number;
  @ApiProperty() code!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional(N) versId?: number | null;
  @ApiPropertyOptional(N) seFileId?: number | null;
  @ApiPropertyOptional(N) teFileId?: number | null;
}

export class BookPackDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: PACK_TYPES }) packType!: string;
  @ApiProperty() packTypeLabel!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional(S) memo?: string | null;
  @ApiProperty({ enum: PACK_STATES }) state!: string;
  @ApiProperty() stateLabel!: string;
  @ApiPropertyOptional({ ...DATE_SCHEMA, nullable: true }) effectiveOn?: string | null;
  @ApiPropertyOptional(N) coordinatorId?: number | null;
  @ApiPropertyOptional(S) coordinatorName?: string | null;
  @ApiPropertyOptional(S) createdByName?: string | null;
  @ApiPropertyOptional(S) deliveredAt?: string | null;
  @ApiPropertyOptional(S) receivedAt?: string | null;
  @ApiProperty({ type: [BookPackStudentDto] }) students!: BookPackStudentDto[];
  @ApiProperty({ type: [BookPackLibDto] }) books!: BookPackLibDto[];
  @ApiProperty({ description: 'pending 자료를 전달해도 되는가 — 필수 링크 판정은 서버가 한다' }) canDeliver!: boolean;
  @ApiProperty({ description: '현재 사용자가 delivered 자료의 지정 코디네이터라 수령 확인할 수 있는가' }) canReceive!: boolean;
  @ApiProperty({ type: [String], description: '전달 전에 채워야 할 항목' }) deliveryBlockers!: string[];
}

export class BookPacksDto {
  @ApiProperty({ type: [BookPackDto] }) items!: BookPackDto[];
  @ApiProperty({ type: [NamedCountDto] }) types!: NamedCountDto[];
  @ApiProperty({ type: [NamedCountDto] }) coordinators!: NamedCountDto[];
}

export class BooksDto {
  @ApiProperty({ type: [BookDto] }) items!: BookDto[];
  /** 과목 이름 → 권수. 키가 정해져 있지 않으므로 additionalProperties 로 적는다.
   *  이걸 빼면 front 타입이 Record<string, never> 로 내려간다 (생성기 게이트가 잡는다). */
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: '과목별 권수 — 필터 칩에 쓴다',
  })
  bySub!: Record<string, number>;

  /** 더 나중 판이 있는 교재 수 — 원본 §39 머리 띠의 「N종」. 화면이 다시 세지 않는다 */
  @ApiProperty({ description: '더 나중 판이 있는 교재 수' }) newerCount!: number;
  /** 지금 쓰는 판에 TE 파일이 없는 교재 수 — 「강사에게 보낼 파일이 없습니다」 띠 */
  @ApiProperty({ description: '현재 판에 교사용 TE 파일이 없는 교재 수' }) noFileCount!: number;
  @ApiProperty({ type: [String] }) levels!: string[];
  @ApiProperty({ type: [String] }) grades!: string[];
  @ApiProperty({ type: [NamedCountDto], description: '레벨별 교재 수 — 필터 칩 SSOT' }) levelCounts!: NamedCountDto[];
  @ApiProperty({ type: [NamedCountDto], description: '학년별 교재 수 — 필터 칩 SSOT' }) gradeCounts!: NamedCountDto[];
  @ApiProperty({ description: '새 판 SE+TE 원본 파일 합계 상한. 화면은 이 서버 값을 그대로 쓴다' })
  versionUploadMaxBytes!: number;
}
