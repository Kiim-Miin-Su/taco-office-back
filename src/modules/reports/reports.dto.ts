/** @file-guide
 * 목적: reports.dto.ts — ReportTeacherQueryDto, ReportQueryDto, ReportStudentDto, ReportRowDto, UnwrittenByTeacherDto 등 (dto)
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
import { FileRefDto } from '../files/files.dto';

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
  @ApiProperty({
    description: 'C-40 회차 출석은 유지하면서 학생별 지각 사실만 표시. 본문·학부모 공개에는 자동 삽입하지 않는다',
  })
  late!: boolean;
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
  @ApiProperty({
    enum: ['offline', 'online'],
    description: '회차 예외(EXC.mode)를 반영한 실제 수업 방식. 쓰기 입력이 아니다.',
  })
  mode!: 'offline' | 'online';
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
  @ApiProperty({ description: '역할 낱말(강사 · 매니저 …) — 서버 lib/role-words 한 벌. 오른쪽 머리 「이름 · 역할」 (g5 47-07)' })
  roleLabel!: string;
  @ApiPropertyOptional({ type: String, nullable: true, description: '직함(staff.title) — 원문 「Sophia 강사 · 코디네이터」의 뒤 낱말. 없으면 null' })
  title?: string | null;
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

export class ReportReminderCreateDto {
  @ApiProperty({
    format: 'uuid',
    description: '재시도·더블클릭 중복 방지 키. 같은 키는 같은 actor·teacherId 범위로만 재사용한다',
  })
  @IsUUID()
  requestKey!: string;

  @ApiPropertyOptional({ ...ID_SCHEMA, description: '선택 강사. 생략하면 실행 시점의 조치 대상 강사 전체' })
  @ValidateIf((_object, value) => value !== undefined)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  teacherId?: number;
}

export class ReportReminderRecipientDto {
  @ApiProperty({ type: 'integer' }) teacherId!: number;
  @ApiProperty() teacherName!: string;
  @ApiProperty({ type: 'integer', description: '독촉 생성 시점의 미제출·초안·반려 건수' }) count!: number;
  @ApiProperty({ format: 'date-time', description: '내부 NOTI 생성 시각' }) createdAt!: string;
}

export class ReportReminderResultDto {
  @ApiProperty({ format: 'uuid' }) requestKey!: string;
  @ApiProperty({
    type: [ReportReminderRecipientDto],
    description: '전체 요청의 현재 대상이 0명이면 빈 배열. 원장이 없으므로 같은 키 재시도도 최신 대상을 다시 계산한다',
  })
  items!: ReportReminderRecipientDto[];
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
  @ApiProperty({ example: '20260827_김민준_고2_수학_16-30.png' }) fileName!: string;
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
  @ApiProperty({ format: 'uuid', description: '재시도·더블클릭 중복 방지 키 — 같은 키는 학생·날짜·리포트 집합·본문·PNG 바이트(SHA-256)가 모두 같을 때만 기존 결과로 수렴한다 (CR-BE-03)' }) @IsUUID()
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

export const REPORT_SEND_SPANS = ['day', 'week', 'month'] as const;
export type ReportSendSpan = (typeof REPORT_SEND_SPANS)[number];

export class ReportDeliveryHistoryQueryDto extends ReportDeliveryQueryDto {
  @ApiPropertyOptional(ID_SCHEMA) @ValidateIf((_object, value) => value !== undefined)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  repId?: number;

  @ApiPropertyOptional({
    enum: REPORT_SEND_SPANS,
    description: '보낸 내역을 묶는 눈금 — 일별 · 주별(월요일 시작) · 월별. 보낸 시각(KST) 기준. 없으면 groups 는 빈 배열',
  })
  @ValidateIf((_object, value) => value !== undefined) @IsIn(REPORT_SEND_SPANS)
  span?: ReportSendSpan;
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
  @ApiProperty({ description: '보존된 파일 수 — 재발송이 세는 것과 같은 것이다(pdflog 의 file_url 이 있는 행 · S5)' })
  fileCount!: number;
  @ApiProperty({ type: [FileRefDto], description: 'Neon FILE에 보존된 기록지 PNG. 레거시 외부 URL은 내려보내지 않는다.' })
  downloadFiles!: FileRefDto[];
  @ApiProperty({ description: '다시 보낼 수 있는가 — 보존 파일이 한 장이라도 있어야 한다 (D-R39)' }) canResend!: boolean;
  @ApiProperty({ type: String, nullable: true, description: '재발송이 막힌 이유 — 보낼 수 있으면 null' })
  resendBlockedReason!: string | null;
  @ApiProperty() sentAt!: string;
  @ApiProperty() sentBy!: number;
  @ApiProperty() sentByName!: string;
  @ApiProperty({ type: [String], description: '보낸 리포트들의 과목 이름(없으면 종류 이름) — 원문 줄 「과목 · 강사 · 08-19 수업」' })
  subjectNames!: string[];
  @ApiProperty({ type: [String], description: '보낸 리포트들의 강사 이름 — 회차 강사, 없으면 리포트 작성 강사' })
  teacherNames!: string[];
}

/** §48 보낸 내역 묶음 한 칸 — 「08-17 ~ 08-23 · 1건 · 기록지 1 · 1명」 (g5 48-02) */
export class ReportSendGroupDto {
  @ApiProperty({ ...DATE_SCHEMA, description: '묶음 첫날(KST) — 주는 월요일, 달은 1일' }) from!: string;
  @ApiProperty({ ...DATE_SCHEMA, description: '묶음 끝날(KST)' }) to!: string;
  @ApiProperty({ description: '묶음 이름 — 일 「MM-DD」 · 주 「MM-DD ~ MM-DD」 · 달 「YYYY년 M월」' }) label!: string;
  @ApiProperty({ description: '보낸 건수(재발송 포함)' }) count!: number;
  @ApiProperty({ description: '보존된 기록지(PNG) 장수 — fileCount 합' }) sheets!: number;
  @ApiProperty({ description: '받은 학생 수' }) students!: number;
  @ApiProperty({ type: [Number], description: '이 묶음에 든 발송 id(최신 먼저) — 화면이 items 를 이 묶음에 놓는다' })
  sendIds!: number[];
}

export class ReportSendHistoryListDto {
  @ApiProperty({ description: '필터에 맞는 전체 이력 수. items 100건 상한과 분리한다.' }) total!: number;
  @ApiProperty({ type: [ReportSendHistoryDto] }) items!: ReportSendHistoryDto[];
  @ApiPropertyOptional({ enum: REPORT_SEND_SPANS, nullable: true, description: '요청한 눈금 — 없으면 null' })
  span?: ReportSendSpan | null;
  @ApiProperty({ type: [ReportSendGroupDto], description: 'span 묶음(최신 먼저). 건수·기록지·인원은 100건 상한 밖까지 센다' })
  groups!: ReportSendGroupDto[];
  @ApiProperty({ description: '필터에 맞는 기록지 전체 장수 — 머리 「기록지 N장」' }) sheets!: number;
}

export class ReportDeliveryResultDto {
  @ApiProperty({ type: ReportSendHistoryDto }) item!: ReportSendHistoryDto;
}

export class ReportSendRefDto {
  @ApiProperty(ID_SCHEMA) @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  sendId!: number;
}

/* ══ N-54 주간 묶음 (W11 · R2) ═══════════════════════════════════════════════
 * 그 주(월~일 · KST)의 학생별 묶음 — 본문은 그 주 이미 쓴 리포트를 **읽을 때** 모은다(저장하지 않는다).
 * `wrep.body` 에는 매니저가 쓴 총평만 둔다. 보내기는 `POST /guardians/send` 에 `wrepId` 를 실어 DQ3 원장에 남긴다.
 */

export class WeeklyQueryDto {
  @ApiPropertyOptional({ ...DATE_SCHEMA, description: '그 주의 아무 날 — 서버가 그 주 월요일로 맞춘다. 없으면 KST 어제가 든 주' })
  @ValidateIf((_object, value) => value !== undefined) @IsCalendarDate()
  weekOf?: string;
}

export class WeeklySummaryWriteDto {
  @ApiProperty(ID_SCHEMA) @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  studentId!: number;

  @ApiProperty({ ...DATE_SCHEMA, description: '그 주의 아무 날 — 서버가 월요일로 맞춘다' }) @IsCalendarDate()
  weekOf!: string;

  @ApiProperty({ minLength: 1, maxLength: 2000, description: '매니저가 쓴 총평 — 학부모에게 그대로 나간다. 앞뒤 공백은 서버가 걷는다' })
  @IsString() @MaxLength(2000)
  summary!: string;
}

export class WeeklyLessonDto {
  @ApiProperty(ID_SCHEMA) repId!: number;
  @ApiProperty(ID_SCHEMA) serId!: number;
  @ApiProperty({ ...DATE_SCHEMA, description: 'REP 원래 날짜 키 — 상세 · 쓰기 경로에 그대로 쓴다' }) onDate!: string;
  @ApiProperty({ ...DATE_SCHEMA, description: '실제 KST 수업일' }) date!: string;
  @ApiProperty({ type: 'integer', nullable: true, minimum: 0, maximum: 1439 }) startMin!: number | null;
  @ApiProperty({ type: 'integer', nullable: true, minimum: 1, maximum: 1440 }) endMin!: number | null;
  @ApiProperty() subjectName!: string;
  @ApiProperty({ type: String, nullable: true }) teacherName!: string | null;
  @ApiProperty({ enum: Object.keys(REP_STATE_FROM_DB) }) state!: RepStateDb;
  @ApiProperty({ description: '상태 낱말(서버) — 「승인 대기」 · 「리포트 미작성」 …' }) stateLabel!: string;
  @ApiProperty() written!: boolean;
  @ApiProperty() approved!: boolean;
  @ApiProperty({ type: ReportBodyDto, nullable: true, description: '쓴 리포트의 세 칸 — 안 썼으면 null' })
  body!: ReportBodyDto | null;
}

export class WeeklySummaryDto {
  @ApiProperty({ description: '매니저가 쓴 총평' }) text!: string;
  @ApiProperty({ type: Number, nullable: true }) byId!: number | null;
  @ApiProperty({ type: String, nullable: true }) byName!: string | null;
  @ApiProperty({ description: '쓴 시각 ISO' }) at!: string;
}

export class WeeklyBundleDto {
  @ApiProperty(ID_SCHEMA) studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiProperty({ type: String, nullable: true }) grade!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: '총평을 쓴 뒤의 묶음 id(`wrep`) — 보호자 발송이 이 id 를 싣는다' })
  wrepId!: number | null;
  @ApiProperty({ type: WeeklySummaryDto, nullable: true }) summary!: WeeklySummaryDto | null;
  @ApiProperty({ description: '예전 방식으로 저장된 기록(N-25 · 고치지 않는다) — 쓰기 · 보내기가 막힌다' }) legacy!: boolean;
  @ApiProperty({ type: [WeeklyLessonDto], description: '그 주 리포트 — 수업 차례' }) lessons!: WeeklyLessonDto[];
  @ApiProperty({ type: 'integer' }) lessonCount!: number;
  @ApiProperty({ type: 'integer' }) approvedCount!: number;
  @ApiProperty() canWriteSummary!: boolean;
  @ApiProperty({ type: String, nullable: true }) summaryBlockedReason!: string | null;
  @ApiProperty({ description: '보호자에게 보낼 수 있는가 — 전부 승인 · 총평 있음 · 본문 2,000자 안' }) canSend!: boolean;
  @ApiProperty({ type: String, nullable: true }) sendBlockedReason!: string | null;
  @ApiProperty({ type: String, nullable: true, description: '보낼 본문 — 보낼 수 있을 때만. 창은 이 글을 그대로 보낸다' })
  plainText!: string | null;
  @ApiProperty({ description: '메일 제목 기본값 — 창에서 고칠 수 있다' }) subject!: string;
  @ApiProperty({ type: String, nullable: true, description: '처음 실제로 나간 시각(guardian_send status=sent) — 없으면 null' })
  sentAt!: string | null;
  @ApiProperty({ type: 'integer', description: '보호자 × 채널 시도 수(원장 줄 수)' }) attemptCount!: number;
  @ApiProperty({ type: String, nullable: true }) lastAttemptAt!: string | null;
}

export class WeeklyBundleListDto {
  @ApiProperty({ ...DATE_SCHEMA, description: '그 주 월요일' }) weekOf!: string;
  @ApiProperty({ ...DATE_SCHEMA, description: '그 주 일요일' }) weekTo!: string;
  @ApiProperty({ description: '주 이름 — 「09-21 ~ 09-27」(보낸 내역 주별 묶음과 같은 모양)' }) label!: string;
  @ApiProperty({ type: 'integer', description: '묶음 수(그 주 리포트가 있는 학생)' }) total!: number;
  @ApiProperty({ type: 'integer', description: '아직 보호자에게 나가지 않은 묶음 수 — 탭 배지' }) remaining!: number;
  @ApiProperty({ type: [WeeklyBundleDto] }) bundles!: WeeklyBundleDto[];
}
