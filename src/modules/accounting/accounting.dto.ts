/** @file-guide
 * 목적: accounting.dto.ts — PAY_METHODS, EXPENSE_CATEGORIES, EXPENSE_SETTLED, EXPENSE_CATEGORY_LABEL, InvoiceLineDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

/** 입금 수단 — 지금 저장되는 두 가지뿐이다. 코드표 확장은 원문 근거가 생길 때 한다 (발명 금지) */
export const PAY_METHODS = ['transfer', 'cash'] as const;

/**
 * 지출 계정과목 — **간이 5분류(A-D5) + 임대료**.
 *
 * A-D5 의 5분류는 「**카드 사용** 분류」이고(ACCOUNTING §6), 임대료는 §56 의 부대비용 고정비라
 * 카드 분류에 넣을 자리가 없다. `erd.dbml` 의 기존 6낱말 주석과도 같다.
 * 라벨은 **서버가 내려보낸다** — 화면에 코드표를 복사해 두지 않는다 (D-R18).
 */
export const EXPENSE_CATEGORIES = ['rent', 'book', 'supply', 'ent', 'fee', 'etc'] as const;

/**
 * 「나간 돈」에 드는 지출 상태 — **낱말 하나**다 (C43-b).
 * 결재 중인 신청은 아직 나간 돈이 아니다. 머리의 「남은 돈」과 §56 분류 합계가 같은 집합을 봐야 한다.
 * `expense.state` 는 CHECK `expense_state_words` 가 세 낱말로 지킨다.
 */
export const EXPENSE_SETTLED = 'approved';
export const EXPENSE_CATEGORY_LABEL: Record<string, string> = {
  rent: '임대료', book: '도서·교재비', supply: '소모품비', ent: '접대비', fee: '지급수수료', etc: '기타',
};

export class InvoiceLineDto {
  @ApiPropertyOptional({ type: String, nullable: true }) subKey?: string | null;
  @ApiProperty() label!: string;
  @ApiProperty() count!: number;
  @ApiProperty() unitPrice!: number;
  @ApiProperty() amount!: number;
}

export class InvoiceDto {
  @ApiProperty() id!: number;
  @ApiProperty() studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) grade?: string | null;
  @ApiProperty() yearMonth!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: Number, nullable: true, description: '금액 — canMoney 가 아니면 null 로 내려간다 (D-R39)' }) amount!: number | null;
  @ApiProperty({ type: Number, nullable: true }) paidAmount!: number | null;
  @ApiProperty({ enum: ['draft', 'sent', 'unpaid', 'partial', 'paid', 'void'] }) state!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) issuedOn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) dueOn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) paidAt?: string | null;
  @ApiProperty({ type: Number, nullable: true, description: '청구액 − 확정 누계. 다음 입금의 placeholder 다 (A-D2)' }) remaining!: number | null;
  @ApiProperty({ description: '예정일이 지났는데 안 들어온 날 수. 0이면 연체 아님' }) overdueDays!: number;
  @ApiProperty({ type: [InvoiceLineDto] }) lines!: InvoiceLineDto[];
}

/**
 * 청구 종류 — **원본 §53 카드에 실제로 붙어 있는 배지 두 가지뿐이다.**
 *
 * `inv.entity.ts` 주석은 「청구 종류 6종」이라고 적어 두었는데 **원문에 그 여섯의 목록이 없다.**
 * 여섯을 지어내면 그 목록이 곧 발명이 된다 (D-R44). 컷이 보여 준 둘만 둔다 —
 * 「수업료 청구」·「컨설팅비 청구」. 셋째가 필요해지면 그때 원문 근거와 함께 늘린다.
 * (DB `inv.inv_type` 은 varchar 라 CHECK 가 없다. 낱말을 굳히는 것도 목록이 확정된 뒤다.)
 */
export const INV_TYPES = ['tuition', 'consulting'] as const;
export const INV_TYPE_LABEL: Record<string, string> = {
  tuition: '수업료 청구', consulting: '컨설팅비 청구',
};

/**
 * 청구서 한 장을 새로 낸다 (§53 「+ 새 청구서 발행」).
 *
 * **줄(INV_LINE)은 받지 않는다.** 원문 명세가 「횟수는 서버가 `occ()` 로 센다 —
 * 프론트가 세면 예외(EXC)를 빠뜨린다」고 못 박았다. 화면이 센 숫자를 받으면
 * 그 순간 횟수를 세는 자리가 둘이 된다 (D-R37 · D-R18).
 * 누구의 어느 달인지만 주면 나머지는 서버가 만든다.
 */
export class InvoiceIssueDto {
  @ApiProperty({ description: '누구에게' })
  @IsInt() @Min(1) studentId!: number;

  @ApiProperty({ description: '어느 달 — YYYY-MM', example: '2026-08' })
  @IsString() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: '달은 YYYY-MM 입니다' })
  yearMonth!: string;

  @ApiProperty({ description: '청구 종류', enum: INV_TYPES })
  @IsIn(INV_TYPES as unknown as string[]) invType!: string;

  @ApiPropertyOptional({ description: '제목 — 비우면 서버가 「2026년 8월 수업료」처럼 짓는다' })
  @IsOptional() @IsString() @MaxLength(80) title?: string;

  @ApiPropertyOptional({ description: '납기일 — YYYY-MM-DD', type: String })
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '납기일은 YYYY-MM-DD 입니다' })
  dueOn?: string;
}

export class PaymentDto {
  @ApiProperty() id!: number;
  @ApiProperty({ type: String, format: 'date', nullable: true, description: '입금일 — 미확인 날짜는 null이며 문자열 null이 아니다' }) paidOn!: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) studentId?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) studentName?: string | null;
  @ApiProperty({ type: Number, nullable: true, description: '실제 입금액. null은 미확인 또는 금액 권한 없음; summary.canSeeAmounts로 구분. 0은 확인된 0원' }) amount!: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) method?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: '청구액과 다를 때의 사유 · 분납 회차 메모 (A-D2)' }) reason?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) invId?: number | null;
}

/**
 * 입금 한 줄 등록 — **분납은 줄을 늘려서 표현한다** (A-D2 · PLANNING §4-17).
 * 누계·상태 전이·초과 판정은 전부 서버가 한다. 화면은 잔여를 placeholder 로만 보여 준다 (ACCOUNTING §0).
 */
export class PaymentCreateDto {
  @ApiProperty({ description: '어느 청구서에 붙는 입금인가' })
  @IsInt() @Min(1)
  invId!: number;

  @ApiProperty({ description: '이번에 들어온 금액(원). 누계가 청구액을 넘으면 OVERPAY 로 거절한다' })
  @IsInt() @Min(1)
  amount!: number;

  @ApiProperty({ description: '입금일 YYYY-MM-DD' })
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '입금일은 YYYY-MM-DD 입니다' })
  paidOn!: string;

  @ApiPropertyOptional({ enum: PAY_METHODS })
  @IsOptional() @IsIn(PAY_METHODS as unknown as string[])
  method?: string;

  @ApiPropertyOptional({ description: '청구액과 다를 때의 사유 — 분납 회차 메모로도 쓴다' })
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

/** 나간 돈 한 줄 — 법인카드 신청분은 `requestedAmount` 가 채워져 있다 (§56) */
export class ExpenseDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: '사용일 YYYY-MM-DD' }) spendOn!: string;
  @ApiProperty({ enum: EXPENSE_CATEGORIES }) category!: string;
  @ApiProperty({ description: '분류 이름 — 코드표는 서버가 소유한다 (D-R18)' }) categoryLabel!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) merchant?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) purpose?: string | null;
  @ApiProperty({ type: Number, nullable: true, description: '직원이 올린 신청 금액 — 승인 칸의 placeholder 다 (A-1)' }) requestedAmount!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '확정 금액. null 은 미심사이거나 금액 권한 없음' }) amount!: number | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: '신청액과 다를 때 필수 (A-3)' }) reason?: string | null;
  @ApiProperty({ description: '영수증 없이는 승인할 수 없다 (A-4)' }) hasReceipt!: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) requesterName?: string | null;
  @ApiProperty({ type: Number, nullable: true, description: '본인 신청은 본인이 승인할 수 없다 (A-5)' }) requesterId!: number | null;
  @ApiProperty({ enum: ['pending', 'approved', 'rejected'] }) state!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) reviewerName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) reviewedAt?: string | null;
}

/**
 * 법인카드 심사 — **증액은 없다** (A-D3 채택: 증액 금지 · 재신청).
 * 감액 승인은 사유가 있어야 하고, 영수증이 없으면 승인 자체가 안 된다.
 */
export class ExpenseReviewDto {
  @ApiProperty({ enum: ['approve', 'reject'] })
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';

  @ApiPropertyOptional({ description: '확정 금액. 승인일 때 필수이며 신청 금액을 넘을 수 없다 (A-D3)' })
  @IsOptional() @IsInt() @Min(0)
  amount?: number;

  @ApiPropertyOptional({ description: '신청액과 다르거나 반려일 때 필수 (A-3)' })
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

export class PayoutDto {
  @ApiProperty() id!: number;
  @ApiProperty() staffId!: number;
  @ApiProperty() staffName!: string;
  @ApiProperty() yearMonth!: string;
  @ApiProperty() hours!: string;
  @ApiProperty({ type: Number, nullable: true }) gross!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '리포트 지연 차감 (D-R32)' }) lateRepCut!: number | null;
  @ApiProperty({ type: Number, nullable: true }) incomeTax!: number | null;
  @ApiProperty({ type: Number, nullable: true }) localTax!: number | null;
  @ApiProperty({ type: Number, nullable: true }) net!: number | null;
  /**
   * 확정됐는가 — **`payout.state` 낱말은 내려보내지 않는다** (N-27 · 대표 결정 2026-09-12).
   * 판정은 `lib/rules` 한 곳에서 `confirmed_by` 로 낸다. 낱말을 같이 보내면 화면이 그것으로
   * 다시 판정하게 되고, 그 순간 같은 질문에 답이 둘이 된다. 「지급 완료(paid)」 같은 갈래가
   * 필요해지면 그때 낱말을 정하고 칸을 만든다 — 지금 없는 구분을 있는 척 내보내지 않는다.
   */
  @ApiProperty({ description: '확정됐는가 — 누가 확정했는가(confirmed_by)로 본다 (N-27)' }) confirmed!: boolean;
}

/**
 * 회계 머리 **여섯 칸** — §52·§56 원문 그대로다 (C43).
 *
 * 원본 표본: 보낸 청구서 ₩7,214,000 · 받은 돈 ₩4,377,400 · 못 받은 돈 ₩2,836,600 ·
 * 기한 지남 ₩1,170,000 · 남은 돈 ₩-3,052,172 · 손봐야 할 것 6건.
 * **원문 안에서 산술이 닫힌다** — 7,214,000 − 4,377,400 = 2,836,600. 그래서 「못 받은 돈」은
 * 화면이 빼는 값이 아니라 서버가 한 곳에서 내는 값이다 (D-R18).
 *
 * 다섯 칸은 금액이라 권한이 없으면 **null 로 내려간다**(D-R39). 「손봐야 할 것」은 건수이므로
 * 가리지 않는다 — 대표 보고의 회계 배지와 **같은 판정**을 쓴다(`lib/exec-areas` money).
 */
export class MoneySummaryDto {
  @ApiProperty({ type: Number, nullable: true, description: '보낸 청구서 — 초안·취소를 뺀 청구액 합' }) sent!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '받은 돈 — 같은 집합의 확정 입금 합' }) collected!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '못 받은 돈 = 보낸 청구서 − 받은 돈' }) unpaid!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '기한 지남 — **금액**이다. 못 받은 돈의 부분집합' }) overdue!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '남은 돈 = 받은 돈 − 나간 돈(승인 지출 + 확정 정산). 음수가 정상이다' }) net!: number | null;
  @ApiProperty({ description: '손봐야 할 것 — 건수라 가리지 않는다 (§69 회계 배지와 같은 판정)' }) todo!: number;
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39 · 사람별 예외까지 반영된 canMoney)' }) canSeeAmounts!: boolean;
}

/**
 * §56 분류별 지출 합계 — **화면이 더하지 않는다** (C43-b · 대표 지시 「전부 단일 진실원」).
 *
 * 전에는 회계 화면이 지출 줄을 받아 분류별로 직접 더했다. 같은 돈을 머리(「남은 돈」)와
 * 여기서 각각 세면 두 숫자가 어긋날 수 있고, 어긋나도 아무도 모른다 (AGENT §9).
 */
export class ExpenseTotalDto {
  @ApiProperty({ enum: EXPENSE_CATEGORIES }) category!: string;
  @ApiProperty({ description: '분류 이름 — 코드표는 서버가 소유한다 (D-R18)' }) categoryLabel!: string;
  @ApiProperty({ type: Number, nullable: true, description: '확정된 지출의 합 — 권한이 없으면 null (D-R39)' }) sum!: number | null;
}

export class AccountingDto {
  @ApiProperty({ type: MoneySummaryDto }) summary!: MoneySummaryDto;
  @ApiProperty({ type: [InvoiceDto] }) invoices!: InvoiceDto[];
  @ApiProperty({ type: [PaymentDto] }) payments!: PaymentDto[];
  @ApiProperty({ type: [PayoutDto] }) payouts!: PayoutDto[];
  @ApiProperty({ type: [ExpenseDto], description: '나간 돈 §56 — 부대비용·법인카드 신청분' }) expenses!: ExpenseDto[];
  @ApiProperty({ type: [ExpenseTotalDto], description: '§56 분류별 확정 지출 합계 — 화면이 더하지 않는다' }) expenseTotals!: ExpenseTotalDto[];
}
