/** @file-guide
 * 목적: guides.dto.ts — GuideDto, PerLessonNoticeDto, GuidesDto, GuideTemplateDto, GuideTemplateWriteDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BadRequestException } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { DATE_SCHEMA, ID_SCHEMA, IsCalendarDate, ToHttpInteger } from '../../common/validation';
import { GUIDE_FACT_KEYS_TEACHER_CHANGE, type GuideFactKey } from '../../lib/guide-body';
import { LeadDiagDto } from '../ops/lead-diag.dto';

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
  @ApiProperty({ enum: GUIDE_FACT_KEYS_TEACHER_CHANGE, description: '일곱 칸(F-60) — 강사 교체 안내는 여덟째 「이전 강사」(previousTeacher)가 붙는다' }) key!: GuideFactKey;
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

/** §43 사다리 한 칸 — 「하루 · 6시간 · 3시간」. 지난 칸은 화면이 ✕ 로 그린다 (N-89) */
export class GuideLadderStepDto {
  @ApiProperty({ enum: ['day', 'h6', 'h3'] }) key!: string;
  @ApiProperty({ description: '칸 이름 — 원문 머리 「하루 · 6시간 · 3시간」의 낱말' }) label!: string;
  @ApiProperty({ description: '그 칸의 시각이 이미 지났는가(남은 시간 ≤ 칸의 시간)' }) passed!: boolean;
}

/**
 * §43 안내 기한 (N-89 채택 · W11) — 기준은 그 안내가 걸린 **첫 수업 시작 시각**(회차가 없으면 기한 날 00:00 KST).
 * 남은 시간 문장 · 사다리 칸 · 긴급도를 서버가 만든다(D-R37) — 화면은 날짜·시각을 빼지 않는다.
 */
export class GuideDeadlineDto {
  @ApiProperty({ description: '기준 시각 ISO(+09:00) — 수업 시작, 회차가 없으면 기한 날 00:00' }) startAt!: string;
  @ApiProperty({ enum: ['lesson', 'due'], description: 'lesson = 회차 시작 · due = 회차가 없어 기한 날 00:00' }) basis!: string;
  @ApiProperty({ type: 'integer', description: '남은 분 — 지났으면 음수' }) minutesLeft!: number;
  @ApiProperty({ description: '「5시간 남음」 · 「40분 남음」 · 「3일 지남」' }) leftLabel!: string;
  @ApiProperty({ type: [GuideLadderStepDto], description: '하루 · 6시간 · 3시간 — 차례는 서버가 정한다' }) ladder!: GuideLadderStepDto[];
  @ApiProperty({ enum: ['overdue', 'today', 'none'], description: 'overdue = 6시간 칸이 지남(마감 지남) · today = 하루 칸만 지남' })
  urgency!: string;
  @ApiProperty({ ...S, description: '「마감 지남」 · 「오늘 안에」 — 여유가 있으면 null' }) urgencyLabel!: string | null;
}

/**
 * 같은 반 학생 — 같은 규칙·같은 날·같은 사유의 다른 학생 안내 (PDF F-60 「같은 반 학생이 함께 선택됨」 · all160 2026-09-30).
 * 작성 창이 이 목록으로 함께 보낼 학생을 고른다. **옮길 수 있는가와 못 옮기는 까닭은 서버가 정한다** — 복사(F-61)가 덮지 않는
 * 규칙(초안만 받는다)과 같은 함수다. 화면이 상태 낱말로 다시 판정하면 체크가 서는데 복사는 건너뛰는 줄이 생긴다.
 */
export class GuideSiblingDto {
  @ApiProperty() id!: number;
  @ApiProperty({ ...S, description: '학생 이름 — 학생이 지워졌으면 null' }) studentName!: string | null;
  @ApiProperty({ description: '그 형제 안내의 상태 낱말 (draft | ready | sent | read)' }) state!: string;
  @ApiProperty({ description: '본문을 옮길 수 있는가 — 아직 안 쓴 초안만 받는다(쓴 글은 덮지 않는다)' }) copyable!: boolean;
  @ApiProperty({ ...S, description: '못 옮기는 까닭 — 복사 결과의 「건너뛴 이유」와 같은 문장. 옮길 수 있으면 null' }) skipReason!: string | null;
}

export class GuideDto {
  @ApiProperty() id!: number;
  @ApiPropertyOptional(N) serId?: number | null;
  @ApiProperty() studentId!: number;
  @ApiPropertyOptional(N) teacherId?: number | null;
  @ApiProperty({ description: 'new(첫 수업) | teacher_change(강사 교체)' }) reason!: string;
  /* 필수 nullable (wave 6) — 서버는 언제나 싣는다(mapGuide 한 곳). 선택으로 두면 화면 시험 표본이 이 칸을 빠뜨린 채 조용히 낡는다 */
  @ApiProperty({
    ...S,
    description: '안내 종류 낱말 — 첫 수업 = 「포괄 안내」 · 강사 교체 = 「간이 안내」(원문 §45 kind full/quick · §44 머리 칩). 모르는 사유는 null',
  })
  kindLabel!: string | null;
  @ApiProperty({ enum: ['draft', 'ready', 'sent', 'read'], description: 'draft·ready 가 아직 안 보낸 것' }) state!: string;
  /** 「보내야 함」의 정본 — 서버 GUIDE_PENDING_DB 파생. 화면은 상태 목록을 다시 정의하지 않는다. */
  @ApiProperty({ description: '아직 안 보냄 (GUIDE_PENDING_DB 파생) — 화면은 이 값만 읽는다' }) pending!: boolean;
  @ApiProperty({ description: '현재 사용자에게 최초 내부 발송 전이가 허용되는가' }) canSend!: boolean;
  @ApiProperty({ description: '현재 수신 강사에게 최초 확인 전이가 허용되는가' }) canAck!: boolean;
  @ApiProperty({ ...S, description: '발송 불가 사유. canSend=true이면 null' }) sendBlockedReason!: string | null;
  @ApiProperty({ type: 'integer', nullable: true, minimum: 0, description: '최초 GUIDE 발송부터 확인까지 초. 시각 누락/역전이면 null' })
  acknowledgedAfterSeconds!: number | null;
  @ApiPropertyOptional(S) studentName?: string | null;
  @ApiPropertyOptional(S) teacherName?: string | null;
  /* 필수 nullable — 간이 안내(강사 교체)만 값이 있다. 서버가 장부(마법사 LOG · 같은 규칙의 직전 회차)에서 되짚는다 (TEACHER-LINEAGE 2026-09-29) */
  @ApiProperty({ ...N, description: '이전 강사 id — 강사 교체 안내(reason=teacher_change)만. 받는 강사(teacherId)가 교체 강사다. 첫 수업 안내는 null' })
  previousTeacherId!: number | null;
  @ApiProperty({ ...S, description: '이전 강사 이름 — 「이전 강사 → 교체 강사」 readback. 첫 수업 안내 · 되짚을 수 없으면 null' })
  previousTeacherName!: string | null;
  @ApiPropertyOptional(S) serTitle?: string | null;
  /* 수업 이름표 — 정규 수업은 serTitle 이 비어 있다. 화면은 이 넷으로 「과목 · 시각 · 강의실」을 적는다 (g4 「수업명 미정」) */
  @ApiPropertyOptional({ ...S, description: '과목 이름(sub.name) — 과목 없는 회차는 null' }) subName?: string | null;
  @ApiPropertyOptional({ ...S, description: '수업 종류 이름(kind.name) — 과목이 없을 때 부를 이름' }) kindName?: string | null;
  @ApiPropertyOptional({ type: 'integer', nullable: true, minimum: 0, maximum: 1439, description: '그 회차의 시작 분(KST 자정 기준). 회차가 없으면 규칙의 시작 분' })
  startMin?: number | null;
  @ApiPropertyOptional({ ...S, description: '강의실 이름 — 그 회차의 강의실, 없으면 규칙의 강의실. 온라인·미정이면 null' }) roomName?: string | null;
  @ApiPropertyOptional(S) body?: string | null;
  @ApiPropertyOptional({ ...S, description: '§44 「지도 방향」 — 옛 안내 null (g4 §44-3)' }) direction?: string | null;
  @ApiPropertyOptional({
    ...S,
    description: '§44 「관리자 코멘트 · 강사만」 — 관리자와 받는 강사에게만 싣는다. 학부모 발송 본문·안내문 PNG 에는 쓰지 않는다 (g4 §44-3)',
  })
  adminNote?: string | null;
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
  /* 필수 nullable — 서버는 언제나 싣는다(mapGuide 한 곳). 보낸 안내·기준이 없는 안내는 null */
  @ApiProperty({
    type: GuideDeadlineDto, nullable: true,
    description: '아직 안 보낸 안내의 기한(N-89) — 첫 수업 시작(없으면 기한 날 00:00)까지 남은 시간 · 사다리 · 긴급도. 보냈으면 null',
  })
  deadline!: GuideDeadlineDto | null;
  @ApiProperty({ description: '같은 규칙·같은 날·같은 사유의 다른 학생 안내 수 — 0이면 그룹이 아니다 (F-61). `siblings` 의 길이다' })
  siblingCount!: number;
  @ApiProperty({ type: [GuideSiblingDto], description: '같은 반 학생 — 이름 차례 (F-60 · 작성 창이 함께 보낼 학생을 고른다). 그룹이 아니면 빈 목록' })
  siblings!: GuideSiblingDto[];
  @ApiPropertyOptional({
    type: GuideAutoFillDto, nullable: true,
    description: '아직 안 쓴 초안의 자동 채움 일곱 칸 (F-60). 이미 쓴/보낸 안내는 null — 저장하지 않는다',
  })
  autoFill?: GuideAutoFillDto | null;
}

/** GUIDE 행위는 id만 선택한다. 수신자·본문·상태·시각은 요청 필드가 아니다. */
export class GuideActionParamsDto {
  @ApiProperty(ID_SCHEMA)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  id!: number;
}

/** 추가 필드는 ValidationPipe가 막고, 빈 배열/비객체도 두 행위가 같은 검사로 막는다. */
export class GuideActionDto {
  static assertEmpty(body: unknown): void {
    if (body === undefined) return;
    if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0) {
      throw new BadRequestException('안내 발송·확인은 입력 필드를 받지 않습니다');
    }
  }
}

export class ReceivedGuidesDto {
  @ApiProperty({ type: [GuideDto], description: '로그인 강사에게 내부 전달된 sent/read 안내만' }) items!: GuideDto[];
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
  @ApiPropertyOptional({ ...S, description: '과목 이름(sub.name) — 과목 없는 회차는 null (g4 「수업명 미정」)' }) subName?: string | null;
  @ApiPropertyOptional({ ...S, description: '강의실 이름 — 그 회차의 강의실, 없으면 규칙의 강의실. 없으면 null' }) roomName?: string | null;
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

/**
 * §43 매번 머리 「강사 N명 한 번에」(원문 §43 · wave 6 §43-6) — 단추가 서는지와 N 을 **서버가** 센다(D-R37 · D-R39).
 * 고르는 문은 회차 줄의 `canSendTeacher` 와 같은 `sendGate` 하나다 — 화면이 줄을 다시 세면 단추의 N 과 실제로 나간 수가 갈린다.
 */
export class ZoomNoticeBatchInfoDto {
  @ApiProperty({ type: 'integer', minimum: 0, description: '「강사 N명」의 N — 지금 보낼 수 있는 오늘 온라인 회차의 서로 다른 강사 수' })
  teacherCount!: number;
  @ApiProperty({ type: 'integer', minimum: 0, description: '지금 보낼 수 있는 회차 수(canSendTeacher 인 줄)' })
  lessonCount!: number;
  @ApiProperty({ description: '누를 수 있는가 — 발송 권한(canAdminPage·canCrudAll)이 있고 보낼 회차가 하나라도 있을 때만 true' })
  canSend!: boolean;
  @ApiProperty({ ...S, description: '못 누르는 이유 — 누를 수 있으면 null' })
  blockedReason!: string | null;
}

export class GuidesDto {
  @ApiProperty({ type: [GuideDto], description: '한 번만 나가는 안내' }) guides!: GuideDto[];
  @ApiProperty({ type: [PerLessonNoticeDto], description: '회차마다 나가는 안내' }) perLesson!: PerLessonNoticeDto[];
  @ApiProperty({
    type: () => [GuideMissingDto],
    description: '안내가 필요한데(첫 수업·강사 교체) 아직 GUIDE 가 없는 학생 — §43 「안내 없음」 줄. '
      + '판정은 §45 누락 카드와 같은 함수이고, 할 일 창은 수업 날 기준 최근 30일 ~ 앞으로 7일이다',
  })
  missing!: GuideMissingDto[];
  @ApiProperty({ description: '할 일 수 = 안 보낸 안내 + 안내 없음 + 회차 안내 미기록 — 탭 배지와 목록이 같은 수' }) todoCount!: number;
  @ApiPropertyOptional({ ...N, description: '강사 전용 service 재사용 시 자기 것만 본 그 강사 id. 관리자 API는 null' })
  scopedTeacherId?: number | null;
  @ApiProperty({ type: GuideStatsDto, description: '§43 머리 6칸. 화면이 배열을 다시 세지 않는다' })
  stats!: GuideStatsDto;
  @ApiProperty({ type: GuideDeliveryCapabilitiesDto })
  deliveryCapabilities!: GuideDeliveryCapabilitiesDto;
  /* 필수(W11 7-3 ②) — 서버는 언제나 싣는다(all() 한 곳). wave 6 이 남긴 「시험 표본을 채운 뒤 필수로」를 닫았다 */
  @ApiProperty({ type: ZoomNoticeBatchInfoDto, description: '§43 매번 머리 「강사 N명 한 번에」 — N·회차 수·막힌 이유 (wave 6)' })
  zoomBatch!: ZoomNoticeBatchInfoDto;
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
  @ApiPropertyOptional({ ...S, description: '교재 레벨 — 코드표 레벨(N-47) 낱말이 있으면 그것, 아직이면 옛 원문(lib.level) · §44 교재 줄의 레벨 사각(W11 A 후속)' })
  level?: string | null;
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
  @ApiPropertyOptional({
    type: () => LeadDiagDto,
    nullable: true,
    description: '§44 진단 카드 셋(영어 · 수학 · 인터뷰) — 등록된 상담 건(lead.student_id)의 최신 진단 점수(DQ1). 없으면 null',
  })
  scores?: LeadDiagDto | null;
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
  /* 수업 이름표 — 정규 수업은 serTitle 이 비어 있다. 화면은 이 넷으로 「과목 · 시각 · 강의실」을 적는다 (g4 「수업명 미정」) */
  @ApiPropertyOptional({ ...S, description: '과목 이름(sub.name) — 과목 없는 회차는 null' }) subName?: string | null;
  @ApiPropertyOptional({ ...S, description: '수업 종류 이름(kind.name) — 과목이 없을 때 부를 이름' }) kindName?: string | null;
  @ApiPropertyOptional({ type: 'integer', nullable: true, minimum: 0, maximum: 1439, description: '그 회차의 시작 분(KST 자정 기준). 회차가 없으면 규칙의 시작 분' })
  startMin?: number | null;
  @ApiPropertyOptional({ ...S, description: '강의실 이름 — 그 회차의 강의실, 없으면 규칙의 강의실. 온라인·미정이면 null' }) roomName?: string | null;
  @ApiProperty({ enum: ['new', 'teacher_change'] }) reason!: string;
  @ApiProperty({ description: '그 수업 날(기한)이 며칠 지났는가 — 오늘이거나 앞날이면 0' })
  overdueDays!: number;
  @ApiProperty({
    type: GuideDeadlineDto, nullable: true,
    description: '§43 「안내 없음」 줄의 기한(N-89) — 그 회차 시작까지 남은 시간 · 사다리 · 긴급도(「마감 지남」 칩의 근거)',
  })
  deadline!: GuideDeadlineDto | null;
}

/**
 * §45 이력 한 줄 = 사건 하나 (N-90 채택 · W11) — 안내 작성 · 발송 · 강사 확인. 원장은 `hist`(entity='guide')다.
 * 칩은 사건 뒤 상태(`stateAfter`) — 원문 §45 줄의 「발송 대기」(작성 뒤) · 「발송 완료」(발송 뒤).
 */
export class GuideHistoryEventDto {
  @ApiProperty({ description: '사건 id(hist.id)' }) id!: number;
  @ApiProperty({ enum: ['guide_write', 'guide_send', 'guide_ack'] }) action!: string;
  @ApiProperty({ description: '사건 이름 — 원문 §40 칩 낱말(안내 작성 · 안내 발송 · 강사 확인)' }) label!: string;
  @ApiProperty({ enum: ['ready', 'sent', 'read'], description: '그 사건 뒤의 안내 상태 — 줄의 상태 칩' }) stateAfter!: string;
  @ApiProperty({ description: '사건 시각 ISO(+09:00)' }) at!: string;
  @ApiProperty({ description: '사건 시각 KST HH:MM — 줄 오른쪽 끝' }) time!: string;
  @ApiProperty({ ...N, description: '한 사람' }) byId!: number | null;
  @ApiProperty({ ...S, description: '한 사람 이름' }) byName!: string | null;
  @ApiProperty({ type: GuideDto, description: '그 사건의 안내(지금 상태)' }) guide!: GuideDto;
}

export class GuideHistoryTallyDto {
  @ApiProperty({ enum: ['guide_write', 'guide_send', 'guide_ack'] }) action!: string;
  @ApiProperty({ enum: ['ready', 'sent', 'read'] }) stateAfter!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) count!: number;
}

export class GuideHistoryDayDto {
  @ApiProperty({ ...DATE_SCHEMA, description: '사건 시각의 KST 날짜' }) date!: string;
  @ApiProperty({ type: [GuideHistoryEventDto], description: '그날 사건 — 늦은 것부터' }) events!: GuideHistoryEventDto[];
  @ApiProperty({ type: [GuideHistoryTallyDto], description: '날짜 머리 칩 — 사건 종류별 수(0 은 싣지 않는다)' })
  tally!: GuideHistoryTallyDto[];
}

export class GuideHistoryCountsDto {
  @ApiProperty({ description: '기간 안 「안내 작성」 사건 수 — 머리 「N건 만듦」' }) created!: number;
  @ApiProperty({ description: '기간 안 「안내 발송」 사건 수 — 머리 「N건 보냄」' }) sent!: number;
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

  /* §44 두 상자 (g4 §44-3). 안 보내면(undefined) 그대로 두고, 빈 글자·null 은 비운다 */
  @ApiPropertyOptional({ ...S, maxLength: 4000, description: '「지도 방향」 — 안 보내면 그대로, 빈 글자·null 은 비운다' })
  @ValidateIf((_object, value) => value !== undefined && value !== null) @IsString() @MaxLength(4000)
  direction?: string | null;

  @ApiPropertyOptional({
    ...S, maxLength: 4000,
    description: '「관리자 코멘트 · 강사만」 — 강사에게만 보인다(학부모 발송 본문·안내문 PNG 에 싣지 않는다). 안 보내면 그대로, 빈 글자·null 은 비운다',
  })
  @ValidateIf((_object, value) => value !== undefined && value !== null) @IsString() @MaxLength(4000)
  adminNote?: string | null;
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
/** 「나머지 학생에게 복사」의 받을 학생 — 안 보내면 형제 전부(F-61 그대로), 보내면 그 형제만 (F-60 · all160 2026-09-30) */
export class GuideCopyDto {
  @ApiPropertyOptional({ type: [Number], description: '받을 형제 안내 id — 같은 규칙·같은 날·같은 사유의 다른 학생 안내만. 하나라도 형제가 아니면 400 GUIDE_COPY_NOT_SIBLING' })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50)
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(Number.MAX_SAFE_INTEGER, { each: true })
  targetIds?: number[];
}

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

/**
 * §43-6 「강사 N명 한 번에」의 한 줄 — 보냈거나(code·reason null) 건너뛴(서버 코드·문장) 오늘 온라인 회차.
 * 회차 키는 단건과 같은 `(serId, onDate)` 다(C82-b · S5).
 */
export class ZoomNoticeBatchRowDto {
  @ApiProperty(ID_SCHEMA) serId!: number;
  @ApiProperty({ ...DATE_SCHEMA, description: '**회차 키**의 날짜(`ser_occ.on_date`) — 단건 줌 안내와 같은 키' }) onDate!: string;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1439 }) startMin!: number;
  @ApiProperty({ ...N, description: '그 회차의 강사 — 없으면 null' }) teacherId!: number | null;
  @ApiProperty({ ...S }) teacherName!: string | null;
  @ApiProperty({ description: '그 회차 명단의 학생 이름(쉼표로 잇는다) — 결과 띠가 어느 수업인지 말하게' }) studentNames!: string;
  @ApiProperty({
    ...S,
    description: '건너뛴 까닭의 코드 — ZOOM_NOTICE_ALREADY · ZOOM_NOTICE_NO_ACCOUNT · ZOOM_NOTICE_NO_TEACHER · ZOOM_NOTICE_CANCELED · ZOOM_NOTICE_NOT_ONLINE · OCCURRENCE_NOT_FOUND. 보냈으면 null',
  })
  code!: string | null;
  @ApiProperty({ ...S, description: '건너뛴 까닭 — 서버 문장 그대로(단건 쓰기·단추의 막힌 이유와 같은 말). 보냈으면 null' })
  reason!: string | null;
}

export class ZoomNoticeBatchResultDto {
  @ApiProperty({ type: [ZoomNoticeBatchRowDto], description: '이번에 보낸 회차 — 줄마다 제 트랜잭션이라 다른 줄의 거절에 되돌아가지 않는다' })
  sent!: ZoomNoticeBatchRowDto[];
  @ApiProperty({ type: [ZoomNoticeBatchRowDto], description: '건너뛴 회차와 서버 이유 — 이미 보냄 · 계정/강사 없음 · 그 사이 바뀐 회차' })
  skipped!: ZoomNoticeBatchRowDto[];
  @ApiProperty({ type: 'integer', minimum: 0, description: '이번에 받은 서로 다른 강사 수' }) teacherCount!: number;
  @ApiProperty({ type: 'integer', minimum: 0, description: '학부모에게 「보낼 것」으로 남긴 줄 수의 합 — 실제 발송은 아직 없다(N-42)' })
  parentNotices!: number;
}
