/** @file-guide
 * 목적: accounting.controller.ts — AccountingController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse,
  ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { ApiErrorDto, OkDto } from '../../common/http.dto';
import { Perm, canCeoCloseMonth, canCeoConfirmPayout, canCeoVoidInvoice, hasPerm, isRole, type RequestUser } from '../../common/perm';
import {
  AccountingDto, CarryRowDto, ExpenseDto, ExpenseReviewDto, InvBoardDto, InvoiceDto, InvoiceIssueDto,
  OtherIncomeDto, OtherIncomeQueryDto, PaymentCreateDto, TuitionCarryDto, TuitionDto, TuitionQueryDto,
  MonthCloseDto, MonthCloseWriteDto, MonthReopenWriteDto,
  InvoiceBatchDto, InvoiceBatchResultDto, InvoiceVoidDto,
  PayoutSheetDto, PayoutSheetRowDto, PayoutConfirmDto, PayoutMonthParamsDto,
  type IncomeSpan,
  StudentWithdrawDto, WithdrawResultDto,
  RateBookDto, RateRowDto, RateWriteDto, StudentRateRowDto, StudentRateWriteDto, ExpenseCreateDto,
} from './accounting.dto';
import { todayKst } from '../../lib/kst';
import { AccountingService } from './accounting.service';
import { StudentWithdrawService } from './withdraw.service';

@ApiTags('accounting')
@Controller('accounting')
export class AccountingController {
  constructor(private readonly svc: AccountingService, private readonly withdrawSvc: StudentWithdrawService) {}

  /**
   * ⚠️ 2026-09-12 (C36-a) 교정 — 종전 `canCrudAll` 은 **원문과 달랐다.**
   * v2 §76 전수 조사 표는 「회계 탭 전체 · 입금 처리 · 청구서 삭제/수정 — **대표만**」이고 그것이 D-R9 다
   * (`spec/DEV-SPEC.md §4.6` · 원본 컷 §52~§56 머리글 「회계 〔대표·이사〕」 · 상단 탭 `회계 🔒`).
   * 프런트는 이미 `canMoney` 로 막고 있었지만 API 는 매니저에게 200 을 주고 있었다 —
   * 금액만 null 이고 **학생 이름·청구 제목·상태·연체 사실은 그대로 나갔다.**
   * 화면에서 가리는 것은 감춘 것이 아니다 (AGENT §9). 사람별 예외는 `canMoney` 한 줄로 계속 열린다.
   */
  @Get()
  @Perm('canMoney')
  @ApiOperation({ summary: '회계 — 청구서 · 입금 · 정산 (D-R9 · v2 §76 — 대표 전용, 사람별 예외는 canMoney)' })
  @ApiOkResponse({ type: AccountingDto })
  async all(@CurrentUser() user: RequestUser): Promise<AccountingDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.all(canSee, isRole(user.role) && canCeoVoidInvoice(user.role));
  }


  @Get('tuition')
  @Perm('canMoney')
  @ApiOperation({
    summary: '수업료 계산 — 학생별 이번 달 진행과 금액 (§54)',
    description:
      '원문 §54 의 「연동: **청구서 생성 시 이 계산 결과를 씁니다**」가 이 화면의 정체다 — '
      + '청구서가 쓰는 바로 그 계산(`invoice-lines.ts`)을 미리 보는 자리라, 단가를 여기서 다시 세지 않는다 (D-R22). '
      + '세는 것도 나누는 것도 서버다 — 화면이 회차를 세면 취소·「그날만 빠진」을 빠뜨리고(D-R21), '
      + '화면이 %를 내면 머리 칸과 갈린다 (D-R37). 결강은 금액에서 빠지고 「넘길 돈」으로 따로 선다.',
  })
  @ApiOkResponse({ type: TuitionDto })
  async tuition(@CurrentUser() user: RequestUser, @Query() query: TuitionQueryDto): Promise<TuitionDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.tuition(query.month ?? todayKst().slice(0, 7), canSee, isRole(user.role) && canCeoCloseMonth(user.role));
  }

  @Get('payouts')
  @Perm('canMoney')
  @ApiOperation({
    summary: '강사료 시트 — 강사별 한 달 (§57 · 테스트 시나리오 H-82 · D-43)',
    description: '세는 것은 lib/payout-sheet 한 곳(강사 히스토리와 같다). 리포트를 쓴 수업만 시수·금액에 들고, 미작성은 빠지며 얼마가 빠지는지 센다. '
      + '휴강은 시수에 잡히지 않는다. 저장된 초안이 계산과 다르면 줄에 함께 보인다.',
  })
  @ApiOkResponse({ type: PayoutSheetDto })
  async payoutSheet(@CurrentUser() user: RequestUser, @Query() query: TuitionQueryDto): Promise<PayoutSheetDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    const month = query.month ?? todayKst().slice(0, 7);
    return this.svc.payoutSheetOf(month, canSee, isRole(user.role) && canCeoConfirmPayout(user.role));
  }

  @Post('payouts/:month/confirm')
  @Perm('canMoney')
  @ApiOperation({
    summary: '지급 확정 — 대표 전용 (O-148). 그 순간의 시트를 payout 행으로 굳힌다',
    description: '달이 끝나기 전에는 400 PAYOUT_MONTH_OPEN · 시급 없는 수업이 있으면 409 PAYOUT_NO_RATE · 쓴 수업 0 이면 409 PAYOUT_NOTHING · '
      + '이미 확정이면 409 PAYOUT_ALREADY_CONFIRMED. payout_line 은 쓰지 않는다(N-36 결정 전).',
  })
  @ApiCreatedResponse({ type: PayoutSheetRowDto })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: '대표 아님' })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'PAYOUT_MONTH_OPEN' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'PAYOUT_ALREADY_CONFIRMED | PAYOUT_NO_RATE | PAYOUT_NOTHING' })
  confirmPayout(@CurrentUser() user: RequestUser, @Param() params: PayoutMonthParamsDto, @Body() dto: PayoutConfirmDto): Promise<PayoutSheetRowDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.confirmPayout(user.id, isRole(user.role) && canCeoConfirmPayout(user.role), params.month, dto, canSee);
  }

  @Post('withdrawals/preview')
  @Perm('canMoney')
  @ApiOperation({
    summary: '수강 종료·환불 미리보기 — 쓰기 0 (C94-c · H-80 · N-136)',
    description: '같은 트랜잭션을 끝까지 돌리고 되돌린다 — 잔여 회차·청구서 변화·환불액이 실제 처리와 한 원도 다르지 않다. '
      + '종료할 수강이 없으면 409 WITHDRAW_NOTHING · 마감 달 409 MONTH_CLOSED · 단가 없는 과목 409 WITHDRAW_NO_RATE.',
  })
  @ApiCreatedResponse({ type: WithdrawResultDto })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'WITHDRAW_NOTHING | WITHDRAW_NO_RATE | WITHDRAW_EXCEEDS | MONTH_CLOSED' })
  withdrawPreview(@CurrentUser() user: RequestUser, @Body() dto: StudentWithdrawDto): Promise<WithdrawResultDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.withdrawSvc.preview(user.id, dto, canSee);
  }

  @Post('withdrawals')
  @Perm('canMoney')
  @ApiOperation({
    summary: '수강 종료 · 중도 환불 — 한 트랜잭션 (C94-c · H-80 · N-135 · N-136)',
    description: '명단에 종료일(SER_STU.to_date · 행은 남는다) → 종료일 뒤 회차 값을 청구서에서 음수 줄로 빼고 받은 돈이 넘치면 PAY 음수 줄(환불) · '
      + '금액 0 이면 void → ENR.ended_on → LOG. 그룹 수업의 남은 학생 단가는 그 날짜의 인원으로 다시 잡힌다. 되돌리는 길은 없다.',
  })
  @ApiCreatedResponse({ type: WithdrawResultDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'WITHDRAW_BAD_SERIES · 입력 검증' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'WITHDRAW_NOTHING | WITHDRAW_NO_RATE | WITHDRAW_EXCEEDS | MONTH_CLOSED' })
  withdraw(@CurrentUser() user: RequestUser, @Body() dto: StudentWithdrawDto): Promise<WithdrawResultDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.withdrawSvc.withdraw(user.id, dto, canSee);
  }

  @Post('tuition/close')
  @Perm('canMoney')
  @ApiOperation({
    summary: '월 마감 — 대표 전용 (테스트 시나리오 C-39)',
    description: '마감된 달은 회차·휴강·출결·청구서 발행·이월·휴원 쓰기가 409 MONTH_CLOSED 로 막힌다 (L-123). '
      + '판정은 lib/month-close 한 곳. 해제 전까지는 아무도 못 고친다 — 화면이 단추를 숨기는 것과 별개로 서버가 막는다.',
  })
  @ApiCreatedResponse({ type: MonthCloseDto })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'MONTH_ALREADY_CLOSED' })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'MONTH_NOT_STARTED — 아직 시작하지 않은 달' })
  closeMonth(@CurrentUser() user: RequestUser, @Body() dto: MonthCloseWriteDto): Promise<MonthCloseDto> {
    return this.svc.closeMonth(user.id, isRole(user.role) && canCeoCloseMonth(user.role), dto);
  }

  @Post('tuition/reopen')
  @Perm('canMoney')
  @ApiOperation({
    summary: '마감 해제 — 대표 전용 · 사유 필수 (테스트 시나리오 N-140)',
    description: '행을 지우지 않고 누가·언제·왜를 남긴다 — 「흔적 없이 고쳐지면 실패」. 다시 마감하면 새 행이 선다.',
  })
  @ApiCreatedResponse({ type: MonthCloseDto })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'MONTH_NOT_CLOSED' })
  reopenMonth(@CurrentUser() user: RequestUser, @Body() dto: MonthReopenWriteDto): Promise<MonthCloseDto> {
    return this.svc.reopenMonth(user.id, isRole(user.role) && canCeoCloseMonth(user.role), dto);
  }

  @Get('board')
  @Perm('canMoney')
  @ApiOperation({
    summary: '회계 트래킹 보드 — 칸 넷 (§52)',
    description:
      '**칸은 `inv.state` 하나로 갈린다** (대표 결정 2026-09-13 · N-28 「단일 진실원과 자동 전이에 유리하게」). '
      + '두 축(`state` + 「PAY 행이 있는가」)으로 가르면 판정이 두 벌이 되어 같은 청구서가 어느 칸에 있는지 '
      + '두 곳이 다르게 답한다. 전이는 이미 자동이다 — 입금이 들어오면 `addPayment` 가 상태를 옮긴다. '
      + '「50% 냄」·「연체」는 칸을 정하는 값이 아니라 **카드에 적히는 값**이다. '
      + '칸은 비어도 선다(어휘이지 데이터가 아니다) · 건수와 합계도 서버가 센다 (D-R37).',
  })
  @ApiOkResponse({ type: InvBoardDto })
  async invoiceBoard(@CurrentUser() user: RequestUser): Promise<InvBoardDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.invoiceBoard(canSee);
  }

  @Get('other-income')
  @Perm('canMoney')
  @ApiOperation({
    summary: '그 밖의 수입 — 수업료가 아닌 돈 (§57)',
    description:
      '컷의 줄 셋(진단고사 + 상담 비용 · 컨설팅비 · MAP + CAT)은 대표가 정한 청구 종류 그대로다 (N-37 · C64). '
      + '**데이터가 0건이어도 줄은 선다** — 종류는 어휘이지 데이터가 아니다. '
      + '건수·금액·받음은 §52 머리와 **같은 어휘**(`INV_BILLABLE`)로 세어 초안과 취소를 뺀다. '
      + '「청구 안 함 N」은 그 종류의 **초안 건수**로 읽었다 — 원문이 뜻을 안 적었고, '
      + '「청구서 없이 받은 돈」으로 읽으려면 종류마다 새 표가 필요한데 원문이 그런 표를 말한 적이 없다 (N-37 ②). '
      + '컷 오른쪽의 「일별 · 주별 · 월별」(`span`)은 **줄의 숫자를 바꾸지 않는다** — 줄은 여전히 전 기간의 합계이고, '
      + '**줄을 펼쳤을 때 그 눈금으로 날짜 묶음이 생긴다** (대표 결정 2026-09-13 · N-40 「일/주/월 + 유저 선택 시 날짜별 → 서브 그룹」). '
      + '자르는 기준은 발행일이고 발행일이 없는 건은 「날짜 없음」 묶음에 모인다 — 버리지 않는다.',
  })
  @ApiOkResponse({ type: OtherIncomeDto })
  async otherIncome(
    @CurrentUser() user: RequestUser,
    @Query() query: OtherIncomeQueryDto,
  ): Promise<OtherIncomeDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.otherIncome(canSee, (query.span as IncomeSpan | undefined) ?? 'month');
  }

  @Post('tuition/carry')
  @Perm('canMoney')
  @ApiOperation({
    summary: '이월 처리 — 받아 놓고 못 해 준 수업을 다음 달로 (§54)',
    description:
      '대표 결정 2026-09-13 (N-39): 「이월 처리는 **수업이 결제 됐으나 정해진 시수가 채워지지 않은 경우**」. '
      + '그래서 **돈을 안 받았으면 넘길 것이 없다** — 그냥 안 청구된 것이고 §54 가 이미 빼고 있다. '
      + '넘긴 사실은 `carry` 한 줄로 남고 다음 달 §54 가 그 줄을 읽는다 — 저장하지 않고 화면에서만 옮기면 '
      + '다음 달에 같은 결강이 또 넘어오거나 아예 안 넘어온다. **한 달은 한 번만** 넘긴다.',
  })
  @ApiCreatedResponse({ type: CarryRowDto })
  @ApiConflictResponse({
    description: 'code CARRY_NOT_PAID(완납 아님) | CARRY_NOTHING(못 해 준 수업 없음) | CARRY_DUPLICATE(이미 넘김)',
  })
  async carryTuition(
    @CurrentUser() user: RequestUser,
    @Body() dto: TuitionCarryDto,
  ): Promise<CarryRowDto> {
    return this.svc.carryTuition(user.id, dto);
  }

  @Post('invoices')
  @Perm('canMoney')
  @ApiOperation({
    summary: '청구서 한 장 발행 — 줄은 서버가 만든다 (§53 「+ 새 청구서 발행」)',
    description:
      '줄(INV_LINE)을 받지 않는다. 원문 명세가 「횟수는 서버가 occ() 로 센다 — 프론트가 세면 예외(EXC)를 '
      + '빠뜨린다」고 적었다(D-R37). 누구의 어느 달인지만 주면 과목별 회차·단가·소계·합계를 서버가 만든다. '
      + '되돌리기는 없다 — 잘못 냈으면 취소하고 새로 만든다(원문 규칙 줄).',
  })
  @ApiCreatedResponse({ type: InvoiceDto, description: '줄까지 채워진 청구서' })
  @ApiConflictResponse({
    description: 'code INV_DUPLICATE(같은 학생·달·종류가 이미 있음) | INV_NO_LESSONS(그 달 수업 없음) | INV_NO_RATE(단가표에 없는 과목)',
  })
  @ApiNotFoundResponse({ description: '학생 없음' })
  async issueInvoice(@CurrentUser() user: RequestUser, @Body() dto: InvoiceIssueDto): Promise<InvoiceDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.issueInvoice(user.id, dto, canSee, isRole(user.role) && canCeoVoidInvoice(user.role));
  }

  @Post('invoices/batch')
  @Perm('canMoney')
  @ApiOperation({
    summary: '청구서 일괄 발행 — 그 달 수업이 있는 학생 전부 (§54 「청구서 발행」 · 테스트 시나리오 H-75 · O-147)',
    description: '낱장 발행과 같은 계산이다 — 이월 음수 줄·단가 구간·그날만 빠짐·휴원이 그대로 든다. 막힌 학생(이미 있음 · 단가 없음 · '
      + '이월 초과)은 건너뛰고 이유를 돌려준다. 마감 달은 통째로 409 MONTH_CLOSED.',
  })
  @ApiCreatedResponse({ type: InvoiceBatchResultDto })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'MONTH_CLOSED' })
  async issueBatch(@CurrentUser() user: RequestUser, @Body() dto: InvoiceBatchDto): Promise<InvoiceBatchResultDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.issueBatch(user.id, dto, canSee, isRole(user.role) && canCeoVoidInvoice(user.role));
  }

  @Post('invoices/:id/deliver')
  @Perm('canMoney')
  @ApiOperation({ summary: '청구서 전달 — 학부모께 보냈다 (§53 ③ · H-76). 초안·미전달만' })
  @ApiCreatedResponse({ type: InvoiceDto })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'INV_NOT_DELIVERABLE' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'INV_NOT_FOUND' })
  async deliverInvoice(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<InvoiceDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.deliverInvoice(user.id, id, canSee, isRole(user.role) && canCeoVoidInvoice(user.role));
  }

  @Post('invoices/:id/void')
  @Perm('canMoney')
  @ApiOperation({
    summary: '청구서 취소 — 대표 전용 · 사유 필수 (N-139)',
    description: '지우지 않고 void 로 접는다 — 줄·발행일·사유가 남고 미수 집계에서 빠진다. 입금이 붙어 있으면 입금을 먼저 지운다. 마감 달은 409.',
  })
  @ApiCreatedResponse({ type: InvoiceDto })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: '대표 아님' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'INV_ALREADY_VOID | INV_HAS_PAYMENTS | MONTH_CLOSED' })
  async voidInvoice(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: InvoiceVoidDto): Promise<InvoiceDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.voidInvoice(user.id, isRole(user.role) && canCeoVoidInvoice(user.role), id, dto, canSee);
  }

  @Post('payments')
  @Perm('canMoney')
  @ApiOperation({
    summary: '입금 한 줄 등록 — 분납은 줄을 늘린다 (A-D2 · v2 §53 ⑤ 입금 기록)',
    description: '누계·상태 전이(partial/paid)·초과 거절은 서버 한 곳에서 한다. 화면은 잔여를 placeholder 로만 쓴다.',
  })
  @ApiCreatedResponse({ type: InvoiceDto, description: '누계와 전이가 반영된 청구서' })
  @ApiConflictResponse({ description: 'code OVERPAY(남은 금액 초과) | INV_NOT_BILLABLE(초안·취소)' })
  @ApiNotFoundResponse({ description: '청구서 없음' })
  async addPayment(@CurrentUser() user: RequestUser, @Body() dto: PaymentCreateDto): Promise<InvoiceDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.addPayment(user.id, dto, canSee);
  }

  @Delete('payments/:id')
  @Perm('canMoney')
  @ApiOperation({ summary: '입금 줄 삭제 — 부분 납부(partial) 정정일 때만. 완납은 되돌리지 않는다' })
  @ApiOkResponse({ type: OkDto })
  @ApiConflictResponse({ description: 'code INV_PAID_LOCKED' })
  @ApiNotFoundResponse({ description: '입금 기록 없음' })
  async removePayment(@Param('id', ParseIntPipe) id: number): Promise<OkDto> {
    return this.svc.removePayment(id);
  }

  @Post('expenses/:id/review')
  @Perm('canMoney')
  @ApiOperation({
    summary: '법인카드 심사 — 승인(감액 가능·증액 금지)·반려 (A-D3 · v2 §56 법인카드)',
    description: '신청 금액은 placeholder 일 뿐이고 확정 금액은 사람이 넣는다 (대표 지시 2026-08-25). 판정은 전부 서버.',
  })
  @ApiCreatedResponse({ type: ExpenseDto })
  @ApiBadRequestResponse({ description: 'code AMOUNT_REASON_REQUIRED(사유·확정 금액 누락)' })
  @ApiForbiddenResponse({ description: 'code SELF_APPROVAL_FORBIDDEN(본인 신청 자기 심사)' })
  @ApiUnprocessableEntityResponse({ description: 'code CARD_AMOUNT_EXCEEDS_REQUEST(증액) | CARD_RECEIPT_REQUIRED(영수증 없음)' })
  @ApiConflictResponse({ description: 'code EXPENSE_ALREADY_REVIEWED' })
  @ApiNotFoundResponse({ description: '지출 건 없음' })
  async reviewExpense(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ExpenseReviewDto,
  ): Promise<ExpenseDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.reviewExpense(user.id, id, dto, canSee);
  }

  /* ══ 단가표 · 학생별 예외 · 지출 등록 (C94-d · H-81 · H-83 · C-38) ═══════════════════ */

  @Get('rates')
  @Perm('canMoney')
  @ApiOperation({
    summary: '단가표 — 기본 단가(RATE)와 학생별 예외(STURATE) (§54 「데이터 RATE, STURATE」)',
    description: '청구서·§54·명단 가격이 읽는 바로 그 두 표다. 「살아 있는 줄」은 서버가 오늘 기준으로 판정한다 (D-R37).',
  })
  @ApiOkResponse({ type: RateBookDto })
  rateBook(): Promise<RateBookDto> {
    return this.svc.rateBook(todayKst());
  }

  @Post('rates')
  @Perm('canMoney')
  @ApiOperation({
    summary: '기본 단가 한 줄 등록 — 그 날짜부터 청구서·§54·명단 가격에 든다 (C-38 · N-17 ①)',
    description: '지난 줄은 고치지도 지우지도 않는다 — 이미 낸 청구서가 그 값으로 서 있다. '
      + '같은 종류·과목·인원·날짜는 409 RATE_DUPLICATE (rate_tier_key). 종류·과목이 코드표에 없으면 404.',
  })
  @ApiCreatedResponse({ type: RateRowDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'KIND_NOT_FOUND | SUB_NOT_FOUND' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'RATE_DUPLICATE' })
  writeRate(@CurrentUser() user: RequestUser, @Body() dto: RateWriteDto): Promise<RateRowDto> {
    return this.svc.writeRate(user.id, dto);
  }

  @Post('sturates')
  @Perm('canMoney')
  @ApiOperation({
    summary: '학생별 단가 예외 한 줄 — 사유 필수 (H-81)',
    description: '그 학생의 그 종류(비우면 전부)만 이 값으로 청구된다 — 다른 학생은 한 원도 안 바뀐다. '
      + '사유가 비면 400 STURATE_REASON_REQUIRED(DTO) · 표는 CHECK sturate_reason_present. 같은 학생·종류·날짜는 409 STURATE_DUPLICATE.',
  })
  @ApiCreatedResponse({ type: StudentRateRowDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'STURATE_REASON_REQUIRED · 입력 검증' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STUDENT_NOT_FOUND | KIND_NOT_FOUND' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'STURATE_DUPLICATE' })
  writeStudentRate(@CurrentUser() user: RequestUser, @Body() dto: StudentRateWriteDto): Promise<StudentRateRowDto> {
    return this.svc.writeStudentRate(user.id, dto);
  }

  /**
   * 지출 등록은 **돈 권한이 아니라 직원 권한**이다 — 올리는 사람은 금액을 확정하지 않는다(A-1).
   * 확정은 `POST /expenses/{id}/review`(canMoney) 뿐이고, 본인 신청은 본인이 심사할 수 없다(A-5).
   * 강사는 §76 에서 회계·지출이 「조회 불가」라 canAdminPage 밖이다.
   */
  @Post('expenses')
  @Perm('canAdminPage')
  @ApiOperation({
    summary: '지출 등록 — 직원이 올리면 언제나 pending (H-83 「바로 확정되면 실패」)',
    description: '확정 금액·상태는 받지 않는다. 영수증은 POST /files(kind expense-receipt) 로 먼저 올리고 id 를 준다 — 없이 올릴 수 있지만 승인은 안 된다(A-4). '
      + '대표(ceo)에게 「심사 대기」 알림 한 건. 대표가 직원 대신 올릴 때만 requesterId 를 준다.',
  })
  @ApiCreatedResponse({ type: ExpenseDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'EXPENSE_RECEIPT_KIND · 입력 검증' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STAFF_NOT_FOUND | FILE_NOT_FOUND' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'EXPENSE_RECEIPT_USED' })
  createExpense(@CurrentUser() user: RequestUser, @Body() dto: ExpenseCreateDto): Promise<ExpenseDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.createExpense(user.id, dto, canSee);
  }
}
