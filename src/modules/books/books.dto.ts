/** @file-guide
 * 목적: books.dto.ts — BookDto, BookVersionCreateDto, BookVersionDto, BookHistoryRowDto, BooksDto (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString,
  Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { DATE_SCHEMA, IsCalendarDate } from '../../common/validation';
import { HIST_ACTIONS } from '../../lib/history';
import {
  BOOK_EXAM_TAGS, BOOK_GRADE_MAX, BOOK_GRADE_MIN, BOOK_GRADES, BOOK_LEVELS, BOOK_UNCLASSIFIED, bookGradeKey,
  ISSUE_CREATE_STATES, ISSUE_FORMS, ISSUE_STATES, ISSUE_TRANSITION_STATES, PACK_STATES, PACK_TYPES,
} from '../../lib/book';
import { FileUploadDto } from '../files/files.dto';
import { LeadDiagDto } from '../ops/lead-diag.dto';

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

  /* ── §39 두 층 분류 (N-47 채택 · W11) — 옛 칸(subKey · level · grade)은 그대로 두고 새 칸을 사람이 채운다 ── */

  @ApiPropertyOptional({ ...S, description: '교재 과목 키(BOOK_SUBJECT) — null 이면 「미분류」' }) bookSubjectKey?: string | null;
  @ApiPropertyOptional({ ...S, description: '교재 과목 이름 — 원문 낱말 그대로' }) bookSubjectName?: string | null;
  @ApiPropertyOptional({ ...S, description: '교재 과목 색(#RRGGBB) — 코드표 값. 소분류 글자 · 묶음 머리가 쓴다' }) bookSubjectColor?: string | null;
  @ApiPropertyOptional({ ...S, description: '소분류 키(BOOK_CATEGORY)' }) bookCategoryKey?: string | null;
  @ApiPropertyOptional({ ...S, description: '소분류 이름 — 카드 윗줄 (원문 「Reading」)' }) bookCategoryName?: string | null;
  @ApiPropertyOptional({ ...S, enum: [...BOOK_LEVELS], description: '코드표 레벨 — 편집 창 값' }) bookLevel?: string | null;
  @ApiPropertyOptional({ ...S, description: '보여 주는 레벨 — 코드표 레벨 낱말(Foundation …), 아직이면 옛 원문(level) 그대로' })
  levelLabel?: string | null;
  @ApiPropertyOptional({ ...N, description: '학년 범위 시작 — K = 0 · G1~G12 = 1~12' }) gradeFrom?: number | null;
  @ApiPropertyOptional({ ...N, description: '학년 범위 끝' }) gradeTo?: number | null;
  @ApiPropertyOptional({ ...S, description: '보여 주는 학년 — 범위를 원문처럼 「G9·G10」, 아직이면 옛 원문(grade) 그대로' })
  gradeLabel?: string | null;
  @ApiPropertyOptional({ ...S, enum: [...BOOK_EXAM_TAGS], description: '시험 태그 — 편집 창 값' }) examTag?: string | null;
  @ApiPropertyOptional({ ...S, description: '시험 태그 낱말 — 원문 칩 SAT · MAP · ISEE / SSAT' }) examTagLabel?: string | null;
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

/** §39 두 층 분류 칸의 키 모양 — 코드표 키(english · reading …). 있는지는 서비스가 코드표로 본다 */
const TAXONOMY_KEY = /^[a-z0-9_]{1,30}$/;

export class BookWriteDto {
  @ApiProperty({ minLength: 1, maxLength: 30 }) @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(1) @MaxLength(30) code!: string;
  @ApiProperty({ minLength: 1, maxLength: 120 }) @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(1) @MaxLength(120) title!: string;
  @ApiPropertyOptional({ maxLength: 20, description: '시간표 과목(SUB) — 수업의 교재 요구와 맞춰 보는 칸. §39 과목 분류와는 다른 축' }) @IsOptional() @IsString() @MaxLength(20) subKey?: string;
  @ApiPropertyOptional({ maxLength: 20, description: '옛 레벨 원문 — 새 교재는 bookLevel 을 쓴다' }) @IsOptional() @IsString() @MaxLength(20) level?: string;
  @ApiPropertyOptional({ maxLength: 10, description: '옛 학년 원문 — 새 교재는 gradeFrom · gradeTo 를 쓴다' }) @IsOptional() @IsString() @MaxLength(10) grade?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 32767 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(32767) pages?: number;

  /* ── §39 두 층 분류 (N-47) ── */
  @ApiPropertyOptional({ maxLength: 20, description: '교재 과목(BOOK_SUBJECT) 키' }) @IsOptional() @IsString() @Matches(TAXONOMY_KEY) @MaxLength(20) bookSubjectKey?: string;
  @ApiPropertyOptional({ maxLength: 30, description: '소분류(BOOK_CATEGORY) 키 — 고른 과목의 것만' }) @IsOptional() @IsString() @Matches(TAXONOMY_KEY) bookCategoryKey?: string;
  @ApiPropertyOptional({ enum: [...BOOK_LEVELS] }) @IsOptional() @IsIn(BOOK_LEVELS) bookLevel?: string;
  @ApiPropertyOptional({ minimum: BOOK_GRADE_MIN, maximum: BOOK_GRADE_MAX, description: '학년 범위 시작 — K = 0' }) @IsOptional() @Type(() => Number) @IsInt() @Min(BOOK_GRADE_MIN) @Max(BOOK_GRADE_MAX) gradeFrom?: number;
  @ApiPropertyOptional({ minimum: BOOK_GRADE_MIN, maximum: BOOK_GRADE_MAX, description: '학년 범위 끝' }) @IsOptional() @Type(() => Number) @IsInt() @Min(BOOK_GRADE_MIN) @Max(BOOK_GRADE_MAX) gradeTo?: number;
  @ApiPropertyOptional({ enum: [...BOOK_EXAM_TAGS] }) @IsOptional() @IsIn(BOOK_EXAM_TAGS) examTag?: string;

  /**
   * 첫 판 — 등록과 **같은 트랜잭션**에서 판(이름 · 언제부터)과 SE/TE 파일을 함께 만든다 (N-61 ① 채택 · W11).
   * 판 이름은 사람이 적는다 — 비우면 판 없이 교재만 등록한다(이름을 지어 넣지 않는다).
   */
  @ApiPropertyOptional({ type: BookVersionCreateDto, description: '첫 판 — 교재와 같은 트랜잭션에 저장한다' })
  @IsOptional() @ValidateNested() @Type(() => BookVersionCreateDto)
  firstVersion?: BookVersionCreateDto;
}

/** 교재 생성·수정 뒤 목록 캐시를 갱신하기 전에 쓰는 최소 식별 응답. */
export class BookWriteResultDto {
  @ApiProperty() id!: number;
  @ApiProperty() code!: string;
  @ApiProperty() title!: string;
}

export class BookPatchDto {
  // 필수 이름은 생략할 수 있지만 지울 수 없다. IsOptional은 null까지 통과시키므로 쓰지 않는다.
  @ApiPropertyOptional({ minLength: 1, maxLength: 30 }) @ValidateIf((_object, value) => value !== undefined) @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(1) @MaxLength(30) code?: string;
  @ApiPropertyOptional({ minLength: 1, maxLength: 120 }) @ValidateIf((_object, value) => value !== undefined) @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(1) @MaxLength(120) title?: string;
  // 선택 정보는 생략하면 보존하고 null이면 삭제한다. 생성 DTO의 생략 계약은 그대로 둔다.
  @ApiPropertyOptional({ ...S, maxLength: 20 }) @IsOptional() @IsString() @MaxLength(20) subKey?: string | null;
  @ApiPropertyOptional({ ...S, maxLength: 20 }) @IsOptional() @IsString() @MaxLength(20) level?: string | null;
  @ApiPropertyOptional({ ...S, maxLength: 10 }) @IsOptional() @IsString() @MaxLength(10) grade?: string | null;
  @ApiPropertyOptional({ ...N, minimum: 1, maximum: 32767 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(32767) pages?: number | null;
  /* §39 두 층 분류 (N-47) — 생략하면 보존, null 이면 비운다(사람이 분류를 되돌릴 수 있다) */
  @ApiPropertyOptional({ ...S, maxLength: 20 }) @IsOptional() @IsString() @Matches(TAXONOMY_KEY) @MaxLength(20) bookSubjectKey?: string | null;
  @ApiPropertyOptional({ ...S, maxLength: 30 }) @IsOptional() @IsString() @Matches(TAXONOMY_KEY) bookCategoryKey?: string | null;
  @ApiPropertyOptional({ ...S, enum: [...BOOK_LEVELS] }) @IsOptional() @IsIn(BOOK_LEVELS) bookLevel?: string | null;
  @ApiPropertyOptional({ ...N, minimum: BOOK_GRADE_MIN, maximum: BOOK_GRADE_MAX }) @IsOptional() @Type(() => Number) @IsInt() @Min(BOOK_GRADE_MIN) @Max(BOOK_GRADE_MAX) gradeFrom?: number | null;
  @ApiPropertyOptional({ ...N, minimum: BOOK_GRADE_MIN, maximum: BOOK_GRADE_MAX }) @IsOptional() @Type(() => Number) @IsInt() @Min(BOOK_GRADE_MIN) @Max(BOOK_GRADE_MAX) gradeTo?: number | null;
  @ApiPropertyOptional({ ...S, enum: [...BOOK_EXAM_TAGS] }) @IsOptional() @IsIn(BOOK_EXAM_TAGS) examTag?: string | null;
}

/** §39 서가 필터 — 과목 · 레벨 · 학년. 거르기와 건수는 서버가 한다 (N-47 · D-R37) */
export class BookShelfQueryDto {
  @ApiPropertyOptional({ description: `교재 과목 키 — 「${BOOK_UNCLASSIFIED.label}」는 ${BOOK_UNCLASSIFIED.key}`, maxLength: 20 })
  @IsOptional() @IsString() @Matches(TAXONOMY_KEY) @MaxLength(20) subject?: string;
  @ApiPropertyOptional({ enum: [...BOOK_LEVELS] }) @IsOptional() @IsIn(BOOK_LEVELS) level?: string;
  @ApiPropertyOptional({ enum: BOOK_GRADES.map(bookGradeKey), description: '학년 칩 키 — 범위가 이 학년을 덮는 교재' })
  @IsOptional() @IsIn(BOOK_GRADES.map(bookGradeKey)) grade?: string;
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
  @ApiProperty({
    description: '가리키던 행이 지워졌는가 — hist 는 FK 가 없어 줄이 남는다. 참이면 subject 가 「지워진 배부 #N」꼴',
  })
  refMissing!: boolean;
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
  /** 배부 사유 — 무슨 교재를 왜 줬는지 (N-62 ① · 원문 슬라이드 37). 비우면 NULL. 진단 점수는 여기 옮겨 적지 않는다(D-R22) */
  @ApiPropertyOptional({ maxLength: 500, description: '배부 사유 — 비우면 적지 않는다' })
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /** 배부 형태 — PDF · 실물 책 (§38-2 · W11 A'). 고르지 않으면 NULL = 칩 없음 */
  @ApiPropertyOptional({ enum: [...ISSUE_FORMS], description: '배부 형태 — pdf | print · 고르지 않으면 칩이 서지 않는다' })
  @IsOptional() @IsIn(ISSUE_FORMS) form?: string;
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
  @ApiPropertyOptional({ ...S, description: '배부 사유 (N-62) — 옛 배부는 null' }) reason?: string | null;
  @ApiPropertyOptional({ ...S, enum: [...ISSUE_FORMS], description: '배부 형태 (§38-2) — 옛 배부 · 고르지 않은 배부는 null' }) form?: string | null;
  @ApiPropertyOptional({ ...S, description: '형태 칩 낱말 — 원문 「PDF」 · 「실물 책」(서버가 만든다 · D-R18)' }) formLabel?: string | null;
}

/**
 * 배부 창의 진단 한 줄 — 그 학생의 **최신 상담 진단**을 보여 주기만 한다 (N-62 ① · DQ1).
 * 값은 `lead_diag` 한 곳에 있고 배부에 옮겨 적지 않는다(D-R22). 진단이 없으면 diag = null.
 */
export class BookIssueDiagDto {
  @ApiProperty() studentId!: number;
  @ApiPropertyOptional({ type: LeadDiagDto, nullable: true, description: '최신 상담 진단 — 없으면 null' }) diag?: LeadDiagDto | null;
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
  @ApiPropertyOptional({ ...S, description: '교재 레벨 — 「교재별 진도율」 카드의 레벨 배지·왼쪽 띠(원문 §38 · g4 §38-7). 코드표 레벨(N-47)이 있으면 그 낱말, 아직이면 옛 원문(lib.level). 없으면 null' })
  level?: string | null;
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
  @ApiProperty({ type: () => [BookCodeDto], description: '배부 창의 형태 선택지 — 「PDF」 · 「실물 책」(§38-2 · W11 A 후속)' }) issueForms!: BookCodeDto[];
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
  @ApiPropertyOptional({ ...S, description: '교재 레벨 — 카드 교재 줄의 레벨 글자 사각(원문 §41 · g4 §41-3). 코드표 레벨(N-47)이 있으면 그 낱말, 아직이면 옛 원문(lib.level). 없으면 null' })
  level?: string | null;
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
  @ApiPropertyOptional({ ...S, description: '전달한 사람 이름(gpapack.delivered_by) — 옛 건은 null' })
  deliveredByName?: string | null;
  @ApiPropertyOptional({ ...S, description: '수령 확인한 사람 이름(gpapack.received_by) — 옛 건은 null' })
  receivedByName?: string | null;
  @ApiProperty({ type: [BookPackStudentDto] }) students!: BookPackStudentDto[];
  @ApiProperty({ type: [BookPackLibDto] }) books!: BookPackLibDto[];
  @ApiProperty({ description: 'pending 자료를 전달해도 되는가 — 필수 링크 판정은 서버가 한다' }) canDeliver!: boolean;
  @ApiProperty({ description: '현재 사용자가 delivered 자료를 수령 확인할 수 있는가 — 지정 코디네이터 또는 대표 판정(N-88). 판정은 서버가 한다' }) canReceive!: boolean;
  @ApiProperty({ type: [String], description: '전달 전에 채워야 할 항목' }) deliveryBlockers!: string[];
}

/** 코디네이터 레일 한 줄 — 「Sophia 2건 · 미확인 1」 (g4 §41-5) */
export class BookPackCoordinatorDto extends NamedCountDto {
  @ApiProperty({ description: '전달했는데 아직 수령 확인이 없는 묶음 수' }) unreceived!: number;
}

export class BookPacksDto {
  @ApiProperty({ type: [BookPackDto] }) items!: BookPackDto[];
  @ApiProperty({ type: [NamedCountDto] }) types!: NamedCountDto[];
  @ApiProperty({ type: [BookPackCoordinatorDto] }) coordinators!: BookPackCoordinatorDto[];
}

/** §39 코드 한 칸 — 키 · 낱말 (D-R18). 편집 창 선택지가 이것을 그대로 쓴다 */
export class BookCodeDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
}

/** §39 과목 칩 한 칸 — 서가 전체에서 센 권수 + 코드표 색 + 그 과목의 소분류(편집 창 선택지) */
export class BookSubjectCountDto extends NamedCountDto {
  @ApiProperty({ description: '칩 점 · 묶음 머리 색(#RRGGBB) — 코드표 값' }) color!: string;
  @ApiProperty({ type: [BookCodeDto], description: '이 과목의 소분류 — 코드표 차례' }) categories!: BookCodeDto[];
}

/** §39 학년 칩 한 칸 — 범위가 이 학년을 덮는 교재 수 */
export class BookGradeCountDto extends NamedCountDto {
  @ApiProperty({ description: '학년 숫자 — K = 0 · G1~G12 = 1~12. 편집 창의 범위 두 칸이 쓴다' }) grade!: number;
}

/** §39 경고 띠 한 줄 — 어느 교재인지 (서가 전체 기준) */
export class BookNoticeDto {
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiPropertyOptional(S) edition?: string | null;
  @ApiPropertyOptional(S) latestEdition?: string | null;
}

export class BooksDto {
  @ApiProperty({ type: [BookDto], description: '필터(과목 · 레벨 · 학년)를 서버가 적용한 교재 — 필터가 없으면 서가 전체. 차례는 과목 → 소분류 → 코드' })
  items!: BookDto[];
  /** 과목 이름 → 권수. 키가 정해져 있지 않으므로 additionalProperties 로 적는다.
   *  이걸 빼면 front 타입이 Record<string, never> 로 내려간다 (생성기 게이트가 잡는다). */
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: '시간표 과목(SUB) 이름별 권수 — 옛 필터 값. §39 서가 칩은 subjects(교재 과목 · N-47)를 쓴다',
  })
  bySub!: Record<string, number>;

  /** 더 나중 판이 있는 교재 수 — 원본 §39 머리 띠의 「N종」. 화면이 다시 세지 않는다 */
  @ApiProperty({ description: '더 나중 판이 있는 교재 수' }) newerCount!: number;
  /** 지금 쓰는 판에 TE 파일이 없는 교재 수 — 「강사에게 보낼 파일이 없습니다」 띠 */
  @ApiProperty({ description: '현재 판에 교사용 TE 파일이 없는 교재 수' }) noFileCount!: number;
  @ApiProperty({ type: [String], description: '옛 레벨 원문(lib.level)의 값들' }) levels!: string[];
  @ApiProperty({ type: [String], description: '옛 학년 원문(lib.grade)의 값들' }) grades!: string[];
  @ApiProperty({ type: [NamedCountDto], description: '레벨별 교재 수 — 코드표 레벨 셋 전부(0 도 준다) · 서가 전체 기준 · 필터 칩 SSOT (N-47)' }) levelCounts!: NamedCountDto[];
  @ApiProperty({ type: [BookGradeCountDto], description: '학년별 교재 수 — K · G1 … G12 전부(0 도 준다) · 범위가 덮는 학년마다 센다 · 서가 전체 기준 (N-47)' }) gradeCounts!: BookGradeCountDto[];
  @ApiProperty({ type: [BookSubjectCountDto], description: '과목별 교재 수 — 코드표 과목 넷 전부(0 도 준다) · 서가 전체 기준 (N-47)' }) subjects!: BookSubjectCountDto[];
  @ApiProperty({ type: NamedCountDto, description: '과목을 아직 정하지 않은 교재 — 「미분류」 칩 · 묶음' }) unclassified!: NamedCountDto;
  @ApiProperty({ type: [BookCodeDto], description: '시험 태그 셋 — 편집 창 선택지' }) examTags!: BookCodeDto[];
  @ApiProperty({ type: [BookNoticeDto], description: '더 나중 판이 있는 교재 — 머리 띠의 이름들(서가 전체 기준 · newerCount 와 같은 줄)' }) newerBooks!: BookNoticeDto[];
  @ApiProperty({ type: [BookNoticeDto], description: 'TE 파일이 없는 교재 — 머리 띠의 이름들(서가 전체 기준 · noFileCount 와 같은 줄)' }) noTeBooks!: BookNoticeDto[];
  @ApiProperty({ description: '새 판 SE+TE 원본 파일 합계 상한. 화면은 이 서버 값을 그대로 쓴다' })
  versionUploadMaxBytes!: number;
}
