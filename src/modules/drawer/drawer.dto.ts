/** @file-guide
 * 목적: drawer.dto.ts — REQ_DECISIONS, ApRowDto, ReqReviewDto, ChreqReviewDto, ReqReviewResultDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
// 여기서 다시 적었다가 DB(time_move)·읽기 DTO(time)·쓰기 검증(off)이 세 벌로 갈렸다.
import { KIND_GROUPS } from '../../lib/catalog-words';
import { CHREQ_TYPES } from '../../lib/change-request';
import {
  APPROVAL_FLOW_KINDS, APPROVAL_FLOW_RECIPIENT_LABELS,
  APPROVAL_FLOW_RECIPIENT_NAMES, APPROVAL_FLOW_RECIPIENTS,
} from '../../lib/approval';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

/** §14 처리의 두 갈래 — 낱말의 출처는 여기 하나다 */
export const REQ_DECISIONS = ['approve', 'reject'] as const;

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;

/** §14 · §75 결재 한 줄 — 공통 5종과 강사 리포트가 같은 모양으로 온다 (D-R26 · D-R34) */
export class ApRowDto {
  @ApiProperty({ enum: ['rep', 'rpt', 'plan', 'req', 'chreq', 'gpapack', 'suggestion', 'missing'] }) kind!: string;
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiPropertyOptional(S) sub?: string | null;
  @ApiPropertyOptional(N) byId?: number | null;
  @ApiPropertyOptional(S) byName?: string | null;
  @ApiProperty() at!: string;
  @ApiProperty({ enum: ['waiting', 'back', 'done'] }) state!: string;
  @ApiPropertyOptional({ ...S, description: '반려면 반드시 있다 (D-R13)' }) why?: string | null;
  @ApiProperty({ description: '누르면 갈 곳 — §75 결재 흐름은 여전히 이동만 한다 (D-R27)' }) go!: string;

  @ApiPropertyOptional({ ...S, description: 'REQ 갈래의 요청 종류 (wage_change · tz_change …)' })
  reqType?: string | null;

  @ApiPropertyOptional({ ...S, description: '무엇을 바라는가 — 서버가 만든 문장을 그대로 그린다 (D-R18)' })
  asked?: string | null;

  @ApiPropertyOptional({
    type: Boolean,
    description: '이 사람이 **지금** 이 줄을 여기서 처리할 수 있는가 (§14). 화면은 이 값만 보고 단추를 그린다',
  })
  canAct?: boolean;

  @ApiProperty({
    enum: ['schedule_change', 'book_change', 'tz_change', 'wage_change', 'suggestion', 'gpa_request', 'missing', 'other'],
    description: '§14 필터 분류 — 서버 코드표가 정한다',
  })
  category!: string;

  @ApiProperty({ description: '§14 필터 이름 — 화면에 코드표를 복제하지 않는다' })
  categoryLabel!: string;
}

export class ApCategoryDto {
  @ApiProperty({
    enum: ['schedule_change', 'book_change', 'tz_change', 'wage_change', 'suggestion', 'gpa_request', 'missing', 'other'],
  })
  key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() count!: number;
}

/**
 * §14 승인 대기함의 처리 — 승인 또는 반려.
 *
 * 반려는 **사유가 필수**다 (D-R13). 사유 없는 반려는 올린 사람이 무엇을 고쳐야 할지
 * 알 수 없어 같은 요청이 그대로 다시 올라온다.
 */
export class ReqReviewDto {
  @ApiProperty({ enum: REQ_DECISIONS, description: '승인(approve) 또는 반려(reject)' })
  @IsIn(REQ_DECISIONS)
  decision!: (typeof REQ_DECISIONS)[number];

  @ApiPropertyOptional({ ...S, description: '반려 사유 — 반려면 필수 (D-R13)' })
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

/**
 * §20 변경 요청 반영·반려 (C42).
 *
 * 「승인」이 아니라 **「반영」**이다 — 원문 §20 의 탭이 「확인 대기 · 반영 · 반려 · 전체」이고,
 * 반영하면 상태만 바뀌는 것이 아니라 **시간표가 실제로 바뀐다**.
 */
export class ChreqReviewDto {
  @ApiProperty({ enum: REQ_DECISIONS, description: '반영(approve) 또는 반려(reject)' })
  @IsIn(REQ_DECISIONS)
  decision!: (typeof REQ_DECISIONS)[number];

  @ApiPropertyOptional({ ...S, description: '반려 사유 — 반려면 필수 (D-R13). 신청 사유를 덮어쓰지 않는다' })
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

export class ReqReviewResultDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: ['approved', 'rejected'] }) state!: string;
  @ApiPropertyOptional({
    ...S,
    description: '승인이 **실제로 바꾼 것** — 「45,000원/시간 · 2026-09-12부터」처럼. 적용 대상이 없으면 null',
  })
  applied!: string | null;
}

export class ApFlowDto {
  @ApiProperty({ type: [ApRowDto], description: '되돌아온 것 — 맨 위 (§75)' }) back!: ApRowDto[];
  @ApiProperty({ type: [ApRowDto], description: '기다리는 것' }) waiting!: ApRowDto[];
  @ApiProperty({ type: [ApRowDto], description: '내가 올린 것' }) mine!: ApRowDto[];
  @ApiProperty({ type: [ApRowDto], description: '§14에 실제로 보이는 미처리 요청·건의·GPA·누락' }) inbox!: ApRowDto[];
  @ApiProperty({ type: [ApCategoryDto], description: '§14 원문 순서의 필터와 DB 기반 건수' })
  categories!: ApCategoryDto[];
  @ApiProperty({ description: '§75 결재 흐름 배지 — 되돌아온 것 + 기다리는 것' }) count!: number;
  @ApiProperty({ description: '§14 승인 대기함 배지 — inbox와 같은 배열의 길이' }) inboxCount!: number;
  @ApiProperty({ type: [String], description: '아직 표가 없어 못 세는 갈래 (N-13 대기)' })
  missingKinds!: string[];
}

/** §75 중앙 결재 흐름 한 줄. §14 ApRowDto와 다른 전용 projection이다. */
export class ApprovalFlowItemDto {
  @ApiProperty({ enum: APPROVAL_FLOW_KINDS }) kind!: (typeof APPROVAL_FLOW_KINDS)[number];
  @ApiProperty({ description: '원문 타일·행의 공통 종류 이름' }) kindLabel!: string;
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiProperty(S) sub!: string | null;
  @ApiProperty(N) byId!: number | null;
  @ApiProperty({ description: '올린 사람. RPT 제출자 FK가 없으면 `알 수 없음`' }) byName!: string;
  @ApiProperty({ enum: APPROVAL_FLOW_RECIPIENTS }) to!: (typeof APPROVAL_FLOW_RECIPIENTS)[number];
  @ApiProperty({ enum: APPROVAL_FLOW_RECIPIENT_NAMES, description: "행의 '발신자 → 수신자'에 쓰는 조사 없는 이름" }) toName!: string;
  @ApiProperty({ enum: APPROVAL_FLOW_RECIPIENT_LABELS }) toLabel!: string;
  @ApiProperty() at!: string;
  @ApiProperty({ enum: ['back', 'waiting', 'mine'] }) state!: 'back' | 'waiting' | 'mine';
  @ApiProperty({ ...S, description: '반려 사유. PLAN은 append-only LOG.after.reason에서 복원' }) why!: string | null;
  @ApiProperty({ description: '승인·반려 없이 원본 레코드로 이동할 deep link' }) go!: string;
}

export class ApprovalFlowTileDto {
  @ApiProperty({ enum: APPROVAL_FLOW_KINDS }) kind!: (typeof APPROVAL_FLOW_KINDS)[number];
  @ApiProperty() kindLabel!: string;
  @ApiProperty({ enum: APPROVAL_FLOW_RECIPIENTS }) to!: (typeof APPROVAL_FLOW_RECIPIENTS)[number];
  @ApiProperty({ enum: APPROVAL_FLOW_RECIPIENT_LABELS }) toLabel!: string;
  @ApiProperty({ description: '현재 사용자에게 보이는 waiting 행 수' }) count!: number;
}

export class ApprovalFlowDto {
  @ApiProperty({ description: '§75 트리거·데이터 표시 가능여부의 서버 판정' }) canView!: boolean;
  @ApiProperty({ type: [ApprovalFlowTileDto], description: '원문 순서 exact 5종. 강사는 빈 배열' }) tiles!: ApprovalFlowTileDto[];
  @ApiProperty({ type: [ApprovalFlowItemDto], description: '돌아온 건 — 맨 위' }) back!: ApprovalFlowItemDto[];
  @ApiProperty({ type: [ApprovalFlowItemDto], description: '기다리는 건' }) waiting!: ApprovalFlowItemDto[];
  @ApiProperty({ type: [ApprovalFlowItemDto], description: '내가 올린 건' }) mine!: ApprovalFlowItemDto[];
  @ApiProperty({ description: '지금 대기 건수. waiting.length와 같음' }) total!: number;
  @ApiProperty({ description: '돌아온 건수. back.length와 같음' }) backCount!: number;
}

/** §15 할 일 */
export class DrawerTodoDto {
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiPropertyOptional(S) fromName?: string | null;
  @ApiPropertyOptional(S) toName?: string | null;
  @ApiPropertyOptional(N) fromId?: number | null;
  @ApiPropertyOptional(N) toId?: number | null;
  @ApiPropertyOptional(S) dueOn?: string | null;
  @ApiProperty() done!: boolean;
  @ApiProperty({ enum: ['meeting', 'complaint', 'consulting', 'plan', 'manual'] }) src!: string;
  @ApiProperty({ description: '출처 이름 — 서버 코드표가 정한다 (D-R18)' }) srcLabel!: string;
  @ApiProperty({ description: '기한이 지난 날 수. 0이면 안 지남' }) overdueDays!: number;
  @ApiPropertyOptional({ ...S, description: '출처가 있으면 원본으로 갈 곳' }) go?: string | null;
}

/** §16 알림 */
/** 서랍 조회 옵션 — 알림의 **보이는 범위**만 정한다 (D-16: 삭제가 아니다) */
export class DrawerQueryDto {
  @ApiPropertyOptional({ enum: ['month', 'all'], description: '기본 month(최근 30일). all 이면 보관된 전부' })
  @IsOptional() @IsIn(['month', 'all'])
  notiWindow?: 'month' | 'all';
}

export class NotiReadAllDto {
  @ApiProperty() ok!: true;
  @ApiProperty({ description: '이번에 읽음으로 바뀐 수' }) marked!: number;
}

export class NotiDto {
  @ApiProperty() id!: number;
  @ApiProperty() body!: string;
  @ApiPropertyOptional(S) fromName?: string | null;
  @ApiPropertyOptional(N) toId?: number | null;
  @ApiPropertyOptional(S) link?: string | null;
  @ApiProperty() read!: boolean;
  @ApiProperty() at!: string;
  @ApiProperty({
    enum: ['alarm', 'ok', 'warn'],
    description: '표에 색 컬럼이 없어 링크로 파생한다 — lib/noti.ts 한 곳에서만',
  })
  tone!: string;
  @ApiProperty({
    enum: ['report_due', 're_alarm', 'report', 'schedule', 'request', 'etc'],
    description: '§16 분류 칩. NOTI.category가 정본이며 과거 null 행만 링크 fallback을 쓴다',
  })
  category!: string;
  @ApiProperty({ description: '분류 이름 — 코드표는 서버가 소유한다 (D-R18)' }) categoryLabel!: string;
}

export class NotiCategoryDto {
  @ApiProperty({ enum: ['report_due', 're_alarm', 'report', 'schedule', 'request', 'etc'] }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() count!: number;
}

/** §17 구성원 · 시간대 */
export class MemberDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ['teacher', 'manager', 'admin', 'ceo'] }) role!: string;
  @ApiPropertyOptional({ ...S, description: '직함은 권한이 아니다 (D-R39)' }) title?: string | null;
  @ApiPropertyOptional(S) tz?: string | null;
  @ApiProperty() active!: boolean;
}

/**
 * §17 묶음 — **서버가 묶고 서버가 센다.**
 *
 * 「강사 13」의 13 은 세는 일이고(D-R37), 화면에서 역할을 비교하면 같은 모양이 한 줄 옆으로
 * 가는 순간 권한 판정이 된다(D-R39 · eslint 가 막는다). 그래서 묶음째 내려보낸다.
 */
export class MemberGroupDto {
  @ApiProperty({ description: '역할 코드값 — 색·차례를 고르는 열쇠일 뿐 판정이 아니다' }) role!: string;
  @ApiProperty({ description: '묶음 머리의 이름 — 「강사」·「매니저」…' }) label!: string;
  @ApiProperty({ description: '인원. `members.length` 와 **같은 배열**에서 나온다' }) count!: number;
  @ApiProperty({ type: [MemberDto] }) members!: MemberDto[];
}

export class TzGroupDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiProperty() tz!: string;
}

/** §18 프로그램 · 과목 */
export class KindRowDto {
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty() color!: string;
  @ApiProperty({ description: '정원' }) cap!: number;
  @ApiProperty({ enum: KIND_GROUPS }) grp!: string;
  /* 서랍이 화면에 코드표를 다시 적고 있었고 그 표가 원문과 달랐다 — 「상담」/「상담·진단」 (C48 · D-R18) */
  @ApiProperty({ description: '묶음 이름 — 낱말은 서버가 만든다 (D-R18)' }) grpLabel!: string;
  @ApiProperty({ description: 'true 인 종류만 리포트 대상 (D-R6)' }) rep!: boolean;
}

/** §20 변경 요청 이력 */
export class ChangeReqDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: CHREQ_TYPES }) reqType!: (typeof CHREQ_TYPES)[number];
  @ApiProperty() serId!: number;
  @ApiProperty() onDate!: string;
  @ApiProperty({ description: '올린 사람이 적은 **신청** 사유 — 반려해도 지워지지 않는다 (v4.18)' })
  reason!: string;
  @ApiPropertyOptional({ ...S, description: '반려 사유 (D-R13). 옛 행은 없을 수 있다' })
  rejectReason?: string | null;
  @ApiProperty() state!: string;
  @ApiPropertyOptional(S) byName?: string | null;
  @ApiPropertyOptional({ ...S, description: '무엇을 바꿔 달라는가 — 「강사 → KJ」 (§20 이력 줄 · D-R18)' })
  asked?: string | null;
  @ApiProperty({ description: '선택 회차부터 이후 전체 적용' }) applyAll!: boolean;
  @ApiProperty() at!: string;
}

/** §21 줌 계정 — 로그인 정보는 **절대 내려보내지 않는다** */
export class ZoomAccountDto {
  @ApiProperty() id!: number;
  @ApiProperty() label!: string;
  @ApiPropertyOptional({ ...S, description: '학생 참가 링크. 로그인 정보와 같은 화면에 두지 않는다' })
  joinUrl?: string | null;
  @ApiProperty() active!: boolean;
  @ApiProperty({ description: '이 계정이 잡고 있는 회차 수' }) assigned!: number;
  @ApiProperty({ description: '같은 시간에 두 수업에 배정된 건수 — 0이어야 한다' }) overlaps!: number;
}

/** 개발명세서 공용 「할 일」 바의 한 도메인 — 건수와 문구는 서버가 만든다. */
export class WorkSummaryItemDto {
  @ApiProperty({ enum: ['schedule', 'consulting', 'accounting', 'books', 'guides', 'zoom'] }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() count!: number;
  @ApiProperty() go!: string;
}

/** 도메인별 미처리 건수의 단일 진실원. 화면은 합계나 분류를 다시 세지 않는다. */
export class WorkSummaryDto {
  @ApiProperty() total!: number;
  @ApiProperty({ description: '즉시 확인 대상 — 승인 대기 + 기한 초과, total 이하' }) now!: number;
  @ApiProperty({ type: [WorkSummaryItemDto] }) items!: WorkSummaryItemDto[];
}

/** 서랍 하나가 여덟 칸을 함께 내려준다 — 열 때마다 여덟 번 왕복하지 않는다 */
export class DrawerDto {
  @ApiProperty({ type: ApFlowDto, description: '§14 승인 대기함' }) approvals!: ApFlowDto;
  @ApiProperty({ type: ApprovalFlowDto, description: '§75 exact 5종 읽기·이동 전용 중앙 결재 흐름' })
  approvalFlow!: ApprovalFlowDto;
  @ApiProperty({ type: [DrawerTodoDto], description: '§15 할 일' }) todos!: DrawerTodoDto[];
  @ApiProperty({ type: [NotiDto], description: '§16 알림 — 기본은 최근 30일 (D-16: 조회 범위 제한이지 삭제가 아니다)' }) notis!: NotiDto[];
  @ApiProperty({ type: [NotiCategoryDto], description: '§16 원문 순서의 분류와 현재 조회 창 건수' })
  notiCategories!: NotiCategoryDto[];
  @ApiProperty({ description: '목록에 보이는 기간(일). notiWindow=all 이면 0' }) notiWindowDays!: number;
  @ApiProperty({ description: '창 밖에 남아 있는 알림 수 — **지운 것이 아니다** (N-7 영구 보관)' }) notiOlderCount!: number;
  @ApiProperty({ type: [MemberDto], description: '§17 구성원 — 묶지 않은 전체 (다른 화면이 쓴다)' }) members!: MemberDto[];
  @ApiProperty({ type: [MemberGroupDto], description: '§17 역할 묶음 — 사람이 없는 역할은 빠진다' }) memberGroups!: MemberGroupDto[];
  @ApiProperty({ type: [TzGroupDto], description: '§17 시간대 그룹' }) tzGroups!: TzGroupDto[];
  @ApiProperty({ type: [KindRowDto], description: '§18 수업 종류' }) kinds!: KindRowDto[];
  @ApiProperty({ type: [ChangeReqDto], description: '§20 변경 요청' }) changeReqs!: ChangeReqDto[];
  @ApiProperty({ type: [ZoomAccountDto], description: '§21 줌 계정' }) zoomAccounts!: ZoomAccountDto[];
  @ApiProperty({ type: WorkSummaryDto, description: '§38~§41 등 관리자 화면 공용 할 일 요약' }) workSummary!: WorkSummaryDto;
  @ApiProperty({ description: '관리자 화면의 모든 시각은 KST 다 (D-R12)' }) tz!: string;
}

/* ══ 쓰기 ═══════════════════════════════════════════════════════════════
   서랍에서 하는 것은 **넣기와 표시뿐**이다. 승인·반려는 그 화면에서 한다 (D-R27). */


export class TodoDoneDto {
  @ApiProperty({ description: '완료로 바꿀지 여부' })
  @IsBoolean()
  done!: boolean;
}

/** §15 수동 할 일 만들기. 출처 연결 할 일은 각 도메인의 전용 API가 만든다. */
export class TodoCreateDto {
  @ApiProperty({ maxLength: 160 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(160)
  title!: string;

  @ApiPropertyOptional({ minimum: 1, description: '생략하면 나에게 배정. 다른 사람 배정은 canCrudAll만' })
  @IsOptional() @IsInt() @Min(1)
  toId?: number;

  @ApiPropertyOptional({ example: '2026-09-14', description: 'KST 기준 기한' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dueOn?: string;
}

export class TodoCreateResultDto {
  @ApiProperty() id!: number;
}

export class TodoClearDto {
  @ApiProperty() ok!: true;
  @ApiProperty({ description: '이번에 삭제된 완료 할 일 수' }) deleted!: number;
}

/** 종류별 Swagger 모델이 공유하는 회차 대상. 실제 검증도 ChangeReqCreateDto가 같은 필드를 쓴다. */
export class ChangeReqTargetDto {
  @ApiProperty({ minimum: 1, description: '변경할 수업 규칙 id' })
  @IsInt() @Min(1)
  serId!: number;

  @ApiProperty({ example: '2026-09-01', description: '변경 기준 회차 날짜' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  onDate!: string;

  @ApiProperty({ maxLength: 500, description: '판단 근거. 공백만 보낼 수 없다' })
  // trim 뒤 길이·공백 판정은 normalizeChangeRequest() 한 곳에서 한다.
  @IsString()
  reason!: string;

  @ApiPropertyOptional({ description: '선택 회차부터 이후 전체 적용 (D-R16)' })
  @IsOptional() @IsBoolean()
  applyAll?: boolean;
}

export class TimeMoveChangeReqDto extends ChangeReqTargetDto {
  @ApiProperty({ enum: ['time_move'] }) reqType!: 'time_move';
  @ApiProperty({ minimum: 0, maximum: 1439 }) startMin!: number;
  @ApiProperty({ minimum: 10, maximum: 1440 }) endMin!: number;
}

export class TeacherChangeReqDto extends ChangeReqTargetDto {
  @ApiProperty({ enum: ['teacher'] }) reqType!: 'teacher';
  @ApiProperty({ minimum: 1 }) teacherId!: number;
}

export class RoomChangeReqDto extends ChangeReqTargetDto {
  @ApiProperty({ enum: ['room'] }) reqType!: 'room';
  @ApiProperty({ minimum: 1 }) roomId!: number;
}

export class ZoomChangeReqDto extends ChangeReqTargetDto {
  @ApiProperty({ enum: ['room'], description: '온라인 수업 자원 변경도 room 요청으로 저장한다' })
  reqType!: 'room';
  @ApiProperty({ minimum: 1 }) zaccId!: number;
}

export class CancelChangeReqDto extends ChangeReqTargetDto {
  @ApiProperty({ enum: ['cancel'] }) reqType!: 'cancel';
}

/**
 * 런타임 ValidationPipe용 합집합. OpenAPI 요청 본문은 위 다섯 모델의 oneOf로 공개한다.
 * 종류별 정확한 필드 조합은 normalizeChangeRequest()가 한 번 더 좁힌다.
 */
export class ChangeReqCreateDto extends ChangeReqTargetDto {
  @ApiProperty({ enum: CHREQ_TYPES, description: '수업을 바꿔 달라는 요청의 종류' })
  @IsIn(CHREQ_TYPES)
  reqType!: (typeof CHREQ_TYPES)[number];

  @ApiPropertyOptional({ minimum: 0, maximum: 1439 })
  @IsOptional() @IsInt() @Min(0) @Max(1439)
  startMin?: number;

  @ApiPropertyOptional({ minimum: 10, maximum: 1440 })
  @IsOptional() @IsInt() @Min(10) @Max(1440)
  endMin?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional() @IsInt() @Min(1)
  teacherId?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional() @IsInt() @Min(1)
  roomId?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional() @IsInt() @Min(1)
  zaccId?: number;
}

/** §19 겹침 미리보기 한 줄 — 막는 것은 DB, 설명은 이것 */
export class ConflictRowDto {
  @ApiProperty() serId!: number;
  @ApiProperty() onDate!: string;
  @ApiProperty() startMin!: number;
  @ApiProperty() endMin!: number;
  @ApiPropertyOptional(S) title?: string | null;
  @ApiProperty({ enum: ['teacher', 'room', 'zoom'], description: '무엇이 겹치는가' }) with!: string;
  @ApiPropertyOptional({ ...S, description: '누구와 겹치는가 — 이름을 보여 준다' }) whoName?: string | null;
}

export class ChangeReqResultDto {
  @ApiPropertyOptional({ ...N, description: '만들어진 요청 id. 겹쳐서 막혔으면 없다' }) id?: number | null;
  @ApiProperty({ type: [ConflictRowDto], description: '비어 있지 않으면 제출이 막힌 것이다' })
  conflicts!: ConflictRowDto[];
}
