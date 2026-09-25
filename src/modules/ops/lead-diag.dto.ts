/** @file-guide
 * 목적: lead-diag.dto.ts — LeadDiagDto, LeadDiagLevelDto, LeadDiagListDto, LeadDiagWriteDto (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 상담 단계 진단 점수 (DQ1 대표 답변 2026-09-25 「점수만 저장 + 담당자가 선택」 · 테스트 시나리오 A-04 · v2 §23 · N-53).
 *
 * 화면이 보내는 것은 **점수 셋 · 본 날 · 담당자가 고른 레벨 · 담당자가 고른 교재 · 메모**뿐이다.
 * 서버는 점수로 레벨을 정하지 않고 교재도 고르지 않는다 — 만점·경계·교재 대응이 원문에 없다(A-04/A-05 「자동」은 의도적 제외).
 * 이 파일은 ops.dto 를 import 하지 않는다 — LeadDto 가 이 파일의 LeadDiagDto 를 한 방향으로 가져간다(순환 import 방지).
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { DATE_SCHEMA, IsCalendarDate } from '../../common/validation';
import { LEAD_DIAG_LEVELS, LEAD_DIAG_SCORE_STORAGE_MAX } from '../../lib/lead-diag-words';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;
const SCORE = { type: 'integer', minimum: 0, nullable: true } as const;
const scoreMsg = (what: string) => `${what} 점수는 0 이상의 정수입니다`;

/** 진단 한 줄 — 누가 · 언제 적었고 · 점수 셋 · 본 날 · 담당자가 고른 레벨·교재 */
export class LeadDiagDto {
  @ApiProperty() id!: number;
  @ApiProperty() leadId!: number;
  @ApiPropertyOptional({ ...N, description: '영어 점수 — 만점은 정해지지 않았다(DQ1)' }) english?: number | null;
  @ApiPropertyOptional({ ...N, description: '수학 점수' }) math?: number | null;
  @ApiPropertyOptional({ ...N, description: '인터뷰 점수' }) interview?: number | null;
  @ApiPropertyOptional({ ...S, description: '진단고사를 본 날 YYYY-MM-DD — 모르면 null' }) takenOn?: string | null;
  @ApiPropertyOptional({ ...S, description: 'foundation | practice | master — 담당자가 고른 값. 아직 안 골랐으면 null' }) level?: string | null;
  @ApiPropertyOptional({ ...S, description: '레벨 낱말 (서버가 만든다)' }) levelLabel?: string | null;
  @ApiPropertyOptional({ ...N, description: '담당자가 고른 교재 — 서가(LIB) id' }) bookId?: number | null;
  @ApiPropertyOptional({ ...S, description: '교재 이름' }) bookTitle?: string | null;
  @ApiPropertyOptional(S) note?: string | null;
  @ApiProperty() byId!: number;
  @ApiPropertyOptional(S) byName?: string | null;
  @ApiProperty({ description: '적은 시각 (KST)' }) at!: string;
}

/** 레벨 낱말 한 칸 — key · label (D-R18). 화면의 레벨 select 가 이것을 그대로 쓴다 */
export class LeadDiagLevelDto {
  @ApiProperty({ enum: [...LEAD_DIAG_LEVELS] }) key!: string;
  @ApiProperty() label!: string;
}

/** `GET /ops/leads/{id}/diag` · `POST` 응답 — 이력(최근 것이 앞)과 담당자가 고를 레벨 낱말 */
export class LeadDiagListDto {
  @ApiProperty() leadId!: number;
  @ApiPropertyOptional({ ...N, description: '등록되면 그 학생 — 같은 줄이 lead.student_id 를 따라 그 학생의 진단이 된다(값을 옮겨 적지 않는다)' })
  studentId?: number | null;
  @ApiProperty({ type: [LeadDiagDto], description: 'append-only 이력 — 최근 것이 앞. 첫 줄이 지금 값이다' })
  items!: LeadDiagDto[];
  @ApiProperty({ type: [LeadDiagLevelDto], description: '담당자가 고르는 레벨 셋 — 점수로 추천하지 않는다' })
  levels!: LeadDiagLevelDto[];
}

/**
 * 진단 한 줄 적기 — 보낸 칸만 그 줄에 들어간다(빈 칸은 NULL). 새 줄이 쌓이고 지난 줄은 그대로다.
 * 점수 · 레벨 · 교재 중 하나는 있어야 한다(400 LEAD_DIAG_EMPTY · DB lead_diag_not_empty).
 */
export class LeadDiagWriteDto {
  @ApiPropertyOptional({ ...SCORE, description: '영어 점수 — 0 이상 정수. 만점은 정해지지 않아 위 끝을 두지 않는다(저장 형식 한계만 막는다)' })
  @IsOptional()
  @IsInt({ message: scoreMsg('영어') }) @Min(0, { message: scoreMsg('영어') })
  @Max(LEAD_DIAG_SCORE_STORAGE_MAX, { message: '영어 점수가 너무 큽니다' })
  english?: number | null;

  @ApiPropertyOptional({ ...SCORE, description: '수학 점수 — 0 이상 정수' })
  @IsOptional()
  @IsInt({ message: scoreMsg('수학') }) @Min(0, { message: scoreMsg('수학') })
  @Max(LEAD_DIAG_SCORE_STORAGE_MAX, { message: '수학 점수가 너무 큽니다' })
  math?: number | null;

  @ApiPropertyOptional({ ...SCORE, description: '인터뷰 점수 — 0 이상 정수' })
  @IsOptional()
  @IsInt({ message: scoreMsg('인터뷰') }) @Min(0, { message: scoreMsg('인터뷰') })
  @Max(LEAD_DIAG_SCORE_STORAGE_MAX, { message: '인터뷰 점수가 너무 큽니다' })
  interview?: number | null;

  @ApiPropertyOptional({ ...DATE_SCHEMA, nullable: true, description: '진단고사를 본 날 YYYY-MM-DD' })
  @IsOptional()
  @IsCalendarDate({ message: '본 날은 실제 YYYY-MM-DD 날짜여야 합니다' })
  takenOn?: string | null;

  @ApiPropertyOptional({ enum: [...LEAD_DIAG_LEVELS], nullable: true, description: '담당자가 고른 레벨 — 서버가 점수로 정하지 않는다. 낱말은 LeadDiagListDto.levels' })
  @IsOptional()
  @IsIn([...LEAD_DIAG_LEVELS], { message: '레벨은 Foundation · Practice · Master 중 하나입니다' })
  level?: string | null;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, nullable: true, description: '담당자가 고른 교재 — 서가(LIB) id. 없는 교재면 404 BOOK_NOT_FOUND' })
  @IsOptional()
  @IsInt({ message: '교재 번호가 올바르지 않습니다' }) @Min(1, { message: '교재 번호가 올바르지 않습니다' })
  @Max(Number.MAX_SAFE_INTEGER, { message: '교재 번호가 올바르지 않습니다' })
  bookId?: number | null;

  @ApiPropertyOptional({ ...S, maxLength: 500, description: '메모 — 감사 기록(LOG)에는 남기지 않는다(연락처가 섞일 수 있다)' })
  @IsOptional() @IsString() @MaxLength(500, { message: '메모는 500자까지입니다' })
  note?: string | null;
}
