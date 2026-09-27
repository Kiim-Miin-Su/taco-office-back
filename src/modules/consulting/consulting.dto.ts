/** @file-guide
 * 목적: consulting.dto.ts — ConsultingSessionDto, ConsItemDto, ConsItemToggleDto, ConsultingDto, ConsultingListDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString,
  Matches, Max, MaxLength, Min, MinLength, ValidateBy, ValidateNested,
} from 'class-validator';
import { DATE_SCHEMA, ID_SCHEMA, IsCalendarDate } from '../../common/validation';
import { UnavWarnDto } from '../schedule/schedule.dto';
import { CONS_SHARES, type ConsShare } from '../../lib/rules';
import {
  CONS_ITEM_FILE_MAX, CONS_ITEM_MAX,
  CONSULTING_FILE_MAX, CONSULTING_FILE_ROLES, CONSULTING_REQUESTERS, CONSULTING_SESSION_MAX,
  CONSULTING_STAGES, CONSULTING_TYPES, CONTRACT_STEP_MAX, type ConsultingFileRole,
  type ConsultingRequester, type ConsultingStage, type ConsultingType,
} from './consulting.rules';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;

/** share와 지정 목록의 교차 조건을 DTO와 service 두 층에서 막는다. */
function IsPickedStaffIds(): PropertyDecorator {
  return ValidateBy({
    name: 'isPickedStaffIds',
    validator: {
      validate(value: unknown, args) {
        const share = (args?.object as { share?: unknown } | undefined)?.share;
        if (share !== 'picked') return value === undefined || Array.isArray(value) && value.length === 0;
        return Array.isArray(value) && value.length > 0
          && value.every((id) => Number.isInteger(id) && id >= 1)
          && new Set(value).size === value.length;
      },
      defaultMessage: () => "pickedStaffIds는 지정 공개일 때만 중복 없는 양의 정수 1개 이상이어야 합니다",
    },
  });
}

/** §31 컨설팅 회차 — 5W1H 로 적는다 (누가·무엇을·왜·어떻게) */
export class ConsultingSessionDto {
  @ApiProperty() id!: number;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: CONSULTING_SESSION_MAX, description: '건별 고유 회차 순번' }) seq!: number;
  @ApiProperty({ ...S, format: 'date', description: '미정이면 null' }) onDate!: string | null;
  @ApiPropertyOptional(S) who?: string | null;
  @ApiPropertyOptional(S) what?: string | null;
  @ApiPropertyOptional(S) why?: string | null;
  @ApiPropertyOptional(S) how?: string | null;
  @ApiPropertyOptional({ ...N, description: '연결된 수업이 있으면 그 SER' }) serId?: number | null;
  @ApiPropertyOptional({ description: 'C95 · 오늘까지 한 회차인가 — 날짜가 오늘 이하(또는 미정). 앞으로 잡아 둔 날짜는 false (기록 ≠ 완료 · N-18)' })
  done?: boolean;

  /* 원본 §31 회차 머리 「1회차 · 26년 7월 14일 화요일 · 16:00–17:00 · 김범준 · 4호 · 기록됨」 (31-07) — 시간표 회차(SER)에서 파생한다. 연결이 없으면 null */
  @ApiPropertyOptional({ ...N, description: '시작 KST 분 — 연결된 시간표 회차의 시각 (31-07)' }) startMin?: number | null;
  @ApiPropertyOptional({ ...N, description: '끝 KST 분 (자정은 1440)' }) endMin?: number | null;
  @ApiPropertyOptional({ ...S, description: '그 회차를 맡은 사람 — 시간표 회차의 강사(예외가 있으면 예외의 강사)' }) staffName?: string | null;
  @ApiPropertyOptional({ ...S, description: '강의실 이름 — 없으면 null' }) roomName?: string | null;
  @ApiPropertyOptional({ description: '「기록됨」 — 무엇을 · 왜 · 어떻게가 다 찼는가. 할 일을 접는 조건과 같다 (서버 판정)' }) recorded?: boolean;
  /* 원본 §31 회차 본문의 「결과」와 「다음까지」 (31-08) */
  @ApiPropertyOptional({ ...S, description: '결과 — 인용 상자' }) result?: string | null;
  @ApiPropertyOptional({ ...S, description: '다음까지 — 적으면 담당의 할 일과 알림이 선다 (슬라이드 31 연동)' }) nextUntil?: string | null;
}


/** §31 진행 항목 한 줄 — 원장 행 그대로. 진행률은 화면이 세고 서버는 저장하지 않는다 (47D-A). */
export class ConsItemDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: '건별 항목 순번' }) seq!: number;
  @ApiProperty({ maxLength: 80 }) label!: string;
  @ApiProperty({ description: '필수 — 끝내야 종료할 수 있다(N-18). 못 끝내면 예외 종료(N-18-a)' }) required!: boolean;
  @ApiProperty() done!: boolean;
  @ApiPropertyOptional({ ...S, description: '처리자 이름 — 미완료면 null' }) doneBy?: string | null;
  @ApiPropertyOptional({ ...S, format: 'date', description: '처리일 — 미완료면 null' }) doneOn?: string | null;
  @ApiPropertyOptional({ ...S, description: '처리 시각 KST(YYYY-MM-DDTHH:MI:SS+09:00) — 원본 §31 「2026-07-22 14:00 · 김범준」의 시각 (31-04). 미완료면 null' })
  doneAt?: string | null;
  @ApiProperty({ description: 'template(§29 기본 항목) | manual(원문 §31 「항목 수정」으로 담당이 더한 것 · N-18-a)' }) source!: string;
  /* ── W11 · 원문 §31 항목 줄의 「파일」과 「항목 수정」 (N-63 · N-18-a) — 서는지는 서버가 정한다(consItemEditIssue) ── */
  @ApiProperty({
    type: () => [ConsultingFileDto], maxItems: CONS_ITEM_FILE_MAX,
    description: '항목 파일 — 항목마다 최대 6개 · 계약 파일 10개와 따로 센다(N-63). role 은 item',
  })
  files!: ConsultingFileDto[];
  @ApiProperty({ description: '「파일」로 더 올릴 수 있는가 — 종료 전 · 6개 미만' }) canAddFile!: boolean;
  @ApiProperty({ description: '「항목 수정」에서 이름을 바꿀 수 있는가 — 종료 전 · 안 끝낸 항목' }) canRename!: boolean;
  @ApiProperty({ description: '「항목 수정」에서 뺄 수 있는가 — 종료 전 · 안 끝낸 · 담당이 더한(manual) · 파일 없는 항목. 기본 항목은 빼지 않는다' })
  canRemove!: boolean;
}

/** 「항목 수정」 — 더할 항목 한 줄 */
export class ConsItemAddDto {
  @ApiProperty({ minLength: 1, maxLength: 80, description: '항목 이름 — 앞뒤 공백은 서버가 걷는다' })
  @IsString() @MinLength(1) @MaxLength(80) label!: string;
  @ApiProperty({ description: '필수 — 켜면 끝내야 종료할 수 있다(N-18)' })
  @IsBoolean() required!: boolean;
}

/** 「항목 수정」 — 이름 바꿀 항목 한 줄 */
export class ConsItemRenameDto {
  @ApiProperty(ID_SCHEMA) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) id!: number;
  @ApiProperty({ minLength: 1, maxLength: 80 }) @IsString() @MinLength(1) @MaxLength(80) label!: string;
}

/**
 * 원문 §31 「항목 수정」 — 더하기 · 이름 바꾸기 · 빼기를 **한 번에** 보낸다(N-18-a · DQ5 대안 「담당자가 계약마다 항목을 직접 구성」).
 * 목록 통째로 보내지 않는다 — 누가 먼저 더한 항목을 다른 사람의 오래된 목록이 지우지 않게 **바꾸는 것만** 적는다.
 */
export class ConsItemsEditDto {
  @ApiPropertyOptional({ type: [ConsItemAddDto], maxItems: CONS_ITEM_MAX })
  @IsOptional() @IsArray() @ArrayMaxSize(CONS_ITEM_MAX) @ValidateNested({ each: true }) @Type(() => ConsItemAddDto)
  add?: ConsItemAddDto[];

  @ApiPropertyOptional({ type: [ConsItemRenameDto], maxItems: CONS_ITEM_MAX })
  @IsOptional() @IsArray() @ArrayMaxSize(CONS_ITEM_MAX) @ValidateNested({ each: true }) @Type(() => ConsItemRenameDto)
  rename?: ConsItemRenameDto[];

  @ApiPropertyOptional({ type: [Number], items: ID_SCHEMA, maxItems: CONS_ITEM_MAX, uniqueItems: true, description: '뺄 항목 id' })
  @IsOptional() @IsArray() @ArrayMaxSize(CONS_ITEM_MAX) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true }) @Max(Number.MAX_SAFE_INTEGER, { each: true })
  remove?: number[];
}

export class ConsItemToggleDto {
  @ApiProperty({ description: 'true = 완료 처리(처리자·시각 서버 기록) · false = 해제' })
  @IsBoolean()
  done!: boolean;
}

/** §26·§27 컨설팅 건 조회. §29 생성 input은 별도 청크. */
export class ConsultingDto {
  @ApiProperty() id!: number;
  @ApiProperty({ maxLength: 20, description: '종류 코드. 원본 §29에 종류 10개가 있으며 저장 코드와의 대응은 생성 계약에서 정리한다. 조회는 기존 코드를 보존하고 시드 3종으로 제한하지 않는다.' }) consType!: string;
  @ApiProperty({ type: String, enum: CONSULTING_STAGES, description: '계약 → 진행 → 종료' }) stage!: ConsultingStage;
  @ApiPropertyOptional({ type: 'integer', nullable: true, minimum: 1, maximum: CONTRACT_STEP_MAX, description: '계약 5단계. 계약 중 미정은 null, 진행/종료는 5.' }) contractStep?: number | null;
  @ApiProperty({ type: [String] }) studentNames!: string[];
  @ApiPropertyOptional(S) ownerName?: string | null;
  @ApiPropertyOptional({ type: 'integer', nullable: true, minimum: 1, maximum: CONSULTING_SESSION_MAX }) sessions?: number | null;
  @ApiPropertyOptional(S) endOn?: string | null;
  @ApiProperty() createdAt!: string;

  /** D-R39 — 금액은 대표만 본다. 나머지에게는 서버가 null 로 내린다. */
  @ApiPropertyOptional({ ...N, description: '대표가 아니면 null' }) amount?: number | null;
  /** 공개 범위 — 역할 권한과 **독립된 두 번째 층**이다 (DEV-SPEC §4.4). 배분율이 아니다. */
  @ApiProperty({
    type: String, enum: CONS_SHARES,
    description: '전체 공개 · 수납만 공개 · 지정 공개 · 전체 비공개',
  })
  share!: ConsShare;

  @ApiProperty({ description: '내용(회차 기록)을 열 수 있는가 — csCanFull()' }) canOpen!: boolean;

  /* ── 원본 §26 카드가 요구하는 낱말과 수 — 전부 서버가 만든다 (D-R18 · D-R37 · C86-e) ── */
  @ApiProperty({ description: '단계 이름 — 「계약 · 진행 · 종료」' }) stageLabel!: string;
  @ApiProperty({ description: '종류 이름 — 「에세이 지도」' }) typeLabel!: string;
  @ApiProperty({ description: '공개 범위 이름 — 「수납만 공개」' }) shareLabel!: string;
  @ApiProperty({ description: '§26 카드 공개 칩 낱말 — 원본 「수납만」(짧은 낱말 · 26-08). 원본에 없는 범위는 이름 그대로' })
  shareChipLabel!: string;
  @ApiPropertyOptional({ ...S, description: '계약 단계 이름 — 「피드백」. 미정이면 null' })
  contractStepLabel?: string | null;
  @ApiPropertyOptional({ ...S, description: '요청자 — 「어머니」. 안 적혔으면 null' })
  requesterLabel?: string | null;
  @ApiProperty({
    type: 'integer', nullable: true,
    description: '시작한 지 며칠 — 원본 「60일 지남」 (D-R37). 계약 시작일(start_on)부터 센다. 시작일이 없거나 아직 시작 전이면 null(칸을 세우지 않는다)',
  })
  ageDays!: number | null;
  @ApiPropertyOptional({
    ...N,
    description: '받은 돈 합 — 원본 카드의 「₩400,000 / ₩800,000」 왼쪽 반. `amount` 와 **같은 권한**을 탄다 (D-R39)',
  })
  paidAmount?: number | null;

  @ApiProperty({ type: [ConsultingSessionDto] }) sessionsLog!: ConsultingSessionDto[];
  @ApiProperty({ description: 'C95 · 오늘까지 한 회차 수 — `sessionsLog` 중 날짜가 오늘 이하(또는 미정)인 것. 내용이 잠기면 0 (D-R37)' })
  sessionsDone!: number;

  /** §31 진행 항목 — 회차 기록과 별개 원장 (N-18 §4-17). 내용이 잠기면 회차처럼 내려가지 않는다. */
  @ApiProperty({ type: [ConsItemDto] }) items!: ConsItemDto[];
}

/** §26 보드 칸 — 낱말·순서·한 줄이 서버에 있다 (D-R18 · D-R25) */
export class ConsultingStageDto {
  @ApiProperty({ enum: CONSULTING_STAGES }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: '칸 이름 아래 한 줄 — **다음에 무엇을 하는지** (원본 §26)' }) sub!: string;
}

/** 공개 범위 낱말 한 벌 — 이름 + 뜻 한 줄 (슬라이드 32 · §29 칩 아래 · 29-06) */
export class ConsultingShareWordDto {
  @ApiProperty({ enum: CONS_SHARES }) key!: string;
  @ApiProperty({ description: '「전체 공개」 …' }) label!: string;
  @ApiProperty({ description: '「관리자 누구나 봅니다」 …' }) meaning!: string;
}

/** §29 고르개 낱말 한 줄 — 종류 · 요청자 (29-02 · 화면이 표를 따로 들지 않는다 · D-R18) */
export class ConsultingWordDto {
  @ApiProperty() key!: string;
  @ApiProperty({ description: '「편입 · 전학」 · 「어머니」 …' }) label!: string;
}

export class ConsultingListDto {
  @ApiProperty({ type: [ConsultingDto] }) items!: ConsultingDto[];
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39)' }) canSeeAmounts!: boolean;
  @ApiProperty({ description: '「비공개」로 지정할 수 있는가 — §76 대표 전용. 화면의 공개 범위 고르개가 이 값으로 그 칸을 뺀다 (S4 · D-R39)' })
  canSetPrivate!: boolean;
  @ApiProperty({ type: [ConsultingStageDto], description: '§26 칸 셋 — 빈 칸도 이름과 한 줄을 갖는다' })
  stages!: ConsultingStageDto[];
  @ApiPropertyOptional({ type: [ConsultingShareWordDto], description: '공개 범위 넷의 이름과 뜻 — §29 「누가 볼 수 있나」 칩과 그 아래 한 줄(29-06). 「전체 비공개」를 고를 수 있는지는 canSetPrivate' })
  shares?: ConsultingShareWordDto[];
  @ApiPropertyOptional({ type: [ConsultingWordDto], description: '§29 「어떤 컨설팅」 종류 10 — 원본 차례 · 이름(가운뎃점 앞뒤 띄움 · 29-02)' })
  types?: ConsultingWordDto[];
  @ApiPropertyOptional({ type: [ConsultingWordDto], description: '§29 「누가 요청」 둘 — 「어머니 · 아버지」' })
  requesters?: ConsultingWordDto[];
  @ApiPropertyOptional({
    type: 'integer', minimum: 0,
    description: '§27 학생별 탭 머리 「학생 N명」 — 이 사람이 볼 수 있는 건(csCan)의 학생 수. `GET /consulting/students` 의 줄 수와 같은 셈이다(26-03 · D-R37)',
  })
  studentCount?: number;
}

/* ══ §29 생성 · §30 계약 5단계 (C79-product) ═══════════════════════════ */

export class ConsultingCreateDto {
  @ApiProperty({ enum: CONSULTING_TYPES, description: '§29 확정 10종. 레거시 조회 코드는 이 enum으로 축소하지 않는다.' })
  @IsIn(CONSULTING_TYPES as unknown as string[]) consType!: ConsultingType;

  @ApiProperty({ type: [Number], items: ID_SCHEMA, minItems: 1, uniqueItems: true })
  @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true })
  studentIds!: number[];

  @ApiProperty({ enum: CONSULTING_REQUESTERS })
  @IsIn(CONSULTING_REQUESTERS as unknown as string[]) requester!: ConsultingRequester;

  @ApiProperty(ID_SCHEMA) @IsInt() @Min(1) ownerId!: number;
  @ApiProperty({ minimum: 1, maximum: 2_147_483_647 }) @IsInt() @Min(1) @Max(2_147_483_647) amount!: number;
  @ApiProperty({ minimum: 1, maximum: CONSULTING_SESSION_MAX, description: '약정 회차 — 계약서의 숫자다. 이 값으로 회차를 미리 만들지 않는다. 시간표 회차는 「회차 기록」(POST /consulting/{id}/sessions)이 날짜마다 만든다(C95).' }) @IsInt() @Min(1) @Max(CONSULTING_SESSION_MAX) sessions!: number;
  @ApiProperty({ ...DATE_SCHEMA }) @IsCalendarDate() startOn!: string;
  @ApiProperty({ ...DATE_SCHEMA }) @IsCalendarDate() endOn!: string;
  @ApiProperty({ enum: CONS_SHARES }) @IsIn(CONS_SHARES as unknown as string[]) share!: ConsShare;

  @ApiPropertyOptional({ type: [Number], items: ID_SCHEMA, uniqueItems: true, description: "share='picked'일 때 1명 이상 필수, 그 밖에는 비워야 한다." })
  @IsPickedStaffIds()
  pickedStaffIds?: number[];
}

/** 계약 작업을 시작하기 전 바꿀 수 있는 핵심정보. 종류와 공개 범위는 각각 템플릿/전용 계약이 있어 여기서 받지 않는다. */
export class ConsultingPatchDto {
  @ApiPropertyOptional({ type: [Number], items: ID_SCHEMA, minItems: 1, uniqueItems: true })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true })
  studentIds?: number[];

  @ApiPropertyOptional({ enum: CONSULTING_REQUESTERS })
  @IsOptional() @IsIn(CONSULTING_REQUESTERS as unknown as string[])
  requester?: ConsultingRequester;

  @ApiPropertyOptional(ID_SCHEMA) @IsOptional() @IsInt() @Min(1) ownerId?: number;
  @ApiPropertyOptional({ minimum: 1, maximum: 2_147_483_647 }) @IsOptional() @IsInt() @Min(1) @Max(2_147_483_647) amount?: number;
  @ApiPropertyOptional({ minimum: 1, maximum: CONSULTING_SESSION_MAX }) @IsOptional() @IsInt() @Min(1) @Max(CONSULTING_SESSION_MAX) sessions?: number;
  @ApiPropertyOptional({ ...DATE_SCHEMA }) @IsOptional() @IsCalendarDate() startOn?: string;
  @ApiPropertyOptional({ ...DATE_SCHEMA }) @IsOptional() @IsCalendarDate() endOn?: string;
}

export class ConsultingShareUpdateDto {
  @ApiProperty({ enum: CONS_SHARES }) @IsIn(CONS_SHARES as unknown as string[]) share!: ConsShare;
  @ApiPropertyOptional({ type: [Number], items: ID_SCHEMA, uniqueItems: true, description: "share='picked'일 때 1명 이상 필수" })
  @IsPickedStaffIds()
  pickedStaffIds?: number[];
}

export class ConsultingFileCreateDto {
  @ApiProperty({ maxLength: 200 }) @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @ApiProperty({ description: 'base64 본문. data URL 접두사 허용.' }) @IsString() @MinLength(1) base64!: string;
}

export class ConsultingFileDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiProperty() mime!: string;
  @ApiProperty() bytes!: number;
  @ApiProperty() url!: string;
  @ApiProperty({ enum: CONSULTING_FILE_ROLES }) role!: ConsultingFileRole;
  @ApiProperty(S) uploadedByName!: string | null;
  @ApiProperty() uploadedAt!: string;
}

export class ConsultingFeedbackCreateDto {
  @ApiProperty({ maxLength: 2000 }) @IsString() @MinLength(1) @MaxLength(2000) body!: string;
}

export class ConsultingFeedbackDto {
  @ApiProperty() id!: number;
  @ApiProperty() body!: string;
  @ApiProperty(S) createdByName!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() resolved!: boolean;
  @ApiProperty(S) resolvedByName!: string | null;
  @ApiProperty({ type: String, nullable: true }) resolvedAt!: string | null;
}

export class ConsultingTypeCapabilityDto {
  @ApiProperty() defaultItemsSupported!: boolean;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ description: '「회차 기록」이 시간표 회차(SER)를 만드는가 — C95 부터 true (30-02)' }) scheduleCreationSupported!: boolean;
  @ApiProperty({ type: String, nullable: true }) scheduleCreationReason!: string | null;
}

export class ConsultingCapabilitiesDto {
  @ApiProperty() canEdit!: boolean;
  @ApiProperty() canChangeShare!: boolean;
  @ApiProperty({ description: '「비공개」로 지정할 수 있는가 — §76 대표 전용(S4). canChangeShare 와 다른 층이다: 범위를 바꿀 수는 있어도 비공개는 못 고를 수 있다' })
  canSetPrivate!: boolean;
  @ApiProperty() canAddContractFile!: boolean;
  @ApiProperty() canRemoveContractFile!: boolean;
  @ApiProperty() canAddFeedback!: boolean;
  @ApiProperty() canResolveFeedback!: boolean;
  @ApiProperty() canDeliver!: boolean;
  @ApiProperty() canAddSignedFile!: boolean;
  @ApiProperty({ description: '「납부 넣기」가 서는가 — 회계 표의 줄과 같은 판정(payGate) (S5)' }) canAddPayment!: boolean;
  @ApiProperty({ type: String, nullable: true, description: '납부를 못 넣는 이유 — 넣을 수 있거나 금액 권한이 없으면 null' }) payBlockedReason!: string | null;
  @ApiProperty() canCreateInvoice!: boolean;
  @ApiProperty({ description: '「지우기」(보관)가 서는가 — 받은 돈 · 살아 있는 전환 청구서 · 회차 기록이 있으면 false (PB-11)' }) canArchive!: boolean;
  @ApiProperty({ type: String, nullable: true, description: '지우기가 막힌 이유 — 쓰기의 409 CONS_ARCHIVE_BLOCKED 와 같은 문장. 열려 있으면 null (PB-11)' })
  archiveBlockedReason!: string | null;
  @ApiProperty({ description: '「계약서 전달하기」가 있는가 — 보호자 메일에 계약서를 붙여 보낸다(N-77). deliver 는 시스템 밖 전달의 완료 기록이다' }) externalParentSendSupported!: boolean;
  @ApiProperty({ type: String, nullable: true }) externalParentSendReason!: string | null;
  @ApiProperty({ description: '지금 계약서를 보낼 수 있는가 — 계약 2·4단계 · 계약서 있음 · 풀리지 않은 피드백 없음. 실제로 나간 메일이 있어야 「전달」 단계로 넘어간다 (N-77)' })
  canSendContract!: boolean;
  /* ── C95 · §31 회차 · 종료 ── */
  @ApiProperty({ description: '회차를 더 잡을 수 있는가 — 진행(running) 중인 건만 (I-91)' }) canAddSession!: boolean;
  @ApiProperty({ description: '종료할 수 있는가 — N-18 채택 「필수 항목 + 약정 회차 후 명시 종료」를 서버가 판정한다 (I-95)' }) canClose!: boolean;
  @ApiProperty({ type: String, nullable: true, description: '종료가 막힌 이유 문장 — 화면이 그대로 띄운다. 열려 있으면 null' }) closeBlockedReason!: string | null;
  @ApiProperty({ description: '예외 종료를 할 수 있는가 — 필수 항목·약정 회차만 남아 종료가 막혔고 이 사람이 승인 권한이 있을 때 (N-18-a · DQ6)' })
  canCloseException!: boolean;
  @ApiProperty({ description: '「항목 수정」과 항목 파일 빼기가 서는가 — 종료 전 건 (N-18-a · N-63)' }) canEditItems!: boolean;
}

export class ConsultingDeliveryDto {
  @ApiProperty() deliveredAt!: string;
  @ApiProperty(S) deliveredByName!: string | null;
}

export class ConsultingPaymentStateDto {
  @ApiProperty(N) paid!: number | null;
  @ApiProperty(N) due!: number | null;
  @ApiProperty(N) invoiceId!: number | null;
}

/** 계약 단계 한 칸 — 원본 §30 스테퍼 「✓ 계약서 준비 · 초안을 올립니다」 (30-07) */
export class ConsultingContractStepDto {
  @ApiProperty({ minimum: 1, maximum: CONTRACT_STEP_MAX }) step!: number;
  @ApiProperty() label!: string;
  @ApiProperty() sub!: string;
}

export class ConsultingDetailDto {
  @ApiProperty() id!: number;
  @ApiProperty() consType!: string;
  @ApiProperty() consTypeLabel!: string;
  @ApiProperty({ enum: CONSULTING_STAGES }) stage!: ConsultingStage;
  @ApiProperty({ type: 'integer', nullable: true, minimum: 1, maximum: CONTRACT_STEP_MAX }) contractStep!: number | null;
  @ApiProperty({ type: [Number] }) studentIds!: number[];
  @ApiProperty({ type: [String] }) studentNames!: string[];
  @ApiProperty({ enum: CONSULTING_REQUESTERS, nullable: true }) requester!: ConsultingRequester | null;
  @ApiProperty(N) ownerId!: number | null;
  @ApiProperty(S) ownerName!: string | null;
  @ApiProperty({ ...DATE_SCHEMA, nullable: true }) startOn!: string | null;
  @ApiProperty({ ...DATE_SCHEMA, nullable: true }) endOn!: string | null;
  @ApiProperty(N) amount!: number | null;
  @ApiProperty(N) sessions!: number | null;
  @ApiProperty({ enum: CONS_SHARES }) share!: ConsShare;
  @ApiProperty({ description: '공개 범위 이름 — 「수납만 공개」 (D-R18)' }) shareLabel!: string;
  @ApiPropertyOptional({ ...S, description: '공개 범위의 뜻 한 줄 — 「금액만 보이고 내용은 숨깁니다」(슬라이드 32 · 30-06)' }) shareMeaning?: string | null;
  @ApiProperty({ type: () => [ConsultingContractStepDto], description: '계약 5단계 — 이름과 한 줄(원본 §30 스테퍼 · 30-07). 낱말은 서버가 쥔다' })
  contractSteps!: ConsultingContractStepDto[];
  @ApiProperty({ type: [Number] }) pickedStaffIds!: number[];
  @ApiProperty({ type: [String] }) pickedStaffNames!: string[];
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: ConsultingTypeCapabilityDto }) typeCapability!: ConsultingTypeCapabilityDto;
  @ApiProperty({ type: ConsultingCapabilitiesDto }) capabilities!: ConsultingCapabilitiesDto;
  @ApiProperty({ type: [ConsultingFileDto], maxItems: CONSULTING_FILE_MAX }) contractFiles!: ConsultingFileDto[];
  @ApiProperty({ type: [ConsultingFileDto], maxItems: CONSULTING_FILE_MAX }) signedFiles!: ConsultingFileDto[];
  @ApiProperty({ type: [ConsultingFeedbackDto] }) feedback!: ConsultingFeedbackDto[];
  @ApiProperty({ type: ConsultingDeliveryDto, nullable: true }) delivery!: ConsultingDeliveryDto | null;
  @ApiProperty({ type: ConsultingPaymentStateDto }) payment!: ConsultingPaymentStateDto;
  /* ── C95 · §31 회차 · 종료 — 세는 것은 전부 서버다 (D-R37) ── */
  @ApiProperty({ description: '오늘까지 한 회차 수 (날짜 오늘 이하 또는 미정)' }) sessionsDone!: number;
  @ApiProperty({ description: '앞으로 잡아 둔 회차 수 (날짜가 오늘 뒤)' }) sessionsPlanned!: number;
  @ApiProperty({ description: '아직 안 끝낸 필수 항목 수' }) requiredLeft!: number;
  @ApiProperty({ type: String, nullable: true, description: '종료 시각 — cons_event closed 행 (없으면 null)' }) closedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: '종료한 사람' }) closedByName!: string | null;
  @ApiProperty({ type: String, nullable: true, description: '예외 종료의 사유 — 예외로 닫은 건만(감사 원장의 그 줄). 아니면 null (N-18-a)' })
  closeReason!: string | null;
}

/* ══ §28 컨설팅 회계 (C58) ═══════════════════════════════════════════════ */

/** 납부 기록 한 줄 — 원문 `CONS.pay[]` */
export class ConsPaymentDto {
  @ApiProperty() id!: number;
  @ApiProperty() amount!: number;
  @ApiProperty({ example: '2026-07-12' }) paidOn!: string;
  @ApiPropertyOptional(S) memo?: string | null;
  @ApiPropertyOptional(S) byName?: string | null;
}

/** 컨설팅에 걸린 학생 한 명 — 「청구서로 전환」 창의 고르개가 읽는다 (N-33 ②) */
export class ConsStudentRefDto {
  @ApiProperty(ID_SCHEMA) id!: number;
  @ApiProperty() name!: string;
}

/** §28 표 한 줄 — 계약 하나의 돈 */
export class ConsAccountRowDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: '학생 — 여럿이면 쉼표로 잇는다' }) studentName!: string;
  @ApiProperty({ type: [ConsStudentRefDto], description: '학생 id · 이름 — 여럿이면 「청구서로 전환」에서 받는 학생을 고른다(이름 차례)' })
  students!: ConsStudentRefDto[];
  @ApiProperty({ description: '종류 코드' }) consType!: string;
  @ApiProperty({ description: '종류 이름 — 「에세이 지도」 (서버 낱말 · 29-02)' }) typeLabel!: string;
  @ApiProperty({ type: String, enum: CONSULTING_STAGES }) stage!: ConsultingStage;
  @ApiProperty({ description: '단계 이름 — 낱말은 서버가 만든다 (D-R18)' }) stageLabel!: string;

  @ApiPropertyOptional({ ...N, description: '계약 금액 — 못 보면 null' }) amount?: number | null;
  @ApiPropertyOptional({ ...N, description: '받은 돈 — 납부 기록의 합 + 살아 있는 전환 청구서에 붙은 입금 (N-33 ② · 계약 → 진행 전이와 같은 조각)' }) paid?: number | null;
  /** 남은 돈 — **서버가 뺀다.** 화면이 계약 − 받음을 다시 하면 머리 칸의 합계와 갈린다 (D-R37) */
  @ApiPropertyOptional({ ...N, description: '남은 돈 — 서버가 뺀다' }) due?: number | null;

  @ApiProperty({ type: [ConsPaymentDto], description: '납부 기록 — 청구서로 전환해도 그대로 남는다' })
  payments!: ConsPaymentDto[];

  @ApiPropertyOptional({ ...N, description: '전환된 청구서 — 없으면 null' }) invId?: number | null;
  @ApiProperty({ description: '청구서로 전환할 수 있는가 — 이미 살아 있는 청구서가 있으면 false' })
  canInvoice!: boolean;
  @ApiProperty({ description: '「납부 넣기」가 서는가 — 쓰기가 거절하는 순서 그대로다(종료 · 서명본 전 · 남은 금액 0) (S5 · D-R39)' })
  canAddPayment!: boolean;
  @ApiProperty({ ...S, description: '납부를 못 넣는 이유 — 넣을 수 있거나 금액 권한이 없으면 null' })
  payBlockedReason!: string | null;
}

/** `GET /consulting/accounting` — §28 */
export class ConsAccountingDto {
  @ApiProperty({ type: [ConsAccountRowDto] }) items!: ConsAccountRowDto[];
  /* 머리 세 칸 — 원문 「계약 금액 · 받은 돈 · 남은 돈」. 화면이 줄을 더하지 않는다 (D-R37) */
  @ApiPropertyOptional({ ...N, description: '계약 금액 합계 — 못 보면 null' }) totalAmount?: number | null;
  @ApiPropertyOptional({ ...N, description: '받은 돈 합계' }) totalPaid?: number | null;
  @ApiPropertyOptional({ ...N, description: '남은 돈 합계' }) totalDue?: number | null;
  @ApiProperty({ description: '금액을 볼 수 있는가 — 공개 범위와 D-R39 두 층을 모두 통과해야 한다' })
  canSeeAmounts!: boolean;
}

/** 납부 넣기 — 원문 §28 「납부 넣기」 */
export class ConsPaymentCreateDto {
  @ApiProperty({ description: '받은 금액 — 0 원은 기록이 아니며, 누계가 계약 금액을 넘으면 OVERPAY', minimum: 1 })
  @IsInt() @Min(1) amount!: number;

  @ApiProperty({ example: '2026-07-12' })
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '날짜는 YYYY-MM-DD 입니다' })
  paidOn!: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional() @IsString() @MaxLength(80) memo?: string;
}

/**
 * 청구서로 전환 — 원문 §28 「청구서로 전환」 창의 입력 (N-33 ②).
 * 청구서(`inv.student_id`)는 학생 한 명 앞으로 나간다 — 학생이 여럿인 컨설팅은 **사람이 고른다**(전에는 409 로 돌려보냈다).
 * 한 명이면 비워도 그 학생이다.
 */
export class ConsToInvoiceDto {
  @ApiPropertyOptional({ ...ID_SCHEMA, description: '청구서를 받을 학생 — 그 컨설팅의 학생이어야 한다. 학생이 여럿이면 필수' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) studentId?: number;
}

/* ══ §27 컨설팅 학생별 (C59) ═════════════════════════════════════════════ */

/** 학생 한 명 아래 걸린 계약 하나 */
export class ConsStudentCaseDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: '종류 코드' }) consType!: string;
  @ApiProperty({ description: '종류 이름 — 「국제학교 지원」 (서버 낱말 · 29-02)' }) typeLabel!: string;
  @ApiProperty({ type: String, enum: CONSULTING_STAGES }) stage!: ConsultingStage;
  @ApiProperty({ description: '단계 이름 — 낱말은 서버가 만든다 (D-R18)' }) stageLabel!: string;
  @ApiProperty({ description: '건이 생긴 날 — 계약 시작일이 아니다(그것은 startOn)', example: '2026-07-12' })
  createdOn!: string;
  /* 기간 칸은 「시작 ~ 종료」다 — 건이 생긴 날을 시작으로 적으면 §30·§31 머리와 다른 기간을 말한다 (27-05) */
  @ApiPropertyOptional({ ...S, description: '계약 시작일 — §29 「시작 *」(cons.start_on). 미정이면(옛 건 포함) null', example: '2026-07-12' })
  startOn?: string | null;
  @ApiPropertyOptional({ ...S, description: '종료 예정일 — 미정이면 null' }) endOn?: string | null;
  @ApiPropertyOptional(S) ownerName?: string | null;

  /* 셋 다 **서버가 센다** — 화면이 배열 길이를 세면 잠긴 건에서 분자가 0 이 된다 (D-R37) */
  @ApiProperty({ description: '기록된 회차 수 — 완료 회차가 아니다 (N-18 §4-17)' }) sessionsLogged!: number;
  @ApiProperty({ description: '오늘까지 한 회차 수 — §26 카드 · §30 머리와 **같은 셈**(날짜가 오늘 이하 또는 미정 · 27-04). 앞으로 잡아 둔 날짜는 세지 않는다' })
  sessionsDone!: number;
  @ApiPropertyOptional({ ...N, description: '약정 회차 — 미정이면 null' }) sessions?: number | null;
  @ApiProperty() itemsDone!: number;
  @ApiProperty() itemsTotal!: number;

  @ApiPropertyOptional({ ...N, description: '계약 금액 — 못 보면 null' }) amount?: number | null;
  @ApiPropertyOptional({ ...N, description: '받은 돈' }) paid?: number | null;

  @ApiProperty({
    type: [ConsItemDto],
    description: '진행 항목 — 내용이 잠긴 건은 빈 배열이다 (목록 계약과 같은 규약)',
  })
  items!: ConsItemDto[];
}

/** §27 왼쪽 줄 하나 = 학생 한 명 */
export class ConsStudentDto {
  @ApiProperty() studentId!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ ...S, description: '학년 — 없으면 null' }) grade?: string | null;
  @ApiProperty({ description: '이 사람이 볼 수 있는 건만 센다 — 원문 규칙 「csCan() 으로 볼 수 있는 것만 집계합니다」' })
  caseCount!: number;
  @ApiPropertyOptional({ ...N }) amount?: number | null;
  @ApiPropertyOptional({ ...N }) paid?: number | null;
  @ApiProperty({ type: [ConsStudentCaseDto] }) cases!: ConsStudentCaseDto[];
}

/** `GET /consulting/students` — §27 */
export class ConsStudentsDto {
  @ApiProperty({ type: [ConsStudentDto] }) items!: ConsStudentDto[];
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39)' }) canSeeAmounts!: boolean;
}

/* ══ C95 · §31 회차 기록 · 종료 (테스트 시나리오 I-91 · I-95 · N-18 채택) ═════════════════════════════════════════
 * 회차는 **날짜 여러 개를 한 번에** 잡는다(I-91 「날짜 3개 고르기」). 날짜마다 `cons_sess` 한 줄(순번은 서버) · 담당의 할 일(TODO) 한 줄 ·
 * 그날 그 담당의 컨설팅 회차(`kind=consulting`)가 시간표에 이미 있으면 **그 회차에 연결**하고, 없으면 **시간표 쓰기 그대로**
 * (`ScheduleWriteService.create` · ONCE · 겹침은 EXCLUDE 409 · 불가 시간은 응답) 하루짜리 회차를 만든다 — 원본 §2 「CONS.sess → SER → TODO」.
 * 미리보기는 같은 트랜잭션을 돌리고 되돌린다 (C91·C93 과 같은 모양 · D-R37).
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════════ */

export const CONS_SESSION_DATES_MAX = 31;

export class ConsSessionCreateDto {
  @ApiProperty({ type: [String], minItems: 1, maxItems: CONS_SESSION_DATES_MAX, uniqueItems: true, description: '회차 날짜들 YYYY-MM-DD — 연속일 필요 없다. 오름차순으로 순번을 붙인다' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(CONS_SESSION_DATES_MAX) @ArrayUnique() @IsCalendarDate({ each: true })
  dates!: string[];

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 1439, description: '시작 KST 분 — 그날 시간표에 이미 있는 회차에 연결될 때는 그 회차의 시각이 이긴다. 새로 만들 때는 필수' })
  @IsOptional() @IsInt() @Min(0) @Max(1439) startMin?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 1440 })
  @IsOptional() @IsInt() @Min(1) @Max(1440) endMin?: number;

  @ApiPropertyOptional({ ...ID_SCHEMA, description: '담당 — 없으면 건의 담당(owner). 활동 중인 직원' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) staffId?: number;

  @ApiPropertyOptional({ ...ID_SCHEMA, nullable: true, description: '새로 만드는 회차의 강의실' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) roomId?: number | null;

  @ApiPropertyOptional({ enum: ['offline', 'online'], description: '새로 만드는 회차의 방식 — 기본 offline' })
  @IsOptional() @IsIn(['offline', 'online']) mode?: 'offline' | 'online';

  @ApiPropertyOptional({ maxLength: 500, description: '「무엇을」 — 잡는 회차 전부에 같은 글이 들어간다. 회차마다 다르면 뒤에 따로 적는다' })
  @IsOptional() @IsString() @MaxLength(500) what?: string;
}

/** 회차의 육하원칙 — 보낸 칸만 바꾼다 (C93 PATCH 와 같은 규약) */
export class ConsSessionWriteDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200, description: '누가 — 비우면 서버가 잡을 때 적은 「담당 · 학생」이 남는다' })
  @IsOptional() @IsString() @MaxLength(200) who?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) @IsOptional() @IsString() @MaxLength(2000) what?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) @IsOptional() @IsString() @MaxLength(2000) why?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) @IsOptional() @IsString() @MaxLength(2000) how?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000, description: '결과 — 원본 §31 인용 상자 (31-08)' })
  @IsOptional() @IsString() @MaxLength(2000) result?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 120, description: '다음까지 — 바뀌어 적히면 담당의 할 일(TODO) 한 줄과 알림이 같은 트랜잭션에서 선다(슬라이드 31 연동 · 31-08). 한 회차에 할 일은 하나 — 고쳐 적으면 그 할 일의 제목을 바꾼다' })
  @IsOptional() @IsString() @MaxLength(120) nextUntil?: string | null;
}

/** 잡힌 회차 한 줄 — 미리보기와 확정이 같은 모양 */
export class ConsSessionPlanRowDto {
  @ApiProperty({ ...DATE_SCHEMA }) date!: string;
  @ApiProperty({ description: '서버가 붙인 순번' }) seq!: number;
  @ApiProperty(N) sessId!: number | null;
  @ApiProperty(N) serId!: number | null;
  @ApiProperty({ description: '시간표에 이미 있던 회차에 연결했는가 (false = 하루짜리 회차를 새로 만들었다)' }) linked!: boolean;
  @ApiProperty() startMin!: number;
  @ApiProperty() endMin!: number;
  @ApiProperty({ description: '오늘까지 한 회차인가' }) done!: boolean;
  @ApiProperty(N) todoId!: number | null;
}

export class ConsSessionsResultDto {
  @ApiProperty({ description: 'true 면 아무것도 쓰지 않았다' }) preview!: boolean;
  @ApiProperty() consId!: number;
  @ApiProperty() staffId!: number;
  @ApiProperty() staffName!: string;
  @ApiProperty({ type: [String] }) studentNames!: string[];
  @ApiProperty({ type: [ConsSessionPlanRowDto] }) rows!: ConsSessionPlanRowDto[];
  @ApiProperty({ description: '이번에 만든 하루짜리 회차 수' }) created!: number;
  @ApiProperty({ description: '이미 있던 회차에 연결한 수' }) linked!: number;
  @ApiProperty({ description: '잡은 뒤 오늘까지 한 회차 수' }) sessionsDone!: number;
  @ApiProperty({ description: '잡은 뒤 앞으로 남은 회차 수' }) sessionsPlanned!: number;
  @ApiProperty(N) sessions!: number | null;
  @ApiProperty({ description: '약정 회차를 넘겼는가 — 막지 않고 말한다 (seq ≤ sessions 규칙은 미확정 · N-18)' }) overContract!: boolean;
  @ApiProperty({ type: [UnavWarnDto], description: '새 회차가 담당의 불가 시간 위에 놓였으면 (C84-c 와 같은 알림)' }) unavailable!: UnavWarnDto[];
  @ApiProperty({ description: '담당에게 알림을 보냈는가 (돌린 사람 본인이면 false)' }) notified!: boolean;
}

/** 예외 종료 — 사유는 필수다(DQ6 권장안). 승인은 이 요청을 보낸 권한자다(서버가 권한을 본다) */
export class ConsCloseExceptionDto {
  @ApiProperty({ minLength: 1, maxLength: 500, description: '예외 종료 사유 — 감사 원장에 남긴다' })
  @IsString() @MinLength(1) @MaxLength(500) @Matches(/\S/, { message: '사유를 적어 주세요' }) reason!: string;
}

export class ConsCloseDto {
  @ApiPropertyOptional({ ...ID_SCHEMA, description: '안내 문구 틀(gtpl) — 고르면 그 본문이 안내문이 된다. 없으면 서버 기본 문장(예외 종료는 기본 문장이 없다)' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) templateId?: number;
  @ApiPropertyOptional({ maxLength: 500, description: '안내문 뒤에 붙는 한 줄 — 예외 종료에서 문구 틀을 안 고르면 이 글이 안내문 전부다' })
  @IsOptional() @IsString() @MaxLength(500) memo?: string;
  @ApiPropertyOptional({
    type: () => ConsCloseExceptionDto,
    description: '예외 종료(N-18-a) — 필수 항목·약정 회차가 남은 진행 중 건을 사유와 함께 닫는다. 승인 권한(대표 전용 판정)이 있어야 하고, 학부모 안내는 사람이 고른 문구 틀이나 적은 글만 쓴다',
  })
  @IsOptional() @ValidateNested() @Type(() => ConsCloseExceptionDto)
  exception?: ConsCloseExceptionDto;
}

export class ConsCloseResultDto {
  @ApiProperty({ description: 'true 면 아무것도 쓰지 않았다' }) preview!: boolean;
  @ApiProperty() consId!: number;
  @ApiProperty({ enum: CONSULTING_STAGES }) stage!: ConsultingStage;
  @ApiProperty({ type: [String] }) studentNames!: string[];
  @ApiProperty({ description: '학부모 안내문 본문 — PNOTI parent 행에 그대로 남는다 (발송처는 N-42)' }) noticeBody!: string;
  @ApiProperty({ description: '남긴 학부모 안내 행 수 (학생마다 하나)' }) parentNotices!: number;
  @ApiProperty() sessionsDone!: number;
  @ApiProperty(N) sessions!: number | null;
  @ApiProperty(S) endOn!: string | null;
  @ApiProperty({ description: '담당에게 알림을 보냈는가' }) notified!: boolean;
  @ApiProperty({ description: '예외 종료였는가 — 남은 항목·회차와 사유가 감사 원장에 남는다 (N-18-a)' }) exception!: boolean;
}
