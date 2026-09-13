/** @file-guide
 * 목적: ops.dto.ts — LeadDto, LeadFailDto, LeadResumeDto, ComplaintDto, TodoDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { MFB_STATES } from '../../lib/marketing-words';
import { PLAN_DUE_KINDS, PLAN_DUE_STATES, PLAN_STAGES } from '../../lib/plan-words';
import { MINUTES_TEMPLATES, MT_ATTEND_STATES, MT_TYPES } from '../../lib/meeting-words';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;
const FQ = { description: 'FQ 클라이언트 검색 대상. 원문을 보존한다.' } as const;

/** §23 상담 단계 보드 · §24 중단 지점 */
export class LeadDto {
  @ApiProperty() id!: number;
  @ApiProperty(FQ) name!: string;
  @ApiPropertyOptional({ ...S, ...FQ }) school?: string | null;
  @ApiProperty({ description: 'first | wait2nd | second | hold | enrolled | failed' }) stage!: string;
  @ApiPropertyOptional(N) ownerId?: number | null;
  @ApiPropertyOptional(N) studentId?: number | null;
  @ApiPropertyOptional({ ...S, ...FQ }) ownerName?: string | null;
  @ApiPropertyOptional({ ...S, description: '실패한 경우 어디서 멈췄나 (§24)' }) stopAt?: string | null;
  @ApiPropertyOptional({ ...S, ...FQ }) reason?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ description: '접수한 지 며칠' }) ageDays!: number;

  /* N-25 채택 (§4-17) — 실패 이력. 판정은 서버 한 곳: fail_from 명시값 → 도달 기록 역순 → 미분류. */
  @ApiPropertyOptional({ ...S, description: '실패 당시 이전 단계 명시값 — 전이 때 서버가 라이브 기록. 레거시 NULL' })
  failFrom?: string | null;
  @ApiPropertyOptional({ ...S, description: '되살릴 단계 판정 결과(failed 건만) — null 이면 미분류(단계 지정 필요)' })
  revivalStage?: string | null;
  @ApiPropertyOptional({ ...S, description: "판정 근거 — 'explicit'(명시값) | 'log'(도달 기록) | null(미분류)" })
  revivalSource?: string | null;
}

const LEAD_ACTIVE_STAGES = ['first', 'wait2nd', 'second', 'hold'] as const;
const LEAD_STOPS = ['before_book', 'before_first', 'after_first', 'after_second'] as const;

export class LeadFailDto {
  @ApiProperty({ enum: [...LEAD_STOPS], description: '중단 지점 분류 (§24 · 기존 4어휘)' })
  @IsIn([...LEAD_STOPS], { message: '중단 지점은 기존 4분류 중 하나입니다' })
  stopAt!: string;
  @ApiPropertyOptional({ description: '사유 — 500자 이내. 생략하면 기존 사유 유지' })
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

export class LeadResumeDto {
  @ApiPropertyOptional({
    enum: [...LEAD_ACTIVE_STAGES],
    description: '되살릴 단계 지정 — 생략하면 서버 판정(명시값 → 도달 기록). 미분류인데 생략하면 409 UNCLASSIFIED',
  })
  @IsOptional()
  @IsIn([...LEAD_ACTIVE_STAGES], { message: '되살릴 단계는 진행 4단계 중 하나입니다' })
  to?: string;
}

/** §67 컴플레인 */
export class ComplaintDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: ['lesson', 'intake', 'book', 'schedule', 'teacher'] }) area!: string;
  @ApiPropertyOptional(S) studentName?: string | null;
  @ApiProperty({ description: 'received | acting | closed' }) stage!: string;
  @ApiProperty() body!: string;
  @ApiPropertyOptional(S) action?: string | null;
  @ApiPropertyOptional(S) result?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() ageDays!: number;
}

/** §64 운영 할 일 */
export class TodoDto {
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiPropertyOptional(S) toName?: string | null;
  @ApiPropertyOptional(S) dueOn?: string | null;
  @ApiProperty() done!: boolean;
  @ApiProperty({ enum: ['meeting', 'complaint', 'consulting', 'plan', 'manual'] }) src!: string;
  @ApiProperty({ description: '기한이 지난 날 수. 0이면 안 지남' }) overdueDays!: number;
}

/** §61 기획 단계 보드 */
export class PlanDto {
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: PLAN_STAGES, description: '코드값 — 이름은 stageLabel 을 쓴다' }) stage!: string;
  @ApiProperty({ description: '단계 이름 — 낱말은 서버가 만든다 (D-R18 · C56)' }) stageLabel!: string;
  @ApiPropertyOptional(S) goal?: string | null;
  @ApiPropertyOptional(S) ask?: string | null;
  @ApiPropertyOptional(S) dueOn?: string | null;
  @ApiPropertyOptional(S) ownerName?: string | null;
  @ApiProperty() overdueDays!: number;
  /** 기한이 대표를 지나왔는가 — 「최종 승인」이 열리는 조건이다 (원문 §61·§65) */
  @ApiProperty({ enum: PLAN_DUE_STATES, description: '기한 상태 — due_on 과 due_approved_at 에서 파생' })
  dueState!: string;
}

/** §62 기획 기한 한 줄 — 기획 마감과 과제 기한이 **한 표에** 섞인다 */
export class PlanDueRowDto {
  @ApiProperty({ description: '한 표 안에서 겹치지 않는 키 — `plan:3` · `task:11`' }) key!: string;
  @ApiProperty({ enum: PLAN_DUE_KINDS }) kind!: string;
  @ApiProperty({ description: '구분 이름 — 원문 「기획 마감 · 과제」' }) kindLabel!: string;
  @ApiProperty({ example: '2026-08-25' }) dueOn!: string;
  /** 「D-2 · 오늘 · 1일 지남」 — 화면이 날짜를 빼지 않는다 (D-R37) */
  @ApiProperty({ description: '남은 날 한 낱말' }) dueLabel!: string;
  @ApiProperty({ description: '지난 날 수 — 0 이면 안 지났다. 붉게 칠하는 판정이 이 값 하나다' })
  overdueDays!: number;
  @ApiProperty({ description: '내용 — 기획 제목 또는 과제 제목' }) title!: string;
  @ApiProperty({ description: '어느 기획인가' }) planId!: number;
  @ApiProperty() planTitle!: string;
  @ApiPropertyOptional(S) ownerName?: string | null;
  @ApiProperty({ enum: PLAN_STAGES }) stage!: string;
  @ApiProperty() stageLabel!: string;
}

/** §65 기획 보고서의 과제 한 줄 — TODO 에서 온다 (명세서 슬라이드 65 연동) */
export class PlanTaskDto {
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiProperty() done!: boolean;
  @ApiPropertyOptional(S) toName?: string | null;
  @ApiPropertyOptional(S) dueOn?: string | null;
  @ApiProperty({ description: '지난 날 수 — 끝난 과제는 0' }) overdueDays!: number;
}

/** §65 기획 보고서 — 목표 → 과제 → 리서치 → 결정 요청 */
export class PlanDetailDto {
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: PLAN_STAGES }) stage!: string;
  @ApiProperty() stageLabel!: string;
  @ApiPropertyOptional(S) ownerName?: string | null;
  @ApiProperty({ description: '작성일 YYYY-MM-DD' }) createdOn!: string;

  @ApiPropertyOptional({ ...S, description: '1 · 목표' }) goal?: string | null;
  @ApiProperty({ type: [PlanTaskDto], description: '2 · 과제 — TODO 에서 온다' }) tasks!: PlanTaskDto[];
  @ApiProperty({ description: '끝낸 과제 / 전체 — 화면이 다시 세지 않는다 (D-R37)' }) taskDone!: number;
  @ApiPropertyOptional({ ...S, description: '3 · 리서치' }) research?: string | null;
  @ApiPropertyOptional({ ...S, description: '4 · 결정 요청' }) ask?: string | null;

  @ApiPropertyOptional(S) dueOn?: string | null;
  @ApiProperty({ enum: PLAN_DUE_STATES }) dueState!: string;
  @ApiProperty({ description: '띠에 쓰는 이름' }) dueStateLabel!: string;
  @ApiPropertyOptional({ ...S, description: '기한을 승인한 사람' }) dueApprovedByName?: string | null;
  @ApiProperty() overdueDays!: number;

  /* 단추가 열리는지는 **서버가 정한다** — 화면이 역할과 기한 상태를 다시 조합하지 않는다 (D-R39) */
  @ApiProperty({ description: '기한을 승인·반려할 수 있는가 — 대표이고 아직 제안 상태일 때' })
  canDecideDue!: boolean;
  @ApiProperty({ description: '최종 승인·보완 요청을 할 수 있는가 — **기한이 먼저 승인돼야 열린다** (원문 §61·§65)' })
  canReview!: boolean;
  @ApiProperty({ description: '단추가 닫혀 있는 이유 — 열려 있으면 null', nullable: true, type: String })
  reviewBlockedReason!: string | null;
}

/** 기한 승인 · 반려 — 원문 §65 의 「기한 승인」 「기한 반려」 */
export class PlanDueDecisionDto {
  @ApiProperty({ description: 'true 면 승인, false 면 반려' })
  @IsBoolean() approve!: boolean;
}

/** 최종 승인 · 보완 요청 — 원문 §65 바닥의 두 단추 */
export class PlanReviewDto {
  @ApiProperty({ enum: ['approve', 'rework'] })
  @IsIn(['approve', 'rework']) decision!: 'approve' | 'rework';

  @ApiPropertyOptional({ description: '보완 요청 사유 — 되돌릴 때는 필수다', maxLength: 500 })
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** §63 회의 목록 */
export class MeetingDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: MT_TYPES, description: '코드값 — 이름은 mtTypeLabel 을 쓴다' }) mtType!: string;
  @ApiProperty({ description: '회의 종류 이름 — 낱말은 서버가 만든다 (D-R18 · C57)' }) mtTypeLabel!: string;
  @ApiPropertyOptional(S) title?: string | null;
  @ApiPropertyOptional(S) onDate?: string | null;
  @ApiProperty() attendees!: number;
  @ApiProperty() confirmed!: number;
  @ApiProperty({ description: '속기록을 썼는가 — 안 쓰면 회의가 끝난 것이 아니다' }) hasMinutes!: boolean;
}

/** §59 마케팅 트래킹 */
export class MarketingDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: '코드값 — 이름은 channelLabel 을 쓴다' }) channel!: string;
  @ApiProperty({ description: '코드값 — 이름은 itemLabel 을 쓴다' }) item!: string;
  /* 낱말은 서버가 만든다 — 화면이 영어 코드를 한글로 옮기지 않는다 (D-R18 · C53) */
  @ApiProperty({ description: '채널 이름' }) channelLabel!: string;
  @ApiProperty({ description: '항목 이름' }) itemLabel!: string;
  @ApiPropertyOptional({ ...S, description: '활동 이름 — 원문 §59·§60 카드 제목 (옛 행은 null)' }) title?: string | null;
  @ApiProperty({ description: '카드에 쓰는 이름 — title 이 없으면 채널·항목으로 부른다' }) name!: string;
  @ApiPropertyOptional(N) byId?: number | null;
  @ApiPropertyOptional({ ...S, description: '담당자 — §60 답변을 쓸 수 있는 사람' }) byName?: string | null;
  @ApiPropertyOptional(S) url?: string | null;
  @ApiPropertyOptional(N) impressions?: number | null;
  @ApiPropertyOptional(N) clicks?: number | null;
  @ApiPropertyOptional(N) inquiries?: number | null;
  @ApiPropertyOptional(N) enrolled?: number | null;
  @ApiPropertyOptional({ ...N, description: '집행 비용 — 대표만 (D-R39)' }) cost?: number | null;
  @ApiPropertyOptional({ ...N, description: '등록당 비용' }) costPerEnroll?: number | null;
}

/* ══ §66 회의 상세 (C57) ═══════════════════════════════════════════════ */

/** 참석 한 줄 — `confirmed` 는 **세 값**이다 (null = 응답 대기) */
export class MeetingAttendeeDto {
  @ApiProperty() staffId!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional(S) title?: string | null;
  @ApiProperty({ enum: MT_ATTEND_STATES, description: 'waiting | in | out — null 을 false 로 접지 않는다' })
  state!: string;
  @ApiProperty({ description: '칩에 쓰는 이름 — 낱말은 서버가 만든다 (D-R18)' }) stateLabel!: string;
}

/** ③ 할 일 — 이 회의에서 빠져나온 TODO */
export class MeetingTaskDto {
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiProperty() done!: boolean;
  @ApiPropertyOptional(S) toName?: string | null;
  @ApiPropertyOptional(S) dueOn?: string | null;
  @ApiProperty({ description: '지난 날 수 — 끝난 할 일은 0' }) overdueDays!: number;
}

/** §66 회의 상세 — 참석 확인 → 사전 자료 → 속기록 → 할 일 배정 */
export class MeetingDetailDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: MT_TYPES }) mtType!: string;
  @ApiProperty() mtTypeLabel!: string;
  @ApiPropertyOptional(S) title?: string | null;
  @ApiPropertyOptional(S) onDate?: string | null;

  @ApiProperty({ type: [MeetingAttendeeDto] }) attendees!: MeetingAttendeeDto[];
  /** 원문 「참석 0/4 확인」 — 화면이 다시 세지 않는다 (D-R37) */
  @ApiProperty({ description: '참석하겠다고 답한 사람 수' }) confirmed!: number;
  @ApiProperty({ description: '참석 머리글 — 원문 「참석 N/M 확인」' }) attendLabel!: string;

  @ApiProperty({ type: [String], description: '① 사전 자료 — 파일 주소' }) preFiles!: string[];
  @ApiPropertyOptional({ ...S, description: '② 속기록 본문' }) minutes?: string | null;
  @ApiPropertyOptional({ ...S, description: '마지막 저장 시각 (KST ISO) — 없으면 아직 저장한 적이 없다' })
  minutesAt?: string | null;
  @ApiPropertyOptional(S) minutesByName?: string | null;
  /** 원문 속기록 칸 아래 단추 넷과 오른쪽 안내 — 회의마다 머리말이 제각각이 되지 않게 한다 */
  @ApiProperty({ type: [String], enum: MINUTES_TEMPLATES }) minutesTemplates!: string[];
  @ApiProperty() minutesHint!: string;

  @ApiProperty({ type: [MeetingTaskDto], description: '③ 할 일' }) tasks!: MeetingTaskDto[];
  @ApiProperty({ description: '끝낸 할 일 수 — 화면이 다시 세지 않는다' }) taskDone!: number;
}

/** 속기록 저장 — 누가 언제 저장했는지 서버가 남긴다 */
export class MinutesWriteDto {
  @ApiProperty({ description: '속기록 본문', maxLength: 8000 })
  @IsString() @MinLength(1, { message: '속기록을 적어 주세요' }) @MaxLength(8000)
  minutes!: string;
}

/** 할 일 배정 — 원문 §66 「연동 배정한 할 일 → TODO + 담당자 NOTI」 */
export class MeetingTaskCreateDto {
  @ApiProperty({ maxLength: 160 })
  @IsString() @MinLength(1, { message: '할 일을 적어 주세요' }) @MaxLength(160)
  title!: string;

  @ApiProperty({ description: '누구에게' })
  @IsInt() @Min(1) toId!: number;

  @ApiPropertyOptional({ description: '기한 YYYY-MM-DD — 비우면 기한 없음' })
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '날짜는 YYYY-MM-DD 입니다' })
  dueOn?: string;
}

/** §60 대표 피드백 — 글 한 줄 (코멘트 · 답변 공용) */
export class MfbPostDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: ['comment', 'reply'], description: '쓸 때의 종류 — 역할로 되짚지 않는다' }) kind!: string;
  @ApiProperty({ description: '칩에 쓰는 이름 — 낱말은 서버가 만든다 (D-R18)' }) kindLabel!: string;
  @ApiProperty() body!: string;
  @ApiProperty() byId!: number;
  @ApiPropertyOptional(S) byName?: string | null;
  @ApiProperty({ description: 'KST ISO' }) at!: string;
}

/**
 * §60 카드 하나 — 마케팅 활동 하나에 달린 글타래.
 *
 * 「고쳤습니다 / 확인 필요」와 「고쳐야 할 것 N건」은 **서버가 정한다.** 화면이 코멘트와 답변의
 * 시각을 견주면 카드의 칩과 머리의 숫자가 갈린다 (D-R37 · D-R39).
 */
export class MfbThreadDto {
  @ApiProperty({ description: '마케팅 활동 id' }) mktId!: number;
  @ApiProperty({ description: '카드 이름 — MarketingDto.name 과 같은 자리에서 나온다' }) name!: string;
  @ApiProperty() channelLabel!: string;
  @ApiProperty() itemLabel!: string;
  @ApiPropertyOptional(S) url?: string | null;
  @ApiPropertyOptional({ ...S, description: '담당자 — 답변을 쓸 수 있는 사람' }) byName?: string | null;
  @ApiProperty({ enum: MFB_STATES, description: '판정은 서버가 한다' }) state!: string;
  @ApiProperty({ description: '칩에 쓰는 이름' }) stateLabel!: string;
  @ApiProperty({ description: '가장 나중 대표 코멘트의 시각 — 카드 오른쪽 위' }) at!: string;
  @ApiProperty({ type: [MfbPostDto], description: '코멘트와 그 답변이 시각 순으로 섞여 있다' }) posts!: MfbPostDto[];
  @ApiProperty({ description: '내가 답변을 쓸 수 있는가 — 담당자이거나 담당자가 없을 때' }) canReply!: boolean;
}

/** 대표 코멘트 쓰기 — 원문 §60 「+ 코멘트 남기기」 */
export class MfbCommentWriteDto {
  @ApiProperty({ description: '코멘트 본문', maxLength: 1000 })
  @IsString() @MinLength(1, { message: '코멘트를 적어 주세요' }) @MaxLength(1000)
  body!: string;
}

/** 담당자 답변 쓰기 — 원문 §60 「고친 것 알리기」 */
export class MfbReplyWriteDto {
  @ApiProperty({ description: '어느 코멘트에 대한 답인가' })
  @IsInt() @Min(1)
  parentId!: number;
  @ApiProperty({ description: '답변 본문', maxLength: 1000 })
  @IsString() @MinLength(1, { message: '답변을 적어 주세요' }) @MaxLength(1000)
  body!: string;
}

/** 답 고치기 — 원문 §60 「답 고치기」. 자기가 쓴 글만 고친다 */
export class MfbEditDto {
  @ApiProperty({ maxLength: 1000 })
  @IsString() @MinLength(1, { message: '본문을 적어 주세요' }) @MaxLength(1000)
  body!: string;
}

/** 건의 사항 */
export class SuggestionDto {
  @ApiProperty() id!: number;
  @ApiProperty() staffName!: string;
  @ApiProperty({ enum: ['lesson', 'pay', 'schedule', 'etc'] }) category!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ enum: ['open', 'reviewing', 'done'] }) state!: string;
  @ApiPropertyOptional(S) reply?: string | null;
  @ApiProperty() createdAt!: string;
}

/**
 * §61 기획 단계의 낱말 한 벌 — 화면이 **빈 칸의 이름**을 지을 수 있어야 한다 (D-R18).
 *
 * 화면은 칸 이름을 **줄에서 빌려 오고** 있었다(`items[0]?.stageLabel ?? s.key`).
 * 그래서 **줄이 하나도 없는 칸은 빌려 올 데가 없어 코드값 `done` 을 그대로 찍었다.**
 * 나머지 넷은 줄이 있어서 우연히 맞았을 뿐이다. 낱말은 데이터가 아니라 어휘이므로
 * 데이터와 따로 내려보낸다 — `INV_TYPES`(C64) · `INV_TYPE_ROW`(C66)와 같은 자리다.
 */
export class PlanStageDto {
  @ApiProperty({ description: '저장값' }) key!: string;
  @ApiProperty({ description: '사람이 읽는 이름' }) label!: string;
}

export class OpsDto {
  @ApiProperty({ type: [LeadDto] }) leads!: LeadDto[];
  @ApiProperty({ type: [ComplaintDto] }) complaints!: ComplaintDto[];
  @ApiProperty({ type: [TodoDto] }) todos!: TodoDto[];
  @ApiProperty({ type: [PlanDto] }) plans!: PlanDto[];
  @ApiProperty({ type: [PlanStageDto], description: '§61 칸 다섯의 이름 — 빈 칸도 이름을 갖는다 (D-R18)' })
  planStages!: PlanStageDto[];
  @ApiProperty({ type: [PlanDueRowDto], description: '§62 기획 기한 — 기획 마감과 과제 기한을 날짜 순으로 섞은 표' })
  planDues!: PlanDueRowDto[];
  @ApiProperty({ description: '기한 지난 것 — 서버가 센다 (D-R37)' }) planOverdue!: number;
  @ApiProperty({ type: [MeetingDto] }) meetings!: MeetingDto[];
  @ApiProperty({ type: [MarketingDto] }) marketing!: MarketingDto[];
  @ApiProperty({ type: [MfbThreadDto], description: '§60 대표 피드백 — 코멘트가 달린 활동만' }) feedback!: MfbThreadDto[];
  @ApiProperty({ description: '고쳐야 할 것 — 서버가 센다 (D-R37)' }) feedbackNeedsFix!: number;
  @ApiProperty({ description: '대표 코멘트를 남길 수 있는가 — 원문 §60 「대표가 코멘트하면」 (D-R39)' }) canComment!: boolean;
  @ApiProperty({ type: [SuggestionDto] }) suggestions!: SuggestionDto[];
  @ApiProperty({ description: '집행 비용을 볼 수 있는가' }) canSeeAmounts!: boolean;
}
