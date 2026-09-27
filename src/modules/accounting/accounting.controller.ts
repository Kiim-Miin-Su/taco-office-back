/** @file-guide
 * 목적: accounting.controller.ts — AccountingController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse,
  ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { ApiErrorDto, OkDto } from '../../common/http.dto';
import {
  Perm, canCeoApproveCorrection, canCeoCloseMonth, canCeoConfirmPayout, canCeoFileExpenseForOther, canCeoSetAcctPrivacy, canCeoVoidInvoice,
  hasPerm, isRole, type RequestUser,
} from '../../common/perm';
import {
  AccountingDto, CarryRowDto, ExpenseDto, ExpenseReviewDto, InvBoardDto, InvoiceDto, InvoiceIssueDto,
  InvoiceDraftDto, InvoiceDraftQueryDto,
  ManualPaymentCreateDto, OtherIncomeDto, OtherIncomeQueryDto, PaymentCreateDto, PaymentDto, TuitionCarryDto, TuitionDto, TuitionQueryDto,
  MonthCloseDto, MonthCloseWriteDto, MonthReopenWriteDto,
  InvoiceBatchDto, InvoiceBatchResultDto, InvoiceVoidDto,
  PayoutSheetDto, PayoutSheetRowDto, PayoutConfirmDto, PayoutMonthParamsDto, PayoutDetailDto, PayoutDetailParamsDto,
  CashflowDto, CashflowQueryDto,
  type IncomeSpan,
  StudentWithdrawDto, WithdrawResultDto,
  RateBookDto, RateRowDto, RateWriteDto, StudentRateRowDto, StudentRateWriteDto, ExpenseCreateDto,
  WageHistoryDto, WageHistoryQueryDto, WageRowDto, WageWriteDto, MyExpenseListDto,
  PayoutBonusBookDto, PayoutBonusRuleDto, PayoutBonusRuleWriteDto, AcctPrivacyDto, AcctPrivacyWriteDto,
} from './accounting.dto';
import { todayKst } from '../../lib/kst';
import { AccountingService, type AcctViewer } from './accounting.service';
import { StudentWithdrawService } from './withdraw.service';

/** 회계 비공개(N-94)의 보는 사람 — 비공개 열람(canHide · 사람별 예외 반영)과 본인 번호 */
const viewerOf = (user: RequestUser): AcctViewer => ({
  id: user.id, canHide: isRole(user.role) && hasPerm(user.role, 'canHide', user.perms),
});

/**
 * 회계 비공개 스위치를 켜고 끌 수 있는가 — 대표 판정 **그리고** 비공개 열람(`canHide` · 사람별 예외 포함).
 * 비공개 열람을 끈 사람이 스위치를 끄면 자기에게 가려진 금액이 드러난다 — 권한 한도(W11 · 내게 없는 권한은 남에게도 나에게도 못 연다)와 같은 뜻이다.
 * 실브라우저 QA(W11-M-13)가 좁혀진 매니저의 우회를 잡았다.
 */
function canSetAcctPrivacy(user: RequestUser): boolean {
  return isRole(user.role) && canCeoSetAcctPrivacy(user.role) && viewerOf(user).canHide;
}

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
    return this.svc.all(canSee, isRole(user.role) && canCeoVoidInvoice(user.role), viewerOf(user));
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
      + '휴강은 시수에 잡히지 않는다. 저장된 초안이 계산과 다르면 줄에 함께 보인다. '
      + '가산(N-93)은 같은 함수가 더하고, 확정된 달은 저장값(근거 줄)을 그대로 읽는다(N-36). 앞선 확정 달의 회차를 확정 뒤에 쓰면 '
      + '다음 미확정 달에 보정 줄로 얹힌다(N-51). 시급 비공개(N-94)가 켜지면 줄 금액은 비공개 열람 · 본인만 보고 합계는 그대로다.',
  })
  @ApiOkResponse({ type: PayoutSheetDto })
  async payoutSheet(@CurrentUser() user: RequestUser, @Query() query: TuitionQueryDto): Promise<PayoutSheetDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    const month = query.month ?? todayKst().slice(0, 7);
    return this.svc.payoutSheetOf(
      month, canSee, isRole(user.role) && canCeoConfirmPayout(user.role), viewerOf(user),
      isRole(user.role) && canCeoApproveCorrection(user.role),
    );
  }

  @Get('payouts/:staffId')
  @Perm('canMoney')
  @ApiOperation({
    summary: '§56 강사 한 사람 상세 — 시급 · 수업 날짜 · 리포트 미작성 · 정산 내역 (w5 · 56-01)',
    description: '시트와 같은 함수(lib/payout-sheet)가 센다 — 줄(row)은 시트의 그 줄과 같은 값이고 수업 줄의 강사료 합이 총액이다. '
      + '그 달 정산에 없는 사람은 404(없는 정산을 0원으로 지어내지 않는다).',
  })
  @ApiOkResponse({ type: PayoutDetailDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STAFF_NOT_FOUND' })
  async payoutDetail(
    @CurrentUser() user: RequestUser, @Param() params: PayoutDetailParamsDto, @Query() query: TuitionQueryDto,
  ): Promise<PayoutDetailDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.payoutDetail(
      params.staffId, query.month ?? todayKst().slice(0, 7), canSee, isRole(user.role) && canCeoConfirmPayout(user.role),
      viewerOf(user), isRole(user.role) && canCeoApproveCorrection(user.role),
    );
  }

  @Get('cashflow')
  @Perm('canMoney')
  @ApiOperation({
    summary: '§55 들어온 돈 — 기간 요약 · 입금 달력 · 분류별 · 미수 전체 (w5 · 55-01 · 55-02 · 55-03 · 55-05)',
    description: '한 기간의 돈은 두 갈래다 — 그 기간에 들어온 입금 줄(pay.paid_on)과 기한이 그 기간인 덜 받은 청구서의 남은 돈(예정). '
      + '청구 = 입금 + 예정. 분류는 입금 목록의 칩과 같은 함수(payCategory)가 정한다. 분류 칩으로 좁혀도 칩 건수는 그대로다. '
      + '미수 전체는 기간과 무관하다. 끝이 시작보다 앞서면 409 BAD_RANGE.',
  })
  @ApiOkResponse({ type: CashflowDto })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'BAD_RANGE' })
  async cashflow(@CurrentUser() user: RequestUser, @Query() query: CashflowQueryDto): Promise<CashflowDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.cashflow(canSee, query, todayKst(), viewerOf(user));
  }

  @Post('payouts/:month/confirm')
  @Perm('canMoney')
  @ApiOperation({
    summary: '지급 확정 — 대표 전용 (O-148). 그 순간의 시트를 payout 행과 회차 근거 줄(payout_line)로 굳힌다 (N-36)',
    description: '달이 끝나기 전에는 400 PAYOUT_MONTH_OPEN · 시급 없는 수업이 있으면 409 PAYOUT_NO_RATE · 쓴 수업(보정 줄 포함) 0 이면 409 PAYOUT_NOTHING · '
      + '이미 확정이면 409 PAYOUT_ALREADY_CONFIRMED. 회차마다 근거 줄(시급 스냅숏 · 시수 · 금액 · 가산 · 차감)을 남긴다 — 한 회차는 한 번만(409 PAYOUT_LINE_DUPLICATE). '
      + '보정 줄(N-51)이 든 달은 보정 승인 판정을 함께 지난다(403 PAYOUT_CORRECTION_FORBIDDEN) · 감사 payout.correction.',
  })
  @ApiCreatedResponse({ type: PayoutSheetRowDto })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: '대표 아님 · PAYOUT_CORRECTION_FORBIDDEN' })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'PAYOUT_MONTH_OPEN' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'PAYOUT_ALREADY_CONFIRMED | PAYOUT_NO_RATE | PAYOUT_NOTHING | PAYOUT_LINE_DUPLICATE' })
  confirmPayout(@CurrentUser() user: RequestUser, @Param() params: PayoutMonthParamsDto, @Body() dto: PayoutConfirmDto): Promise<PayoutSheetRowDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.confirmPayout(
      user.id, isRole(user.role) && canCeoConfirmPayout(user.role), params.month, dto, canSee,
      isRole(user.role) && canCeoApproveCorrection(user.role), viewerOf(user),
    );
  }

  /* ══ 가산 규칙 (N-93 · D1 §4-12 · 원문 §56 「추가로 드리는 돈」) — 정리 · 기준 탭 · canWage ═══════════ */

  @Get('bonus-rules')
  @Perm('canAdminPage', 'canWage')
  @ApiOperation({
    summary: '가산 규칙 — 칸 셋(한 번에 · Kinder 시급에 더함 · 그룹 한 명당)과 적은 줄 전부 (N-93)',
    description: '셈은 lib/payout-sheet 의 한 함수가 시트 · 확정 · 강사 히스토리에 같이 한다. D1 금액은 칸을 미리 채울 값이지 데이터가 아니다. '
      + 'Kinder 는 수업을 가를 표시가 모델에 없어 0 원으로 센다(applied=false · note).',
  })
  @ApiOkResponse({ type: PayoutBonusBookDto })
  bonusBook(): Promise<PayoutBonusBookDto> {
    return this.svc.bonusBook(todayKst());
  }

  @Post('bonus-rules')
  @Perm('canAdminPage', 'canWage')
  @ApiOperation({
    summary: '가산 규칙 새 줄 — 시급처럼 새 줄로만 바꾼다 (N-93)',
    description: '적용일은 오늘 이후(409 BONUS_RETROACTIVE — 확정한 달 · 지난 수업은 바뀌지 않는다) · 같은 칸 같은 날 409 BONUS_SAME_DAY · '
      + '「한 번에」는 수업 종류가 필요하다(400 BONUS_KIND_KEY · 없는 종류 404 KIND_NOT_FOUND). 금액 0 은 「그 날부터 멈춤」. 감사 payout.bonus_rule.',
  })
  @ApiCreatedResponse({ type: PayoutBonusRuleDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'BONUS_KIND_KEY · 입력 검증' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'KIND_NOT_FOUND' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'BONUS_RETROACTIVE | BONUS_SAME_DAY' })
  writeBonusRule(@CurrentUser() user: RequestUser, @Body() dto: PayoutBonusRuleWriteDto): Promise<PayoutBonusRuleDto> {
    return this.svc.writeBonusRule(user.id, dto);
  }

  /* ══ 회계 비공개 스위치 (N-94 · 원문 §53 · §55 탭 줄 오른쪽 「시급 비공개 · 컨설팅 비공개」) ═══════════ */

  @Get('privacy')
  @Perm('canMoney')
  @ApiOperation({
    summary: '회계 비공개 스위치 두 개 — 시급 비공개 · 컨설팅 비공개 (N-94)',
    description: '켜면 그 줄 금액은 비공개 열람(canHide)만 본다 — 합계는 그대로다. 켜고 끄는 사람은 대표 판정(canSet).',
  })
  @ApiOkResponse({ type: AcctPrivacyDto })
  acctPrivacy(@CurrentUser() user: RequestUser): Promise<AcctPrivacyDto> {
    return this.svc.acctPrivacy(canSetAcctPrivacy(user), viewerOf(user).canHide);
  }

  @Patch('privacy')
  @Perm('canMoney')
  @ApiOperation({
    summary: '회계 비공개 스위치 켬 · 끔 — 대표 판정 (N-94 · 원문 슬라이드 77 「강사 시급 공개 지정 · 내역 비공개 지정 — 대표만」)',
    description: '대표 판정이 아니거나 비공개 열람(canHide — 사람별 예외 포함)이 없으면 403 ACCT_PRIVACY_FORBIDDEN. 누가 · 언제를 남기고 감사 acct.privacy.',
  })
  @ApiOkResponse({ type: AcctPrivacyDto })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'ACCT_PRIVACY_FORBIDDEN' })
  setAcctPrivacy(@CurrentUser() user: RequestUser, @Body() dto: AcctPrivacyWriteDto): Promise<AcctPrivacyDto> {
    return this.svc.setAcctPrivacy(user.id, canSetAcctPrivacy(user), viewerOf(user).canHide, dto);
  }

  @Post('withdrawals/preview')
  @Perm('canMoney')
  @ApiOperation({
    summary: '수강 종료·환불 미리보기 — 쓰기 0 (C94-c · H-80 · N-136)',
    description: '같은 트랜잭션을 끝까지 돌리고 되돌린다 — 잔여 회차·청구서 변화·환불액이 실제 처리와 한 원도 다르지 않다. '
      + '종료할 수강이 없으면 409 WITHDRAW_NOTHING · 마감 달 409 MONTH_CLOSED · 단가 없는 과목 409 WITHDRAW_NO_RATE · '
      + '진단고사 · 상담 줄이 섞인 옛 수업료 청구서에 그 회차가 종료일 뒤로 남으면 409 WITHDRAW_MIXED_INVOICE(사람이 확인 · W11 A\' 후속).',
  })
  @ApiCreatedResponse({ type: WithdrawResultDto })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'WITHDRAW_NOTHING | WITHDRAW_NO_RATE | WITHDRAW_EXCEEDS | WITHDRAW_MIXED_INVOICE | MONTH_CLOSED' })
  withdrawPreview(@CurrentUser() user: RequestUser, @Body() dto: StudentWithdrawDto): Promise<WithdrawResultDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.withdrawSvc.preview(user.id, dto, canSee, isRole(user.role) && canCeoVoidInvoice(user.role));
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
  @ApiConflictResponse({ type: ApiErrorDto, description: 'WITHDRAW_NOTHING | WITHDRAW_NO_RATE | WITHDRAW_EXCEEDS | WITHDRAW_NEEDS_CEO_VOID | WITHDRAW_MIXED_INVOICE | MONTH_CLOSED' })
  withdraw(@CurrentUser() user: RequestUser, @Body() dto: StudentWithdrawDto): Promise<WithdrawResultDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.withdrawSvc.withdraw(user.id, dto, canSee, isRole(user.role) && canCeoVoidInvoice(user.role));
  }

  @Post('tuition/close')
  @Perm('canMoney')
  @ApiOperation({
    summary: '월 마감 — 대표 전용 (테스트 시나리오 C-39)',
    description: '마감된 달은 회차·휴강·출결·청구서 발행·이월·휴원 쓰기가 409 MONTH_CLOSED 로 막힌다 (L-123). '
      + '판정은 lib/month-close 한 곳. 해제 전까지는 아무도 못 고친다 — 화면이 단추를 숨기는 것과 별개로 서버가 막는다. '
      + '마감 · 해제는 그 달 열쇠를 배타로, 발행 · 이월은 공유로 잡는다 — 도는 발행 · 이월이 끝난 뒤에 마감한다(W11 A\' 후속).',
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
    summary: '회계 트래킹 보드 — §52 칸 넷 + §53 칸 다섯',
    description:
      '**칸은 `inv.state` 하나로 갈린다** (대표 결정 2026-09-13 · N-28 「단일 진실원과 자동 전이에 유리하게」). '
      + '두 축(`state` + 「PAY 행이 있는가」)으로 가르면 판정이 두 벌이 되어 같은 청구서가 어느 칸에 있는지 '
      + '두 곳이 다르게 답한다. 전이는 이미 자동이다 — 입금이 들어오면 `addPayment` 가 상태를 옮긴다. '
      + '「50% 냄」·「연체」는 칸을 정하는 값이 아니라 **카드에 적히는 값**이다. '
      + '칸은 비어도 선다(어휘이지 데이터가 아니다) · 건수와 합계도 서버가 센다 (D-R37). '
      + '`stages` 는 §53 다섯 칸 판이다(N-28 ② 채택) — ②~⑤ 는 네 칸과 같은 판정이고 ① 「아직 안 씀」은 이번 달의 '
      + '**아직 청구서가 없는 청구 대상**을 일괄 발행과 같은 함수로 세어 예상 금액(발행과 같은 함수)과 함께 내린다(저장하지 않는다). '
      + '다음 칸 단추(`next`)는 이미 있는 쓰기만 가리킨다 — 발행 · 전달 · 입금.',
  })
  @ApiOkResponse({ type: InvBoardDto })
  async invoiceBoard(@CurrentUser() user: RequestUser): Promise<InvBoardDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.invoiceBoard(canSee, viewerOf(user));
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
    return this.svc.otherIncome(canSee, (query.span as IncomeSpan | undefined) ?? 'month', viewerOf(user));
  }

  @Post('tuition/carry')
  @Perm('canMoney')
  @ApiOperation({
    summary: '이월 처리 — 받아 놓고 못 해 준 수업을 다음 달로 (§54)',
    description:
      '대표 결정 2026-09-13 (N-39): 「이월 처리는 **수업이 결제 됐으나 정해진 시수가 채워지지 않은 경우**」. '
      + '그래서 **돈을 안 받았으면 넘길 것이 없다** — 그냥 안 청구된 것이고 §54 가 이미 빼고 있다. '
      + '넘긴 사실은 `carry` 한 줄로 남고 다음 달 §54 가 그 줄을 읽는다 — 저장하지 않고 화면에서만 옮기면 '
      + '다음 달에 같은 결강이 또 넘어오거나 아예 안 넘어온다. **한 달은 한 번만** 넘긴다. '
      + '넘기는 달도 **받는 달도** 열려 있어야 한다(마감이면 409 MONTH_CLOSED) · 받는 달 수업료 발행과 한 줄로 선다(동시에 들어와도 '
      + '이월분이 어느 청구서에서도 안 빠지는 일이 없다).',
  })
  @ApiCreatedResponse({ type: CarryRowDto })
  @ApiConflictResponse({
    description: 'code CARRY_NOT_PAID(완납 아님) | CARRY_NOTHING(못 해 준 수업 없음) | CARRY_DUPLICATE(이미 넘김) | '
      + 'CARRY_NEXT_ISSUED(받는 달 수업료 청구서가 이미 나감) | MONTH_CLOSED(넘기는 달 또는 받는 달이 마감) | '
      + 'CARRY_MIXED_INVOICE(진단고사 · 상담 줄이 섞인 옛 수업료 청구서에 그 회차의 못 해 준 몫이 있음 — 사람이 확인 · 수강 종료와 같은 판정)',
  })
  async carryTuition(
    @CurrentUser() user: RequestUser,
    @Body() dto: TuitionCarryDto,
  ): Promise<CarryRowDto> {
    return this.svc.carryTuition(user.id, dto);
  }

  @Get('invoices/draft')
  @Perm('canMoney')
  @ApiOperation({
    summary: '낼 청구서 미리 세기 — 쓰지 않는다 (§53 발행 창의 분납 일정 합계 · N-79)',
    description:
      '발행과 **같은 함수**로 줄 · 이월 차감 · 합계를 센다(수업료 · 진단고사 + 상담). 이미 낸 종류 · 단가 없음 · 이월 초과면 '
      + '발행 409 와 같은 코드 · 문장으로 막혔다고 말한다. 응시료는 사람이 줄을 적으므로 여기서 세지 않는다.',
  })
  @ApiOkResponse({ type: InvoiceDraftDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: '학생 없음' })
  async draftInvoice(@CurrentUser() user: RequestUser, @Query() query: InvoiceDraftQueryDto): Promise<InvoiceDraftDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.draftInvoice(query, canSee);
  }

  @Post('invoices')
  @Perm('canMoney')
  @ApiOperation({
    summary: '청구서 한 장 발행 — 줄은 서버가 만든다 (§53 「+ 새 청구서 발행」)',
    description:
      '수업료 · 진단고사 + 상담 비용은 줄(INV_LINE)을 받지 않는다. 원문 명세가 「횟수는 서버가 occ() 로 센다 — 프론트가 세면 예외(EXC)를 '
      + '빠뜨린다」고 적었다(D-R37). 누구의 어느 달인지만 주면 과목별 회차·단가·소계·합계를 서버가 만든다 — 진단고사 · 상담 회차는 '
      + '제 종류로만 센다(수업료 줄에서 뺀다 · N-75). MAP + CAT 응시료는 원천이 없어 사람이 줄(내용 · 금액)을 적는다. '
      + '컨설팅비는 컨설팅 「청구서로 전환」 한 길이라 409 INV_TYPE_NOT_SUPPORTED. 분납 일정(installments)을 주면 합이 청구액이어야 하고 '
      + '기한은 마지막 회차의 예정일이다(N-79). 되돌리기는 없다 — 잘못 냈으면 취소하고 새로 만든다(원문 규칙 줄).',
  })
  @ApiCreatedResponse({ type: InvoiceDto, description: '줄까지 채워진 청구서' })
  @ApiBadRequestResponse({
    type: ApiErrorDto,
    description: 'INV_LINES_REQUIRED(응시료에 줄 없음) | INV_LINES_NOT_ALLOWED(서버가 세는 종류에 줄) | INV_LINE_LABEL_REQUIRED | '
      + 'INV_INSTALLMENT_DATES(같은 날 두 회차) | INV_INSTALLMENT_DUE(기한 ≠ 마지막 회차) | INV_DUE_REQUIRED',
  })
  @ApiConflictResponse({
    type: ApiErrorDto,
    description: 'code INV_DUPLICATE(같은 학생·달·종류가 이미 있음) | INV_NO_LESSONS(그 달 그 종류의 회차 없음) | INV_NO_RATE(단가표에 없는 과목) | '
      + 'INV_CARRY_EXCEEDS | INV_TYPE_NOT_SUPPORTED(컨설팅비) | INV_INSTALLMENT_SUM(분납 합 ≠ 청구액) | MONTH_CLOSED',
  })
  @ApiNotFoundResponse({ description: '학생 없음' })
  async issueInvoice(@CurrentUser() user: RequestUser, @Body() dto: InvoiceIssueDto): Promise<InvoiceDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.issueInvoice(user.id, dto, canSee, isRole(user.role) && canCeoVoidInvoice(user.role));
  }

  @Post('invoices/batch')
  @Perm('canMoney')
  @ApiOperation({
    summary: '청구서 일괄 발행 — 그 달 회차가 있는 청구 대상 전부 (§54 「청구서 발행」 · §53 「자동 생성 켜기」 · 테스트 시나리오 H-75 · O-147)',
    description: '낱장 발행과 같은 계산이다 — 이월 음수 줄·단가 구간·그날만 빠짐·휴원이 그대로 든다. 대상은 (학생 · 종류) — '
      + '수업료와 진단고사 + 상담 비용을 회차의 종류로 가른다(N-75 · §53 「아직 안 씀」과 같은 함수). 막힌 대상(이미 있음 · 단가 없음 · '
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

  @Post('payments/manual')
  @Perm('canMoney')
  @ApiOperation({
    summary: '청구서 없이 들어온 돈 한 줄 — §55 「+ 결제 등록」 (A-D1 ② 매니저 직접 입력)',
    description: '`pay.inv_id` 는 비운다 — §55 분류는 「기타」다. 무엇에 대한 돈인지(reason)가 필수이고 같은 트랜잭션에 LOG(PAY create).',
  })
  @ApiCreatedResponse({ type: PaymentDto, description: '저장된 입금 줄 — 목록의 줄과 같은 모양' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'code STUDENT_NOT_FOUND' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'code PAY_REASON_REQUIRED(사유가 공백뿐)' })
  async addManualPayment(@CurrentUser() user: RequestUser, @Body() dto: ManualPaymentCreateDto): Promise<PaymentDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.addManualPayment(user.id, dto, canSee);
  }

  @Delete('payments/:id')
  @Perm('canMoney')
  @ApiOperation({
    summary: '입금 줄 삭제 — 부분 납부(partial) 정정일 때만. 완납은 되돌리지 않는다',
    description: '지우기 전에 그 줄을 통째로 LOG(PAY delete)에 남긴다 — 장부의 입금 줄이 흔적 없이 사라지면 안 된다 (S2).',
  })
  @ApiOkResponse({ type: OkDto })
  @ApiConflictResponse({ description: 'code INV_PAID_LOCKED' })
  @ApiNotFoundResponse({ description: '입금 기록 없음' })
  async removePayment(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<OkDto> {
    return this.svc.removePayment(user.id, id);
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

  /* ══ 강사 시급 (C97 · D-48) — canWage(매니저 이상) · 승인 경로(C41)와 같은 함수 ═══════════ */

  @Get('wages')
  @Perm('canAdminPage', 'canWage')
  @ApiOperation({
    summary: '시급 이력 — 한 사람의 WAGE 줄 전부 (C97 · D-48)',
    description: '적용일 내림차순. 「지금」 줄은 오늘 이하의 마지막 줄 — 회차의 시급(lib/payout-sheet)과 같은 정의다. 미래 날짜 줄은 예약이다.',
  })
  @ApiOkResponse({ type: WageHistoryDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STAFF_NOT_FOUND' })
  wageHistory(@CurrentUser() user: RequestUser, @Query() q: WageHistoryQueryDto): Promise<WageHistoryDto> {
    return this.svc.wageHistory(q.staffId, viewerOf(user));
  }

  @Post('wages')
  @Perm('canAdminPage', 'canWage')
  @ApiOperation({
    summary: '시급 직접 수정 — 새 줄 한 줄 (C97 · 테스트 시나리오 D-48 · I-8)',
    description: '지난 줄은 고치지도 지우지도 않는다 — 지난 정산이 회차 날짜의 줄을 읽는다(과거 정산 불변). '
      + '적용일은 오늘 이후(409 WAGE_RETROACTIVE) · 같은 날 한 줄(409 WAGE_SAME_DAY) — §14 승인 경로와 같은 lib/wage.insertWage. 강사 NOTI · LOG.',
  })
  @ApiCreatedResponse({ type: WageRowDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STAFF_NOT_FOUND' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'WAGE_RETROACTIVE | WAGE_SAME_DAY | STAFF_INACTIVE' })
  writeWage(@CurrentUser() user: RequestUser, @Body() dto: WageWriteDto): Promise<WageRowDto> {
    return this.svc.writeWage(user.id, dto);
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
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'EXPENSE_PROXY_FORBIDDEN — 남의 이름으로 올리는 것은 대표만 · EXPENSE_RECEIPT_NOT_OWNER — 올린 사람 · 신청자가 올린 영수증만 붙는다(PB-26)' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'EXPENSE_RECEIPT_USED' })
  createExpense(@CurrentUser() user: RequestUser, @Body() dto: ExpenseCreateDto): Promise<ExpenseDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.createExpense(user.id, dto, canSee, isRole(user.role) && canCeoFileExpenseForOther(user.role));
  }

  /**
   * 서랍 요청함의 「내 지출 신청」 (N-52 채택 · W11) — 올리는 권한(`canAdminPage`)과 같은 문. 신청자가 **나인 줄만** 준다 —
   * 회계 탭(`canMoney`)을 못 여는 사람도 자기가 올린 지출의 상태 · 금액 · 반려 사유를 본다(N-64: 되돌아온 지출을 보는 자리).
   */
  @Get('expenses/mine')
  @Perm('canAdminPage')
  @ApiOperation({
    summary: '내 지출 신청 — 본인이 신청자인 지출만 · 분류 코드표 (N-52)',
    description: '남의 줄은 조건에서 빠진다(requester_id = 나). 금액은 본인 신청분이라 보인다. 심사(대표 · 자기 심사 금지)는 그대로다.',
  })
  @ApiOkResponse({ type: MyExpenseListDto })
  myExpenses(@CurrentUser() user: RequestUser): Promise<MyExpenseListDto> {
    return this.svc.myExpenses(user.id);
  }
}
