/** @file-guide
 * 목적: consulting.dto.ts — ConsultingSessionDto, ConsItemDto, ConsItemToggleDto, ConsultingDto, ConsultingListDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString,
  Matches, Max, MaxLength, Min, MinLength, ValidateBy,
} from 'class-validator';
import { DATE_SCHEMA, ID_SCHEMA, IsCalendarDate } from '../../common/validation';
import { UnavWarnDto } from '../schedule/schedule.dto';
import { CONS_SHARES, type ConsShare } from '../../lib/rules';
import {
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
}


/** §31 진행 항목 한 줄 — 원장 행 그대로. 진행률은 화면이 세고 서버는 저장하지 않는다 (47D-A). */
export class ConsItemDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: '건별 항목 순번' }) seq!: number;
  @ApiProperty({ maxLength: 80 }) label!: string;
  @ApiProperty({ description: '필수 지정은 종료 전이 게이트(47D-C)와 함께 확정 — 지금은 표기만' }) required!: boolean;
  @ApiProperty() done!: boolean;
  @ApiPropertyOptional({ ...S, description: '처리자 이름 — 미완료면 null' }) doneBy?: string | null;
  @ApiPropertyOptional({ ...S, format: 'date', description: '처리일 — 미완료면 null' }) doneOn?: string | null;
  @ApiProperty({ description: 'template(§29 자동 생성분) | manual(N-18-a 확정 전 쓰기 없음)' }) source!: string;
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
  @ApiPropertyOptional({ ...S, description: '계약 단계 이름 — 「피드백」. 미정이면 null' })
  contractStepLabel?: string | null;
  @ApiPropertyOptional({ ...S, description: '요청자 — 「어머니」. 안 적혔으면 null' })
  requesterLabel?: string | null;
  @ApiProperty({ description: '시작한 지 며칠 — 원본 「60일 지남」 (D-R37)' }) ageDays!: number;
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

export class ConsultingListDto {
  @ApiProperty({ type: [ConsultingDto] }) items!: ConsultingDto[];
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39)' }) canSeeAmounts!: boolean;
  @ApiProperty({ description: '「비공개」로 지정할 수 있는가 — §76 대표 전용. 화면의 공개 범위 고르개가 이 값으로 그 칸을 뺀다 (S4 · D-R39)' })
  canSetPrivate!: boolean;
  @ApiProperty({ type: [ConsultingStageDto], description: '§26 칸 셋 — 빈 칸도 이름과 한 줄을 갖는다' })
  stages!: ConsultingStageDto[];
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
  @ApiProperty({ minimum: 1, maximum: CONSULTING_SESSION_MAX, description: '약정 회차. 실제 일정 생성 정책은 미확정이므로 저장만 하며 수업을 자동 생성하지 않는다.' }) @IsInt() @Min(1) @Max(CONSULTING_SESSION_MAX) sessions!: number;
  @ApiProperty({ ...DATE_SCHEMA }) @IsCalendarDate() startOn!: string;
  @ApiProperty({ ...DATE_SCHEMA }) @IsCalendarDate() endOn!: string;
  @ApiProperty({ enum: CONS_SHARES }) @IsIn(CONS_SHARES as unknown as string[]) share!: ConsShare;

  @ApiPropertyOptional({ type: [Number], items: ID_SCHEMA, uniqueItems: true, description: "share='picked'일 때 1명 이상 필수, 그 밖에는 비워야 한다." })
  @IsPickedStaffIds()
  pickedStaffIds?: number[];
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
  @ApiProperty({ description: '실제 일정 생성 정책은 원본에 없어 현재 false' }) scheduleCreationSupported!: boolean;
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
  @ApiProperty() canAddPayment!: boolean;
  @ApiProperty() canCreateInvoice!: boolean;
  @ApiProperty() canArchive!: boolean;
  @ApiProperty({ description: '학부모 연락처/채널 정책 미제공으로 현재 false. deliver는 외부 발송이 아니라 완료 기록이다.' }) externalParentSendSupported!: boolean;
  @ApiProperty({ type: String, nullable: true }) externalParentSendReason!: string | null;
  /* ── C95 · §31 회차 · 종료 ── */
  @ApiProperty({ description: '회차를 더 잡을 수 있는가 — 진행(running) 중인 건만 (I-91)' }) canAddSession!: boolean;
  @ApiProperty({ description: '종료할 수 있는가 — N-18 채택 「필수 항목 + 약정 회차 후 명시 종료」를 서버가 판정한다 (I-95)' }) canClose!: boolean;
  @ApiProperty({ type: String, nullable: true, description: '종료가 막힌 이유 문장 — 화면이 그대로 띄운다. 열려 있으면 null' }) closeBlockedReason!: string | null;
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

/** §28 표 한 줄 — 계약 하나의 돈 */
export class ConsAccountRowDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: '학생 — 여럿이면 쉼표로 잇는다' }) studentName!: string;
  @ApiProperty({ description: '종류 코드' }) consType!: string;
  @ApiProperty({ type: String, enum: CONSULTING_STAGES }) stage!: ConsultingStage;
  @ApiProperty({ description: '단계 이름 — 낱말은 서버가 만든다 (D-R18)' }) stageLabel!: string;

  @ApiPropertyOptional({ ...N, description: '계약 금액 — 못 보면 null' }) amount?: number | null;
  @ApiPropertyOptional({ ...N, description: '받은 돈 — 납부 기록의 합' }) paid?: number | null;
  /** 남은 돈 — **서버가 뺀다.** 화면이 계약 − 받음을 다시 하면 머리 칸의 합계와 갈린다 (D-R37) */
  @ApiPropertyOptional({ ...N, description: '남은 돈 — 서버가 뺀다' }) due?: number | null;

  @ApiProperty({ type: [ConsPaymentDto], description: '납부 기록 — 청구서로 전환해도 그대로 남는다' })
  payments!: ConsPaymentDto[];

  @ApiPropertyOptional({ ...N, description: '전환된 청구서 — 없으면 null' }) invId?: number | null;
  @ApiProperty({ description: '청구서로 전환할 수 있는가 — 이미 살아 있는 청구서가 있으면 false' })
  canInvoice!: boolean;
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

/* ══ §27 컨설팅 학생별 (C59) ═════════════════════════════════════════════ */

/** 학생 한 명 아래 걸린 계약 하나 */
export class ConsStudentCaseDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: '종류 코드' }) consType!: string;
  @ApiProperty({ type: String, enum: CONSULTING_STAGES }) stage!: ConsultingStage;
  @ApiProperty({ description: '단계 이름 — 낱말은 서버가 만든다 (D-R18)' }) stageLabel!: string;
  @ApiProperty({ description: '건이 생긴 날 — 계약 시작일이라는 칸은 원문에 없다', example: '2026-07-12' })
  createdOn!: string;
  @ApiPropertyOptional({ ...S, description: '종료 예정일 — 미정이면 null' }) endOn?: string | null;
  @ApiPropertyOptional(S) ownerName?: string | null;

  /* 셋 다 **서버가 센다** — 화면이 배열 길이를 세면 잠긴 건에서 분자가 0 이 된다 (D-R37) */
  @ApiProperty({ description: '기록된 회차 수 — 완료 회차가 아니다 (N-18 §4-17)' }) sessionsLogged!: number;
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

export class ConsCloseDto {
  @ApiPropertyOptional({ ...ID_SCHEMA, description: '안내 문구 틀(gtpl) — 고르면 그 본문이 안내문이 된다. 없으면 서버 기본 문장' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) templateId?: number;
  @ApiPropertyOptional({ maxLength: 500, description: '안내문 뒤에 붙는 한 줄' })
  @IsOptional() @IsString() @MaxLength(500) memo?: string;
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
}
