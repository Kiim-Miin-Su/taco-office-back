/** @file-guide
 * 목적: accounting.controller.ts — AccountingController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse,
  ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import { AccountingDto, ExpenseDto, ExpenseReviewDto, InvoiceDto, PaymentCreateDto } from './accounting.dto';
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
