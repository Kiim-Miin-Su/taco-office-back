import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min,
  IsUUID, ValidateNested,
} from 'class-validator';
import {
  REPORT_FIELDS, REPORT_PNG_DATA_URL_MAX_CHARS, type ReportFieldKey, type ReportReviewDecision,
} from '../../lib/rules';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export class ReportStudentDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) grade?: string | null;
  @ApiProperty({ description: 'REP_STU.deliver — 이 학생에게 전문을 전달할지' }) deliver!: boolean;
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
  @ApiProperty({ description: '클립보드와 RSEND.body가 공유하는 서버 생성 5섹션 본문' }) plainText!: string;
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
  @ApiProperty({ description: '현재 사용자가 학부모 전달 이력을 만들 수 있는지. manager 이상만 true' })
  canDeliver!: boolean;
  @ApiProperty({ description: '전문·파일명에 함께 쓰는 서버 과목명' }) subjectName!: string;
  @ApiProperty() lang!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) writtenAt?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) submittedAt?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) reviewedAt?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) rejectReason?: string | null;
}

export class ReportDeliveryFileInputDto {
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1)
  repId!: number;

  @ApiProperty({ maxLength: 255 }) @IsString() @MaxLength(255)
  fileName!: string;

  @ApiProperty({ description: 'html-to-image가 만든 PNG data URL', maxLength: REPORT_PNG_DATA_URL_MAX_CHARS })
  @IsString() @MaxLength(REPORT_PNG_DATA_URL_MAX_CHARS)
  pngDataUrl!: string;
}

/** RSEND 한 행과 같은 학생 1명 단위. 전체 발송은 이 요청을 순차 재사용한다. */
export class ReportDeliveryCreateDto {
  @ApiProperty({ format: 'uuid', description: '재시도·더블클릭 중복 방지 키' }) @IsUUID()
  requestKey!: string;

  @ApiProperty({ example: '2026-08-27' }) @Matches(ISO)
  onDate!: string;

  @ApiProperty() @Type(() => Number) @IsInt() @Min(1)
  studentId!: number;

  @ApiProperty({ type: [ReportDeliveryFileInputDto], maxItems: 20 })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ReportDeliveryFileInputDto)
  files!: ReportDeliveryFileInputDto[];
}

export class ReportResendDto {
  @ApiProperty({ format: 'uuid', description: '재시도·더블클릭 중복 방지 키' }) @IsUUID()
  requestKey!: string;
}

export class ReportDeliveryQueryDto {
  @ApiPropertyOptional({ example: '2026-08-27', description: '없으면 KST 어제' })
  @IsOptional() @Matches(ISO)
  onDate?: string;
}

export class ReportDeliveryHistoryQueryDto extends ReportDeliveryQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  repId?: number;
}

export class ReportDeliveryStudentDto {
  @ApiProperty({ type: ReportStudentDto }) student!: ReportStudentDto;
  @ApiProperty({ type: [ReportDetailDto] }) reports!: ReportDetailDto[];
  @ApiProperty({ description: '미작성·미승인 0건이고 아직 최초 발송 전인 학생' }) canSend!: boolean;
  @ApiProperty() blockedCount!: number;
  @ApiPropertyOptional({ type: Number, nullable: true }) lastSendId!: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) lastSentAt!: string | null;
}

export class ReportDeliveryQueueDto {
  @ApiProperty() onDate!: string;
  @ApiProperty() total!: number;
  @ApiProperty() remaining!: number;
  @ApiProperty() blocked!: number;
  @ApiProperty({ type: [ReportDeliveryStudentDto] }) students!: ReportDeliveryStudentDto[];
}

export class ReportSendHistoryDto {
  @ApiProperty() id!: number;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'null이면 최초 발송, 값이 있으면 해당 이력의 재발송' })
  sourceSendId!: number | null;
  @ApiProperty() studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiProperty() onDate!: string;
  @ApiProperty({ type: [Number] }) repIds!: number[];
  @ApiProperty({ enum: ['blob'] }) channel!: string;
  @ApiProperty() fileCount!: number;
  @ApiProperty() sentAt!: string;
  @ApiProperty() sentBy!: number;
  @ApiProperty() sentByName!: string;
}

export class ReportSendHistoryListDto {
  @ApiProperty({ type: [ReportSendHistoryDto] }) items!: ReportSendHistoryDto[];
}

export class ReportDeliveryResultDto {
  @ApiProperty({ type: ReportSendHistoryDto }) item!: ReportSendHistoryDto;
}

export class ReportSendRefDto {
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1)
  sendId!: number;
}
