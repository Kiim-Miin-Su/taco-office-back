/** @file-guide
 * 목적: guides.dto.ts — GuideDto, PerLessonNoticeDto, GuidesDto, GuideTemplateDto, GuideTemplateWriteDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { DATE_SCHEMA, ID_SCHEMA, IsCalendarDate, ToHttpInteger } from '../../common/validation';
import { GUIDE_FACT_KEYS, type GuideFactKey } from '../../lib/guide-body';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;

/**
 * §43 수업 안내 — **한 번만** 나가는 것.
 * 첫 수업 안내 · 강사 교체 안내가 여기다. 보냈으면 끝이다.
 */
/**
 * §43 「안내 작성」의 자동 채움 한 칸 (F-60).
 * 못 채운 칸은 `value=null` 이고 **왜 없는지**는 서버가 문장으로 준다 — 화면이 「—」를 짓지 않는다.
 */
export class GuideFactDto {
  @ApiProperty({ enum: GUIDE_FACT_KEYS }) key!: GuideFactKey;
  @ApiProperty({ description: '칸 이름 — 본문 머리말과 같은 낱말' }) label!: string;
  @ApiPropertyOptional({ ...S, description: '못 채웠으면 null' }) value?: string | null;
  @ApiProperty() filled!: boolean;
}

/**
 * 아직 안 쓴 초안에만 실린다 — **저장하지 않는다**(`guide.body` 는 사람이 쓴 말이다).
 * 쓰는 순간 `PUT /guides/{id}/body` 가 그 텍스트를 굳히고 그 뒤로는 `autoFill` 이 null 이다.
 */
export class GuideAutoFillDto {
  @ApiProperty({ description: '머리말 — 작성 창이 이 문자열로 열린다. 언제나 빈 줄로 끝난다' }) body!: string;
  @ApiProperty({ type: [GuideFactDto], description: '일곱 칸 — 순서는 서버가 정한다' }) facts!: GuideFactDto[];
}

export class GuideDto {
  @ApiProperty() id!: number;
  @ApiPropertyOptional(N) serId?: number | null;
  @ApiProperty() studentId!: number;
  @ApiPropertyOptional(N) teacherId?: number | null;
  @ApiProperty({ description: 'new(첫 수업) | teacher_change(강사 교체)' }) reason!: string;
  @ApiProperty({ enum: ['draft', 'ready', 'sent', 'read'], description: 'draft·ready 가 아직 안 보낸 것' }) state!: string;
  /** 「보내야 함」의 정본 — 서버 GUIDE_PENDING_DB 파생. 화면은 상태 목록을 다시 정의하지 않는다. */
  @ApiProperty({ description: '아직 안 보냄 (GUIDE_PENDING_DB 파생) — 화면은 이 값만 읽는다' }) pending!: boolean;
  @ApiPropertyOptional(S) studentName?: string | null;
  @ApiPropertyOptional(S) teacherName?: string | null;
  @ApiPropertyOptional(S) serTitle?: string | null;
  @ApiPropertyOptional(S) body?: string | null;
  @ApiPropertyOptional(S) dueOn?: string | null;
  @ApiPropertyOptional({ ...S, format: 'date', description: '첫 수업·강사 교체가 실제로 일어난 KST 회차일. 레거시 행은 null' })
  eventOn?: string | null;
  @ApiPropertyOptional({ ...N, description: '현재 SER_OCC 투영 id. 재투영 때 바뀔 수 있으므로 GUIDE에는 저장하지 않는다' })
  sourceOccurrenceId?: number | null;
  @ApiPropertyOptional(N) createdBy?: number | null;
  @ApiPropertyOptional(S) createdByName?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional(N) sentBy?: number | null;
  @ApiPropertyOptional(S) sentByName?: string | null;
  @ApiPropertyOptional({ ...S, description: 'HIST guide_send의 최초 시각. 없으면 null' }) sentAt?: string | null;
  @ApiPropertyOptional(N) acknowledgedBy?: number | null;
  @ApiPropertyOptional(S) acknowledgedByName?: string | null;
  @ApiPropertyOptional({ ...S, description: 'HIST guide_ack의 최초 시각. 없으면 null' }) acknowledgedAt?: string | null;
  @ApiProperty({ description: '기한이 지난 날 수. 0이면 안 지남' }) overdueDays!: number;
  @ApiProperty({ description: '같은 규칙·같은 날·같은 사유의 다른 학생 안내 수 — 0이면 그룹이 아니다 (F-61)' })
  siblingCount!: number;
  @ApiPropertyOptional({
    type: GuideAutoFillDto, nullable: true,
    description: '아직 안 쓴 초안의 자동 채움 일곱 칸 (F-60). 이미 쓴/보낸 안내는 null — 저장하지 않는다',
  })
  autoFill?: GuideAutoFillDto | null;
}

export class PerLessonNoticeRecordDto {
  @ApiPropertyOptional(N) id?: number | null;
  @ApiProperty() studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiPropertyOptional({ ...S, enum: ['sms', 'kakao', 'email', 'app'] }) channel?: string | null;
  @ApiPropertyOptional(S) body?: string | null;
  @ApiPropertyOptional({ ...S, description: 'PNOTI 발송 기록이 없으면 null' }) sentAt?: string | null;
}

/** §43 회차 안내 — 오늘 온라인 SER_OCC가 정본이고 PNOTI는 학생별 발송 기록이다. */
export class PerLessonNoticeDto {
  /** 기존 화면 key 호환용이며 sourceOccurrenceId와 같다. */
  @ApiProperty() id!: number;
  @ApiProperty(ID_SCHEMA) sourceOccurrenceId!: number;
  @ApiProperty(ID_SCHEMA) serId!: number;
  @ApiProperty({ description: '**회차 키**의 날짜(`ser_occ.on_date`) — 줌 안내 쓰기가 이 값을 그대로 받는다. 옮긴 회차에서는 그려지는 날과 다르다 (S5 · C82-b)' })
  onDate!: string;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1439 }) startMin!: number;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 1440 }) endMin!: number;
  @ApiPropertyOptional(N) teacherId?: number | null;
  @ApiPropertyOptional(S) teacherName?: string | null;
  @ApiPropertyOptional(S) kindName?: string | null;
  @ApiPropertyOptional(N) zaccId?: number | null;
  @ApiPropertyOptional(S) zaccLabel?: string | null;
  @ApiProperty() zoomAssigned!: boolean;
  @ApiProperty({ type: [PerLessonNoticeRecordDto] }) notices!: PerLessonNoticeRecordDto[];
  @ApiProperty({ description: '명단 학생 모두에게 PNOTI.sent_at이 있을 때만 true' }) parentDeliveryRecorded!: boolean;
  @ApiProperty({ description: 'PNOTI audience=teacher 가 있고 sent_at 이 찍혔을 때만 true (F-63)' }) teacherDeliveryRecorded!: boolean;
  /** 단추가 서는지도 서버가 정한다 (D-R39) — 화면이 온라인·줌 계정·강사를 다시 보지 않는다. */
  @ApiProperty({ description: '줌 안내를 보낼 수 있는가 — 취소 아님 · 줌 계정 있음 · 강사 있음 · 아직 안 보냄 (F-63)' }) canSendTeacher!: boolean;
  @ApiPropertyOptional({ ...S, description: '못 보내는 이유 — 보낼 수 있으면 null' }) sendBlockedReason?: string | null;
  /** 아래 호환 필드는 구조화 notices 첫 항목/전체 상태에서 파생한다. */
  @ApiProperty({ enum: ['sms', 'kakao', 'email', 'app'] }) channel!: string;
  @ApiPropertyOptional(S) studentName?: string | null;
  @ApiPropertyOptional(S) serTitle?: string | null;
  @ApiProperty() body!: string;
  @ApiPropertyOptional({ ...S, description: '아직 안 보냈으면 null' }) sentAt?: string | null;
}

/** §43 머리의 여섯 숫자 — GUIDE/PNOTI 현재 사실을 서버 한 곳에서 계산한다. */
export class GuideStatsDto {
  @ApiProperty() monitoring!: number;
  @ApiProperty() overdue!: number;
  @ApiProperty() drafting!: number;
  @ApiProperty() sendPending!: number;
  @ApiProperty() teacherUnconfirmed!: number;
  @ApiProperty() repeatedTeacherChange!: number;
}

/** 연락처/외부 발송 제공자가 없는 동안 UI가 발송 성공을 가장하지 않게 하는 계약. */
export class GuideDeliveryCapabilitiesDto {
  @ApiProperty({ default: false }) parentExternal!: boolean;
  @ApiProperty({ default: false }) teacherExternal!: boolean;
  @ApiPropertyOptional(S) reason?: string | null;
}

export class GuidesDto {
  @ApiProperty({ type: [GuideDto], description: '한 번만 나가는 안내' }) guides!: GuideDto[];
  @ApiProperty({ type: [PerLessonNoticeDto], description: '회차마다 나가는 안내' }) perLesson!: PerLessonNoticeDto[];
  @ApiProperty({ description: '아직 안 보낸 안내 수' }) todoCount!: number;
  @ApiPropertyOptional({ ...N, description: '강사 전용 service 재사용 시 자기 것만 본 그 강사 id. 관리자 API는 null' })
  scopedTeacherId?: number | null;
  @ApiProperty({ type: GuideStatsDto, description: '§43 머리 6칸. 화면이 배열을 다시 세지 않는다' })
  stats!: GuideStatsDto;
  @ApiProperty({ type: GuideDeliveryCapabilitiesDto })
  deliveryCapabilities!: GuideDeliveryCapabilitiesDto;
}

export class GuideBookDto {
  @ApiProperty() issueId!: number;
  @ApiProperty() libId!: number;
  @ApiPropertyOptional(N) versId?: number | null;
  @ApiProperty() code!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional(S) edition?: string | null;
  @ApiPropertyOptional(S) seTe?: string | null;
  @ApiPropertyOptional(S) subKey?: string | null;
}

export class GuideDiagnosticDto {
  @ApiProperty() id!: number;
  @ApiProperty() levelSummary!: string;
  @ApiPropertyOptional(S) strengths?: string | null;
  @ApiPropertyOptional(S) weaknesses?: string | null;
  @ApiPropertyOptional(S) curriculum?: string | null;
  @ApiProperty() createdAt!: string;
}

export class GuideStudentDto {
  @ApiProperty() studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiPropertyOptional(S) grade?: string | null;
  @ApiPropertyOptional(S) guidance?: string | null;
  @ApiPropertyOptional(S) lang?: string | null;
  @ApiProperty() guideCount!: number;
  @ApiProperty({ type: GuideDto }) latestGuide!: GuideDto;
  @ApiProperty({ type: [GuideBookDto] }) books!: GuideBookDto[];
  @ApiPropertyOptional({ type: GuideDiagnosticDto, nullable: true }) diagnostic?: GuideDiagnosticDto | null;
}

export class GuideStudentsDto {
  @ApiProperty({ type: [GuideStudentDto], description: 'GUIDE가 있는 학생과 최신 유효 안내' }) items!: GuideStudentDto[];
}

export const GUIDE_HISTORY_SPANS = ['day', 'week', 'month'] as const;
export type GuideHistorySpan = (typeof GUIDE_HISTORY_SPANS)[number];

export class GuideHistoryQueryDto {
  @ApiPropertyOptional({ enum: GUIDE_HISTORY_SPANS, default: 'month' })
  @ValidateIf((_object, value) => value !== undefined) @IsIn(GUIDE_HISTORY_SPANS)
  span?: GuideHistorySpan;

  @ApiPropertyOptional({ ...DATE_SCHEMA, description: 'day=그날, week=그 주, month=그 달의 기준 KST 날짜' })
  @ValidateIf((_object, value) => value !== undefined) @IsCalendarDate()
  anchor?: string;
}

export class GuideMissingDto {
  @ApiProperty(ID_SCHEMA) sourceOccurrenceId!: number;
  @ApiProperty({ ...DATE_SCHEMA }) eventOn!: string;
  @ApiProperty(ID_SCHEMA) serId!: number;
  @ApiProperty(ID_SCHEMA) studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiPropertyOptional(N) teacherId?: number | null;
  @ApiPropertyOptional(S) teacherName?: string | null;
  @ApiPropertyOptional(S) serTitle?: string | null;
  @ApiProperty({ enum: ['new', 'teacher_change'] }) reason!: string;
}

export class GuideHistoryDayDto {
  @ApiProperty({ ...DATE_SCHEMA }) date!: string;
  @ApiProperty({ type: [GuideDto] }) items!: GuideDto[];
}

export class GuideHistoryCountsDto {
  @ApiProperty() created!: number;
  @ApiProperty() sent!: number;
  @ApiProperty() missing!: number;
}

export class GuideHistoryDto {
  @ApiProperty({ enum: GUIDE_HISTORY_SPANS }) span!: GuideHistorySpan;
  @ApiProperty({ ...DATE_SCHEMA }) anchor!: string;
  @ApiProperty({ ...DATE_SCHEMA }) from!: string;
  @ApiProperty({ ...DATE_SCHEMA }) to!: string;
  @ApiProperty({ type: [GuideMissingDto] }) missing!: GuideMissingDto[];
  @ApiProperty({ type: [GuideHistoryDayDto] }) days!: GuideHistoryDayDto[];
  @ApiProperty({ type: GuideHistoryCountsDto }) counts!: GuideHistoryCountsDto;
}

/** 누락 카드가 보내는 것은 투영 회차와 학생뿐이다. reason/teacher/date는 서버가 재판정한다. */
export class GuideDraftCreateDto {
  @ApiProperty(ID_SCHEMA)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  sourceOccurrenceId!: number;

  @ApiProperty(ID_SCHEMA)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  studentId!: number;
}

/**
 * §43 머리의 「문구 관리」 — 안내를 쓸 때 꺼내 쓰는 **문구 틀**(GTPL).
 *
 * 틀은 안내와 **끊어져 있다.** 안내를 만들 때 본문을 복사해 넣고, 그 뒤로 틀을 고쳐도
 * 이미 쓴 안내는 안 바뀐다 — 보낸 말이 나중에 달라지면 안 되기 때문이다.
 * (`guide` 에 `gtpl_id` 가 없는 것이 그 뜻이다.)
 */
export class GuideTemplateDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiProperty() body!: string;
}

export class GuideTemplateWriteDto {
  @ApiProperty({ description: '무엇에 쓰는 틀인지 — 목록에서 이 이름으로 고른다' })
  @IsString() @MinLength(1) @MaxLength(40) name!: string;

  @ApiProperty({ description: '문구 본문' })
  @IsString() @MinLength(1) @MaxLength(4000) body!: string;
}

/**
 * §43 「안내 작성」 — 본문을 채우면 **보낼 준비**가 된다.
 *
 * 상태 낱말을 화면이 보내지 않는다. 「썼다」는 사실만 서버에 주고, 그 결과 어느 상태가 되는지는
 * 서버가 정한다 (D-R18) — 화면이 `'ready'` 를 적어 보내면 낱말이 두 곳에 살게 된다.
 */
export class GuideBodyDto {
  @ApiProperty({ description: '안내 본문' })
  @IsString() @MinLength(1) @MaxLength(4000) body!: string;
}

/**
 * §43 「나머지 학생에게 복사」 — F-61.
 *
 * 그룹 수업의 안내는 공통 문단이 대부분이라 학생마다 다시 치게 하면 실제로는 안 쓴다.
 * 그래서 **쓴 본문을 같은 규칙·같은 날의 다른 학생 초안으로** 옮긴다.
 *
 * **머리말은 받는 학생 것으로 다시 만든다.** 그대로 복사하면 A 의 이름·학년·교재가 B 의 안내에
 * 남고, 그 말이 학부모에게 나간다. 원본이 자기 머리말로 시작할 때만 앞자락을 떼고 갈아 끼우며,
 * 사람이 머리말까지 고쳐 써서 앞자락이 안 맞으면 **그대로 복사하고 `headReplaced:false` 로 알린다**
 * — 조용히 머리말을 지어내지 않는다.
 */
export class GuideCopySkippedDto {
  @ApiProperty() id!: number;
  @ApiProperty() studentName!: string;
  @ApiProperty({ description: '왜 건너뛰었는지 — 이미 쓴 안내는 덮지 않는다' }) reason!: string;
}

export class GuideCopyResultDto {
  @ApiProperty({ type: [GuideDto], description: '본문이 채워진 형제 초안' }) copied!: GuideDto[];
  @ApiProperty({ type: [GuideCopySkippedDto], description: '건너뛴 형제와 이유' }) skipped!: GuideCopySkippedDto[];
  @ApiProperty({ description: '받는 학생의 머리말로 갈아 끼웠는가 — false 면 원본 본문을 그대로 옮겼다' })
  headReplaced!: boolean;
}

/**
 * §43 회차 안내의 「강사 안내」 — F-63.
 *
 * 회차 키는 **`(serId, onDate)`** 다. `ser_occ.id` 는 재투영 때 바뀌므로 저장·전달의 키가 될 수 없다
 * (C82-b 가 §12 준비 할 일에서 같은 판단을 했다).
 */
export class ZoomNoticeWriteDto {
  @ApiProperty(ID_SCHEMA)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  serId!: number;

  @ApiProperty({ ...DATE_SCHEMA, description: '**회차 키**의 날짜 — 목록이 준 `PerLessonNoticeDto.onDate` 를 그대로 되돌려 준다. 그려지는 날이 아니다(옮긴 회차에서 갈린다 · S5)' })
  @IsCalendarDate()
  onDate!: string;
}

export class ZoomNoticeResultDto {
  @ApiProperty({ type: PerLessonNoticeDto, description: '보낸 뒤의 그 회차 — 화면이 다시 세지 않는다' })
  lesson!: PerLessonNoticeDto;
  @ApiProperty({ description: '강사에게 남긴 줄 수 — 회차마다 하나(pnoti_teacher_once)' }) teacherNotices!: number;
  @ApiProperty({ description: '학부모에게 「보낼 것」으로 남긴 줄 수 — 실제 발송은 아직 없다(N-42)' }) parentNotices!: number;
}
