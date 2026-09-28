/** @file-guide
 * 목적: ops.dto.ts — LeadDto, LeadCreateDto, LeadStageMoveDto, LeadTouchWriteDto, LeadFailDto, LeadResumeDto, ComplaintDto, TodoDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TODO_SRC_T_VALUES } from '../../entities/enums';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CPL_AREAS, CPL_REQUESTERS, CPL_SEVERITIES, CPL_STAGES } from '../../lib/complaint-words';
import { INTAKE_FUNNEL_STAGES, LEAD_AFTERCARE_KEYS, LEAD_CARD_ACTION_KEYS, LEAD_REASON_KINDS, LEAD_SOURCES, LEAD_TOUCH_KINDS } from '../../lib/intake-words';
import { MFB_ANSWER_KINDS, MFB_KINDS, MFB_STATES, MKT_CHANNELS, MKT_ITEMS } from '../../lib/marketing-words';
import { PLAN_DUE_KINDS, PLAN_DUE_STATES, PLAN_SHARES, PLAN_STAGES } from '../../lib/plan-words';
import { MINUTES_TEMPLATES, MT_ATTEND_STATES, MT_TYPES } from '../../lib/meeting-words';
import { DATE_SCHEMA, IsCalendarDate, IsSafeHttpUrl } from '../../common/validation';
import { LeadDiagDto } from './lead-diag.dto';
import { LeadApptDto, LeadPlanLineDto } from './lead-plan.dto';
import { UnavWarnDto } from '../schedule/schedule.dto';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;
const FQ = { description: 'FQ 클라이언트 검색 대상. 원문을 보존한다.' } as const;

/** §23 상담 단계 보드 · §24 중단 지점 · C90 유입 경로 · 접촉 원장 · 다음 단계 */
export class LeadDto {
  @ApiProperty() id!: number;
  @ApiProperty(FQ) name!: string;
  @ApiPropertyOptional({ ...S, ...FQ }) school?: string | null;
  @ApiProperty({ description: 'first | wait2nd | second | hold | enrolled | failed' }) stage!: string;
  @ApiPropertyOptional(N) ownerId?: number | null;
  @ApiPropertyOptional(N) studentId?: number | null;
  @ApiPropertyOptional({ ...S, ...FQ }) ownerName?: string | null;
  @ApiPropertyOptional({ ...S, description: '옛 중단 지점 코드(before_book · before_first · after_first · after_second) — **읽기 전용 기록**이다. W11 · N-87 뒤로 새 실패는 적지 않고 되살리기도 지우지 않는다. §24 분류는 failStopKey' })
  stopAt?: string | null;
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
  /* W11 · N-87 — §24 중단 지점은 **실패 당시 단계**로 판정한다(원문 슬라이드 24 「fail.from 필드로 중단 단계 판정」). 사람이 고르지 않는다 */
  @ApiPropertyOptional({ ...S, description: "§24 중단 지점(failed 건만) — first · wait2nd · second · hold(실패 당시 단계) | 'none'(판정 없음 · 미분류). 실패 아닌 건은 null" })
  failStopKey?: string | null;
  @ApiPropertyOptional({ ...S, description: '「1차 상담 중단」 · 「2차 안 옴」 · 「2차 상담 중단」 · 「보류 후 무산」 · 「미분류」 — 서버가 만든다 (D-R18)' })
  failStopLabel?: string | null;
  @ApiPropertyOptional({ ...S, description: '옛 중단 지점(stopAt)의 낱말 — 적은 적이 없으면 null. 대응표로 옮기지 않은 옛 기록을 그대로 읽는다 (N-25)' })
  stopAtLabel?: string | null;

  /* C90 · N-44 유입 경로 · 접촉 원장 / N-45 단계 이동 — 낱말·판정은 전부 서버 (D-R18 · D-R37) */
  @ApiPropertyOptional({ ...S, description: 'kakao | phone | blog | instagram | referral | walkin — 옛 건은 null (N-25 보정 0)' })
  source?: string | null;
  @ApiPropertyOptional({ ...S, description: '유입 경로 낱말 — null 이면 「경로 없음」 칩이 아니라 카드에 아무것도 안 붙는다' })
  sourceLabel?: string | null;
  @ApiProperty({ type: () => [IntakeWordDto], description: '지금 단계에서 옮길 수 있는 다음 단계 — 비면 끝난 결과(등록·등록 실패)라 옮기지 못한다 (N-45 전이표)' })
  nextStages!: IntakeWordDto[];
  @ApiProperty({ type: () => [LeadTouchDto], description: '접촉 원장 — 최근 것이 앞 (append-only · N-44)' })
  touches!: LeadTouchDto[];
  @ApiPropertyOptional({ ...S, description: '마지막 접촉 시각 (KST) — 접촉이 없으면 null' })
  lastTouchAt?: string | null;
  @ApiPropertyOptional({ ...S, description: '마지막 접촉의 「다음은 언제」 — 없으면 null' })
  nextOn?: string | null;
  @ApiPropertyOptional({ ...S, description: '카드 칩 한 줄 — 「상담 오늘」 · 「상담 2일 지남」 · 「사후 관리 D-1」 · 「사후 관리 3일 밀림」. 서버가 만든다 (D-R18)' })
  nextLabel?: string | null;
  @ApiPropertyOptional({ ...S, description: "칩 색 — 'danger'(지남·밀림) | 'warning'(오늘) | 'info'(임박) | null" })
  nextTone?: string | null;

  /* DQ1 (2026-09-25 「점수만 저장 + 담당자가 선택」) — 카드·서랍이 따로 묻지 않고 그린다. 레벨·교재는 담당자가 고른 값이다 */
  @ApiPropertyOptional({ type: () => LeadDiagDto, nullable: true, description: '최신 진단 점수 한 줄(점수 셋 · 본 날 · 담당자가 고른 레벨·교재) — 적은 적이 없으면 null' })
  latestDiag?: LeadDiagDto | null;

  /* 1:1 대조 wave 3 (23-10 · 23-12 · 24-04 · 24-05 · 24-06) — 전부 추가 칸이고 옛 건은 null 이다(추정 0 · N-25) */
  @ApiPropertyOptional({ ...S, maxLength: 10, description: '학년 — 원본 §23 카드의 학년 칩. 적은 그대로(표기 규약을 서버가 바꾸지 않는다) · 옛 건 null' })
  grade?: string | null;
  @ApiPropertyOptional({ ...S, description: '실패 사유 분류 — unreachable | other_academy | schedule | cost | timing (원본 §24 다섯) · 분류 전·옛 건 null' })
  reasonKind?: string | null;
  @ApiPropertyOptional({ ...S, description: '실패 사유 분류 낱말 — 「연락 두절」. 서버가 만든다 (D-R18)' })
  reasonKindLabel?: string | null;
  @ApiPropertyOptional({ ...S, format: 'date', description: '실패한 날(KST) — 도달 기록의 마지막 「등록 실패」 줄. 실패 건이 아니거나 도달 기록이 없는 옛 건은 null' })
  failedAt?: string | null;
  @ApiPropertyOptional({ type: () => LeadRecontactDto, nullable: true, description: '실패 건의 재연락 — 「재연락 완료/대기」 · 다음 연락일. 실패 시각을 모르는 옛 건·실패 아닌 건은 null' })
  recontact?: LeadRecontactDto | null;
  @ApiPropertyOptional({ type: () => LeadStageDueDto, nullable: true, description: '단계 기한 띠 — 슬라이드 23 SLA(1차 2일 · 2차 대기 7일 · 2차 상담 1일 · 보류 2일). 보류는 재확인 날짜 · 2차 대기는 2차 일정이 있으면 그 날짜가 기한이다. 들어온 날을 모르면 null. 등록 건은 사후 관리 띠(W11 · N-86 — 「해피콜 D-3」 · 「월간 상담 …」 · 둘 다 끝나면 「정기 관리 중」 · 할 일이 없는 옛 건은 null)' })
  stageDue?: LeadStageDueDto | null;
  @ApiPropertyOptional({ type: () => [LeadPlanLineDto], description: '배치안 초안 줄(23-16) — §23 카드 「SAT Reading 주2 · Rebecca」 · §24 「당시 배치안」 · 등록 확정 창의 기본 줄. 적은 적이 없으면 []' })
  plan?: LeadPlanLineDto[];
  @ApiPropertyOptional({ type: () => [LeadApptDto], description: '2차 · 진단 일정(23-15) — 종류마다 한 줄 · 진단이 앞. 없으면 []' })
  appts?: LeadApptDto[];
  @ApiPropertyOptional({ ...S, format: 'date', description: '보류 재확인 날짜(23-16) — 적어 둔 날짜 또는 보류에 들어온 날 + 2일. 보류가 아니거나 들어온 날을 모르면 null' })
  recheckOn?: string | null;
  /* 1:1 대조 wave 5 (23-18) — 등록 카드의 사후 관리 줄. 그 학생의 청구서 · 교재 · 안내 원장을 읽기만 한다 ·
     W11 · N-86 — 앞 두 줄(해피콜 · 월간)은 상담 담당의 할 일(todo.src='lead')을 읽는다 */
  @ApiPropertyOptional({
    type: () => [LeadAftercareRowDto], nullable: true,
    description: '등록 카드의 줄(원본 §23 「해피콜 완료 08-15 · 월간 완료 · 청구서 없음 · 교재 없음 · 안내 없음」) — 차례 해피콜 · 월간(첫 월간 상담) · 청구서 · 교재 · 안내. '
      + '해피콜·월간은 사후 관리 할 일의 예약·완료(없으면 「없음」). 등록 건이 아니거나 학생이 안 붙었으면 null',
  })
  aftercare?: LeadAftercareRowDto[] | null;
  /* 1:1 대조 wave 6 (23-11 · 23-14) — 등록 카드의 「등록 수업」 한 줄 · 카드 단추 줄. 둘 다 서버가 만든다(D-R18 · D-R39) */
  @ApiPropertyOptional({
    type: [String], nullable: true,
    description: '등록 카드의 「등록 수업」(원본 §23 「모의수업 A 주1 · KJ」) — 그 학생의 지금 명단(SER_STU · 끝난 명단·규칙 · 단발 제외)을 한 줄씩. '
      + '「주N」은 매주 규칙의 요일 수 · 매일/격주는 규칙 낱말. 등록 건이 아니거나 학생이 안 붙었으면 null',
  })
  lessons?: string[] | null;
  @ApiPropertyOptional({
    type: () => [LeadCardActionDto],
    description: '카드 단추 줄(원본 §23 단계별 단추) — 서는 단추와 낱말은 서버 한 곳(lib/intake-words.leadCardActions). 단계 이동은 nextStages 안에서만',
  })
  cardActions?: LeadCardActionDto[];
}

/** 카드 단추 하나 (23-14) — key 가 부를 경로를 정한다. 낱말·서는지는 서버다 */
export class LeadCardActionDto {
  @ApiProperty({ enum: [...LEAD_CARD_ACTION_KEYS], description: 'appt(2차·진단 일정) · enroll(등록 확정) · fail(실패 분류) · schedule(스케줄에 만들기) · move(단계 이동) · extend(연장 +2일) · touch(접촉 기록) · detail(상세) · resume(되살리기)' })
  key!: string;
  @ApiProperty({ description: '단추 낱말 — 「2차 진행」 · 「연장 +2일」 · 「스케줄에 1건 만들기」' }) label!: string;
  @ApiPropertyOptional({ ...S, description: 'move 의 도착 단계 — 언제나 그 건의 nextStages 안이다. 다른 단추는 null' }) to?: string | null;
}

/** 등록 카드 사후 관리 한 줄 (23-18) — 낱말은 서버(`lib/intake-words.leadAftercareRows`) */
export class LeadAftercareRowDto {
  @ApiProperty({ enum: [...LEAD_AFTERCARE_KEYS] }) key!: string;
  @ApiProperty({ description: '「해피콜」 · 「월간」 · 「청구서」 · 「교재」 · 「안내」' }) label!: string;
  @ApiProperty({ description: '「완료 08-15」 · 「08-24 예정」 · 「날짜 미정」 · 「완료」 · 「없음」 · 「2건」 · 「1권」 · 「배정 대기」 · 「보냄」 · 「쓰는 중」' }) value!: string;
  @ApiProperty({ description: '됐는가 — 줄 바탕 색(됨 = 초록 · 아직 = 회색)을 가른다' }) done!: boolean;
}

/** 「스케줄에 N건 만들기」 결과 (23-15) — 갱신된 상담 한 줄 · 이번에 만든 회차 수 · 담당의 불가 시간 경고(막지 않는다 · 시간표 쓰기와 같은 규약) */
export class LeadApptScheduleResultDto {
  @ApiProperty({ type: () => LeadDto }) lead!: LeadDto;
  @ApiProperty({ description: '이번에 만든 시간표 회차 수' }) created!: number;
  @ApiProperty({ type: () => [UnavWarnDto], description: '담당(시간표의 강사 자리)이 적어 둔 불가 시간과 겹친 회차 — 경고일 뿐 막지 않는다' })
  unavailable!: UnavWarnDto[];
}

/** 실패 건의 재연락 (원본 §24 카드 · 24-06) — 판정은 서버 한 곳(`leadRecontactDone`) */
export class LeadRecontactDto {
  @ApiProperty({ description: '실패로 분류된 뒤 접촉 원장에 한 줄이라도 있는가' }) done!: boolean;
  @ApiProperty({ description: '「재연락 완료」 · 「재연락 대기」' }) label!: string;
  @ApiProperty({ description: "칩 색 — 'info'(완료) | 'warning'(대기)" }) tone!: string;
  @ApiPropertyOptional({ ...S, format: 'date', description: '다음 연락일 — 마지막 접촉의 「다음은 언제」. 없으면 null' }) on?: string | null;
  @ApiPropertyOptional({ ...S, description: '다음 연락일까지 — 「D-28」 · 「오늘」 · 「3일 지남」. 날짜가 없으면 null' }) dueLabel?: string | null;
}

/** 단계 기한 띠 (원본 §23 카드 · 23-12) — 낱말·기한·톤은 서버가 만든다 (`leadStageDue`) */
export class LeadStageDueDto {
  @ApiProperty({ description: '그 단계에서 할 일 — 「2차 일정 + 진단고사 잡기」 · 등록 건은 「해피콜」 · 「월간 상담」 · 「정기 관리 중」' }) task!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date', description: '기한 — 그 단계에 들어온 날 + SLA 일수 · 등록 건은 사후 관리 할 일의 날. 날이 없는 띠(「정기 관리 중」 · 날짜 미정)는 null' })
  dueOn!: string | null;
  @ApiProperty({ type: String, nullable: true, description: '「오늘」 · 「D-1」 · 「1일 지남」 — 날이 없는 띠는 null' }) dueLabel!: string | null;
  @ApiProperty({ description: "띠·카드 바탕 색 — 'danger'(지남) | 'warning'(오늘) | 'neutral'" }) tone!: string;
}

/** 낱말 하나 — key · label (D-R18). 다음 단계 · 접촉 「어떻게」 가 쓴다 */
export class IntakeWordDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
}

/** 접촉 원장 한 줄 — 누가 · 언제 · 어떻게 · 한 줄 · 다음은 언제 (N-44 · C90) */
export class LeadTouchDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: 'call | kakao | sms | visit | book | noshow | memo' }) kind!: string;
  @ApiProperty() kindLabel!: string;
  @ApiProperty() note!: string;
  @ApiPropertyOptional({ ...S, description: '다음 접촉·상담 예정일 YYYY-MM-DD — book 이면 상담 날짜' }) nextOn?: string | null;
  @ApiPropertyOptional(N) byId?: number | null;
  @ApiPropertyOptional(S) byName?: string | null;
  @ApiProperty({ description: 'KST 시각' }) at!: string;
}

/** 「+ 신규 문의」 (C90 · 테스트 시나리오 A-01 · N-45). 단계는 받지 않는다 — 유입은 언제나 1차 상담이다 */
export class LeadCreateDto {
  @ApiProperty({ maxLength: 40, description: '학생 이름' })
  @IsString() @MinLength(1, { message: '이름을 적어 주세요' }) @MaxLength(40)
  name!: string;

  @ApiPropertyOptional({ ...S, maxLength: 60 })
  @IsOptional() @IsString() @MaxLength(60)
  school?: string | null;

  @ApiProperty({ enum: [...LEAD_SOURCES], description: '유입 경로 — 컷 §23 여섯 갈래. 낱말은 GET /ops.intakeHead.sources' })
  @IsIn([...LEAD_SOURCES], { message: '유입 경로는 카카오채널 · 전화 · 블로그 · 인스타그램 · 소개 · 워크인 중 하나입니다' })
  source!: string;

  @ApiPropertyOptional({ ...N, description: '담당 — 비우면 미배정' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  ownerId?: number | null;

  @ApiPropertyOptional({ ...S, maxLength: 500, description: '첫 접촉 한 줄 — 원하는 것 · 학부모 · 연락처 · 「소개」면 누구 소개인지. 적으면 접촉 원장의 첫 줄이 된다(어떻게 = 유입 경로에서)' })
  @IsOptional() @IsString() @MaxLength(500)
  note?: string | null;

  @ApiPropertyOptional({ ...S, maxLength: 10, description: '학년 — 원본 §23 카드의 학년 칩(23-10). 비우면 null' })
  @IsOptional() @IsString() @MaxLength(10)
  grade?: string | null;
}

/** 상담 카드 핵심정보 수정 — 단계/실패/진단/배치와 섞지 않고 카드 머리의 사실만 바꾼다. */
export class LeadPatchDto {
  @ApiPropertyOptional({ maxLength: 40, description: '학생 이름' })
  @IsOptional() @IsString() @MinLength(1, { message: '이름을 적어 주세요' }) @MaxLength(40)
  name?: string;

  @ApiPropertyOptional({ ...S, maxLength: 60, description: '학교 — null 또는 빈 문자열이면 비운다' })
  @IsOptional() @IsString() @MaxLength(60)
  school?: string | null;

  @ApiPropertyOptional({ enum: [...LEAD_SOURCES], description: '유입 경로 — 낱말은 GET /ops.intakeHead.sources' })
  @IsOptional() @IsIn([...LEAD_SOURCES], { message: '유입 경로는 카카오채널 · 전화 · 블로그 · 인스타그램 · 소개 · 워크인 중 하나입니다' })
  source?: string;

  @ApiPropertyOptional({ ...N, description: '담당 — null이면 미배정' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  ownerId?: number | null;

  @ApiPropertyOptional({ ...S, maxLength: 10, description: '학년 — null 또는 빈 문자열이면 비운다' })
  @IsOptional() @IsString() @MaxLength(10)
  grade?: string | null;
}

/** 단계 이동 (C90 · N-45) — 받아 주는 값은 LeadDto.nextStages 뿐. 등록·실패는 각자의 길이다 */
export class LeadStageMoveDto {
  @ApiProperty({ enum: [...INTAKE_FUNNEL_STAGES], description: '옮길 단계 — 깔때기 안 넷. 전이표 밖이면 409 LEAD_STAGE_INVALID · 끝난 건이면 409 LEAD_LOCKED' })
  @IsIn([...INTAKE_FUNNEL_STAGES], { message: '옮길 단계는 1차 상담 · 2차 대기 · 2차 상담 · 보류 중 하나입니다' })
  to!: string;
}

/** 접촉 기록 한 줄 (C90 · N-44 · A-03) */
export class LeadTouchWriteDto {
  @ApiProperty({ enum: [...LEAD_TOUCH_KINDS], description: '어떻게 — 낱말은 GET /ops.intakeHead.touchKinds' })
  @IsIn([...LEAD_TOUCH_KINDS], { message: '접촉 방법은 전화 · 카카오톡 · 문자 · 방문 · 상담 예약 · 예약 불참 · 메모 중 하나입니다' })
  kind!: string;

  @ApiProperty({ maxLength: 500, description: '한 줄' })
  @IsString() @MinLength(1, { message: '한 줄을 적어 주세요' }) @MaxLength(500)
  note!: string;

  @ApiPropertyOptional({ ...DATE_SCHEMA, nullable: true, description: '다음은 언제 YYYY-MM-DD — 상담 예약이면 상담 날짜' })
  @IsOptional() @IsCalendarDate()
  nextOn?: string | null;
}

const LEAD_ACTIVE_STAGES = ['first', 'wait2nd', 'second', 'hold'] as const;

/**
 * 실패 지정 (§24) — **중단 지점을 묻지 않는다**(W11 · N-87). 서버가 실패 순간의 단계를 `fail_from` 에 적고 그 단계가 곧 중단 지점이다
 * (원문 슬라이드 24 「fail.from 필드로 중단 단계 판정」). 옛 `stopAt` 칸은 받지 않는다 — 보내면 400(모르는 칸).
 */
export class LeadFailDto {
  @ApiPropertyOptional({ description: '사유 — 500자 이내. 생략하면 기존 사유 유지' })
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
  @ApiPropertyOptional({ enum: [...LEAD_REASON_KINDS], description: '사유 분류 — 원본 §24 다섯(연락 두절 · 타 학원 등록 · 일정 안 맞음 · 비용 · 시기 안 맞음). 생략하면 기존 분류 유지. 낱말은 GET /ops.intakeHead.failReasons' })
  @IsOptional()
  @IsIn([...LEAD_REASON_KINDS], { message: '사유 분류는 연락 두절 · 타 학원 등록 · 일정 안 맞음 · 비용 · 시기 안 맞음 중 하나입니다' })
  reasonKind?: string;

  @ApiPropertyOptional({ ...DATE_SCHEMA, nullable: true, description: '재연락 예정일 YYYY-MM-DD — 있으면 실패 전이와 같은 트랜잭션에 접촉 원장 한 줄을 남긴다 (A-08)' })
  @IsOptional() @IsCalendarDate()
  nextOn?: string | null;
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
  @ApiProperty({ enum: [...CPL_AREAS] }) area!: string;
  @ApiPropertyOptional(N) studentId?: number | null;
  @ApiPropertyOptional(S) studentName?: string | null;
  @ApiProperty({ description: 'received | acting | closed' }) stage!: string;
  @ApiProperty() body!: string;
  @ApiPropertyOptional(S) action?: string | null;
  @ApiPropertyOptional(S) result?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() ageDays!: number;
  @ApiProperty({ description: '갈래 이름 — 화면이 제 표를 들면 §67 칩과 §69 줄이 갈린다 (D-R18)' }) areaLabel!: string;
  @ApiPropertyOptional(N) ownerId?: number | null;
  @ApiPropertyOptional({ ...S, description: '담당 — 원본 §67 카드 바닥. 없으면 null («담당 없음»)' })
  ownerName?: string | null;
  /* C93 — 기한 · 심각도 · 강사 교체 (J-96 · J-98 · J-97). 옛 행은 null — 「미지정」이라 적지 않는다 (N-25) */
  @ApiPropertyOptional({ ...S, description: '대응 기한 YYYY-MM-DD (J-98) — 없으면 null' }) dueOn?: string | null;
  @ApiProperty({ description: '기한이 지난 날 수 — 열린 건만 · 서버가 센다 (D-R37). 0 이면 안 지남' }) overdueDays!: number;
  @ApiPropertyOptional({ ...S, description: 'light | normal | severe — 코드값 · 이름은 severityLabel' }) severity?: string | null;
  @ApiPropertyOptional({ ...S, description: '가벼움 · 보통 · 심각 — 낱말은 서버 (D-R18)' }) severityLabel?: string | null;
  @ApiProperty({ description: '강사 교체 마법사를 거쳤는가 (J-97 · `cpl.teacher_changed`)' }) teacherChanged!: boolean;
  @ApiProperty({
    description: '「수강 종료 · 환불」이 서는가 — 돈 권한 · 아직 안 끝난 건 · 학생이 붙은 건 (S5 · D-R39). '
      + '그 창이 부르는 경로가 canMoney 라 화면이 권한을 안 보면 창이 뜨자마자 403 이 난다',
  })
  canWithdraw!: boolean;
  /* wave 6 — 문의자 관계 · 마무리 날짜 (원본 §67 카드 「고은설 어머니」 · 결과 칸 「08-12」 · 67-5 · 67-6). 옛 행은 null (N-25) */
  @ApiPropertyOptional({ ...S, enum: [...CPL_REQUESTERS], description: 'mother | father — 누가 알렸는지(코드값). 모르면 null' })
  requester?: string | null;
  @ApiPropertyOptional({ ...S, description: '「어머니」 · 「아버지」 — 낱말은 서버 (D-R18). 모르면 null(카드에 서지 않는다)' })
  requesterLabel?: string | null;
  @ApiPropertyOptional({ ...S, format: 'date', description: '마무리한 날(KST) — 「결과」로 옮긴 순간 서버가 찍는다(입력 칸 아님). 열린 건 · 옛 「결과」 행(모름)은 null' })
  closedOn?: string | null;
}

/** §67 「+ 접수」 (C93 · J-96 · N-46 ①) — 상태는 받지 않는다: 접수는 언제나 `received` */
export class ComplaintCreateDto {
  @ApiProperty({ enum: [...CPL_AREAS], description: '갈래 다섯 — 낱말은 GET /ops.cplAreas' })
  @IsIn([...CPL_AREAS], { message: '갈래는 수업 · 상담 · 교재 · 스케줄 · 선생님 중 하나입니다' })
  area!: string;

  @ApiPropertyOptional({ ...N, description: '학생 — 없으면 문의자' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  studentId?: number | null;

  @ApiProperty({ maxLength: 1000, description: '내용' })
  @IsString() @MinLength(1, { message: '내용을 적어 주세요' }) @MaxLength(1000)
  body!: string;

  @ApiPropertyOptional({ ...N, description: '담당 — 정하면 그 사람에게 알림' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  ownerId?: number | null;

  @ApiPropertyOptional({ ...S, description: '대응 기한 YYYY-MM-DD (J-98)' })
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '기한은 YYYY-MM-DD 입니다' })
  dueOn?: string | null;

  @ApiPropertyOptional({ enum: [...CPL_SEVERITIES], nullable: true, description: '가벼움 · 보통 · 심각 — 코드값' })
  @IsOptional() @IsIn([...CPL_SEVERITIES], { message: '심각도는 가벼움 · 보통 · 심각 중 하나입니다' })
  severity?: string | null;

  @ApiPropertyOptional({ enum: [...CPL_REQUESTERS], nullable: true, description: '문의자 관계(67-5) — 어머니 · 아버지 코드값. 낱말은 GET /ops.cplRequesters · 모르면 비운다' })
  @IsOptional() @IsIn([...CPL_REQUESTERS], { message: '문의자 관계는 어머니 · 아버지 중 하나입니다' })
  requester?: string | null;
}

/** §67 카드 처리 — 담당 · 단계 · 조치 · 결과 · 기한 · 심각도 (C93 · J-101). 보낸 칸만 고친다 */
export class ComplaintPatchDto {
  @ApiPropertyOptional({ enum: CPL_STAGES, description: 'received → acting → closed — acting 은 담당이, closed 는 결과가 있어야 한다' })
  @IsOptional() @IsIn(CPL_STAGES, { message: '단계는 접수 · 대응 · 결과 중 하나입니다' })
  stage?: string;

  @ApiPropertyOptional({ ...N, description: '담당 — null 이면 담당 해제' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  ownerId?: number | null;

  @ApiPropertyOptional({ ...S, maxLength: 1000, description: '조치 — 「대응」 칸에 적히는 글' })
  @IsOptional() @IsString() @MaxLength(1000)
  action?: string | null;

  @ApiPropertyOptional({ ...S, maxLength: 1000, description: '결과 — 「결과」 칸에 적히는 글 · 마무리에 필수 (J-101)' })
  @IsOptional() @IsString() @MaxLength(1000)
  result?: string | null;

  @ApiPropertyOptional({ ...S, description: '대응 기한 YYYY-MM-DD — null 이면 기한 없음' })
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '기한은 YYYY-MM-DD 입니다' })
  dueOn?: string | null;

  @ApiPropertyOptional({ enum: [...CPL_SEVERITIES], nullable: true })
  @IsOptional() @IsIn([...CPL_SEVERITIES], { message: '심각도는 가벼움 · 보통 · 심각 중 하나입니다' })
  severity?: string | null;

  @ApiPropertyOptional({ enum: [...CPL_REQUESTERS], nullable: true, description: '문의자 관계(67-5) — null 이면 비운다. 마무리 날짜는 받지 않는다(「결과」로 옮길 때 서버가 찍는다)' })
  @IsOptional() @IsIn([...CPL_REQUESTERS], { message: '문의자 관계는 어머니 · 아버지 중 하나입니다' })
  requester?: string | null;
}

export class CplWordDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
}

/** §64 운영 할 일 */
export class TodoDto {
  @ApiProperty() id!: number;
  @ApiProperty({ type: Number, nullable: true, description: '담당 필터의 식별자. 이름으로 합치지 않는다' }) toId!: number | null;
  @ApiProperty(S) fromName!: string | null;
  @ApiProperty({ description: '기존 TODO 출처 코드표의 표시 이름' }) srcLabel!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional(S) toName?: string | null;
  @ApiPropertyOptional(S) dueOn?: string | null;
  @ApiProperty() done!: boolean;
  @ApiProperty({ enum: TODO_SRC_T_VALUES }) src!: string;
  @ApiProperty({ description: '기한이 지난 날 수. 0이면 안 지남' }) overdueDays!: number;
  /**
   * §64 「연결 수업」 칩 (N-71 · W11) — 회차 키 (ser_id, on_date)로 이어진 수업. 이어진 수업이 없으면 null.
   * **필수 nullable** — 선택으로 두면 시험 표본이 이 칸을 빠뜨린 채 조용히 낡는다 (S5).
   */
  @ApiProperty({ type: () => TodoLessonDto, nullable: true, description: '연결 수업 — 「학습실 09:30」 · 누르면 그 회차' })
  lesson!: TodoLessonDto | null;
  /**
   * 「원본」 — 출처로 돌아가는 이동 링크 (원문 §64 규칙 · W11 A' 후속 2). 서랍 §15 의 할 일 `go` 와 **같은 함수**(lib/todo `todoGo`)가 짓는다.
   * 대상 화면이 한 건을 여는 질의를 이미 읽는 것만 — 없으면 null(손으로 만든 할 일 · 투영에 없는 회차). 필수 nullable (S5).
   */
  @ApiProperty({
    type: String, nullable: true,
    description: '원본 주소 — 회의 `/ops?tab=meeting&meeting=` · 컴플레인 `?tab=complaint&cpl=` · 기획 `?tab=plan&plan=` · 컨설팅 `/consulting?id=` · 상담 `/intake?lead=` · 수업 = 연결 수업 칩과 같은 주소',
  })
  go!: string | null;
}

/** §64 「연결 수업」 칩 한 칸 (N-71) — 낱말·색·이동 주소 전부 서버가 짓는다 (D-R18) */
export class TodoLessonDto {
  @ApiProperty({ description: '「학습실 09:30」 — 수업 이름(제목 → 과목 → 종류) + 그려지는 회차의 시작 시각' }) label!: string;
  @ApiProperty({ type: String, nullable: true, description: '과목색(없으면 종류색) — 칩의 점. 없으면 null' }) color!: string | null;
  @ApiProperty({
    type: String, nullable: true,
    description: '누르면 가는 시간표 주소 — 그 회차를 연다(`/schedule?date=&serId=&onDate=`). 회차가 투영에 없으면 null',
  })
  go!: string | null;
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
  @ApiPropertyOptional(N) ownerId?: number | null;
  @ApiPropertyOptional(S) ownerName?: string | null;
  @ApiProperty() overdueDays!: number;
  /** 기한이 대표를 지나왔는가 — 「최종 승인」이 열리는 조건이다 (원문 §61·§65) */
  @ApiProperty({ enum: PLAN_DUE_STATES, description: '기한 상태 — due_on 과 due_approved_at 에서 파생' })
  dueState!: string;
  /**
   * 원본 §61 rework 카드의 **「보완 N」** 칩 — 사유가 아니라 **횟수**다.
   *
   * 세는 칸을 파지 않고 `log`(entity='plan' · action='rework')를 센다. `reviewPlan` 이
   * 처음부터 그 줄을 남기고 있었고 append-only 라 어긋날 수가 없다 (S6 · D-R22 · D-R37).
   * 시드가 손으로 박은 `rework` 건은 그 줄이 없어 **0 이다** — 누가 언제 반려했는지 정말로
   * 모르기 때문이고, 「보완 1」이라 적으면 없는 사실을 지어내는 것이다 (N-25).
   */
  @ApiProperty({ description: '보완 요청을 받은 횟수 — 0 이면 칩이 서지 않는다 (LOG 에서 센다)' })
  reworkCount!: number;

  /* w5 · g6 61-1~61-3 — 원본 §61 카드의 「과제 1/3」 · 「4일 지남 08-25」 · 「기한 제안/승인」 칩.
     세는 것도 낱말도 서버다 (D-R37 · D-R18) — §65 보고서의 taskDone·dueStateLabel 과 같은 자리에서 나온다. */
  @ApiProperty({ description: '끝낸 과제 수 — 이 기획에 걸린 TODO(plan_id) 중 끝난 것 (§61 「과제 1/3」)' })
  taskDone!: number;
  @ApiProperty({ description: '과제 전체 수 — 이 기획에 걸린 TODO(plan_id)' })
  taskTotal!: number;
  @ApiProperty({
    type: String, nullable: true,
    description: '기한 한 낱말 — 「4일 지남」·「오늘」·「D-2」(§62 dueLabel 과 같은 함수). 기한이 없거나 끝난(승인·완료) 기획이면 null — 끝난 기획의 날짜는 재촉이 아니다',
  })
  dueLabel!: string | null;
  @ApiProperty({ description: '기한 상태 이름 — 「기한 없음」·「기한 제안」·「기한 승인」·「기한 반려」 (§65 dueStateLabel 과 같은 낱말)' })
  dueStateLabel!: string;

  /* W11 — 원문 §61 카드의 「D-2 08-19 · 기한 반려」(N-95)와 「전체 공개」·「지정 공개」 칩(N-72). 필수 nullable (S5) */
  @ApiProperty({
    type: String, nullable: true,
    description: '반려된 기한 YYYY-MM-DD — 반려가 지운 날짜. 담당이 새 기한을 내면 비고, 옛 반려는 기록이 없어 null (N-95 · N-25)',
  })
  dueRejectedOn!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: [...PLAN_SHARES], description: '공개 범위 — all · picked. 옛 기획은 null(모두에게 보이고 칩 없음 · N-72)' })
  share!: string | null;
  @ApiProperty({ type: String, nullable: true, description: '공개 범위 칩 낱말 — 「전체 공개」·「지정 공개」. 옛 기획은 null' })
  shareLabel!: string | null;
}

/** §62 기획 기한 한 줄 — 기획 마감과 과제 기한이 **한 표에** 섞인다 */
export class PlanDueRowDto {
  @ApiProperty({ description: '한 표 안에서 겹치지 않는 키 — `plan:3` · `task:11`' }) key!: string;
  @ApiProperty({ enum: PLAN_DUE_KINDS }) kind!: string;
  @ApiProperty({ description: '구분 이름 — 원문 「기획 마감 · 과제」' }) kindLabel!: string;
  @ApiProperty({ example: '2026-08-25', description: '기한 — 기획 마감이 반려됐으면 반려된 날짜(원문 §62 · N-95)' }) dueOn!: string;
  /** 「D-2 · 오늘 · 1일 지남」 — 화면이 날짜를 빼지 않는다 (D-R37) */
  @ApiProperty({ description: '남은 날 한 낱말' }) dueLabel!: string;
  @ApiProperty({ description: '지난 날 수 — 0 이면 안 지났다. 붉게 칠하는 판정이 이 값 하나다(반려된 날짜는 지금 기한이 아니라 0)' })
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

/** 갈 수 있는 다음 단계 한 칸 — 낱말은 서버가 만든다 (D-R18 · C90 `LeadDto.nextStages` 와 같은 모양) */
export class PlanNextStageDto {
  @ApiProperty({ description: '저장값' }) key!: string;
  @ApiProperty({ description: '사람이 읽는 이름' }) label!: string;
}

/** §65 기획 보고서 — 목표 → 과제 → 리서치 → 결정 요청 */
export class PlanDetailDto {
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: PLAN_STAGES }) stage!: string;
  @ApiProperty() stageLabel!: string;
  @ApiPropertyOptional(N) ownerId?: number | null;
  @ApiPropertyOptional(S) ownerName?: string | null;
  @ApiProperty({ description: '담당을 바꿀 수 있는가 — 기획 결재권자만. 쓰기 권한과 같은 판정' })
  canChangeOwner!: boolean;
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
  @ApiProperty({ description: '최종 승인을 할 수 있는가 — **기한이 먼저 승인돼야 열린다** (원문 §61·§65)' })
  canReview!: boolean;
  @ApiProperty({ description: '단추가 닫혀 있는 이유 — 열려 있으면 null', nullable: true, type: String })
  reviewBlockedReason!: string | null;
  /*
   * 「보완 요청」은 **따로 연다** (g6 65-7 · x5). 원문 규칙이 막는 것은 「최종 승인」뿐이다 —
   * 「기한을 먼저 승인해야 **최종 승인** 버튼이 열립니다」(슬라이드 61·65) · 컷 §65 의 「보완 요청」은 기한 승인 전에도
   * 살아 있다. 권한·자기 결재·검토 요청 단계는 최종 승인과 같이 본다. 막힌 문장은 쓰기(409)와 같은 말이다.
   */
  @ApiProperty({ description: '보완 요청을 할 수 있는가 — 기한 승인과 무관하다(원문 규칙은 최종 승인만 막는다)' })
  canRework!: boolean;
  @ApiProperty({ description: '보완 요청 단추가 닫혀 있는 이유 — 열려 있으면 null', nullable: true, type: String })
  reworkBlockedReason!: string | null;

  /* ── S6 「기획이 결재까지 간다」 ────────────────────────────────────── */

  /**
   * 왜 반려됐나 — 그동안 `log.after->>'reason'` 에만 들어가 **담당자가 볼 방법이 없었다**.
   * **다시 올리면 지워진다**(지난 사유가 남아 있으면 지금 상태를 속인다 · C85-a).
   *
   * **필수 nullable 이다** — 선택으로 두면 생성 타입에 `?` 가 붙어 시험 표본이 이 칸을
   * 빠뜨린 채 조용히 낡는다 (S5 에서 배운 것).
   */
  @ApiProperty({ description: '보완 요청 사유 — rework 가 아니면 null', nullable: true, type: String })
  reworkReason!: string | null;

  @ApiProperty({ description: '본문(목표·리서치·결정 요청·제목·기한)을 고칠 수 있는가 — draft·rework 일 때만' })
  canEdit!: boolean;
  /** 쓰기가 409 로 내는 **그 문장**이다 (D-R22 · D-R39) */
  @ApiProperty({ description: '못 고치는 이유 — 고칠 수 있으면 null', nullable: true, type: String })
  editBlockedReason!: string | null;

  /**
   * 옮길 수 있는 단계 — 화면은 이 배열만 보고 단추를 세운다 (D-R18 · D-R39).
   * **결재(review → approved|rework)는 여기 없다** — 그것은 위의 `canReview` 가 여는 길이다.
   */
  @ApiProperty({ type: [PlanNextStageDto], description: '갈 수 있는 다음 단계 — 비면 옮길 곳이 없다' })
  nextStages!: PlanNextStageDto[];

  /* w5 · g6 65-4 — 원본 §65 「2 · 과제」 오른쪽의 「+ 대표 지시」. 서는지와 막힌 이유를 서버가 정한다 (D-R39) */
  @ApiProperty({ description: '「+ 대표 지시」로 과제를 더할 수 있는가 — 기획 결재 권한 · 끝나지 않은 기획' })
  canAddTask!: boolean;
  /** `POST /ops/plans/:id/tasks` 가 409 로 내는 **그 문장**이다 (S5 · D-R22) */
  @ApiProperty({ type: String, nullable: true, description: '과제를 못 더하는 이유 — 더할 수 있으면 null' })
  addTaskBlockedReason!: string | null;

  /* ── W11 · N-95 기한 반려 보존 · N-72 공개 범위 (필수 nullable · S5) ───────────── */
  @ApiProperty({ type: String, nullable: true, description: '반려된 기한 YYYY-MM-DD — 새 기한을 내면 빈다. 옛 반려는 null (N-95)' })
  dueRejectedOn!: string | null;
  @ApiProperty({ type: String, nullable: true, description: '기한을 반려한 사람' })
  dueRejectedByName!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: [...PLAN_SHARES], description: '공개 범위 — all · picked · 옛 기획 null' })
  share!: string | null;
  @ApiProperty({ type: String, nullable: true, description: '공개 범위 칩 낱말 — 옛 기획 null' })
  shareLabel!: string | null;
  @ApiProperty({ type: [Number], description: '지정 공개로 볼 수 있게 지정된 사람 — 지정 공개가 아니면 빈 배열' })
  pickIds!: number[];
  @ApiProperty({ type: [String], description: '지정된 사람 이름 — pickIds 와 같은 차례' })
  pickNames!: string[];
  @ApiProperty({ description: '공개 범위를 바꿀 수 있는가 — 담당이거나 결재권자. 쓰기(403 PLAN_SHARE_FORBIDDEN)와 같은 판정 (D-R39)' })
  canEditShare!: boolean;
}

/** 공개 범위 두 값 (N-72) — 「전체 공개」·「지정 공개」. 창의 고르기 칸이 쓴다 (D-R18) */
export class PlanShareWordDto {
  @ApiProperty({ enum: [...PLAN_SHARES] }) key!: string;
  @ApiProperty() label!: string;
}

/**
 * 「+ 대표 지시」 — 원본 §65 「2 · 과제」 (w5 · g6 65-4).
 *
 * 과제는 TODO 한 줄(`src='plan'` · `plan_id`)이다 — 새 표를 파지 않는다. 입력 모양은 §66 할 일 배정·
 * 서랍 「할 일 만들기」와 같다(할 일 · 담당 · 기한) — 같은 창(`TodoCreateDialog`)을 쓰기 때문이다.
 */
export class PlanTaskCreateDto {
  @ApiProperty({ maxLength: 160 })
  @IsString() @MinLength(1, { message: '할 일을 적어 주세요' }) @MaxLength(160)
  title!: string;

  @ApiProperty({ description: '누구에게 — 활동 중인 구성원' })
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  toId!: number;

  @ApiPropertyOptional({ ...DATE_SCHEMA, description: '기한 — 비우면 기한 없음' })
  @IsOptional() @IsCalendarDate()
  dueOn?: string;
}

/**
 * 기획 본문 고치기 — §65 의 「1 · 목표」「3 · 리서치」「4 · 결정 요청」 (S6).
 *
 * **보낸 칸만 고친다** — 대표 보고 `PATCH /exec/report` 와 같다. 안 보낸 칸을 지우면
 * §65 를 나눠 쓰는 자리에서 남의 줄이 사라진다.
 */
export class PlanPatchDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional() @IsString() @MinLength(1, { message: '제목을 적어 주세요' }) @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ ...S, maxLength: 2000, description: '1 · 목표' })
  @IsOptional() @IsString() @MaxLength(2000)
  goal?: string | null;

  @ApiPropertyOptional({ ...S, maxLength: 4000, description: '3 · 리서치 — 이 칸을 쓰는 API 가 S6 전에는 없었다' })
  @IsOptional() @IsString() @MaxLength(4000)
  research?: string | null;

  @ApiPropertyOptional({ ...S, maxLength: 2000, description: '4 · 결정 요청' })
  @IsOptional() @IsString() @MaxLength(2000)
  ask?: string | null;

  /**
   * 기한 제안 — **승인된 뒤에는 못 옮긴다**(409 `PLAN_DUE_APPROVED`). 담당이 옮길 수 있으면
   * 대표의 승인이 거짓이 된다. 기한 반려로 지워진 뒤 새 날짜를 내는 길이 이것이다.
   */
  @ApiPropertyOptional({ ...S, description: '기한 제안 — 승인 전에만. null 이면 지운다. 새 날짜를 내면 반려 표시가 빈다 (N-95)' })
  @IsOptional() @IsCalendarDate()
  dueOn?: string | null;

  /**
   * 공개 범위 (N-72) — 본문이 아니라 **누가 보는가**라 단계 잠금을 받지 않는다. 바꾸면 감사 한 줄(`plan.share`).
   * 옛 기획(NULL)을 NULL 로 되돌리는 값은 없다 — NULL 은 「모른다」이지 고를 수 있는 값이 아니다.
   */
  @ApiPropertyOptional({ enum: [...PLAN_SHARES], description: '공개 범위 — all 전체 공개 · picked 지정 공개' })
  @IsOptional() @IsIn([...PLAN_SHARES], { message: '공개 범위는 전체 공개 또는 지정 공개입니다' })
  share?: string;

  @ApiPropertyOptional({ type: [Number], description: '지정 공개로 볼 사람 — 지정 공개일 때만 · 보내면 통째로 갈아 끼운다(활동 중인 구성원만)' })
  @IsOptional() @IsArray() @ArrayMaxSize(50)
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(Number.MAX_SAFE_INTEGER, { each: true })
  pickIds?: number[];
}

/** 기획 담당 변경 — 본문/공개 범위와 별도 원자적 쓰기. 활동 중인 구성원만 받을 수 있다. */
export class PlanOwnerPatchDto {
  @ApiProperty({ description: '새 담당 — 활동 중인 구성원' })
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  ownerId!: number;
}

/** 단계 이동 (S6) — 받아 주는 값은 `PlanDetailDto.nextStages` 뿐. 결재는 `:id/review` 가 옮긴다 */
export class PlanStageMoveDto {
  @ApiProperty({ enum: [...PLAN_STAGES], description: '옮길 단계 — 전이표 밖이면 409 PLAN_STAGE_INVALID · 옮길 곳이 없으면 409 PLAN_STAGE_LOCKED' })
  @IsIn([...PLAN_STAGES], { message: '옮길 단계는 작성 중 · 검토 요청 · 보완 요청 · 승인 · 완료 중 하나입니다' })
  to!: string;
}

/**
 * 기한 승인 · 반려 — 원문 §65 의 「기한 승인」 「기한 반려」.
 *
 * **대표가 본 날짜를 함께 보낸다** (PB-12-2 · N-95). 전에는 승인이 행을 잠그지 않고 무조건 썼다 — 그 사이 담당이
 * 기한을 옮기면 **대표가 본 적 없는 날짜가 승인**되고 감사 줄에는 옛 날짜가 적혔다. 이제 서버가 행을 잠그고
 * 지금 날짜가 이 값과 다르면 409 `PLAN_DUE_CHANGED` 로 돌려보낸다 — 새 날짜를 보고 다시 정한다.
 */
export class PlanDueDecisionDto {
  @ApiProperty({ description: 'true 면 승인, false 면 반려' })
  @IsBoolean() approve!: boolean;

  @ApiProperty({ ...DATE_SCHEMA, description: '결정하는 기한 — 화면이 본 날짜. 그 사이 바뀌었으면 409 PLAN_DUE_CHANGED' })
  @IsCalendarDate()
  dueOn!: string;
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
  @ApiProperty({ description: '짧은 이름 — 원문 §63 줄 머리 칩 「기획」 (g6 63-7 · x5). §66 머리는 긴 이름(mtTypeLabel)' })
  mtTypeShort!: string;
  @ApiPropertyOptional(S) title?: string | null;
  @ApiPropertyOptional(S) onDate?: string | null;
  @ApiProperty() attendees!: number;
  @ApiProperty() confirmed!: number;
  @ApiProperty({ description: '속기록을 썼는가 — 안 쓰면 회의가 끝난 것이 아니다' }) hasMinutes!: boolean;
  /*
   * 시각·자리는 **시간표가 갖는다** (C96) — `mtrec` 에 칸을 새기면 같은 사실이 두 곳에 살고
   * 겹침(`ser_occ` EXCLUDE)의 판정 밖이 된다. 옛 회의는 어느 회차였는지 아무도 모르므로
   * 셋 다 null 이고, 화면은 그 사실을 「시각 없음」으로 말한다 (N-25).
   */
  @ApiPropertyOptional({ ...N, description: '시간표 회차 — 옛 회의는 null (C96)' }) serId?: number | null;
  @ApiPropertyOptional({ ...N, description: '시작 분 — 회차가 있을 때만' }) startMin?: number | null;
  @ApiPropertyOptional({ ...N, description: '끝 분 — 회차가 있을 때만' }) endMin?: number | null;
  @ApiPropertyOptional({ ...S, description: '자리 — 「1호」 또는 「온라인 TN Zoom」. 낱말은 서버가 만든다 (D-R18)' })
  placeLabel?: string | null;
  @ApiProperty({ description: '아직 답 안 한 사람 — 「대기 4」 (원본 §63 · confirmed IS NULL · C57)' })
  waiting!: number;
  /*
   * w5 · g6 63-1·63-2 — 원본 §63 줄 오른쪽의 **참석자 이름 칩**과 「예정」.
   * 이름은 §66 상세와 **같은 모양**(세 값 상태)으로 싣는다 — 줄은 이름 칩, 상세는 참석 행으로 같은 사실을 그린다.
   * `MeetingAttendeeDto` 는 아래에 선언되므로 지연 참조로 가리킨다.
   */
  @ApiProperty({ type: () => [MeetingAttendeeDto], description: '참석자 — 이름 · 세 값 상태 (§66 과 같은 모양 · 순서도 같다)' })
  attendeeList!: MeetingAttendeeDto[];
  @ApiProperty({ description: '아직 오지 않은 회의인가 — 오늘 포함(끝났는지는 날짜만으로 모른다). 날짜 없는 옛 회의는 false · 원본 §63 「예정」' })
  upcoming!: boolean;
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
  @ApiPropertyOptional({ ...S, description: '한 날 — 기간을 가르는 날(§59 「일·주·월」) · 옛 행은 null (x5)' }) onDate?: string | null;
  @ApiPropertyOptional(N) byId?: number | null;
  @ApiPropertyOptional({ ...S, description: '담당자 — §60 답변을 쓸 수 있는 사람' }) byName?: string | null;
  @ApiPropertyOptional(S) url?: string | null;
  @ApiPropertyOptional(N) impressions?: number | null;
  @ApiPropertyOptional(N) clicks?: number | null;
  @ApiPropertyOptional(N) inquiries?: number | null;
  @ApiPropertyOptional(N) enrolled?: number | null;
  @ApiPropertyOptional({ ...N, description: '집행 비용 — 대표만 (D-R39)' }) cost?: number | null;
  @ApiPropertyOptional({ ...N, description: '등록당 비용' }) costPerEnroll?: number | null;
  /* W11 · N-29 ② — 원문 §59 카드 제목 아래 한 줄(「상담 예약 4건 전환」 · 「일 예산 5만 · CTR 3.1%」). MMEMO = MKT 의 한 칸 */
  @ApiPropertyOptional({ ...S, description: '메모 한 줄 — 적은 적이 없으면 null' }) memo?: string | null;
}

/**
 * §59 「+ 오늘 한 것」 — 활동 등록 · URL 첨부 (g6 59-3 · P1 · x5).
 *
 * 채널·항목은 **원문 컷의 넷 · 넷**이다(W11 · N-29 ① — 카카오채널 · 네이버 광고 · 인스타그램 · 네이버 블로그 × 댓글·응대 · 광고 집행 ·
 * 릴스·영상 · 글 발행 · 둘은 따로 고른다). 나머지 셋 · 셋은 이름이 없어 받지 않는다. 옛 행의 코드도 받지 않는다(읽기만 한다).
 * 메모 한 줄(MMEMO · N-29 ②)을 받는다. 성과(노출·문의·등록·비용)는 받지 않는다 — 나중에 적는 값이다.
 */
export class MarketingCreateDto {
  @ApiProperty({ maxLength: 120, description: '활동 이름 — 카드 제목' })
  @IsString() @MinLength(1, { message: '무엇을 했는지 적어 주세요' }) @MaxLength(120)
  title!: string;

  @ApiProperty({ enum: [...MKT_CHANNELS], description: '어디에 — 낱말은 GET /ops.mktChannels' })
  @IsIn([...MKT_CHANNELS], { message: '채널을 목록에서 고르세요' })
  channel!: string;

  @ApiProperty({ enum: [...MKT_ITEMS], description: '무엇을 — 낱말은 GET /ops.mktItems' })
  @IsIn([...MKT_ITEMS], { message: '항목을 목록에서 고르세요' })
  item!: string;

  @ApiPropertyOptional({ ...S, maxLength: 2000, description: '올린 글·광고의 주소 — HTTP(S) · 비우면 없음' })
  @IsOptional() @IsString() @MaxLength(2000)
  @IsSafeHttpUrl({ allowBlank: true, message: 'URL은 로그인 정보가 없는 올바른 HTTP(S) 주소여야 합니다' })
  url?: string | null;

  @ApiPropertyOptional({ ...DATE_SCHEMA, nullable: true, description: '한 날 — 없으면 오늘(「오늘 한 것」)' })
  @IsOptional() @IsCalendarDate()
  onDate?: string | null;

  @ApiPropertyOptional({ ...N, description: '담당 — 없으면 나. §60 답변을 쓸 수 있는 사람' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  byId?: number | null;

  @ApiPropertyOptional({ ...S, maxLength: 120, description: '메모 한 줄 — 카드 제목 아래(원문 「상담 예약 4건 전환」). 비우면 없음 (N-29 ②)' })
  @IsOptional() @IsString() @MaxLength(120)
  memo?: string | null;
}

/** §59 활동 수정 — 보낸 칸만 고치고 성과 숫자는 이 경로에서 받지 않는다. */
export class MarketingPatchDto {
  @ApiPropertyOptional({ maxLength: 120, description: '활동 이름 — 빈 문자열은 허용하지 않는다' })
  @IsOptional() @IsString() @MinLength(1, { message: '무엇을 했는지 적어 주세요' }) @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ enum: [...MKT_CHANNELS], description: '어디에 — 낱말은 GET /ops.mktChannels' })
  @IsOptional() @IsIn([...MKT_CHANNELS], { message: '채널을 목록에서 고르세요' })
  channel?: string;

  @ApiPropertyOptional({ enum: [...MKT_ITEMS], description: '무엇을 — 낱말은 GET /ops.mktItems' })
  @IsOptional() @IsIn([...MKT_ITEMS], { message: '항목을 목록에서 고르세요' })
  item?: string;

  @ApiPropertyOptional({ ...S, maxLength: 2000, description: 'HTTP(S) URL — null 또는 빈 문자열이면 비운다' })
  @IsOptional() @IsString() @MaxLength(2000)
  @IsSafeHttpUrl({ allowBlank: true, message: 'URL은 로그인 정보가 없는 올바른 HTTP(S) 주소여야 합니다' })
  url?: string | null;

  @ApiPropertyOptional({ ...DATE_SCHEMA, nullable: true, description: '활동 날짜 — null이면 비운다' })
  @IsOptional() @IsCalendarDate()
  onDate?: string | null;

  @ApiPropertyOptional({ ...N, description: '담당 — 활동 중인 구성원' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  byId?: number | null;

  @ApiPropertyOptional({ ...S, maxLength: 120, description: '메모 — null 또는 빈 문자열이면 비운다' })
  @IsOptional() @IsString() @MaxLength(120)
  memo?: string | null;
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
  @ApiProperty({
    description: '보는 사람이 이 할 일의 완료를 체크할 수 있는가 — `PATCH /drawer/todos/:id` 와 같은 판정(운영 권한 · 받은 사람 · 준 사람). '
      + '참석자로만 여는 강사는 자기에게 온 할 일만 (W11 A\' 후속 · P)',
  })
  canToggle!: boolean;
}

/** §66 회의 상세 — 참석 확인 → 사전 자료 → 속기록 → 할 일 배정 */
export class MeetingDetailDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: MT_TYPES }) mtType!: string;
  @ApiProperty() mtTypeLabel!: string;
  @ApiPropertyOptional(S) title?: string | null;
  @ApiPropertyOptional(S) onDate?: string | null;
  /*
   * w5 · g6 66-2 — 원본 §66 머리 「18:30–19:30 · 김범준, Allissa, KJ, Sophia · 6호」.
   * §63 줄(`MeetingDto`)과 **같은 조인·같은 낱말 함수**에서 나온다 — 옛 회의(이어진 회차 없음)는 셋 다 null (N-25).
   */
  @ApiProperty({ type: Number, nullable: true, description: '시작 분 — 이어진 회차가 있을 때만' }) startMin!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '끝 분 — 이어진 회차가 있을 때만' }) endMin!: number | null;
  @ApiProperty({ type: String, nullable: true, description: '자리 — 「6호」 또는 「온라인 TN」 (§63 placeLabel 과 같은 낱말)' })
  placeLabel!: string | null;

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

  /*
   * W11 · N-32 — 이 창은 참석자 본인에게도 열린다(「안내 보내기」 알림 링크가 오는 곳).
   * 단추가 서는지는 서버가 정한다 — 화면이 역할을 견주지 않는다 (D-R39).
   */
  @ApiProperty({ description: '속기록 · 할 일 배정 · 사전 자료를 고칠 수 있는가(운영 권한)' }) canEdit!: boolean;
  @ApiProperty({ description: '「안내 보내기」가 서는가 — 운영 권한 · 받을 참석자가 있고 취소되지 않은 회의' }) canSendNotice!: boolean;
  @ApiProperty({ type: String, nullable: true, description: '「안내 보내기」가 막힌 이유 — 쓰기(409)와 같은 문장 · 운영 권한이 없으면 null' })
  noticeBlockedReason!: string | null;
  @ApiProperty({ description: '보는 사람이 참석자인가 — 본인 응답(참석 · 불참) 단추가 선다' }) canRespond!: boolean;
  @ApiProperty({ type: () => MeetingMyAttendDto, nullable: true, description: '보는 사람의 참석 응답 — 참석자가 아니면 null' })
  myAttend!: MeetingMyAttendDto | null;
}

/** 보는 사람 자신의 참석 응답 (N-32) */
export class MeetingMyAttendDto {
  @ApiProperty({ enum: MT_ATTEND_STATES, description: 'waiting | in | out — 날이 지나도 답하지 않았으면 waiting 그대로' })
  state!: string;
  @ApiProperty({ description: '칩에 쓰는 이름 (D-R18)' }) stateLabel!: string;
}

/** 참석 응답 — 본인 줄만 · 대리 입력 없음 (N-32) */
export class MeetingAttendDto {
  @ApiProperty({ description: 'true = 참석 · false = 불참' })
  @IsBoolean() confirmed!: boolean;
}

/** 「안내 보내기」 결과 — 보낸 알림 수와 다시 그릴 회의 상세 (N-32) */
export class MeetingNoticeResultDto {
  @ApiProperty({ description: '보낸 알림 수 — 참석자(보낸 사람 · 그만둔 사람 제외)' }) sent!: number;
  @ApiProperty({ type: () => MeetingDetailDto }) meeting!: MeetingDetailDto;
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
  @ApiProperty({ enum: [...MFB_KINDS], description: '쓸 때의 종류 — 역할로 되짚지 않는다 · hold 는 담당의 보류(W11 · N-29 ③)' }) kind!: string;
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
  /* W11 · N-29 ③ — 보류는 담당 답변의 한 종류다. 칩은 「확인 필요」 그대로 · 「고쳐야 할 것」에서 빠지지 않는다 · 「고친 것 알리기」가 푼다 */
  @ApiPropertyOptional({ type: Boolean, description: '가장 나중 코멘트에 담당이 「보류」로 답했는가(아직 고친 것은 알리지 않음) — 「보류」 단추는 한 번뿐이다' })
  held?: boolean;
}

/** 대표 코멘트 쓰기 — 원문 §60 「+ 코멘트 남기기」 */
export class MfbCommentWriteDto {
  @ApiProperty({ description: '코멘트 본문', maxLength: 1000 })
  @IsString() @MinLength(1, { message: '코멘트를 적어 주세요' }) @MaxLength(1000)
  body!: string;
}

/** 담당자 답변 쓰기 — 원문 §60 「고친 것 알리기」 · 「보류」(W11 · N-29 ③) */
export class MfbReplyWriteDto {
  @ApiProperty({ description: '어느 코멘트에 대한 답인가' })
  @IsInt() @Min(1)
  parentId!: number;
  @ApiProperty({ description: '답변 본문 — 보류면 왜 미루는지 한 줄', maxLength: 1000 })
  @IsString() @MinLength(1, { message: '답변을 적어 주세요' }) @MaxLength(1000)
  body!: string;
  @ApiPropertyOptional({ enum: [...MFB_ANSWER_KINDS], description: 'reply(고친 것 알리기 · 기본) | hold(보류 — 카드는 「확인 필요」로 남는다 · 코멘트마다 한 번)' })
  @IsOptional() @IsIn([...MFB_ANSWER_KINDS], { message: '답은 고친 것 알리기 · 보류 중 하나입니다' })
  kind?: string;
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
  @ApiPropertyOptional({ ...S, description: '답변한 관리자 이름' }) replyBy?: string | null;
  @ApiPropertyOptional({ ...S, description: '답변일 YYYY-MM-DD (KST)' }) replyOn?: string | null;
  @ApiProperty() createdAt!: string;
}

/** 건의 관리자 답변 — 답변 완료로 옮기고 답변자·시각을 같은 트랜잭션에 남긴다. */
export class SuggestionReplyDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString() @MinLength(1, { message: '답변을 적어 주세요' }) @MaxLength(2000)
  reply!: string;
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
  @ApiProperty({ description: '칸 이름 아래 한 줄 — **다음에 무엇을 하는지** (원본 §61)' }) sub!: string;
}

/** §67 컴플레인 단계 — 낱말·순서·한 줄이 서버에 있다 (D-R18 · D-R25) */
export class CplStageDto {
  @ApiProperty({ description: 'received | acting | closed — **저장되는 말이다**' }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: '칸 이름 아래 한 줄 (원본 §67)' }) sub!: string;
}

/* ── §23 상담 머리 — 퍼널 · 담당 · 경고 (C86-a) ────────────────────── */

/**
 * 퍼널 한 칸. **순서와 낱말은 서버가 갖는다** (D-R18 · D-R25 의 짝) —
 * 원본 §23 은 「1차 상담 › 2차 대기 › 2차 상담 › 보류 ⇒ 등록 | 등록 실패」로 읽고,
 * 화살표가 **⇒ 로 바뀌는 자리**(등록 전/후)까지 뜻이 있다.
 */
export class IntakeFunnelStepDto {
  @ApiProperty({ description: 'first | wait2nd | second | hold | enrolled | failed' }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: '그 단계의 건수 — 서버가 센다 (D-R37)' }) count!: number;
  @ApiProperty({ description: '보드 칸 아래 한 줄 — **다음에 무엇을 하는지** (원본 §23)' }) sub!: string;
  @ApiProperty({ description: '등록 전 깔때기인가 — false 면 결과 칸(등록 · 등록 실패)이다' }) funnel!: boolean;
}

/** 담당 한 사람 — 원본 §23 의 「담당 [전체] [Grace] [김범준]」 칩. */
export class IntakeOwnerDto {
  @ApiPropertyOptional({ ...N, description: '없으면 담당 미지정' }) id?: number | null;
  @ApiProperty() name!: string;
  @ApiProperty() count!: number;
}

/**
 * 경고 칩 하나 — 원본 §23 의 빨간 줄. **세는 일은 전부 서버가 한다** (D-R37).
 * 금액이 실리는 칩은 `amount` 가 `null` 로 내려간다 (D-R39).
 */
export class IntakeAlertDto {
  @ApiProperty({ description: 'unpaid | noSchedule | noInvoice | consultDue | followUpLate' }) key!: string;
  @ApiProperty({ description: '사람이 읽는 한 줄 — 화면이 문장을 만들지 않는다' }) label!: string;
  @ApiProperty() count!: number;
  @ApiPropertyOptional({ ...N, description: '금액 칩만. 볼 수 없으면 null (D-R39)' }) amount?: number | null;
  @ApiProperty({ description: '누르면 가는 곳 — 결과는 그 화면에서 본다 (D-R27)' }) go!: string;
}

/**
 * 중단 지점 한 칸 — 원본 §24 의 갈래. **낱말과 순서만 서버가 준다.**
 *
 * 건수를 싣지 않는 이유가 있다 — §24 의 표는 **검색으로 걸러진 행**을 세고(FQ 가 그 화면의 축이다)
 * 그 수는 업무 판정이 아니라 지금 보고 있는 목록의 모양이다. 낱말이 두 벌이면 갈리지만(D-R18)
 * 보고 있는 것을 세는 일까지 서버로 보내면 글자마다 왕복이 생긴다.
 */
export class IntakeStopDto {
  @ApiProperty({ description: '실패 당시 단계 — first | wait2nd | second | hold (W11 · N-87 · 원문 슬라이드 24 「fail.from 으로 중단 단계 판정」)' }) key!: string;
  @ApiProperty({ description: '「1차 상담 중단」 · 「2차 안 옴」 · 「2차 상담 중단」 · 「보류 후 무산」 (원문 §24 컷)' }) label!: string;
  @ApiPropertyOptional({ type: String, description: '분류 카드 아래 한 줄 — 원문 §24 「첫 통화 뒤 더 진행되지 않았습니다」' }) sub?: string;
}

/** 유입 경로 칩 하나 — 원본 §23 의 「유입 경로」 줄 (N-44 · C90). 건수 0 이어도 선다(어휘) · 「경로 없음」은 있을 때만 */
export class IntakeSourceDto {
  @ApiProperty({ description: 'kakao | phone | blog | instagram | referral | walkin | none' }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: '그 경로로 온 건수 — 서버가 센다 (D-R37)' }) count!: number;
}

/** 실패 사유 분류 한 줄 — 원본 §24 오른쪽 「실패 사유 N건」 막대와 이름 칩 (24-05). 다섯은 0 이어도 서고 「분류 안 됨」은 있을 때만 */
export class IntakeFailReasonDto {
  @ApiProperty({ description: 'unreachable | other_academy | schedule | cost | timing | none' }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: '그 분류의 실패 건수 — 서버가 센다 (D-R37)' }) count!: number;
  @ApiProperty({ type: [String], description: '그 분류의 학생 이름 — 막대 아래 이름 칩' }) names!: string[];
}

export class IntakeHeadDto {
  @ApiProperty({ type: [IntakeFunnelStepDto] }) funnel!: IntakeFunnelStepDto[];
  @ApiProperty({ description: '등록률 % — 등록 / (등록 + 등록 실패), 정수 반올림. 끝난 건이 없으면 0. 진행 중인 건은 분모에 넣지 않는다(원본 §23 「등록 3 · 실패 6 · 33%」 · 23-19)' }) enrollRate!: number;
  @ApiProperty({ type: [IntakeOwnerDto], description: '담당 칩 — 「전체」는 화면이 붙인다' }) owners!: IntakeOwnerDto[];
  @ApiProperty({ type: [IntakeAlertDto] }) alerts!: IntakeAlertDto[];
  @ApiProperty({ type: [IntakeStopDto], description: '§24 중단 지점 넷(실패 당시 단계) — 낱말 · 순서 · 설명 한 줄 (D-R18 · D-R25). 「미분류」는 그런 건의 failStopLabel 이 말한다' })
  stops!: IntakeStopDto[];
  @ApiProperty({ type: [IntakeSourceDto], description: '유입 경로 칩 줄 — 여섯 + 「경로 없음」(옛 건이 있을 때만) · 「전체」는 화면이 붙인다 (N-44 · C90)' })
  sources!: IntakeSourceDto[];
  @ApiProperty({ type: [IntakeWordDto], description: '접촉 「어떻게」 일곱 — 「+ 기록」 폼의 낱말 (D-R18)' })
  touchKinds!: IntakeWordDto[];
  @ApiProperty({ description: '「사후 관리 임박」 타일 — 다음 예정일이 오늘~D+2 인 건 (끝난 결과·지난 것은 빼고 센다)' }) followUpSoon!: number;
  @ApiPropertyOptional({ ...S, description: '도달 기록이 시작된 날 — §71 퍼널이 「언제부터의 값」인지 화면이 말한다 (N-45 · N-25). 기록이 없으면 null' })
  funnelSince?: string | null;
  @ApiProperty({ type: [IntakeFailReasonDto], description: '§24 실패 사유 분류 다섯 + 「분류 안 됨」(있을 때만) — 막대 집계와 실패 지정 폼의 낱말 (24-05)' })
  failReasons!: IntakeFailReasonDto[];
  @ApiPropertyOptional({ type: [IntakeWordDto], description: '2차 · 진단 일정 종류 둘(「진단」 · 「2차」) — 일정 폼의 낱말 (23-15 · D-R18)' })
  apptKinds?: IntakeWordDto[];
}

/* ══ C96 — 운영에 만드는 길 (N-46 ②③ · J-102) ═══════════════════════════════ */

/** 지금 보고 있는 기간 — 화면이 「최근 두 달」 같은 말을 만들지 않는다 (D-R18) */
export class OpsRangeDto {
  @ApiPropertyOptional({ ...S, description: '없으면 전체' }) from?: string | null;
  @ApiPropertyOptional(S) to?: string | null;
  @ApiProperty({ description: '「전체」 · 「2026-09-19」 · 「2026-09-14 ~ 2026-09-20」 · 「2026년 9월」' })
  label!: string;
}

/** 칩 하나 — 키 · 이름 · 건수 */
export class OpsCountDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() count!: number;
}

export class OpsAreaCountDto extends OpsCountDto {}

/** 시간표 쓰기가 돌려주는 불가 시간 줄 — 모양은 schedule 모듈의 것과 같다 */
export class UnavWarnLiteDto {
  @ApiProperty() date!: string;
  @ApiProperty() teacherName!: string;
  @ApiProperty() startMin!: number;
  @ApiProperty() endMin!: number;
  @ApiProperty() reason!: string;
}

export class OpsDto {
  @ApiProperty({ type: [LeadDto] }) leads!: LeadDto[];
  @ApiProperty({ type: [ComplaintDto] }) complaints!: ComplaintDto[];
  @ApiProperty({ type: [TodoDto] }) todos!: TodoDto[];
  @ApiProperty({ type: [PlanDto] }) plans!: PlanDto[];
  @ApiProperty({ type: [PlanStageDto], description: '§61 칸 다섯의 이름 — 빈 칸도 이름을 갖는다 (D-R18)' })
  planStages!: PlanStageDto[];
  @ApiProperty({ type: [CplStageDto], description: '§67 칸 셋의 이름과 한 줄 (D-R18 · D-R25)' })
  cplStages!: CplStageDto[];
  @ApiProperty({ type: [CplWordDto], description: '갈래 다섯 — 「+ 접수」 폼과 칩 줄의 낱말 (D-R18 · C93)' })
  cplAreas!: CplWordDto[];
  @ApiProperty({ type: [CplWordDto], description: '심각도 셋 — 가벼움 · 보통 · 심각 (원본 §67 · C93)' })
  cplSeverities!: CplWordDto[];
  @ApiPropertyOptional({ type: [CplWordDto], description: '문의자 관계 둘 — 어머니 · 아버지 (원본 §67 카드 · §29 「누가 요청」 · wave 6 67-5). 「+ 접수」·처리 창의 낱말' })
  cplRequesters?: CplWordDto[];
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
  @ApiProperty({ type: IntakeHeadDto, description: '§23 상담 머리 — 퍼널 · 담당 · 경고. 화면은 세지 않는다 (D-R37)' })
  intakeHead!: IntakeHeadDto;
  @ApiProperty({ type: OpsRangeDto, description: '지금 보고 있는 기간 — 낱말도 서버가 만든다 (C96 · D-R18)' })
  range!: OpsRangeDto;
  @ApiProperty({ type: [OpsAreaCountDto], description: '§67 갈래 칩 줄의 건수 — 서버가 센다. 0건 갈래도 선다(어휘이지 데이터가 아니다 · C66)' })
  areaCounts!: OpsAreaCountDto[];
  @ApiProperty({ type: [OpsCountDto], description: '§63 회의 종류 칩 줄의 건수 — 서버가 센다 (D-R37)' })
  mtTypeCounts!: OpsCountDto[];
  @ApiProperty({ type: [OpsCountDto], description: '§64 열린 할 일의 담당 칩. key는 담당 ID 문자열 또는 __none__. 같은 이름도 별도 ID로 구분' })
  todoOwnerCounts!: OpsCountDto[];
  @ApiProperty({ type: [OpsCountDto], description: '§64 끝난 할 일의 담당 칩. key는 담당 ID 문자열 또는 __none__' })
  todoDoneOwnerCounts!: OpsCountDto[];
  @ApiProperty({ type: [CplWordDto], description: '회의 종류 다섯 — 「+ 회의 잡기」 폼의 낱말 (D-R18 · C96)' })
  mtTypes!: CplWordDto[];
  @ApiProperty({ description: '「+ 회의 잡기」가 서는가 — 단추도 서버가 정한다 (D-R39)' }) canCreateMeeting!: boolean;
  @ApiProperty({ description: '「+ 기획 올리기」가 서는가 (D-R39)' }) canCreatePlan!: boolean;

  /* w5 · g6 C-4 · 67-2 · 63-5 · 63-6 — 탭 동그라미와 머리 칩의 수. 화면이 목록을 다시 세지 않는다 (D-R37).
     서버는 언제나 채운다. 선택 칸으로 둔 까닭은 이 응답을 표본으로 쓰는 **다른 화면(상담)의 시험**이 이 넷을 모른 채
     컴파일되게 하려는 것이다 — 읽는 쪽(운영 화면)은 없으면 0 으로 읽지 않고 동그라미를 세우지 않는다. */
  @ApiPropertyOptional({ type: Number, description: '기한 지난 컴플레인 — 열린 건만 · 갈래 칩과 무관(같은 기간) · §67 「기한 지남 N」과 컴플레인 탭 동그라미' })
  cplOverdue?: number;
  @ApiPropertyOptional({ type: Number, description: '대표 손이 가야 할 기획 — 검토 요청 + 보완 요청 (§61 「단계 보드」 동그라미와 기획 탭 동그라미)' })
  planPending?: number;
  @ApiPropertyOptional({ type: Number, description: '내가 아직 답하지 않은 회의 수 — 원본 §63 「내 응답 대기 N」. 응답은 본인이 §66 회의 상세에서 한다 (N-32 · W11)' })
  mtMyWaiting?: number;
  @ApiPropertyOptional({ type: Number, description: '속기록을 쓴 회의 수 — 원본 §63 「54회 · 속기록 32」의 뒤 수 (같은 기간)' })
  mtMinutesCount?: number;
  @ApiPropertyOptional({
    type: Number,
    description: '회의 탭 동그라미 「손봐야 할 것」 — 이미 지난(날이 오늘보다 앞) 회의 중 속기록이 빈 수. 날짜 없는 옛 회의는 세지 않는다 (N-96 · W11)',
  })
  mtNeedsMinutes?: number;
  @ApiPropertyOptional({ type: () => [PlanShareWordDto], description: '기획 공개 범위 두 값의 낱말 — 「+ 기획 올리기」·§65 고르기 칸 (N-72 · D-R18)' })
  planShares?: PlanShareWordDto[];

  /* x5 · g6 59-3 · 59-4 · 59-5 — §59 마케팅. 수와 낱말은 서버가 만든다 (D-R37 · D-R18). 선택 칸인 까닭은 위 넷과 같다. */
  @ApiPropertyOptional({ type: [CplWordDto], description: '「+ 오늘 한 것」 폼의 채널 — 원문 컷의 넷(카카오채널 · 네이버 광고 · 인스타그램 · 네이버 블로그 · W11 N-29 ①)' })
  mktChannels?: CplWordDto[];
  @ApiPropertyOptional({ type: [CplWordDto], description: '「+ 오늘 한 것」 폼의 항목 — 원문 컷의 넷(댓글·응대 · 광고 집행 · 릴스·영상 · 글 발행) · 채널과 따로 고른다' })
  mktItems?: CplWordDto[];
  @ApiPropertyOptional({ type: Boolean, description: '「+ 오늘 한 것」이 서는가 — 단추도 서버가 정한다 (D-R39)' })
  canCreateMarketing?: boolean;
  @ApiPropertyOptional({ type: [OpsCountDto], description: '§59 「어디에」 — 고른 기간의 채널별 활동 수. 건수가 있는 채널만(원문 띠) · 많은 순' })
  mktChannelCounts?: OpsCountDto[];
  @ApiPropertyOptional({ type: [OpsCountDto], description: '§59 「누가」 — 고른 기간의 담당별 활동 수. key 는 담당 ID 또는 __none__ · 많은 순' })
  mktByCounts?: OpsCountDto[];
  @ApiPropertyOptional({ type: [OpsCountDto], description: '§59 머리 오른쪽 항목 범례 — 고른 기간의 항목별 활동 수 · 많은 순' })
  mktItemCounts?: OpsCountDto[];
  @ApiPropertyOptional({ type: Number, description: '§59 머리 「N건 · M일 진행」의 M — 고른 기간에 활동이 있었던 날 수' })
  mktDays?: number;
}

/**
 * 「+ 회의 잡기」 (원본 §63 · N-46 ①).
 *
 * 시각·자리를 `mtrec` 에 적지 않는다 — 서버가 **시간표에 하루짜리 회차를 만들고** 그 회차에 회의를 건다.
 * 그래야 「11:00–12:00」도 「1호」도 「온라인 TN」도 한 곳에서 나오고, 겹침을 `ser_occ` 의 EXCLUDE 가 막는다.
 */
export class MeetingCreateDto {
  @ApiProperty({ enum: [...MT_TYPES], description: '회의 종류 다섯 — 낱말은 GET /ops.mtTypes' })
  @IsIn([...MT_TYPES], { message: '회의 종류는 기획 · 컨설팅 · 마케팅 · 개발 · 일반 중 하나입니다' })
  mtType!: string;

  @ApiPropertyOptional({ ...S, maxLength: 120, description: '제목 — 없으면 종류 이름으로 부른다' })
  @IsOptional() @IsString() @MaxLength(120)
  title?: string | null;

  @ApiProperty({ ...DATE_SCHEMA, description: '언제' })
  @IsCalendarDate()
  onDate!: string;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1440, description: '시작 분 (0~1440)' })
  @IsInt() @Min(0) @Max(1440)
  startMin!: number;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1440, description: '끝 분 — 시작보다 뒤' })
  @IsInt() @Min(0) @Max(1440)
  endMin!: number;

  @ApiProperty({ enum: ['offline', 'online'], description: '현장이면 강의실, 온라인이면 줌 계정' })
  @IsIn(['offline', 'online'], { message: '현장 또는 온라인입니다' })
  mode!: string;

  @ApiPropertyOptional({ ...N, description: '강의실 — 현장일 때' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  roomId?: number | null;

  @ApiPropertyOptional({ ...N, description: '줌 계정 — 온라인일 때. 겹치면 시간표가 막는다' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  zaccId?: number | null;

  @ApiPropertyOptional({ ...N, description: '주관자 — 없으면 나. 시간표의 「강사」 자리라 이 사람이 겹치면 막힌다' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  ownerId?: number | null;

  @ApiPropertyOptional({ type: [Number], description: '참석자 — 답하기 전에는 「응답 대기」다 (C57)' })
  @IsOptional() @IsArray() @ArrayMaxSize(50)
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(Number.MAX_SAFE_INTEGER, { each: true })
  attendeeIds?: number[];
}

/**
 * 「+ 기획 올리기」 (원본 §61 · N-46 ①).
 *
 * **단계를 받지 않는다** — 올린 기획은 언제나 첫 단계다. 화면이 단계를 정하면 전이표가 두 벌이 되고,
 * 기한도 **제안**일 뿐이라 `due_approved_at` 은 비어 있다(대표가 승인해야 최종 승인이 열린다 · C56).
 */
export class PlanCreateDto {
  @ApiProperty({ maxLength: 120 })
  @IsString() @MinLength(1, { message: '제목을 적어 주세요' }) @MaxLength(120)
  title!: string;

  @ApiPropertyOptional({ ...S, maxLength: 2000, description: '무엇을 이루려는가' })
  @IsOptional() @IsString() @MaxLength(2000)
  goal?: string | null;

  @ApiPropertyOptional({ ...S, maxLength: 2000, description: '무엇이 필요한가' })
  @IsOptional() @IsString() @MaxLength(2000)
  ask?: string | null;

  @ApiPropertyOptional({ ...N, description: '담당 — 없으면 나' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  ownerId?: number | null;

  @ApiPropertyOptional({ ...S, description: '기한 제안 — 대표가 승인해야 최종 승인이 열린다 (C56)' })
  @IsOptional() @IsCalendarDate()
  dueOn?: string | null;

  /** 공개 범위 (N-72) — 원문 두 값. 안 보내면 전체 공개다(NULL 은 옛 기획만의 자리) */
  @ApiPropertyOptional({ enum: [...PLAN_SHARES], description: '공개 범위 — 없으면 all(전체 공개)' })
  @IsOptional() @IsIn([...PLAN_SHARES], { message: '공개 범위는 전체 공개 또는 지정 공개입니다' })
  share?: string;

  @ApiPropertyOptional({ type: [Number], description: '지정 공개로 볼 사람 — 지정 공개일 때만(활동 중인 구성원)' })
  @IsOptional() @IsArray() @ArrayMaxSize(50)
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(Number.MAX_SAFE_INTEGER, { each: true })
  pickIds?: number[];
}

/**
 * `GET /ops` 의 기간·갈래 (N-46 ② · J-102).
 *
 * **검색 인자는 두지 않는다** — §24 FQ 는 받은 목록에서 거르고 추가 GET 이 0회라는 규약 그대로다.
 * 여기서 받는 것은 **얼마나 가져올지**뿐이다.
 */
export class OpsQueryDto {
  @ApiPropertyOptional({ ...DATE_SCHEMA, description: '이 날부터 — `to` 와 짝이다' })
  @IsOptional() @IsCalendarDate()
  from?: string;

  @ApiPropertyOptional({ ...DATE_SCHEMA, description: '이 날까지' })
  @IsOptional() @IsCalendarDate()
  to?: string;

  @ApiPropertyOptional({ enum: [...CPL_AREAS], description: '§67 갈래로 좁히기' })
  @IsOptional() @IsIn([...CPL_AREAS], { message: '갈래는 수업 · 상담 · 교재 · 스케줄 · 선생님 중 하나입니다' })
  area?: string;
}

/** 회의를 잡은 결과 — 시간표에 생긴 회차까지 함께 돌려준다 */
export class MeetingCreateResultDto {
  @ApiProperty({ type: MeetingDto }) meeting!: MeetingDto;
  @ApiProperty({ description: '만든 참석자 줄 수 — 전부 「응답 대기」다' }) attendees!: number;
  @ApiProperty({ type: [UnavWarnLiteDto], description: '막지 않고 알린다 — 주관자가 못 한다고 적어 둔 시간에 걸쳤다 (C84-c)' })
  unavailable!: UnavWarnLiteDto[];
}

/** 기획을 올린 결과 */
export class PlanCreateResultDto {
  @ApiProperty({ type: PlanDto }) plan!: PlanDto;
}
