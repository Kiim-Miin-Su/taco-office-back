/** @file-guide
 * 목적: reports.dto.ts — ReportStudentDto, ReportRowDto, UnwrittenByTeacherDto, UnwrittenDto, ReportListDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min,
  IsUUID, Matches, ValidateIf, ValidateNested,
} from 'class-validator';
import {
  REP_STATE_FROM_DB, REPORT_FIELDS, REPORT_PNG_DATA_URL_MAX_CHARS, type RepStateDb, type ReportFieldKey, type ReportReviewDecision,
} from '../../lib/rules';
import { DATE_SCHEMA, ID_SCHEMA, IsCalendarDate, ToHttpInteger } from '../../common/validation';

const EXPORT_REVISION_PATTERN = /^[a-f0-9]{64}$/;
const EXPORT_REVISION_SCHEMA = {
  pattern: EXPORT_REVISION_PATTERN.source,
  description: '서버 파일명/본문의 SHA-256 출력 버전. 조회 값을 PNG 요청에 그대로 전달하며 인증 서명은 아님',
};

export class ReportTeacherQueryDto {
  @ApiPropertyOptional({ ...ID_SCHEMA, description: '작성자 필터. 강사는 유효한 값도 본인 ID로 강제한다' })
  @ValidateIf((_object, value) => value !== undefined)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  teacherId?: number;
}

/** 조회일은 실제 KST 수업일, 상세/쓰기의 onDate는 원래 회차 키다. */
export class ReportQueryDto extends ReportTeacherQueryDto {
  @ApiPropertyOptional({ ...DATE_SCHEMA, description: '실제 KST 수업일 시작(포함). 없으면 하한 없음' })
  @ValidateIf((_object, value) => value !== undefined) @IsCalendarDate()
  from?: string;

  @ApiPropertyOptional({ ...DATE_SCHEMA, description: '실제 KST 수업일 끝(포함). 없으면 상한 없음' })
  @ValidateIf((_object, value) => value !== undefined) @IsCalendarDate()
  to?: string;

  @ApiPropertyOptional({ enum: Object.keys(REP_STATE_FROM_DB), description: '현재 회차에서 파생한 리포트 상태' })
  @ValidateIf((_object, value) => value !== undefined) @IsIn(Object.keys(REP_STATE_FROM_DB))
  state?: RepStateDb;
}

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
  @ApiProperty({ type: 'integer', nullable: true, minimum: 0, maximum: 1439,
    description: '실제 SER_OCC.span 시작의 KST 분. 회차 투영이 없으면 null; 쓰기 입력이 아니다.' })
  startMin!: number | null;
  @ApiProperty({ type: 'integer', nullable: true, minimum: 1, maximum: 1440,
    description: '실제 SER_OCC.span 종료의 KST 분. 자정 종료는 1440, 회차 투영이 없으면 null; 쓰기 입력이 아니다.' })
  endMin!: number | null;
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
  @ApiProperty(ID_SCHEMA) @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  serId!: number;

  @ApiProperty({ ...DATE_SCHEMA, example: '2026-08-27', description: 'REP 복합 유니크 키의 원래 날짜. 옮긴 실제 날짜와 다를 수 있다' })
  @IsCalendarDate()
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
  @ApiProperty(EXPORT_REVISION_SCHEMA) revision!: string;
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
  @ApiProperty(ID_SCHEMA) @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  repId!: number;

  @ApiProperty({ maxLength: 255 }) @IsString() @MaxLength(255)
  fileName!: string;

  @ApiProperty(EXPORT_REVISION_SCHEMA) @IsString() @Matches(EXPORT_REVISION_PATTERN)
  revision!: string;

  @ApiProperty({ description: 'html-to-image가 만든 PNG data URL', maxLength: REPORT_PNG_DATA_URL_MAX_CHARS })
  @IsString() @MaxLength(REPORT_PNG_DATA_URL_MAX_CHARS)
  pngDataUrl!: string;
}

/** RSEND 한 행과 같은 학생 1명 단위. 전체 발송은 이 요청을 순차 재사용한다. */
export class ReportDeliveryCreateDto {
  @ApiProperty({ format: 'uuid', description: '재시도·더블클릭 중복 방지 키' }) @IsUUID()
  requestKey!: string;

  @ApiProperty({ ...DATE_SCHEMA, example: '2026-08-27', description: '발송 묶음의 실제 KST 수업일. 각 리포트의 원래 onDate와 구분한다' }) @IsCalendarDate()
  onDate!: string;

  @ApiProperty(ID_SCHEMA) @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
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
  @ApiPropertyOptional({ ...DATE_SCHEMA, example: '2026-08-27', description: '발송 대상 실제 KST 수업일. 큐에서 생략하면 어제, 이력에서 생략하면 전체. 이력은 발송 당시 날짜를 보존한다' })
  @ValidateIf((_object, value) => value !== undefined) @IsCalendarDate()
  onDate?: string;
}

export class ReportDeliveryHistoryQueryDto extends ReportDeliveryQueryDto {
  @ApiPropertyOptional(ID_SCHEMA) @ValidateIf((_object, value) => value !== undefined)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
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
  @ApiProperty(ID_SCHEMA) @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  sendId!: number;
}
