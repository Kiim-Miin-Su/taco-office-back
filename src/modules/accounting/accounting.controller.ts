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
import { Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import {
  AccountingDto, ExpenseDto, ExpenseReviewDto, InvoiceDto, InvoiceIssueDto, OtherIncomeDto,
  PaymentCreateDto, TuitionDto, TuitionQueryDto,
} from './accounting.dto';
import { todayKst } from '../../lib/kst';
import { AccountingService } from './accounting.service';

@ApiTags('accounting')
@Controller('accounting')
export class AccountingController {
  constructor(private readonly svc: AccountingService) {}

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
    return this.svc.all(canSee);
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
    return this.svc.tuition(query.month ?? todayKst().slice(0, 7), canSee);
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
      + '컷 오른쪽의 「일별 · 주별 · 월별」은 눌렀을 때 무엇이 달라지는지 컷이 보여 주지 않아 만들지 않았다 (N-40).',
  })
  @ApiOkResponse({ type: OtherIncomeDto })
  async otherIncome(@CurrentUser() user: RequestUser): Promise<OtherIncomeDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.svc.otherIncome(canSee);
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
    return this.svc.issueInvoice(user.id, dto, canSee);
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
  @ApiOkResponse({ description: '{ ok: true }' })
  @ApiConflictResponse({ description: 'code INV_PAID_LOCKED' })
  @ApiNotFoundResponse({ description: '입금 기록 없음' })
  async removePayment(@Param('id', ParseIntPipe) id: number): Promise<{ ok: true }> {
    return this.svc.removePayment(id);
  }

  @Post('expenses/:id/review')
  @Perm('canMoney')
  @ApiOperation({
    summary: '법인카드 심사 — 승인(감액 가능·증액 금지)·반려 (A-D3 · v2 §56 법인카드)',
    description: '신청 금액은 placeholder 일 뿐이고 확정 금액은 사람이 넣는다 (대표 지시 2026-08-25). 판정은 전부 서버.',
  })
  @ApiOkResponse({ type: ExpenseDto })
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
}
