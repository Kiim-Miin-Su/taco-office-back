import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { REPORT_FIELDS, type ReportFieldKey, type ReportReviewDecision } from '../../lib/rules';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export class ReportStudentDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) grade?: string | null;
}

export class ReportRowDto {
  @ApiProperty() id!: number;
  @ApiProperty() serId!: number;
  @ApiProperty({ example: '2026-08-27', description: '화면에 보이는 실제 회차 날짜' }) date!: string;
  @ApiProperty({ example: '2026-08-27', description: 'REP · SER_OCC 식별자인 원래 날짜' }) onDate!: string;
  @ApiProperty() startMin!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) subKey?: string | null;
  @ApiProperty() kindKey!: string;
  @ApiPropertyOptional({ type: Number, nullable: true }) teacherId?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) teacherName?: string | null;
  @ApiProperty({ enum: ['na', 'plan', 'none', 'draft', 'wait', 'ok', 'rej'] }) state!: string;
  @ApiProperty({ description: '썼는가 — 정산 조건 (D-R7)' }) written!: boolean;
  @ApiProperty({ type: [ReportStudentDto] }) students!: ReportStudentDto[];

  @ApiProperty({ description: '수업이 끝난 뒤 지난 분. 음수면 아직 안 끝났다' }) minutesSinceEnd!: number;
  @ApiProperty({ description: '지금 확정하면 깎이는 금액 (D-R32)' }) penalty!: number;
}

export class UnwrittenByTeacherDto {
  @ApiProperty() teacherId!: number;
  @ApiProperty() teacherName!: string;
  @ApiProperty() count!: number;
  @ApiPropertyOptional({ type: String, nullable: true, description: '가장 오래된 것' }) oldestDate?: string | null;
  @ApiProperty({ description: '1시간 넘긴 건수' }) over1h!: number;
  @ApiProperty({ description: '4시간 넘긴 건수' }) over4h!: number;
  @ApiProperty({ description: '예상 차감 합계' }) penalty!: number;
}

export class UnwrittenDto {
  @ApiProperty({ type: [UnwrittenByTeacherDto] }) byTeacher!: UnwrittenByTeacherDto[];
  @ApiProperty() total!: number;
  @ApiProperty() penaltyTotal!: number;
  @ApiProperty({ type: [ReportRowDto] }) items!: ReportRowDto[];
}

export class ReportListDto {
  @ApiProperty({ type: [ReportRowDto] }) items!: ReportRowDto[];
}

/* ══ 쓰기 계약 ════════════════════════════════════════════════════════════════
   입력 키는 rules.ts → Swagger/OpenAPI → 프론트 생성 타입 순서로만 흐른다. */

export class ReportRefDto {
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1)
  serId!: number;

  @ApiProperty({ example: '2026-08-27', description: 'REP 복합 유니크 키의 날짜' })
  @Matches(ISO)
  onDate!: string;
}

export class ReportBodyDto {
  @ApiProperty({ maxLength: 2000 }) @IsString() @MaxLength(2000)
  content!: string;

  @ApiProperty({ maxLength: 2000 }) @IsString() @MaxLength(2000)
  progress!: string;

  @ApiProperty({ maxLength: 2000 }) @IsString() @MaxLength(2000)
  homework!: string;
}

/** 임시저장과 제출이 같은 입력 모양을 쓴다. 단, 제출은 rules.ts 가 빈 칸을 막는다. */
export class ReportUpsertDto extends ReportBodyDto {}

export class ReportReviewDto {
  @ApiProperty({ enum: ['approve', 'reject'] })
  @IsIn(['approve', 'reject'])
  decision!: ReportReviewDecision;

  @ApiPropertyOptional({ maxLength: 2000, description: '반려 시 필수 (D-R13)' })
  @IsOptional() @IsString() @MaxLength(2000)
  reason?: string;
}

export class ReportFieldDto {
  @ApiProperty({ enum: REPORT_FIELDS.map((field) => field.key) }) key!: ReportFieldKey;
  @ApiProperty() label!: string;
  @ApiProperty() hint!: string;
  @ApiProperty() min!: number;
  @ApiProperty() max!: number;
}

export class ReportExportFileDto {
  @ApiProperty() studentId!: number;
  @ApiProperty({ example: '20260827_김민준_고2_수학_16:30.png' }) fileName!: string;
}

export class ReportDetailDto extends ReportRowDto {
  @ApiProperty({ type: ReportBodyDto }) body!: ReportBodyDto;
  @ApiProperty({ type: [ReportFieldDto], description: '화면이 순서·문구·제한을 재정의하지 않고 그대로 그린다' })
  fields!: ReportFieldDto[];
  @ApiProperty({ description: '현재 사용자·회차·상태 기준 저장 가능 여부' }) canEdit!: boolean;
  @ApiProperty({ description: '현재 사용자·상태 기준 승인/반려 가능 여부' }) canReview!: boolean;
  @ApiProperty({ description: '저장된 전문을 현재 사용자가 PNG·본문으로 출력할 수 있는지' }) canExport!: boolean;
  @ApiProperty({ type: [ReportExportFileDto], description: '서버가 정한 학생별 PNG 파일명. canExport=false면 빈 배열' })
  exportFiles!: ReportExportFileDto[];
  @ApiProperty({ description: '전문·파일명에 함께 쓰는 서버 과목명' }) subjectName!: string;
  @ApiProperty() lang!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) writtenAt?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) submittedAt?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) reviewedAt?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) rejectReason?: string | null;
}
