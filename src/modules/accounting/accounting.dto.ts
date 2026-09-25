/** @file-guide
 * 목적: accounting.dto.ts — PAY_METHODS, EXPENSE_CATEGORIES, EXPENSE_SETTLED, EXPENSE_CATEGORY_LABEL, InvoiceLineDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { DATE_SCHEMA, IsCalendarDate } from '../../common/validation';

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
  /*
   * 청구 **종류** — 원문 §53 카드마다의 「수업료 청구」·「컨설팅비 청구」 칩 (g5 53-02 · x5).
   * 보드 카드(`InvBoardCardDto`)는 이미 들고 오는데 표 줄만 없었다 — 같은 청구서를 두 화면이 다르게 보였다.
   * 낱말은 보드 카드와 같은 `INV_TYPE_LABEL` 이다 (D-R18). 종류는 돈이 아니라 금액 권한과 무관하게 온다.
   */
  @ApiProperty({ description: '청구 종류 코드(INV_TYPES 넷 중 하나) — 이름은 invTypeLabel 을 쓴다' }) invType!: string;
  @ApiProperty({ description: '청구 종류 이름 — 「수업료 청구」·「컨설팅비 청구」 (§53 칩 · 보드 카드와 같은 낱말)' }) invTypeLabel!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) issuedOn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) dueOn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) paidAt?: string | null;
  @ApiProperty({ type: Number, nullable: true, description: '청구액 − 확정 누계. 다음 입금의 placeholder 다 (A-D2)' }) remaining!: number | null;
  @ApiProperty({ description: '예정일이 지났는데 안 들어온 날 수. 0이면 연체 아님' }) overdueDays!: number;
  @ApiProperty({ type: [InvoiceLineDto] }) lines!: InvoiceLineDto[];
  /* C94-a — 전달 · 취소 (테스트 시나리오 H-76 · N-139). 단추가 서는지는 서버가 정한다 (D-R39) */
  @ApiPropertyOptional({ type: String, nullable: true, description: '학부모께 전달한 시각 (ISO) — 전달 전이면 null' }) sentAt?: string | null;
  @ApiProperty({ description: '「전달」을 누를 수 있는가 — 초안·미전달만' }) canDeliver!: boolean;
  @ApiProperty({ description: '「취소」를 누를 수 있는가 — 대표 · 취소 전 · **그 달이 안 마감** · 입금 행 0 (S5 · 쓰기와 같은 조건)' })
  canVoid!: boolean;
  @ApiProperty({
    type: String, nullable: true,
    description: '취소가 막힌 이유 — 열려 있거나 권한 자체가 없으면 null. 쓰기가 내는 문장과 같은 말이다',
  })
  voidBlockedReason!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: '취소 사유 — 취소된 청구서에만 (N-139 「이력에 남는다」)' }) voidReason?: string | null;
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
 * 지금 **낼 수 있는** 청구 종류 (PB-01 · 결정 대기).
 *
 * 줄 계산(`invoice-lines.ts`)은 그 달의 **수업**을 센다 — 수업료의 규칙이다. 종류를 받고도 그 계산을 그대로 써서
 * 응시료·진단고사·컨설팅비로 내면 수업료와 똑같은 줄·금액의 청구서가 또 생겼다(종류가 달라 중복 검사도 통과).
 * 수업료 외 종류의 금액 규칙(정액 · 수동 금액 · 연결 원천)이 정해지기 전까지는 **수업료만** 낸다.
 * 컨설팅비는 §28 「청구서로 전환」(남은 돈)이 따로 낸다 — 이 목록과 무관하다.
 */
export const INV_TYPES_ISSUABLE: readonly string[] = ['tuition'];
export const INV_TYPE_NOT_SUPPORTED = 'INV_TYPE_NOT_SUPPORTED' as const;
/** 막힌 이유 한 문장 — 발행 409 와 §53 종류 고르기(meta)가 같은 말을 쓴다 (D-R22) */
export const invTypeIssueBlockedReason = (key: string): string | null =>
  (INV_TYPES_ISSUABLE.includes(key) ? null : '수업료 외 청구는 금액 규칙이 정해지면 열립니다');

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

  /**
   * **납부 기한 — 발행할 때 사람이 고른다** (대표 결정 2026-09-20 · 기본값을 두지 않는다).
   *
   * 원문 §53 은 카드마다 「11일 지남」·「D-21」을 보여 주지만 **기한을 어떻게 정하는지는 보여 주지 않는다.**
   * 서버가 「발행일 + N일」 같은 규칙을 지어내면 그것은 원문에 없는 업무 규칙이다(D-R44). 그래서 필수로
   * 받되 값은 짓지 않는다 — 안 보내면 400 이고, 화면도 비어 있으면 단추가 잠긴다.
   *
   * 이 칸이 비어 있던 동안 **연체 합계·「기한 지남」·§69 회계 배지가 구조적으로 0** 이었다(S3).
   */
  @ApiProperty({ ...DATE_SCHEMA, description: '납부 기한 — YYYY-MM-DD. 발행할 때 고른다(기본값 없음 · S3)' })
  @IsCalendarDate()
  dueOn!: string;
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

/**
 * §55 「+ 결제 등록」 — **청구서 없이 들어온 돈**(교재비 · 조정 등)을 매니저가 직접 적는다.
 *
 * A-D1(2026-08-25 확정)이 「청구서 발행 + 매니저 직접 입력 둘 다」를 정했고 `pay.inv_id` 가 nullable 인 것이 그 자리다.
 * 청구서가 없으니 **무엇에 대한 돈인지(`reason`)가 필수**다 — 없으면 장부에 이유 없는 돈이 남는다.
 * 금액은 사람이 확인한 값 그대로이고 서버가 계산하지 않는다(가격 규칙을 새로 만들지 않는다).
 * 분류는 저장하지 않는다 — `inv_id IS NULL` 이 곧 §55 의 「기타」다(N-37 ③ · `payCategory` 한 곳).
 */
export class ManualPaymentCreateDto {
  @ApiProperty({ description: '누구의 돈인가 — 학생 번호' })
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  studentId!: number;

  @ApiProperty({ description: '들어온 금액(원) — 사람이 확인한 값 그대로' })
  @IsInt() @Min(1) @Max(1_000_000_000)
  amount!: number;

  @ApiProperty({ ...DATE_SCHEMA, description: '입금일' })
  @IsCalendarDate()
  paidOn!: string;

  @ApiPropertyOptional({ enum: PAY_METHODS })
  @IsOptional() @IsIn(PAY_METHODS as unknown as string[])
  method?: string;

  @ApiProperty({ description: '무엇에 대한 돈인가 — 교재비 · 조정 등. 청구서가 없으니 필수(공백뿐이면 409 PAY_REASON_REQUIRED)' })
  @IsString() @MaxLength(500)
  reason!: string;
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
  @ApiProperty({
    type: Number, nullable: true,
    description: '**실제로 올린 사람** — 대표가 대신 올리면 requesterId 와 갈린다. 이 사람도 심사하지 못한다 (S2 · 옛 행은 null)',
  })
  filedById!: number | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: '대신 올린 사람 이름 — 본인이 올렸으면 requesterName 과 같다' })
  filedByName?: string | null;
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

/** 지출 분류 코드표 한 줄 — 「+ 지출 등록」의 고르기가 이것을 쓴다. 화면에 코드표를 복사해 두지 않는다 (D-R18 · C94-d) */
export class ExpenseCategoryDto {
  @ApiProperty({ enum: EXPENSE_CATEGORIES }) key!: string;
  @ApiProperty() label!: string;
}

export class AccountingDto {
  @ApiProperty({ type: MoneySummaryDto }) summary!: MoneySummaryDto;
  @ApiProperty({ type: [InvoiceDto] }) invoices!: InvoiceDto[];
  @ApiProperty({ type: [PaymentDto] }) payments!: PaymentDto[];
  @ApiProperty({ type: [PayoutDto] }) payouts!: PayoutDto[];
  @ApiProperty({ type: [ExpenseDto], description: '나간 돈 §56 — 부대비용·법인카드 신청분' }) expenses!: ExpenseDto[];
  @ApiProperty({ type: [ExpenseTotalDto], description: '§56 분류별 확정 지출 합계 — 화면이 더하지 않는다' }) expenseTotals!: ExpenseTotalDto[];
  @ApiProperty({ type: [ExpenseCategoryDto], description: '지출 분류 여섯 — 건수가 0이어도 선다 (어휘이지 데이터가 아니다 · C94-d)' }) expenseCategories!: ExpenseCategoryDto[];
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
  @ApiProperty({ description: '추가 수업(KIND.extra) 회차 수 — 전체에 들되 따로 센다 (C94-d · C-38)' }) extra!: number;
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
  @ApiProperty({ description: '이월 처리를 누를 수 있는가 — 마감한 달은 false 다 (N-39 · S5)' }) carryable!: boolean;
  /*
   * 단추가 **설 자리인데** 막힌 이유 (PB-04) — 완납·넘길 돈·아직 안 넘김이 다 참인데 못 누르는 줄만 문장이 있다
   * (그 달 마감 · 받는 달 수업료 청구서가 이미 나감). 쓰기(`carryTuition`)의 409 문장과 같은 말이다.
   * 넘길 것이 없거나 이미 넘긴 줄은 null — 단추가 설 자리가 아니다.
   */
  @ApiPropertyOptional({ type: String, nullable: true, description: '이월 단추가 설 자리인데 막힌 이유 — 마감 · 받는 달 수업료 청구서가 이미 나감. 설 자리가 아니거나 누를 수 있으면 null (PB-04)' })
  carryBlockedReason?: string | null;
  /*
   * **넘길 돈이 있는 줄인가** — 원문 §54 는 그 줄을 **위로 모으고 옅게 칠한다**(g5 54-02 · x5).
   * 차례는 서버가 정하고(줄 순서) 칠할지도 서버가 말한다 — 금액(`carryAmount`)은 권한이 없으면 null 이라
   * 화면이 금액으로 판정하면 권한마다 모양이 갈린다. 결강 수가 이미 보이는 자리라 새로 드러나는 것이 없다.
   * 선택 칸으로 둔 까닭은 형제 `carriedAt` 과 같은 표기다 — 서버는 언제나 보낸다.
   */
  @ApiPropertyOptional({ type: Boolean, description: '넘길 돈이 있는 줄 — 원문 §54 처럼 위로 모이고 옅게 칠한다 (금액 권한과 무관)' })
  carryPending?: boolean;
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
  @ApiProperty({ description: '지난달에서 넘어온 **회차 수** — 「이월 4회 · 9월 청구에서 빠집니다」의 4 (C92-b · C-35). 금액 권한과 무관하게 센다' })
  carriedInSessions!: number;

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
  @ApiProperty({ description: '추가 수업 회차 — 「상단 추가 칸」 (C94-d · C-38). 전체에도 들어 있다' }) extraCount!: number;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '지금까지 금액' }) doneAmount?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '다음 달로 넘길 돈' }) carryAmount?: number | null;
  /* 이 달이 받은 이월 — 「상단에 4회 이월 표시 · 다음 달 청구 회차 = 예정 − 이월」 (C92-b · C-35) */
  @ApiProperty({ description: '지난달에서 넘어온 회차 수의 합' }) carriedInCount!: number;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '넘어온 돈의 합 — 이 달 청구서에서 빠진다' }) carriedInAmount?: number | null;

  @ApiProperty({ type: [TuitionRowDto] }) items!: TuitionRowDto[];
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39)' }) canSeeAmounts!: boolean;

  /* 월 마감 (C92-d · C-39 · L-123 · N-140) — 마감이면 그 달의 회차·휴강·출결·청구·이월·휴원 쓰기가 409 MONTH_CLOSED */
  @ApiPropertyOptional({ type: () => MonthCloseDto, nullable: true, description: '지금 열려 있는 마감 — null 이면 열린 달' })
  close?: MonthCloseDto | null;
  @ApiProperty({ description: '「N월 마감하기」 단추가 서는가 — 대표 · 아직 안 마감 · 오늘이 그 달 시작 이후 (D-R39)' }) canClose!: boolean;
  @ApiProperty({ description: '「마감 해제」 단추가 서는가 — 대표 · 마감 중' }) canReopen!: boolean;
}

/* ── 월 마감 (C92-d) ────────────────────────────────────────────────── */

export class MonthCloseDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: 'YYYY-MM' }) month!: string;
  @ApiProperty({ description: 'ISO' }) closedAt!: string;
  @ApiProperty({ description: '마감한 사람 이름' }) closedBy!: string;
  @ApiPropertyOptional({ type: String, nullable: true, description: '해제 시각 (ISO) — 열려 있는 마감이면 null' }) reopenedAt?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) reopenedBy?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: '해제 사유 — 흔적 없이 고치지 않는다 (N-140)' }) reopenReason?: string | null;
}

/* ── 청구서 일괄 발행 · 전달 · 취소 (C94-a · H-75 · O-147 · H-76 · N-139) ──────── */

/** `POST /accounting/invoices/batch` — 그 달 수업이 있는 학생 전부에게 한 번에 */
export class InvoiceBatchDto {
  @ApiProperty({ description: '어느 달 — YYYY-MM', example: '2026-09' })
  @IsString() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: '달은 YYYY-MM 입니다' })
  yearMonth!: string;

  /** 한 번에 내는 청구서들의 **납부 기한 하나** — 낱장 발행과 같은 규약이다(기본값 없음 · S3) */
  @ApiProperty({ ...DATE_SCHEMA, description: '납부 기한 — YYYY-MM-DD. 이 달 청구서 전부에 같은 기한이 붙는다' })
  @IsCalendarDate()
  dueOn!: string;
}

export class InvoiceBatchSkipDto {
  @ApiProperty() studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiProperty({ description: 'INV_DUPLICATE | INV_NO_LESSONS | INV_NO_RATE | INV_CARRY_EXCEEDS — 낱장 발행과 같은 코드' }) code!: string;
  @ApiProperty() message!: string;
}

export class InvoiceBatchResultDto {
  @ApiProperty() yearMonth!: string;
  @ApiProperty({ description: '수업이 있는 학생 수 — 발행 + 건너뜀' }) candidates!: number;
  @ApiProperty({ type: [InvoiceDto], description: '이번에 발행한 청구서 — 줄까지' }) issued!: InvoiceDto[];
  @ApiProperty({ type: [InvoiceBatchSkipDto], description: '건너뛴 학생과 이유 — 이미 있음 · 단가 없음 · 이월 초과' }) skipped!: InvoiceBatchSkipDto[];
  @ApiPropertyOptional({ type: Number, nullable: true, description: '발행한 금액 합 — 금액 권한 없으면 null' }) issuedAmount?: number | null;
}

/** `POST /accounting/invoices/{id}/void` — 대표 전용 · 사유 필수 */
export class InvoiceVoidDto {
  @ApiProperty({ description: '취소 사유 — 잘못 낸 이유', minLength: 1, maxLength: 200 })
  @IsString() @MinLength(1) @MaxLength(200) reason!: string;
}

/* ── §57 강사료 시트 · 지급 확정 (C94-b · H-82 · O-148 · D-43) ──────────────── */

/** `GET /accounting/payouts?month=` 의 한 줄 — 강사 한 사람 한 달. 세는 것은 `lib/payout-sheet` 한 곳(강사 히스토리와 같다) */
export class PayoutSheetRowDto {
  @ApiProperty() staffId!: number;
  @ApiProperty() staffName!: string;
  @ApiProperty({ description: 'YYYY-MM' }) yearMonth!: string;
  @ApiProperty({ description: '리포트 쓴 수업 수 — 이것만 시수·금액에 든다 (D-R7)' }) writtenCount!: number;
  @ApiProperty() writtenMinutes!: number;
  @ApiProperty({ description: '끝났는데 리포트를 안 쓴 수업 — 강사료에서 빠진다 (D-43)' }) unwrittenCount!: number;
  @ApiProperty() unwrittenMinutes!: number;
  @ApiProperty({ description: '휴강 — 시수에 잡히지 않는다 (H-82)' }) canceledCount!: number;
  @ApiProperty({ description: '리포트 대상이 아닌 종류(자습·회의 …)의 회차 — 정산에 들지 않는다' }) naCount!: number;
  @ApiProperty({ description: '시급이 없어 못 센 수업 — 0 이 아니면 확정할 수 없다' }) noRateCount!: number;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '지급 총액 — 금액 권한 없으면 null' }) gross?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '지각 차감 (D-R32)' }) lateCut?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) incomeTax?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) localTax?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '실지급' }) net?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '미작성으로 빠진 돈 — 「이만큼 안 나간다」' }) unwrittenAmount?: number | null;
  @ApiProperty({ description: '저장된 정산 행이 있는가 (payout)' }) saved!: boolean;
  @ApiProperty({ description: '저장값이 지금 계산과 다른가 — 확정은 지금 계산을 굳힌다' }) savedDiffers!: boolean;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '저장된 실지급 — 다를 때 나란히 보인다' }) savedNet?: number | null;
  @ApiProperty({ description: '확정됐는가 — confirmed_by 로 본다 (N-27)' }) confirmed!: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) confirmedAt?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) confirmedBy?: string | null;
  @ApiProperty({ description: '「지급 확정」을 누를 수 있는가 — 대표 · 달이 끝남 · 미확정 · 시급 없는 수업 0 · 쓴 수업 1 이상 (D-R39)' }) canConfirm!: boolean;
}

export class PayoutSheetDto {
  @ApiProperty({ description: 'YYYY-MM' }) month!: string;
  @ApiProperty() today!: string;
  @ApiProperty({ description: '달이 끝났는가 — 끝나기 전에는 확정할 수 없다 (O-148 「전월 종료」)' }) monthEnded!: boolean;
  @ApiProperty({ type: [PayoutSheetRowDto] }) rows!: PayoutSheetRowDto[];
  @ApiProperty({ description: '전체 미작성 수업 수 — 「미작성 N건은 강사료에서 빠집니다」' }) unwrittenCount!: number;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '실지급 합 — 줄의 합. 화면이 더하지 않는다' }) netTotal?: number | null;
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39)' }) canSeeAmounts!: boolean;

  /*
   * w5 · g5 56-02 — 원본 §56 합계 카드 「8월에 드릴 돈 ₩4,836,692 · 88.7시간 · 강사료 ₩5,096,750 · 차감 −₩95,000 ·
   * 세금 −₩165,058 · 보류 98.4h」. 전부 **줄의 합**이고 서버가 더한다 — 화면이 행을 더하지 않는다 (D-R37).
   * 시간은 분으로 보낸다(화면이 「88.7시간」으로 적는다 — 단위 바꾸기는 표시다).
   */
  @ApiProperty({ description: '리포트 쓴 수업 시간 합(분) — 「88.7시간」' }) writtenMinutes!: number;
  @ApiProperty({ description: '미작성으로 보류된 수업 시간 합(분) — 「보류 98.4h」' }) unwrittenMinutes!: number;
  @ApiProperty({ type: Number, nullable: true, description: '강사료(총액) 합 — 금액 권한 없으면 null' }) grossTotal!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '지각 차감 합 (D-R32)' }) lateCutTotal!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '세금 합 — 소득세 + 지방세 (D-15)' }) taxTotal!: number | null;
}

/**
 * `GET /accounting/payouts/{staffId}?month=` — 원본 §56 오른쪽 상세 「시급 · 수업 날짜 · 리포트 미작성 · 정산 내역」 (w5 · 56-01).
 *
 * 세는 곳은 **시트와 같은 함수**(`lib/payout-sheet`)다 — 줄(`row`)은 시트의 그 줄과 같은 값이고, 수업 줄의 금액 합이
 * 곧 줄의 총액이다. 화면이 수업을 다시 세거나 더하지 않는다 (D-R37).
 */
export class PayoutRateDto {
  @ApiProperty({ description: '이 날부터 (WAGE.from_date)' }) fromDate!: string;
  @ApiProperty({ type: Number, nullable: true, description: '시급 — 금액 권한 없으면 null' }) rate!: number | null;
}

export class PayoutLessonDto {
  @ApiProperty() serId!: number;
  @ApiProperty({ description: 'YYYY-MM-DD' }) onDate!: string;
  @ApiProperty() startMin!: number;
  @ApiProperty() durMin!: number;
  @ApiProperty({ description: '수업 이름 — 제목 → 과목 → 종류 순 (서버가 고른다)' }) name!: string;
  @ApiProperty({ type: String, nullable: true, description: '그날 명단 이름' }) students!: string | null;
  @ApiProperty() studentCount!: number;
  @ApiProperty({ description: '휴강인가' }) canceled!: boolean;
  @ApiProperty({ enum: ['written', 'unwritten', 'canceled', 'na', 'upcoming'], description: '정산 갈래' }) settle!: string;
  @ApiProperty({ description: '갈래 이름 — 「리포트 씀」·「리포트 미작성」·「휴강」·「리포트 대상 아님」·「아직」 (D-R18)' }) settleLabel!: string;
  @ApiProperty({ type: Number, nullable: true, description: '이 수업의 강사료 — 쓴 수업만 · 금액 권한 없으면 null' }) pay!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '지각 차감 — 쓴 수업만 (D-R32)' }) lateCut!: number | null;
}

export class PayoutDetailDto {
  @ApiProperty() staffId!: number;
  @ApiProperty() staffName!: string;
  @ApiProperty({ description: 'YYYY-MM' }) month!: string;
  @ApiProperty({ type: PayoutSheetRowDto, description: '시트의 그 줄과 같은 값 — 같은 함수가 셌다' }) row!: PayoutSheetRowDto;
  @ApiProperty({ type: [PayoutRateDto], description: '이 달에 걸린 시급 — 달 시작 때의 시급 + 달 안에서 바뀐 것 (D8)' }) rates!: PayoutRateDto[];
  @ApiProperty({ type: [PayoutLessonDto], description: '이 달의 수업 — 날짜 내림차순 (강사 히스토리와 같은 순서)' }) lessons!: PayoutLessonDto[];
}

export class PayoutDetailParamsDto {
  @ApiProperty({ description: '강사', type: 'integer', minimum: 1 })
  @Transform(({ value }) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value))
  @IsInt({ message: '강사 번호가 올바르지 않습니다' }) @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  staffId!: number;
}

/* ── §55 들어온 돈 — 기간 · 달력 · 분류별 · 미수 전체 (w5 · g5 55-01 · 55-02 · 55-03 · 55-05) ──────────────── */

/**
 * `GET /accounting/cashflow?from&to&category` — 원본 §55 「들어온 돈 › 입금 기록」.
 *
 * 원본 컷의 수가 스스로 뜻을 말한다 — 「11건 · ₩5,287,300 청구 · ₩3,964,000 입금 · ₩1,323,300 예정」은
 * **청구 = 입금 + 예정**이고, 달력 날짜 칸의 합이 청구(5,287,300)와 같으며, 숫자 배지(22일 1 · 28일 1 · 31일 2)가
 * 「미수 전체」의 **기한**(D-1 · D-7 · D-10 둘)에 앉는다. 그래서 한 기간의 돈은 두 갈래다 —
 *   · **입금**: 그 기간에 들어온 입금 줄(`pay.paid_on`)
 *   · **예정**: 아직 덜 받은 청구서(`INV_OPEN` · 남은 돈 > 0)의 **기한**(`inv.due_on`)이 그 기간에 드는 것 — 남은 돈
 * 분납 회차별 기한은 저장처가 없어(55-06 결정 대기) 청구서 한 장이 예정 한 건이다.
 */
export class CashflowQueryDto {
  @ApiPropertyOptional({ ...DATE_SCHEMA, description: '이 날부터 — 없으면 처음부터' })
  @IsOptional() @IsCalendarDate()
  from?: string;

  @ApiPropertyOptional({ ...DATE_SCHEMA, description: '이 날까지 — 없으면 끝까지' })
  @IsOptional() @IsCalendarDate()
  to?: string;

  @ApiPropertyOptional({ enum: PAY_CATEGORIES.map((c) => c.key), description: '분류 칩으로 좁히기 — 달력·요약만 좁히고 칩 건수는 그대로다' })
  @IsOptional() @IsIn(PAY_CATEGORIES.map((c) => c.key), { message: '분류는 수업료 · GPA 관리비 · 컨설팅비 · 진단고사·상담 · 시험 응시료 · 기타 중 하나입니다' })
  category?: string;
}

export class CashflowDayDto {
  @ApiProperty({ description: 'YYYY-MM-DD' }) date!: string;
  @ApiProperty({ type: Number, nullable: true, description: '그날의 돈(입금 + 예정) — 달력 칸의 금액' }) amount!: number | null;
  @ApiProperty({ type: Number, nullable: true }) paidAmount!: number | null;
  @ApiProperty({ type: Number, nullable: true }) expectedAmount!: number | null;
  @ApiProperty({ description: '그날의 건수(입금 + 예정)' }) count!: number;
  @ApiProperty({ description: '그날 기한인 예정 건수 — 원본 달력 칸의 숫자 배지' }) expectedCount!: number;
}

export class CashflowCategoryDto {
  @ApiProperty() key!: string;
  @ApiProperty({ description: '§55 컷의 낱말' }) label!: string;
  @ApiProperty({ description: '이 기간의 건수(입금 + 예정) — 칩 「수업료 2」' }) count!: number;
  @ApiProperty({ type: Number, nullable: true, description: '청구(입금 + 예정)' }) billed!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '입금' }) paid!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '받은 비율 % — 입금 / 청구, 반올림. 청구 0 이면 0 · 금액 권한 없으면 null' }) rate!: number | null;
}

export class CashflowOpenDto {
  @ApiProperty() invId!: number;
  @ApiProperty() studentName!: string;
  @ApiProperty({ description: '「전액」(아직 한 푼도 안 받음) · 「잔액」(일부 받음) — 분납 회차별 기한은 저장처가 없다(55-06)' }) partLabel!: string;
  @ApiProperty({ type: Number, nullable: true, description: '남은 돈 — 금액 권한 없으면 null' }) amount!: number | null;
  @ApiProperty({ type: String, nullable: true }) dueOn!: string | null;
  @ApiProperty({ description: '「21일 연체」·「오늘」·「D-7」·「기한 없음」 — 낱말은 서버 (D-R18)' }) whenLabel!: string;
  @ApiProperty({ type: String, nullable: true, description: "줄 바탕 — 'danger'(연체) | 'warning'(7일 안) | null" }) tone!: string | null;
}

export class CashflowDto {
  @ApiProperty({ type: String, nullable: true }) from!: string | null;
  @ApiProperty({ type: String, nullable: true }) to!: string | null;
  @ApiProperty({ description: '기간 낱말 — 「전체」·「2026년 8월」·「8월 21일」·「08-17 ~ 08-23」' }) label!: string;
  @ApiProperty({ type: Number, nullable: true, description: '기간의 날 수 — 「31일」. 전체면 null' }) dayCount!: number | null;
  @ApiProperty({ type: String, nullable: true, description: '고른 분류 — 없으면 null(전체)' }) category!: string | null;
  @ApiProperty({ description: '오늘 (KST) — 달력의 오늘 칸' }) today!: string;
  @ApiProperty({ description: '건수(입금 + 예정) — 「11건」' }) count!: number;
  @ApiProperty({ type: Number, nullable: true, description: '청구 = 입금 + 예정' }) billed!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '입금' }) paid!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '예정 — 기한이 이 기간인 청구서의 남은 돈' }) expected!: number | null;
  @ApiProperty({ type: [CashflowDayDto], description: '돈이 있는 날만 — 날짜 오름차순' }) days!: CashflowDayDto[];
  @ApiProperty({ type: [CashflowCategoryDto], description: '분류 여섯 — 0건도 선다(어휘) · 고른 분류와 무관' }) categories!: CashflowCategoryDto[];
  @ApiProperty({ type: [CashflowOpenDto], description: '미수 전체 — 기간과 무관 · 기한 이른 순' }) open!: CashflowOpenDto[];
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39)' }) canSeeAmounts!: boolean;
}

/** `POST /accounting/payouts/{month}/confirm` — 대표 전용 */
export class PayoutConfirmDto {
  @ApiProperty({ description: '어느 강사' }) @IsInt() @Min(1) staffId!: number;
}

export class PayoutMonthParamsDto {
  @ApiProperty({ description: 'YYYY-MM', example: '2026-08' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: '달은 YYYY-MM 입니다' })
  month!: string;
}

/* ── 수강 종료 · 환불 (C94-c · 테스트 시나리오 H-80 · N-135 · N-136) ─────────────────────
   「잔여 회차 × 회당 단가로 산출 · 환불 기록이 장부에 남는다 · 수강이 종료 처리된다 · 이후 일정이 정리된다 ·
   그룹 수업이면 남은 학생 단가가 다시 계산된다」. 화면은 날짜·범위·사유만 보내고 잔여 회차·환불액은 서버가 센다(D-R37).
   미리보기(preview)는 같은 트랜잭션을 돌리고 되돌린 결과라 실제와 한 원도 다르지 않다.                     */

export class StudentWithdrawDto {
  @ApiProperty({ description: '누구' }) @IsInt() @Min(1) studentId!: number;

  @ApiProperty({ ...DATE_SCHEMA, description: '마지막으로 수업이 있는 날(포함) — 이 날 뒤의 회차가 정리된다' })
  @IsCalendarDate() endedOn!: string;

  @ApiPropertyOptional({ type: [Number], description: '이 규칙(들)만 종료 — 비우면 그 학생이 든 모든 규칙(학생이 그만둠 · N-136)' })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true })
  serIds?: number[];

  @ApiPropertyOptional({ maxLength: 200, description: '사유 — 장부(환불 줄)와 이력에 남는다' })
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

export class WithdrawSeriesDto {
  @ApiProperty() serId!: number;
  @ApiProperty() kindKey!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) subKey?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) title?: string | null;
  @ApiProperty({ description: '이미 있던 명단 종료일 — 이번에 적히는 값' }) endedOn!: string;
  @ApiProperty({ description: '종료일 뒤에 남아 있던 회차(투영 지평선 안 · 휴강 제외) — 서버가 센다' }) remainingCount!: number;
}

export class WithdrawInvoiceDto {
  @ApiProperty() id!: number;
  @ApiProperty() yearMonth!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ description: '청구서 상태 — 처리 뒤' }) state!: string;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '처리 전 금액 — 금액 권한 없으면 null' }) amountBefore?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '처리 뒤 금액 — 잔여 회차 줄을 뺀 값' }) amountAfter?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '받은 돈' }) paidAmount?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '돌려줄 돈 — 받은 돈이 새 금액보다 많은 만큼 (PAY 음수 줄)' }) refund?: number | null;
  @ApiProperty({ description: '잔여 회차 수 — 이 청구서에서 빠진 회차' }) removedCount!: number;
  @ApiProperty({ description: '금액이 0 이 되어 취소(void)로 접혔는가' }) voided!: boolean;
  @ApiProperty({ description: '취소가 걸리는데 **대표가 아니라서** 막히는가 — 미리보기에서만 true 가 될 수 있다 (N-139)' })
  needsCeoVoid!: boolean;
}

export class WithdrawResultDto {
  @ApiProperty() studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiProperty() endedOn!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) reason?: string | null;
  @ApiProperty({ description: '미리보기인가 — true 면 아무것도 쓰지 않았다' }) preview!: boolean;
  @ApiProperty({ type: [WithdrawSeriesDto] }) series!: WithdrawSeriesDto[];
  @ApiProperty({ type: [WithdrawInvoiceDto], description: '종료일 뒤 회차가 들어 있던 청구서 — 줄이 빠지고 넘친 돈은 환불 줄로' }) invoices!: WithdrawInvoiceDto[];
  @ApiProperty({ description: '정리된 회차 수(규칙 합)' }) remainingCount!: number;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '환불 합계 — 금액 권한 없으면 null' }) refundTotal?: number | null;
  @ApiProperty({ description: '수강(ENR) 행에 종료일이 적힌 수 — 등록 행이 없으면 0' }) enrollmentsEnded!: number;
  @ApiProperty() canSeeAmounts!: boolean;
  @ApiProperty({
    description: '이 종료를 실제로 확정할 수 있는가 — **청구서가 통째로 비어 취소(void)되는 경우는 대표만**(N-139). '
      + '화면이 역할을 다시 조합하지 않는다 (D-R39)',
  })
  canConfirm!: boolean;
  @ApiProperty({ type: String, nullable: true, description: '확정이 막힌 이유 — 열려 있으면 null' })
  confirmBlockedReason!: string | null;
}

/** `POST /accounting/tuition/close` — 대표 전용 */
export class MonthCloseWriteDto {
  @ApiProperty({ description: '마감할 달 — YYYY-MM', example: '2026-08' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: '달은 YYYY-MM 입니다' })
  month!: string;
}

/** `POST /accounting/tuition/reopen` — 대표 전용 · 사유 필수 */
export class MonthReopenWriteDto extends MonthCloseWriteDto {
  @ApiProperty({ description: '해제 사유 — 마감 뒤 무엇을 고치려는지', minLength: 1, maxLength: 200 })
  @IsString() @MinLength(1) @MaxLength(200) reason!: string;
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

/* ══ 단가표 · 학생별 예외 · 지출 등록 (C94-d · 테스트 시나리오 H-81 · H-83 · C-38) ═══════════
 * 원문 §54 「데이터 RATE, STURATE(학생별 예외)」 — 청구서·§54·명단 가격이 이미 읽는 두 표에
 * **쓰는 길**이 없었다(시드만 있었다). 여기서 쓰는 것은 줄 하나뿐이고 **셈은 한 곳도 바뀌지 않는다** —
 * `invoice-lines.ts` 가 `from_date` 로 그 날짜의 단가를 고르므로, 새 줄은 그 날짜부터 청구서·§54·명단에
 * 같이 든다. 지난 줄은 고치지도 지우지도 않는다(이미 낸 청구서가 그 값으로 서 있다 — C63 의 교훈).
 * ══════════════════════════════════════════════════════════════════════════════════════ */

/** 기본 단가 한 줄 — `rate` (종류 · 과목 · 인원 구간 · 언제부터) */
export class RateRowDto {
  @ApiProperty() id!: number;
  @ApiProperty() kindKey!: string;
  @ApiProperty({ description: '종류 이름 — 낱말은 서버가 만든다 (D-R18)' }) kindName!: string;
  @ApiProperty({ description: '추가 수업 종류인가 (C-38)' }) kindExtra!: boolean;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'null 이면 그 종류 전체' }) subKey?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) subName?: string | null;
  @ApiProperty({ description: '인원 구간 — 인원 이하의 최대 heads 줄이 적용된다 (N-17 ①)' }) heads!: number;
  @ApiProperty({ description: '회당 단가' }) unitPrice!: number;
  @ApiProperty({ description: '이 날부터 (YYYY-MM-DD)' }) fromDate!: string;
  @ApiProperty({ description: '오늘 기준으로 이 구간에서 살아 있는 줄인가 — 같은 (종류·과목·인원)의 가장 최근 from_date' }) current!: boolean;
}

/** 학생별 예외 한 줄 — `sturate` (사유 · 누가 · 언제) */
export class StudentRateRowDto {
  @ApiProperty() id!: number;
  @ApiProperty() studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'null 이면 모든 종류' }) kindKey?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) kindName?: string | null;
  @ApiProperty() unitPrice!: number;
  @ApiProperty() fromDate!: string;
  @ApiPropertyOptional({ type: String, nullable: true, description: '옛 시드 행만 null — 새 줄은 사유가 필수다 (H-81)' }) reason?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) byName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) createdAt?: string | null;
  @ApiProperty({ description: '오늘 기준으로 그 학생·종류에 살아 있는 줄인가' }) current!: boolean;
}

/** `GET /accounting/rates` — 단가표와 학생별 예외를 한 번에 */
export class RateBookDto {
  @ApiProperty({ type: [RateRowDto], description: '종류 → 과목 → 인원 → 최근순' }) rates!: RateRowDto[];
  @ApiProperty({ type: [StudentRateRowDto], description: '학생 이름 → 최근순' }) studentRates!: StudentRateRowDto[];
}

const KIND_KEY = /^[a-z][a-z0-9_]{1,15}$/;
const SUB_KEY = /^[a-z][a-z0-9-]{1,19}$/;

/** `POST /accounting/rates` — 기본 단가 한 줄. 같은 (종류·과목·인원·날짜)는 409 RATE_DUPLICATE (`rate_tier_key`) */
export class RateWriteDto {
  @ApiProperty({ description: '종류 코드 — §18 프로그램의 KIND' })
  @IsString() @Matches(KIND_KEY, { message: '종류 코드가 아닙니다' })
  kindKey!: string;

  @ApiPropertyOptional({ description: '과목 코드 — 비우면 그 종류 전체의 단가' })
  @IsOptional() @IsString() @Matches(SUB_KEY, { message: '과목 코드가 아닙니다' })
  subKey?: string;

  @ApiProperty({ description: '인원 구간 — 1 이면 1인 단가. 그룹은 인원마다 줄을 둔다 (D-R10 · N-17 ①)', example: 1 })
  @IsInt() @Min(1) @Max(100)
  heads!: number;

  @ApiProperty({ description: '회당 단가 (원). 0 원은 단가가 아니다 — 무료면 줄을 두지 않는다', example: 60000 })
  @IsInt() @Min(1) @Max(100_000_000)
  unitPrice!: number;

  @ApiProperty({ ...DATE_SCHEMA, description: '이 날부터 — 그 날짜 이후 회차의 청구서·§54·명단 가격이 이 값을 읽는다' })
  @IsCalendarDate()
  fromDate!: string;
}

/** `POST /accounting/sturates` — 학생별 예외 한 줄. **사유가 없으면 실패** (H-81) */
export class StudentRateWriteDto {
  @ApiProperty() @IsInt() @Min(1) studentId!: number;

  @ApiPropertyOptional({ description: '종류 코드 — 비우면 그 학생의 모든 종류' })
  @IsOptional() @IsString() @Matches(KIND_KEY, { message: '종류 코드가 아닙니다' })
  kindKey?: string;

  @ApiProperty({ description: '회당 단가 (원)', example: 50000 })
  @IsInt() @Min(1) @Max(100_000_000)
  unitPrice!: number;

  @ApiProperty({ ...DATE_SCHEMA, description: '이 날부터' })
  @IsCalendarDate()
  fromDate!: string;

  @ApiProperty({ description: '사유 — 「형제 할인」·「장학」 … 없으면 400 (H-81 · CHECK sturate_reason_present)', maxLength: 200 })
  @IsString() @MinLength(1) @MaxLength(200)
  reason!: string;
}

/**
 * `POST /accounting/expenses` — 지출 등록 (H-83 「직원이 등록하면 pending · 바로 확정되면 실패」).
 * 상태는 받지 않는다 — 언제나 `pending` 이고 확정 금액은 심사(`/expenses/{id}/review`)가 넣는다.
 */
export class ExpenseCreateDto {
  @ApiProperty({ ...DATE_SCHEMA, description: '사용일' })
  @IsCalendarDate()
  spendOn!: string;

  @ApiProperty({ enum: EXPENSE_CATEGORIES, description: '분류 — 코드표 6개뿐 (CHECK expense_category_code)' })
  @IsIn(EXPENSE_CATEGORIES as unknown as string[])
  category!: string;

  @ApiPropertyOptional({ description: '가맹점', maxLength: 80 })
  @IsOptional() @IsString() @MaxLength(80)
  merchant?: string;

  @ApiPropertyOptional({ description: '용도', maxLength: 300 })
  @IsOptional() @IsString() @MaxLength(300)
  purpose?: string;

  @ApiProperty({ description: '신청 금액 (원) — 심사 칸의 placeholder 가 된다 (A-1)', example: 35000 })
  @IsInt() @Min(1) @Max(100_000_000)
  requestedAmount!: number;

  @ApiPropertyOptional({ description: '영수증 — `POST /files`(kind expense-receipt) 로 올린 파일의 id. 없이 올릴 수 있지만 승인은 안 된다 (A-4)' })
  @IsOptional() @IsInt() @Min(1)
  receiptFileId?: number;

  @ApiPropertyOptional({ description: '누구의 지출인가 — 비우면 올리는 사람. 대표가 직원 대신 올릴 때만 쓴다 (본인 신청은 본인이 심사할 수 없다 · A-5)' })
  @IsOptional() @IsInt() @Min(1)
  requesterId?: number;
}

/* ══ 강사 시급 (C97 · 테스트 시나리오 D-48 「시급 변경」) ═══════════════════════════════ */

/** WAGE 한 줄 — 누가 언제부터 얼마 */
export class WageRowDto {
  @ApiProperty() id!: number;
  @ApiProperty() staffId!: number;
  @ApiProperty() staffName!: string;
  @ApiProperty({ description: '기본 시급(원/시간)' }) rate!: number;
  @ApiProperty({ description: '이 날짜의 수업부터 (YYYY-MM-DD) — 소급 없음 (D8)' }) fromDate!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) reason?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: '적은 사람 — 승인 경로면 승인자, 직접 수정이면 고친 사람' }) approvedByName?: string | null;
  @ApiProperty({ description: '오늘 붙는 줄인가 — 같은 사람의 오늘 이하 마지막 줄' }) current!: boolean;
  @ApiProperty({ description: 'KST 시각' }) createdAt!: string;
}

export class WageHistoryDto {
  @ApiProperty() staffId!: number;
  @ApiProperty() staffName!: string;
  @ApiProperty({ type: [WageRowDto], description: '적용일 내림차순 — 맨 앞이 가장 나중 줄(미래 예약 포함)' }) rows!: WageRowDto[];
}

export class WageHistoryQueryDto {
  @ApiProperty({ description: '구성원 id' })
  @Transform(({ value }) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value))
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  staffId!: number;
}

/**
 * `POST /accounting/wages` — 관리자 직접 수정 (D-48). 승인 경로(C41)와 **같은 함수**(`lib/wage.insertWage`)라
 * 「소급 없음 · 같은 날 한 줄」이 두 길에서 같다. 지난 정산은 회차 날짜의 줄을 읽으므로 흔들리지 않는다(I-8).
 */
export class WageWriteDto {
  @ApiProperty({ description: '구성원 id — 활성인 사람만' })
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  staffId!: number;

  @ApiProperty({ description: '기본 시급(원/시간)', example: 45000 })
  @IsInt() @Min(1000) @Max(10_000_000)
  rate!: number;

  @ApiPropertyOptional({ ...DATE_SCHEMA, description: '적용 시작일 — 비우면 오늘. 오늘보다 앞이면 409 WAGE_RETROACTIVE' })
  @IsOptional() @IsCalendarDate()
  fromDate?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @IsOptional() @IsString() @MaxLength(200)
  reason?: string | null;
}
