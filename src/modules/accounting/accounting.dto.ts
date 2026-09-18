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
  /*
   * 상태의 **낱말**. 회계 화면 파일이 여섯을 직접 적고 있었고, 그러면 상태 이름이 바뀌던 날
   * 그 자리만 뒤처져 **같은 행을 §53 표와 §57 줄이 다르게 부른다**(C64 가 청구 종류에서 고친 모양).
   * 줄이 제 낱말을 들고 오므로 화면이 코드표를 따로 받을 필요가 없다 — `/meta` 를 한 번 더 부르면
   * C50 이 고쳐 둔 「회계 화면에 들어갈 때마다 코드표를 받아 오던」 자리로 되돌아간다.
   */
  @ApiProperty({ description: '상태의 이름 — 낱말은 서버가 만든다 (D-R18)' }) stateLabel!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) issuedOn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) dueOn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) paidAt?: string | null;
  @ApiProperty({ type: Number, nullable: true, description: '청구액 − 확정 누계. 다음 입금의 placeholder 다 (A-D2)' }) remaining!: number | null;
  @ApiProperty({ description: '예정일이 지났는데 안 들어온 날 수. 0이면 연체 아님' }) overdueDays!: number;
  @ApiProperty({ type: [InvoiceLineDto] }) lines!: InvoiceLineDto[];
}

/**
 * 청구 종류 — **넷** (대표 결정 2026-09-13 · N-37).
 *
 * C50 은 둘만 두었다 — 원본 §53 카드의 배지가 둘이었고, 엔티티 주석의 「청구 종류 6종」은
 * **원문에 그 여섯의 목록이 없어** 지어내지 않았다. 그 뒤 §57 컷의 「그 밖의 수입」이
 * **수업료가 아닌 돈을 세 줄로 갈라** 보여 준다는 것을 찾았다 —
 * 「진단고사 + 상담 비용(진단고사 · 입학 상담)」·「컨설팅비(진학 컨설팅 · 인터뷰 준비)」·
 * 「MAP + CAT(MAP · CAT 응시료)」. 그 셋에 수업료를 더한 **넷**이 정본이다.
 *
 * **이름은 컷에서 읽었고 코드는 우리가 붙였다** — 원문이 코드값을 주지 않는다
 * (`CONSULTING_TYPES` 와 같은 선례 · D-R44). 코드는 저장값이라 나중에 바꾸면 데이터 이관이다.
 *
 * 여섯이 아니라 넷인 것도 적어 둔다 — 엔티티 주석의 「6종」은 **여전히 근거가 없다.**
 * 컷이 보여 준 것은 넷이고, 다섯째가 필요해지면 그때 원문 근거와 함께 늘린다.
 */
export const INV_TYPES = ['tuition', 'consulting', 'diag_intake', 'exam_fee'] as const;
export const INV_TYPE_LABEL: Record<string, string> = {
  tuition: '수업료 청구',
  consulting: '컨설팅비 청구',
  diag_intake: '진단고사 + 상담 비용',
  exam_fee: 'MAP + CAT 응시료',
};
/** §57 「그 밖의 수입」 — 수업료가 아닌 돈. 컷의 부제 그대로 */
export const INV_TYPE_SUB: Record<string, string> = {
  tuition: '정규 수업',
  consulting: '진학 컨설팅 · 인터뷰 준비',
  diag_intake: '진단고사 · 입학 상담',
  exam_fee: 'MAP · CAT 응시료',
};
/**
 * §57 「그 밖의 수입」 **줄 제목** — §53 카드의 칩과 낱말이 다르다.
 *
 * 컷을 나란히 놓으면 같은 종류를 세 화면이 **다르게 부른다** —
 *   · §53 카드 칩   「컨설팅비 **청구**」 · 「수업료 **청구**」
 *   · §57 줄 제목   「컨설팅비」 · 「진단고사 + 상담 비용」 · 「**MAP + CAT**」(부제가 「MAP · CAT 응시료」)
 *   · §55 분류 칩   「컨설팅비」 · 「진단고사 · 상담」 · 「시험 응시료」
 * 하나로 접으면 어느 화면이든 원문과 다른 말을 하게 된다. 그래서 쓰는 자리마다 갖는다 (D-R18).
 * `INV_TYPE_LABEL` 은 §53 칩 쪽이고 여기는 §57 줄이다.
 */
export const INV_TYPE_ROW: Record<string, string> = {
  tuition: '수업료',
  consulting: '컨설팅비',
  diag_intake: '진단고사 + 상담 비용',
  exam_fee: 'MAP + CAT',
};

/**
 * 청구서 상태의 **낱말** — 화면이 짓지 않는다 (D-R18).
 *
 * C64 가 청구 종류를 화면에서 서버로 옮긴 것과 같은 자리다. 낱말이 화면 파일에 있으면
 * 상태가 늘거나 이름이 바뀌던 날 그 자리가 바로 뒤처지고, **두 화면이 같은 행을 다르게 부른다.**
 * 값은 `inv_state_t` 여섯 그대로이고 이름만 여기 한 벌 둔다.
 */
export const INV_STATE_LABEL: Record<string, string> = {
  draft: '작성 중',
  sent: '전달',
  unpaid: '미납',
  partial: '일부 납부',
  paid: '입금 완료',
  void: '취소',
};

/** 수업료가 아닌 종류 — §57 「그 밖의 수입」이 세는 것 */
export const INV_TYPES_OTHER = INV_TYPES.filter((t) => t !== 'tuition');

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

/**
 * §55 「들어온 돈」의 **분류 여섯** — 대표 결정 2026-09-13 (N-37 ③).
 *
 * 「**Entity, DTO 의 정합성과 단일 진실원 해결**」. 그래서 **새 칸을 만들지 않는다** —
 * 여섯이 전부 **읽어서 만드는 값**이다:
 *   · `pay.inv_id → inv.inv_type` 이 넷을 준다 (수업료 · 컨설팅비 · 진단고사 · 시험 응시료)
 *   · `pay.inv_id IS NULL`(「매니저가 직접 넣은 건」 · A-D1)이 **「기타」**를 준다
 *   · 수업료 중 **`kind = 'gpa'` 수업으로 만들어진 것**이 **「GPA 관리비」**다
 *     (`inv_line.sub_key → sub.kind_key` 로 줄에서 읽힌다)
 *
 * 이것이 C50·C64 가 두 번 「원문에 6종의 목록이 없다」고 적은 그 여섯의 정체다 —
 * **청구 종류(`INV_TYPES`)가 아니라 입금의 분류**다. 그래서 `INV_TYPES` 는 넷 그대로다.
 *
 * 이름은 **§55 컷의 낱말**이고 §53 칩(`INV_TYPE_LABEL`)·§57 줄(`INV_TYPE_ROW`)과 또 다르다 —
 * 같은 종류를 세 화면이 다르게 부른다는 것을 C66 에서 적었다. 접지 않고 쓰는 자리마다 갖는다 (D-R18).
 */
export const PAY_CATEGORIES = [
  { key: 'tuition', label: '수업료' },
  { key: 'gpa', label: 'GPA 관리비' },
  { key: 'consulting', label: '컨설팅비' },
  { key: 'diag_intake', label: '진단고사 · 상담' },
  { key: 'exam_fee', label: '시험 응시료' },
  { key: 'etc', label: '기타' },
] as const;

export type PayCategoryKey = (typeof PAY_CATEGORIES)[number]['key'];
export const PAY_CATEGORY_LABEL: Record<string, string> =
  Object.fromEntries(PAY_CATEGORIES.map((c) => [c.key, c.label]));

/**
 * 입금 한 줄의 분류 — **판정은 이 함수 하나뿐이다** (D-R39).
 *
 * 청구서가 없으면 「기타」다 — 그것이 `pay.inv_id` 가 nullable 인 자리이고,
 * 여섯 중 「기타」만 청구 종류로는 설명되지 않는 이유다.
 */
export function payCategory(invType: string | null, isGpa: boolean): PayCategoryKey {
  if (invType === null) return 'etc';
  if (invType === 'tuition') return isGpa ? 'gpa' : 'tuition';
  return (PAY_CATEGORIES.some((c) => c.key === invType) ? invType : 'etc') as PayCategoryKey;
}

/** §55 분류 칩 한 개 — 「수업료 2」 */
export class PayCategoryDto {
  @ApiProperty() key!: string;
  @ApiProperty({ description: '§55 컷의 낱말' }) label!: string;
  @ApiProperty({ description: '그 분류의 건수 — 화면이 세지 않는다 (D-R37)' }) count!: number;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '그 분류로 들어온 돈' }) amount?: number | null;
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
  /*
   * §55 의 **분류** — 저장된 칸이 아니라 **읽어서 만든 값**이다 (N-37 ③ · 대표 결정).
   * 낱말도 서버가 만든다 — 화면이 코드값을 찍지 않는다 (D-R18).
   */
  @ApiProperty({ description: '분류 코드 — 여섯 (N-37 ③)' }) category!: string;
  @ApiProperty({ description: '분류 이름 — §55 컷의 낱말' }) categoryLabel!: string;
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
  @ApiProperty({
    type: [PayCategoryDto],
    description: '§55 분류 칩 여섯 — **건수가 0이어도 선다**(분류는 어휘이지 데이터가 아니다). 화면이 세지 않는다 (D-R37)',
  })
  payCategories!: PayCategoryDto[];
}

/* ══ §54 수업료 계산 (C65) ═══════════════════════════════════════════════
 * 원문 슬라이드 54 — 「데이터 RATE(단가), STURATE(학생별 예외), ENR」 ·
 * 「동작 단가 수정 시 전체 재계산」 · 「규칙 그룹 수업은 인원이 늘면 1인 단가가 내려가고
 * 총액은 올라갑니다」 · 「연동 **청구서 생성 시 이 계산 결과를 씁니다**」.
 *
 * 마지막 줄이 이 화면의 정체다 — **청구서가 쓰는 바로 그 계산을 미리 보는 자리**다.
 * 그래서 단가를 여기서 다시 세지 않는다. `invoice-lines.ts` 한 벌을 청구서와 같이 쓴다 (D-R22).
 * ═══════════════════════════════════════════════════════════════════════ */

/** 한 학생의 이번 달 수업료 — 표 한 줄 */
export class TuitionRowDto {
  @ApiProperty() studentId!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) grade?: string | null;

  /* 세는 것은 전부 서버다 (D-R37) — 화면이 회차를 세면 예외(EXC)를 빠뜨린다 */
  @ApiProperty({ description: '이번 달에 **이미 한** 수업 수' }) done!: number;
  @ApiProperty({ description: '이번 달 전체 수업 수 (결강 제외)' }) total!: number;
  @ApiProperty({ description: '얼마나 갔나 — 0~100. 화면이 나누지 않는다' }) percent!: number;
  @ApiProperty({ description: '결강·휴강 수 — 이월·보강 이관으로 처리된 휴강과 「그날만 빠진」 것을 합쳐 센다 (D-R21). 차감은 여기 안 든다' })
  canceled!: number;
  @ApiProperty({ description: '차감(소진)으로 처리된 휴강 수 — 이번 달 회차로 세어 청구한다 (C92 · C-31)' })
  deducted!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '대표 단가 — 가장 많이 쓰인 1회 단가. 못 보면 null' })
  unitPrice?: number | null;
  @ApiProperty({ description: '그 단가가 학생별 예외(STURATE)에서 왔는가 — 「개별 단가」 / 「일반」' })
  unitPriceOverride!: boolean;
  /*
   * 이 달에 이 학생에게 **몇 가지 단가가 붙었는가.** 둘 이상이면 화면은 대표 단가 하나를 적지 않는다 —
   * 「15회 × 20,000원」으로 읽히는데 옆 칸은 540,000원이면, 곱해서 안 맞는 숫자를 돈 화면에 세우는 것이다.
   * 0 이면 단가표에 그 과목이 없다 — 「단가 없음」이라 적고 0원으로 꾸미지 않는다.
   */
  @ApiProperty({ description: '이 달에 붙은 단가의 가짓수 — 0(단가 없음) · 1(그 값) · 2 이상(여러 단가)' })
  priceCount!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '지금까지 금액 — 이미 한 수업의 합' }) doneAmount?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '다음 달로 넘길 돈 — 결강한 회차의 합' }) carryAmount?: number | null;

  /*
   * **이월할 수 있는가** — 대표 결정 2026-09-13 (N-39):
   * 「이월 처리는 **수업이 결제 됐으나 정해진 시수가 채워지지 않은 경우**」.
   * 그래서 둘이 모두 참이어야 한다 — ① 그 달 수업료 청구서가 **완납**이고 ② 못 해 준 수업이 있다.
   * **돈을 안 받았으면 이월할 것이 없다** — 그냥 안 청구된 것이고 §54 가 이미 빼고 있다.
   * 판정은 서버가 한다 — 화면이 「완납인가」를 다시 읽으면 단추가 서는 줄과 서버의 답이 갈린다 (D-R39).
   */
  @ApiProperty({ description: '이월 처리를 누를 수 있는가 (N-39)' }) carryable!: boolean;
  @ApiPropertyOptional({
    type: String, nullable: true,
    description: '이미 넘겼으면 그 시각 — 한 달은 한 번만 넘긴다',
  })
  carriedAt?: string | null;
  @ApiPropertyOptional({
    type: Number, nullable: true,
    description: '지난달에서 **넘어온** 돈 — 이 달이 받은 것이다',
  })
  carriedIn?: number | null;

  @ApiProperty({ type: [InvoiceLineDto], description: '내역 — 청구서가 쓸 바로 그 줄이다' })
  lines!: InvoiceLineDto[];
}

/** `GET /accounting/tuition?month=YYYY-MM` — 달을 안 주면 서버가 이번 달(KST)로 정한다 */
export class TuitionQueryDto {
  @ApiPropertyOptional({ description: 'YYYY-MM — 없으면 이번 달(KST)', example: '2026-08' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: '달은 YYYY-MM 입니다' })
  month?: string;
}

/** `GET /accounting/tuition` — §54 */
export class TuitionDto {
  @ApiProperty({ description: 'YYYY-MM' }) month!: string;
  @ApiProperty({ description: '오늘 (KST) — 「오늘 08-21 기준」의 그 날' }) today!: string;
  @ApiProperty({ description: '이 달에서 지난 날 수' }) daysPast!: number;
  @ApiProperty({ description: '남은 날 수' }) daysLeft!: number;

  /* 머리 다섯 칸 — 줄의 합이다. 화면이 더하지 않는다 (D-R37) */
  @ApiProperty({ description: '한 수업 (전체 학생 합)' }) doneCount!: number;
  @ApiProperty({ description: '이번 달 전체' }) totalCount!: number;
  @ApiProperty({ description: '결강 · 휴강 (이월·보강 이관·그날만 빠짐)' }) canceledCount!: number;
  @ApiProperty({ description: '차감(소진) 처리한 휴강 — 청구에 들어 있다 (C92)' }) deductedCount!: number;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '지금까지 금액' }) doneAmount?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '다음 달로 넘길 돈' }) carryAmount?: number | null;

  @ApiProperty({ type: [TuitionRowDto] }) items!: TuitionRowDto[];
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39)' }) canSeeAmounts!: boolean;
}

/* ── §57 그 밖의 수입 ─────────────────────────────────────────────────── */

/** 줄을 눌러 펼친 한 장 — 「누르면 자세히 봅니다」 */
export class OtherIncomeItemDto {
  @ApiProperty() invId!: number;
  @ApiProperty() studentName!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ description: '청구서 상태 — 낱말은 화면이 짓지 않는다 (D-R18)' }) stateLabel!: string;
  @ApiProperty({ description: '아직 청구하지 않은 건인가 (draft)' }) unbilled!: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) issuedOn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) dueOn?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) amount?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) paid?: number | null;
}

/**
 * §57 오른쪽의 **「일별 · 주별 · 월별」** — 대표 결정 2026-09-13 (N-40).
 *
 * 「**일/주/월 + 유저 선택 시 날짜별 → 서브 그룹**」. 그래서 이 토글은 **줄의 숫자를 바꾸지 않는다** —
 * 접힌 줄은 여전히 **전 기간**의 합계이고(§52 머리 여섯 칸과 같다 · C43),
 * **줄을 펼쳤을 때 그 눈금으로 날짜 묶음이 생긴다.**
 *
 * 토글이 줄의 숫자까지 바꾸면 페이지 머리의 「‹ 2026년 8월 ›」과 **한 화면에 기간이 둘**이 되고,
 * 줄을 쪼개면 컷의 줄 셋이 여러 줄이 된다. 둘 다 컷과 어긋난다.
 *
 * 자르는 기준은 **발행일(`issued_on`)** 이다 — 줄의 「건수 · 금액」이 청구서를 세는 값이기 때문이다.
 * 발행일이 없는 건은 「날짜 없음」 묶음에 모인다(버리지 않는다).
 */
export const INCOME_SPANS = ['day', 'week', 'month'] as const;
export type IncomeSpan = (typeof INCOME_SPANS)[number];
export const INCOME_SPAN_LABEL: Record<IncomeSpan, string> = {
  day: '일별', week: '주별', month: '월별',
};

/** `GET /accounting/other-income?span=…` */
export class OtherIncomeQueryDto {
  @ApiPropertyOptional({ enum: INCOME_SPANS, description: '펼쳤을 때의 날짜 눈금 — 없으면 월별' })
  @IsOptional()
  @IsIn(INCOME_SPANS as unknown as string[], { message: '눈금은 일별·주별·월별입니다' })
  span?: string;
}

/** 펼친 줄 안의 **날짜 묶음** — 「2026-08-21 · 2건 ₩210,000」 */
export class OtherIncomeGroupDto {
  @ApiProperty({ description: '묶음 키 — 날짜 눈금의 시작일, 없으면 `none`' }) key!: string;
  @ApiProperty({ description: '사람이 읽는 이름 — 낱말도 서버가 만든다 (D-R18)' }) label!: string;
  @ApiProperty({ description: '그 묶음의 건수 — 화면이 세지 않는다 (D-R37)' }) count!: number;
  @ApiPropertyOptional({ type: Number, nullable: true }) amount?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) paid?: number | null;
  @ApiProperty({ type: [OtherIncomeItemDto] }) items!: OtherIncomeItemDto[];
}

/** 컷의 한 줄 — 「진단고사 + 상담 비용 · 4건 ₩210,000 · 받음 ₩90,000 · 청구 안 함 2」 */
export class OtherIncomeRowDto {
  @ApiProperty({ description: '청구 종류 코드' }) key!: string;
  @ApiProperty({ description: '줄 제목 — §57 컷의 낱말' }) label!: string;
  @ApiProperty({ description: '부제 — §57 컷의 낱말' }) sub!: string;

  @ApiProperty({ description: '건수 — 보낸 청구서만 센다(초안·취소 제외 · §52 머리와 같은 어휘)' })
  count!: number;
  @ApiProperty({ description: '「청구 안 함 N」 — 아직 초안인 청구서 건수. 건수에 들어 있지 않다' })
  unbilled!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '금액 합계' }) amount?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '받은 돈 합계' }) paid?: number | null;

  @ApiProperty({
    type: [OtherIncomeGroupDto],
    description: '펼쳤을 때의 날짜 묶음 — 눈금은 `span` 이 정한다 (N-40). 줄의 합계는 묶음의 합이다',
  })
  groups!: OtherIncomeGroupDto[];
}

/** `GET /accounting/other-income` — §57 「그 밖의 수입 · 수업료가 아닌 돈」 */
export class OtherIncomeDto {
  @ApiProperty({ type: [OtherIncomeRowDto], description: '컷의 세 줄. **데이터가 0건이어도 줄은 선다** — 종류는 어휘이지 데이터가 아니다' })
  rows!: OtherIncomeRowDto[];
  @ApiProperty({ enum: INCOME_SPANS, description: '지금 고른 날짜 눈금' }) span!: string;
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39)' }) canSeeAmounts!: boolean;
}

/* ── §52 회계 트래킹 보드 ─────────────────────────────────────────────── */

/**
 * 보드의 **칸 넷**과 각 칸에 드는 상태 — 대표 결정 2026-09-13 (N-28).
 *
 * 「**단일 진실원과 자동 전이에 유리하게**」. 그래서 칸은 **`inv.state` 하나**로 가른다.
 * 두 축(`state` + 「PAY 행이 있는가」)으로 가르면 **판정이 두 벌**이 되어 같은 청구서가
 * 어느 칸에 있는지 두 곳이 다르게 답한다 — N-27 과 같은 함정이다.
 * 전이는 이미 자동이다: `addPayment` 가 입금이 들어올 때마다 상태를 옮긴다.
 *
 * **컷의 카드 여섯이 이 표로 전부 제자리에 앉는다** —
 *   서지호(draft) → ① · 고은성·이하린(sent) → ② · 강라율(paid) → ③ ·
 *   고은설 「50% 냄」(partial) → ④ · 양찬욱 「연체」(partial + 기한 지남) → ④.
 * 즉 **「50% 냄」과 「연체」는 칸을 정하는 값이 아니라 카드에 적히는 값**이다.
 *
 * `unpaid` 가 ① 에 드는 이유: 이 저장소에서 `unpaid` 는 「안 냈다」가 아니라
 * **「발행했지만 아직 안 보냈다」**다(`addPayment` 의 되돌리기가 `was_sent` 로 `sent`/`unpaid` 를 가른다).
 * ② 는 「**보냈습니다** · 입금을 기다립니다」이므로 안 보낸 것은 ② 에 설 수 없다.
 *
 * **아직 안 정해진 것 (N-28 ②):** 컷 §53 의 다섯 칸 판(청구서 탭)은 ①「아직 안 씀」과
 * ②「청구서 작성」을 가르는데, 그 둘을 `state` 하나로는 못 가른다. 다섯 칸 판은 그 답이 나온 뒤에 만든다.
 */
export const INV_BOARD_COLUMNS = [
  { key: 'draft', label: '청구서 작성', sub: '아직 안 만들었습니다', states: ['draft', 'unpaid'] },
  { key: 'sent', label: '청구서 전달', sub: '보냈습니다 · 입금을 기다립니다', states: ['sent'] },
  { key: 'paid', label: '입금 완료', sub: '돈이 들어왔습니다', states: ['paid'] },
  { key: 'record', label: '입금 기록', sub: '장부에 넣었습니다', states: ['partial'] },
] as const;

export type InvBoardColumnKey = (typeof INV_BOARD_COLUMNS)[number]['key'];

/** 어느 칸에 드는가 — **판정은 이 함수 하나뿐이다** (D-R39) */
export function invBoardColumn(state: string): InvBoardColumnKey | null {
  const hit = INV_BOARD_COLUMNS.find((c) => (c.states as readonly string[]).includes(state));
  return hit ? hit.key : null; // void 는 어느 칸에도 안 든다 — 청구가 아니다
}

export class InvBoardCardDto {
  @ApiProperty() invId!: number;
  @ApiProperty() studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) grade?: string | null;
  @ApiProperty({ description: '청구 종류 코드' }) invType!: string;
  @ApiProperty({ description: '종류 이름 — §53 카드의 배지 (D-R18)' }) invTypeLabel!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ description: '상태의 이름 — 화면이 코드값을 찍지 않는다' }) stateLabel!: string;

  @ApiPropertyOptional({ type: Number, nullable: true }) amount?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) paid?: number | null;
  /*
   * 컷의 「50% 냄」이다. **화면이 나누지 않는다** — 금액을 못 보는 사람에게는 비율도 안 준다
   * (비율과 받은 돈이 있으면 청구액이 복원된다).
   */
  @ApiPropertyOptional({ type: Number, nullable: true, description: '받은 비율 0~100 — 일부 납부에만' })
  paidPercent?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true }) dueOn?: string | null;
  @ApiProperty({ description: '기한이 지난 날 수 — 0이면 연체 아님 (서버가 센다)' }) overdueDays!: number;
  @ApiProperty({ description: '「D-21」·「1일 지남」·「오늘」 — 낱말도 서버가 만든다 (D-R18)' }) whenLabel!: string;
}

export class InvBoardColumnDto {
  @ApiProperty() key!: string;
  @ApiProperty({ description: '칸 이름 — §52 컷의 낱말' }) label!: string;
  @ApiProperty({ description: '칸 아래 한 줄 — §52 컷의 낱말' }) sub!: string;
  @ApiProperty({ description: '그 칸의 건수 — 화면이 배열을 세지 않는다 (D-R37)' }) count!: number;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '그 칸의 금액 합계' }) amount?: number | null;
  @ApiProperty({ type: [InvBoardCardDto] }) cards!: InvBoardCardDto[];
}

/** `GET /accounting/board` — §52 */
export class InvBoardDto {
  @ApiProperty({ type: [InvBoardColumnDto], description: '칸 넷. **비어도 선다** — 칸은 어휘이지 데이터가 아니다' })
  columns!: InvBoardColumnDto[];
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39)' }) canSeeAmounts!: boolean;
}

/** `POST /accounting/tuition/carry` — §54 「이월 처리」 (N-39) */
export class TuitionCarryDto {
  @ApiProperty({ description: '누구의' })
  @IsInt() @Min(1) studentId!: number;

  @ApiProperty({ description: '어느 달에서 넘기는가 — YYYY-MM', example: '2026-08' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: '달은 YYYY-MM 입니다' })
  month!: string;
}

/** 이월 한 줄의 결과 */
export class CarryRowDto {
  @ApiProperty() id!: number;
  @ApiProperty() studentId!: number;
  @ApiProperty({ description: '못 해 준 수업이 있던 달' }) fromMonth!: string;
  @ApiProperty({ description: '넘겨 받는 달' }) toMonth!: string;
  @ApiProperty() amount!: number;
  @ApiProperty({ description: '못 해 준 회차 수' }) sessions!: number;
  @ApiPropertyOptional({ type: Number, nullable: true }) invId?: number | null;
  @ApiProperty() at!: string;
}
