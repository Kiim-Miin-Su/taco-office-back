/** @file-guide
 * 목적: consulting.dto.ts — ConsultingSessionDto, ConsItemDto, ConsItemToggleDto, ConsultingDto, ConsultingListDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { CONS_SHARES, type ConsShare } from '../../lib/rules';
import { CONSULTING_STAGES, CONTRACT_STEP_MAX, CONSULTING_SESSION_MAX, type ConsultingStage } from './consulting.rules';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;

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

  @ApiProperty({ type: [ConsultingSessionDto] }) sessionsLog!: ConsultingSessionDto[];

  /** §31 진행 항목 — 회차 기록과 별개 원장 (N-18 §4-17). 내용이 잠기면 회차처럼 내려가지 않는다. */
  @ApiProperty({ type: [ConsItemDto] }) items!: ConsItemDto[];
}

export class ConsultingListDto {
  @ApiProperty({ type: [ConsultingDto] }) items!: ConsultingDto[];
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39)' }) canSeeAmounts!: boolean;
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
  @ApiProperty({ description: '받은 금액 — 0 원은 기록이 아니라 실수다', minimum: 1 })
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
