/** @file-guide
 * 목적: drawer.dto.ts — REQ_DECISIONS, ApRowDto, ReqReviewDto, ChreqReviewDto, StaffCreateDto, MemberDto 등 (dto)
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
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsObject, IsOptional,
  IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { DATE_SCHEMA, ID_SCHEMA, IsCalendarDate, ToHttpInteger } from '../../common/validation';
import { TODO_SRC_T_VALUES } from '../../entities/enums';
import { PhoneCountryDto } from '../../auth/dto/onboarding.dto';

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
    ...S,
    description: '올린 사람이 자기 말로 적은 사유 — §14 카드의 인용 줄. 적힌 것이 없거나 줄에 이미 보인 글과 같으면 null',
  })
  reason?: string | null;

  @ApiPropertyOptional({
    type: Boolean,
    description: '이 사람이 **지금** 이 줄을 여기서 처리할 수 있는가 (§14). 화면은 이 값만 보고 단추를 그린다',
  })
  canAct?: boolean;

  @ApiPropertyOptional({
    ...S,
    description: '처리하지 못하는 이유 — 할 수 있으면 null. 시급 요청은 `canWage` 까지 있어야 승인된다 (S5)',
  })
  actBlockedReason?: string | null;

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
  /*
   * N-84 결재 되돌리기 — 원문 §14 머리 「모든 처리는 되돌리기로 취소됩니다」. 본인 · 10분 · 그 처리 하나.
   * 필수 nullable 이다(선택으로 두면 시험 표본이 이 칸을 빠뜨린 채 조용히 낡는다). 되돌릴 길이 없는 처리는 null 이다 —
   * 없는 되돌리기를 약속하지 않는다. 줌 계정 갈래도 이제 토큰이 있다(앞 배정으로 · W11 A' 후속). 토큰은 그 처리의 감사 줄에
   * 묶여 **한 번만** 통한다 — 되돌린 뒤 다시 처리하면 옛 토큰은 409 다.
   */
  @ApiProperty({ ...S, description: '이 처리를 되돌리는 토큰 — 처리한 본인 · 10분. 되돌릴 길이 없는 처리면 null (N-84)' })
  undoToken!: string | null;
  @ApiProperty({ ...S, format: 'date-time', description: '토큰이 끝나는 시각(ISO) — 화면은 10분을 따로 들지 않고 이 값을 쓴다' })
  undoExpiresAt!: string | null;
}

/** N-84 결재 되돌리기 — 토큰 하나. 무엇을 어떻게 되돌릴지는 서명된 토큰과 DB 가 말한다(화면이 고르지 않는다) */
export class ApprovalUndoDto {
  @ApiProperty({ description: '승인·반려·반영 응답의 undoToken 그대로', maxLength: 200_000 })
  @IsString() @MinLength(1) @MaxLength(200_000)
  token!: string;
}

export class ApprovalUndoResultDto {
  @ApiProperty({ description: '되돌린 요청의 id' }) id!: number;
  @ApiProperty({ enum: ['req', 'chreq'], description: '요청(REQ) · 변경 요청(CHREQ)' }) target!: 'req' | 'chreq';
  @ApiProperty({ enum: ['pending'], description: '되돌린 뒤의 상태 — 다시 대기함에 선다' }) state!: 'pending';
  @ApiProperty({ description: '무엇을 되돌렸는지 한 줄 — 「시급 줄 삭제」 · 「시간대 되돌림」 · 「GPA 기록 삭제」 · 「시간표 되돌림」 · 「줌 계정 되돌림」 · 「상태만」' })
  reverted!: string;
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
  @ApiProperty({ enum: TODO_SRC_T_VALUES }) src!: string;
  @ApiProperty({ description: '출처 이름 — 서버 코드표가 정한다 (D-R18)' }) srcLabel!: string;
  @ApiProperty({ description: '기한이 지난 날 수. 0이면 안 지남' }) overdueDays!: number;
  @ApiPropertyOptional({ ...S, description: '출처가 있으면 원본으로 갈 곳 — 그 한 건을 여는 주소(회의 · 컴플레인 · 기획 · 컨설팅 · 상담 사후 관리 `/intake?lead=` · 수업). 운영 §64 와 같은 함수(lib/todo `todoGo`)' }) go?: string | null;
  @ApiProperty({
    description: '끝난 뒤 「끝난 것 지우기」가 이 줄을 지울 수 있는가 — 서버 판정. 상담 사후 관리(해피콜 · 월간 상담)는 완료 이력이라 false (W11 · N-86)',
  })
  clearable!: boolean;
  @ApiProperty({ ...S, description: '지우지 않는 까닭 — 서버 문장. 지울 수 있으면 null' })
  clearBlockedReason!: string | null;
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
  @ApiPropertyOptional({
    ...S,
    description: '§16 카드의 굵은 제목(NOTI.title). 제목 칸이 생기기 전 행과 제목을 안 적는 쓰기는 null — 그때는 본문이 한 줄이다',
  })
  title?: string | null;
  @ApiProperty() body!: string;
  @ApiPropertyOptional(S) fromName?: string | null;
  @ApiPropertyOptional({ ...S, description: '보낸 이의 역할 낱말(§16 메타 줄 · lib/role-words) — 시스템이 보낸 것은 null' })
  fromRoleLabel?: string | null;
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
  @ApiProperty({ description: '로그인 아이디 — 형식 자유(띄어쓰기만 없음) · 대소문자 무시 유일 (W10)' }) loginId!: string;
  @ApiProperty({ ...S, description: '이메일 — 연락 · 인증용(W10 부터 아이디가 아니다). 만들 때 비워 둘 수 있어 null 일 수 있다' })
  email!: string | null;
  @ApiProperty({ enum: ['teacher', 'manager', 'admin', 'ceo'] }) role!: string;
  @ApiPropertyOptional({ ...S, description: '직함은 권한이 아니다 (D-R39)' }) title?: string | null;
  @ApiPropertyOptional(S) tz?: string | null;
  @ApiProperty() active!: boolean;
  /* C97 · D-48 — 지금 시급. **canWage 가 아니면 null** (D-R39 · 응답에서 뺀다). 시급 줄이 없는 강사도 null — 화면은 「시급 없음」이라 적지 않고 「시급 수정」만 세운다 */
  @ApiPropertyOptional({ type: Number, nullable: true, description: '오늘 붙는 기본 시급(원/시간) — canWage 아니면 null · 시급 줄이 없으면 null · 시급 비공개(N-94)가 켜져 있고 비공개 열람(canHide)이 없으면 남의 줄은 null' })
  wageRate?: number | null;
  @ApiPropertyOptional({ ...S, description: '그 시급의 적용 시작일 YYYY-MM-DD' }) wageFrom?: string | null;
  /* 「시급 수정」 단추가 서는 줄 — 강사이고 활성이며 보는 이가 canWage 일 때만. 화면은 role 을 보지 않고 이 값만 본다 (D-R39) */
  @ApiPropertyOptional({ description: '시급 줄을 둘 수 있는 사람인가 — 활성 강사 · canWage 아니면 false (C97 · D-R39)' })
  wageable?: boolean;

  /* ── W8 사용자 표 CRUD (대표 지시 2026-09-26) — 줄마다 **서버가** 가른다. 화면은 role 을 보지 않는다 (D-R39) ── */
  @ApiPropertyOptional({ description: '첫 설정(휴대폰 · 이메일 확인 · 새 비밀번호)을 아직 안 끝낸 계정 — 화면의 「첫 설정 전」 칩' })
  mustChangeCredentials?: boolean;
  @ApiPropertyOptional({ ...S, description: '휴대폰(한국은 숫자만 · 해외는 +국가번호…) — 전체를 다루는 사람(canCrudAll)에게만 싣는다. 그 밖에는 null' })
  phone?: string | null;
  @ApiPropertyOptional({ ...S, description: '입사일 YYYY-MM-DD — 「수정」 창의 처음 값. 옛 계정은 null 일 수 있다' })
  hiredOn?: string | null;
  @ApiPropertyOptional({ description: '「수정」 — 보는 이가 매니저 이상이고 이 줄이 강사·매니저일 때만 (대표·관리자 줄은 이 길로 못 고친다)' })
  canEdit?: boolean;
  @ApiPropertyOptional({ description: '수정 창에서 역할을 바꿀 수 있는가 — canEdit 이고 **자기 줄이 아닐 때만** (자기 역할은 못 바꾼다)' })
  canChangeRole?: boolean;
  @ApiPropertyOptional({ description: '「비밀번호 초기화」 — canEdit 이고 자기 줄이 아닐 때만 (자기 것은 첫 설정 흐름으로 바꾼다)' })
  canResetPassword?: boolean;
  @ApiPropertyOptional({ description: '「사용 중지」·「다시 사용」 — canEdit 이고 자기 줄이 아닐 때만' })
  canToggleActive?: boolean;
  @ApiPropertyOptional({ description: '「삭제」 — canEdit 이고 자기 줄이 아닐 때만. 기록이 있으면 서버가 409 로 막는다(사용 중지로 막는다)' })
  canDelete?: boolean;

  /* ── N-68 사람별 권한 예외 (W11) — 역할 넷은 그대로, 자리 차이는 사람마다 다섯 칸으로 ── */
  @ApiPropertyOptional({ description: '수정 창의 권한 예외 다섯 토글이 서는가 — 대표 판정(P1 동안 매니저 포함) · 강사·매니저 줄 · 자기 줄 아님' })
  canEditPerms?: boolean;
  @ApiPropertyOptional({
    type: () => [MemberPermDto], nullable: true,
    description: '권한 예외 다섯 칸의 지금 값 — 구성원을 다루는 사람(canAdminPage + canCrudAll)에게만 싣는다. 그 밖에는 null',
  })
  perms?: MemberPermDto[] | null;
}

/** 권한 예외 한 칸 — 켬(true) · 끔(false) · 역할 따름(null) */
export class MemberPermDto {
  @ApiProperty({ enum: ['canMoney', 'canWage', 'canApprove', 'canHide', 'canGpaPack'] }) key!: string;
  @ApiProperty({ description: '사람 낱말 — 「회계 권한」 등 · §76 표의 「누가」 칸과 같은 이름' }) label!: string;
  @ApiProperty({ type: Boolean, nullable: true, description: '적힌 예외 — true 켬 · false 끔 · null 역할 따름' }) override!: boolean | null;
  @ApiProperty({ description: '역할만으로 나오는 값 — 「역할 따름」이면 이 값이 된다' }) roleDefault!: boolean;
  @ApiProperty({ description: '지금 실제로 쓰이는 값 — 예외가 있으면 예외, 없으면 역할' }) effective!: boolean;
}

/** 새 구성원이 될 수 있는 역할 — 대표·관리자 계정은 이 길로 만들지 않는다(권한 상승 경로를 두지 않는다 · C97) */
export const STAFF_CREATE_ROLES = ['teacher', 'manager'] as const;

/** 이메일 칸 — 빈 글은 null(비움)로 받는다. 적었으면 앞뒤 공백 없이 소문자(W10) */
const emailOrNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? (value.trim().toLowerCase() || null) : value;

/**
 * §17 「+ 구성원」 (C97 · 테스트 시나리오 D-41 「신규 강사 등록」).
 * **아이디와 임시 비밀번호는 매니저가 정한다** (W10 · 대표 지시 2026-09-26 「매니저가 아이디 비번 만들면 db 에 저장 →
 * 초기 설정 시 주요 인증 및 비번 재설정」). 아이디는 형식 자유(띄어쓰기만 없음) · 이메일은 선택이다. 비밀번호는 해시로만
 * 저장하고 응답 · 기록에는 싣지 않는다 — 넘겨줄 비밀번호는 적은 화면만 안다. 첫 로그인 때 본인이 휴대폰 · 이메일을 확인하고 바꾼다.
 */
export class StaffCreateDto {
  @ApiProperty({ maxLength: 40 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1, { message: '이름을 적어 주세요' }) @MaxLength(40)
  name!: string;

  @ApiProperty({ example: 'kim.teacher', maxLength: 120, description: '로그인 아이디 — 형식 자유 · 띄어쓰기 없음 · 대소문자 무시 유일(W10). 규칙 문장은 서랍의 loginIdRule' })
  @IsString({ message: '아이디를 적어 주세요' }) @MaxLength(120, { message: '아이디는 120자까지입니다' })
  loginId!: string;

  @ApiProperty({ example: '********', maxLength: 200, description: '임시 비밀번호 — 매니저가 정해 넘겨준다(W10). 규칙은 서랍의 tempPasswordRule(첫 설정과 같은 규칙). 응답 · 기록에는 싣지 않는다' })
  @IsString({ message: '임시 비밀번호를 적어 주세요' }) @MaxLength(200, { message: '비밀번호가 너무 깁니다' })
  password!: string;

  @ApiPropertyOptional({ ...S, format: 'email', maxLength: 120, description: '이메일 — 선택(W10). 적으면 모양과 유일(대소문자 무시)을 본다. 첫 설정 때 본인이 적고 코드로 확인한다' })
  @Transform(emailOrNull)
  @ValidateIf((_o, v) => v !== undefined && v !== null) @IsEmail({}, { message: '이메일 형식이 아닙니다' }) @MaxLength(120)
  email?: string | null;

  @ApiProperty({ enum: [...STAFF_CREATE_ROLES], description: '강사 · 매니저 — 대표·관리자는 만들지 않는다' })
  @IsIn([...STAFF_CREATE_ROLES], { message: '역할은 강사 · 매니저 중 하나입니다' })
  role!: string;

  @ApiPropertyOptional({ ...S, maxLength: 20, description: '직함 — 권한과 무관 (D-R39)' })
  @IsOptional() @IsString() @MaxLength(20)
  title?: string | null;

  @ApiPropertyOptional({ ...S, maxLength: 40, description: '시간대 — 시간대 그룹(tzg)에 있는 값만. 비우면 Asia/Seoul' })
  @IsOptional() @IsString() @MaxLength(40)
  tz?: string | null;

  @ApiPropertyOptional({ ...S, maxLength: 32, description: '휴대폰 — 한국 번호는 숫자만 남겨 저장, 해외 번호는 `+국가번호 번호`(N-103 · 나라는 phoneCountries). 모양이 아니면 400' })
  @IsOptional() @IsString() @MaxLength(32)
  phone?: string | null;

  @ApiPropertyOptional({ ...S, description: '입사일 YYYY-MM-DD — 비우면 오늘. 불가 시간 2주 회차의 기산점' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '입사일은 YYYY-MM-DD 입니다' })
  hiredOn?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1000, description: '기본 시급(원/시간) — 적으면 입사일(또는 오늘)부터의 WAGE 한 줄이 같은 트랜잭션에 선다 · 소급 없음' })
  @IsOptional() @IsInt() @Min(1000) @Max(10_000_000)
  wageRate?: number | null;
}

/* ══ §17 사용자 표 CRUD (W8 · 대표 지시 2026-09-26 「매니저 이상급부터 user table CRUD」) ══════════
   대상은 **강사·매니저 줄뿐**이다 — 대표·관리자 줄은 403 STAFF_PROTECTED (매니저가 대표 계정을 고치거나 가져가지 못하게).
   자기 줄은 역할 · 비밀번호 초기화 · 사용 중지 · 삭제가 막힌다. 시급은 여기서 고치지 않는다(「시급 수정」 · C97). */

export class StaffParamsDto {
  @ApiProperty(ID_SCHEMA)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  id!: number;
}

/**
 * 「수정」 창의 권한 예외 다섯 칸 (N-68) — 보낸 칸만 바꾼다. `true` 켬 · `false` 끔 · `null` 역할 따름(예외 지움).
 * 생략한 칸은 그대로다. 판정(누가 적을 수 있나 · 무엇까지 켤 수 있나)은 전부 서버다.
 */
export class StaffPermsPatchDto {
  @ApiPropertyOptional({ type: Boolean, nullable: true, description: '회계 권한 — true 켬 · false 끔 · null 역할 따름' })
  @IsOptional() @IsBoolean() canMoney?: boolean | null;
  @ApiPropertyOptional({ type: Boolean, nullable: true, description: '시급 권한 — true 켬 · false 끔 · null 역할 따름' })
  @IsOptional() @IsBoolean() canWage?: boolean | null;
  @ApiPropertyOptional({ type: Boolean, nullable: true, description: '결재 권한 — true 켬 · false 끔 · null 역할 따름' })
  @IsOptional() @IsBoolean() canApprove?: boolean | null;
  @ApiPropertyOptional({ type: Boolean, nullable: true, description: '비공개 권한 — true 켬 · false 끔 · null 역할 따름' })
  @IsOptional() @IsBoolean() canHide?: boolean | null;
  @ApiPropertyOptional({ type: Boolean, nullable: true, description: '자료 요청 권한 — true 켬 · false 끔 · null 역할 따름' })
  @IsOptional() @IsBoolean() canGpaPack?: boolean | null;
}

/**
 * 「수정」 — 보낸 칸만 바꾼다(생략 = 그대로). 이름·아이디·역할·시간대·입사일은 null 을 받지 않는다 —
 * 지우는 값이 아니기 때문이다. 이메일·직함·휴대폰은 null 또는 빈 글이면 비운다.
 */
export class StaffPatchDto {
  @ApiPropertyOptional({ maxLength: 40 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MinLength(1, { message: '이름을 적어 주세요' }) @MaxLength(40)
  name?: string;

  @ApiPropertyOptional({ maxLength: 120, description: '로그인 아이디 — 형식 자유 · 띄어쓰기 없음 · 대소문자 무시 유일(W10). 연락처가 아니라서 바꿔도 확인 · 첫 설정은 그대로다 — 다음 로그인부터 새 아이디로 들어온다' })
  @ValidateIf((_o, v) => v !== undefined) @IsString({ message: '아이디를 적어 주세요' }) @MaxLength(120, { message: '아이디는 120자까지입니다' })
  loginId?: string;

  @ApiPropertyOptional({ ...S, format: 'email', maxLength: 120, description: '이메일 — 연락 · 인증용 · 유일(대소문자 무시). null · 빈 글이면 비운다. 바꾸거나 비우면 이메일 확인이 풀리고 그 사람은 다음 요청부터 첫 설정을 다시 한다(N-104 · W10)' })
  @Transform(emailOrNull)
  @ValidateIf((_o, v) => v !== undefined && v !== null) @IsEmail({}, { message: '이메일 형식이 아닙니다' }) @MaxLength(120)
  email?: string | null;

  @ApiPropertyOptional({ ...S, maxLength: 32, description: '휴대폰 — 한국 번호는 숫자만 · 해외 번호는 `+국가번호 번호`(N-103). null·빈 글이면 비운다. 바꾸면 휴대폰 확인이 풀리고 그 사람은 다음 요청부터 첫 설정을 다시 한다(N-104)' })
  @IsOptional() @IsString() @MaxLength(32)
  phone?: string | null;

  @ApiPropertyOptional({ ...S, maxLength: 20, description: '직함 — 권한과 무관 (D-R39). null·빈 글이면 비운다' })
  @IsOptional() @IsString() @MaxLength(20)
  title?: string | null;

  @ApiPropertyOptional({ maxLength: 40, description: '시간대 — 시간대 그룹(tzg)에 있는 값만' })
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MinLength(1) @MaxLength(40)
  tz?: string;

  @ApiPropertyOptional({ enum: [...STAFF_CREATE_ROLES], description: '강사 · 매니저 — 대표·관리자로는 못 바꾼다. 자기 역할은 403 SELF_ROLE' })
  @ValidateIf((_o, v) => v !== undefined) @IsIn([...STAFF_CREATE_ROLES], { message: '역할은 강사 · 매니저 중 하나입니다' })
  role?: string;

  @ApiPropertyOptional({ ...DATE_SCHEMA, description: '입사일 YYYY-MM-DD' })
  @ValidateIf((_o, v) => v !== undefined) @IsCalendarDate()
  hiredOn?: string;

  @ApiPropertyOptional({
    type: () => StaffPermsPatchDto,
    description: '권한 예외 다섯 칸(N-68) — 대표 판정으로만(403 PERM_OVERRIDE_FORBIDDEN) · 자기 줄은 403 SELF_ROLE · '
      + '대표·관리자 줄은 403 STAFF_PROTECTED · 보는 사람이 없는 권한은 켤 수 없다(403 PERM_GRANT_FORBIDDEN). 바뀐 값은 다음 요청부터 그 사람의 판정에 쓰인다',
  })
  @IsOptional() @IsObject() @ValidateNested() @Type(() => StaffPermsPatchDto)
  perms?: StaffPermsPatchDto;
}

/**
 * 「비밀번호 초기화」 — 매니저가 임시 비밀번호를 적는다(W10 · 답변 2026-09-26 「매니저가 직접 적기」).
 * 규칙은 만들기와 같다(서랍의 tempPasswordRule). 응답 · 기록에는 싣지 않는다.
 */
export class StaffPasswordResetDto {
  @ApiProperty({ example: '********', maxLength: 200, description: '임시 비밀번호 — 규칙은 서랍의 tempPasswordRule. 응답 · 기록에는 싣지 않는다' })
  @IsString({ message: '임시 비밀번호를 적어 주세요' }) @MaxLength(200, { message: '비밀번호가 너무 깁니다' })
  password!: string;
}

/** 「사용 중지」·「다시 사용」 — 사용 중지된 계정은 다음 요청부터 인증이 막힌다(기존 활성 검사) */
export class StaffActiveDto {
  @ApiProperty({ description: 'false = 사용 중지 · true = 다시 사용' })
  @IsBoolean()
  active!: boolean;
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

/**
 * §20 「최근 변경 이력」 한 줄 (W11 A' 후속 · N-73 의 읽는 쪽) — 원문 컷의 세 줄(누가 — 언제 · 앞 → 뒤 · 무엇을)이다.
 * 원천은 스케줄 감사 줄(`log` entity SER · 규칙 하나의 쓰기 한 번)이고 문장은 서버가 만든다(`lib/schedule-history`).
 */
export class ScheduleHistoryRowDto {
  @ApiProperty({ description: '감사 줄 번호(log.id) — 화면의 줄 키' }) id!: number;
  @ApiProperty({ description: '언제 — KST ISO 시각', format: 'date-time' }) at!: string;
  @ApiProperty({ ...S, description: '누가 — 모르면 null(화면이 「—」)' }) actorName!: string | null;
  @ApiProperty({ description: '무엇을 — 「SAT Reading 8/28 → 20:00 이동 (이 주만)」 같은 서버 문장. 비밀 값은 원장에 없다' })
  summary!: string;
  @ApiProperty({ ...S, description: '원문 둘째 줄 「앞 → 뒤」의 앞 — 첫 번째 바뀐 것 · 모르면 null' }) from!: string | null;
  @ApiProperty({ ...S, description: '원문 둘째 줄의 뒤 — 모르면 null' }) to!: string | null;
  @ApiProperty({ ...S, description: '아직 존재하는 회차면 그 회차를 여는 주소. 지워져 열 수 없으면 null' }) go!: string | null;
}

export class ScheduleHistoryQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 1, description: '이 log.id보다 오래된 줄 스무 개. 생략하면 최신 페이지' })
  @IsOptional() @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  beforeId?: number;
}

export class ScheduleHistoryDto {
  @ApiProperty({ type: [ScheduleHistoryRowDto], description: '최근 것부터 — 볼 수 있는 범위는 §20 목록과 같다(전체 권한이면 모두 · 아니면 내가 한 것)' })
  rows!: ScheduleHistoryRowDto[];
  @ApiProperty({ ...N, description: '더 오래된 줄을 읽을 cursor. 끝이면 null' }) nextBeforeId!: number | null;
}

/**
 * N-52 「내 지출 신청」 머리 — 이 사람이 올린(신청자인) 지출의 수. **서버가 센다**(D-R37).
 * 목록 자체는 칸을 열 때만 `GET /accounting/expenses/mine` 으로 받는다 — 서랍 payload 에 줄을 싣지 않는다.
 */
export class MyExpenseSummaryDto {
  @ApiProperty({ description: '내가 신청자인 지출 전부' }) total!: number;
  @ApiProperty({ description: '심사 대기(pending)' }) pending!: number;
  @ApiProperty({ description: '반려(rejected) — 되돌아온 것은 여기서 본다(N-64)' }) rejected!: number;
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
  @ApiProperty({ description: '§17 「+ 구성원」이 서는가 — canCrudAll (C97 · D-R39: 단추가 서는지도 서버)' }) canAddMember!: boolean;
  @ApiProperty({ description: '시급을 보고 고칠 수 있는가 — canWage. false 면 members.wageRate 는 전부 null (C97)' }) canWage!: boolean;
  @ApiProperty({ type: [PhoneCountryDto], description: '§17 구성원 만들기 · 수정의 휴대폰 국가번호 목록 — 첫 설정과 같은 표(N-103)' })
  phoneCountries!: PhoneCountryDto[];
  @ApiProperty({ description: '§17 구성원 만들기 · 수정의 아이디 규칙 문장 — 화면은 그대로 적는다(W10 · D-R18)' })
  loginIdRule!: string;
  @ApiProperty({ description: '§17 구성원 만들기 · 비밀번호 초기화의 임시 비밀번호 규칙 문장 — 화면은 그대로 적는다(W10 · D-R18)' })
  tempPasswordRule!: string;
  @ApiProperty({ type: MyExpenseSummaryDto, description: '요청함의 「내 지출 신청」 머리 수 — 본인 것만 (N-52)' })
  myExpenses!: MyExpenseSummaryDto;
}

/* ══ §76 권한 — 표도 문장도 서버가 만든다 (N-98 · W11) ═══════════════════════════════ */

export class PermissionRowDto {
  @ApiProperty({ description: '줄 식별자' }) key!: string;
  @ApiProperty({ description: '기능' }) feature!: string;
  @ApiProperty({ description: '무엇인가' }) what!: string;
  @ApiProperty({ description: '누가 — 권한 깃발의 이름(§17 권한 예외 토글과 같은 낱말)' }) who!: string;
  @ApiProperty({ description: '이 줄을 여는 권한 깃발' }) perm!: string;
  @ApiProperty({ description: '지금 이 사람에게 열려 있는가 — 사람별 예외까지 반영된 결론' }) allowed!: boolean;
}

export class PermissionTableDto {
  @ApiProperty({ description: '지금 역할의 이름' }) roleLabel!: string;
  @ApiProperty() possible!: number;
  @ApiProperty() locked!: number;
  @ApiProperty({ description: '창 머리 부제 — 「지금 대표 화면입니다 · N가지 가능 / M가지 잠김」' }) sub!: string;
  @ApiProperty({ type: [PermissionRowDto] }) rows!: PermissionRowDto[];
  @ApiProperty({ type: [String], description: '역할 설명 줄 — 역할마다 「역할 이름 · N가지 가능 / M가지 잠김」(지금의 권한 모형에서 센다)' })
  roleNotes!: string[];
}

/* ══ 쓰기 ═══════════════════════════════════════════════════════════════
   서랍에서 하는 것은 **넣기와 표시뿐**이다. 승인·반려는 그 화면에서 한다 (D-R27). */


export class TodoParamsDto {
  @ApiProperty(ID_SCHEMA)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  id!: number;
}

/** 완료는 기존 주고받은 범위, 기한은 관리자 두 최종 권한을 요구한다. */
export class TodoPatchDto {
  @ApiPropertyOptional({ type: Boolean, description: '생략 유지, true 완료, false 해제. null 불가' })
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean()
  done?: boolean;

  @ApiPropertyOptional({ ...DATE_SCHEMA, nullable: true, description: '생략 유지, null 기한 삭제. 관리자 화면·전체 수정 권한 필요' })
  @IsOptional() @IsCalendarDate()
  dueOn?: string | null;
}

/** §15 수동 할 일 만들기. 출처 연결 할 일은 각 도메인의 전용 API가 만든다. */
export class TodoCreateDto {
  @ApiProperty({ maxLength: 160 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(160)
  title!: string;

  @ApiPropertyOptional({ ...ID_SCHEMA, description: '생략하면 나에게 배정. 다른 사람 배정은 canCrudAll만' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  toId?: number;

  @ApiPropertyOptional({ ...DATE_SCHEMA, example: '2026-09-14', description: 'KST 기준 기한' })
  @IsOptional() @IsCalendarDate()
  dueOn?: string;

  /*
   * W11 · N-71 — 수업 상세 「+ 할 일」이 **회차 키 두 칸**을 싣는다(`ser_occ.id` 가 아니다 — 투영이라 쓰기마다 바뀐다).
   * 둘 다 있거나 둘 다 없다(`todo_lesson_key`). 넣으면 출처는 수업(src=lesson)이고, 회차가 있는지 · 휴강이 아닌지 ·
   * 수업에 걸 권한(canCrudAll)이 있는지 서버가 본다.
   */
  @ApiPropertyOptional({ ...ID_SCHEMA, description: '회차 키 ① 수업(SER) — onDate 와 함께만 · 넣으면 출처가 수업(src=lesson)이다 (N-71)' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  serId?: number;

  @ApiPropertyOptional({ ...DATE_SCHEMA, example: '2026-09-14', description: '회차 키 ② 규칙이 찍은 날(옮긴 회차도 이 날) — serId 와 함께만 (N-71)' })
  @IsOptional() @IsCalendarDate()
  onDate?: string;
}

export class TodoCreateResultDto {
  @ApiProperty() id!: number;
}

/**
 * §15 「끝난 것 지우기」 — **화면이 보여 준 그것만** 지운다 (대표 결정 2026-09-20 · S4).
 *
 * 전에는 본문이 없었고 서버가 「내가 볼 수 있는 완료 행 전부」를 지웠다. `canCrudAll` 이면 그 조건이
 * 통째로 사라져 **전사 하드 삭제**였는데, 화면의 단추는 **지금 보이는 필터(수신함/발신함/전체 · 일·주·월)**
 * 의 끝난 것 수로 열린다 — 「1건」을 보고 눌렀는데 남의 지난달 것까지 사라졌다.
 *
 * 그래서 **범위를 화면이 말한다.** 기간·묶음 규칙을 서버에 한 벌 더 쓰지 않는다(D-R22) — 화면이 세고 있는
 * 그 줄들의 id 를 그대로 보내고, 서버는 그중 **아직 끝나 있고 내가 볼 수 있는** 행만 지운다. 그래서
 * 단추의 숫자와 실제로 지워지는 수가 언제나 같다(D-R39). 그 사이 누가 체크를 풀었으면 그 줄은 안 지워진다.
 */
export class TodoClearRequestDto {
  @ApiProperty({
    type: [Number], items: ID_SCHEMA, minItems: 1, maxItems: 500, uniqueItems: true,
    description: '화면이 지금 「끝난 것」으로 세고 있는 할 일 id 들 — 이 목록 밖은 지우지 않는다',
  })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true })
  ids!: number[];
}

export class TodoClearDto {
  @ApiProperty() ok!: true;
  @ApiProperty({ description: '이번에 삭제된 완료 할 일 수 — 보낸 id 중 아직 끝나 있고 볼 수 있는 것만 · 상담 사후 관리(완료 이력)는 세지 않는다 (N-86)' }) deleted!: number;
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

/**
 * §19 겹침 미리보기 한 줄 — **모양은 schedule 모듈이 갖는다.**
 * 겹침을 세는 것도 그 모듈(`ScheduleService.conflicts()`)이고, §07~§11 일정 이동도 같은 줄을 받는다.
 * 여기서 다시 선언하면 같은 겹침이 화면마다 다른 모양으로 읽힌다.
 */
import { ConflictRowDto } from '../schedule/schedule.dto';
export { ConflictRowDto };

export class ChangeReqResultDto {
  @ApiPropertyOptional({ ...N, description: '만들어진 요청 id. 겹쳐서 막혔으면 없다' }) id?: number | null;
  @ApiProperty({ type: [ConflictRowDto], description: '비어 있지 않으면 제출이 막힌 것이다' })
  conflicts!: ConflictRowDto[];
}
