/** @file-guide
 * 목적: reports.controller.ts — ReportsController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiErrorDto } from '../../common/http.dto';
import { CurrentUser } from '../../auth/current-user.decorator';
import { hasPerm, isRole, type RequestUser } from '../../common/perm';
import {
  ReportDeliveryCreateDto, ReportDeliveryQueryDto, ReportDeliveryQueueDto, ReportDeliveryResultDto,
  ReportDetailDto, ReportDeliveryHistoryQueryDto, ReportListDto, ReportRefDto, ReportResendDto,
  ReportReviewDto, ReportSendHistoryListDto, ReportSendRefDto, ReportUpsertDto, UnwrittenDto,
} from './reports.dto';
import { ReportsService } from './reports.service';

const reportWriteDescription = '입력은 content/progress/homework 3칸이다. 부모 SER 잠금 후 최신 일정·출결·담당자와 REP 상태를 검증한다. 상태/권한 오류는 저장하지 않으며 최신 상세·목록을 다시 조회해야 한다.';
const reportWriteBadRequest = { type: ApiErrorDto, description: '입력 검증 오류, REPORT_FIELD_REQUIRED(제출 필수), REPORT_NOT_ALLOWED, REPORT_CANCELED, REPORT_NOT_ENDED.' };
const reportMissing = { type: ApiErrorDto, description: 'REPORT_NOT_FOUND: 리포트가 없음. 최신 목록에서 다시 선택한다.' };

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  private canCrudAll(user: RequestUser): boolean {
    return isRole(user.role) && hasPerm(user.role, 'canCrudAll', user.perms);
  }

  private canApprove(user: RequestUser): boolean {
    return isRole(user.role) && hasPerm(user.role, 'canApprove', user.perms);
  }

  /** 작성자 범위가 기본이다. 승인 예외 권한은 검토 목록에서만 전건으로 넓힌다 (D-R39). */
  private scope(user: RequestUser, asked?: string, reviewQueue = false): number | undefined {
    const canReadAll = this.canCrudAll(user) || (reviewQueue && this.canApprove(user));
    return canReadAll ? (asked ? Number(asked) : undefined) : user.id;
  }

  @Get()
  @ApiOperation({ summary: '리포트 목록' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'teacherId', required: false })
  @ApiQuery({ name: 'state', required: false })
  @ApiOkResponse({ type: ReportListDto })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('teacherId') teacherId?: string,
    @Query('state') state?: string,
  ): Promise<ReportListDto> {
    const reviewQueue = state === 'wait' || state === 'rej';
    return { items: await this.svc.list({ from, to, teacherId: this.scope(user, teacherId, reviewQueue), state }) };
  }

  @Get('unwritten')
  @ApiOperation({ summary: '§47 안 쓴 리포트 — 강사별 밀린 건수와 예상 차감' })
  @ApiQuery({ name: 'teacherId', required: false })
  @ApiOkResponse({ type: UnwrittenDto })
  async unwritten(
    @CurrentUser() user: RequestUser,
    @Query('teacherId') teacherId?: string,
  ): Promise<UnwrittenDto> {
    return this.svc.unwritten(this.scope(user, teacherId));
  }

  @Get('deliveries')
  @ApiOperation({ summary: '§48·§49 학생별 리포트 발송 큐 — 없으면 KST 어제' })
  @ApiOkResponse({ type: ReportDeliveryQueueDto })
  deliveryQueue(
    @CurrentUser() user: RequestUser,
    @Query() query: ReportDeliveryQueryDto,
  ): Promise<ReportDeliveryQueueDto> {
    return this.svc.deliveryQueue(query.onDate, user.id, this.canCrudAll(user));
  }

  @Get('deliveries/history')
  @ApiOperation({ summary: 'RSEND/PDFLOG 발송 이력 — 날짜 또는 리포트로 필터' })
  @ApiOkResponse({ type: ReportSendHistoryListDto })
  async deliveryHistory(
    @CurrentUser() user: RequestUser,
    @Query() query: ReportDeliveryHistoryQueryDto,
  ): Promise<ReportSendHistoryListDto> {
    return { items: await this.svc.deliveryHistory(query, this.canCrudAll(user)) };
  }

  @Post('deliveries')
  @ApiOperation({ summary: '학생 1명의 승인된 리포트 PNG를 private Blob에 보존하고 발송 이력 생성' })
  @ApiCreatedResponse({ type: ReportDeliveryResultDto })
  async deliver(
    @CurrentUser() user: RequestUser,
    @Body() dto: ReportDeliveryCreateDto,
  ): Promise<ReportDeliveryResultDto> {
    return { item: await this.svc.deliver(dto, user.id, this.canCrudAll(user)) };
  }

  @Post('deliveries/:sendId/resend')
  @ApiOperation({ summary: '기존 본문·Blob을 변경 없이 재발송하고 새 감사행 생성' })
  @ApiCreatedResponse({ type: ReportDeliveryResultDto })
  async resend(
    @CurrentUser() user: RequestUser,
    @Param() ref: ReportSendRefDto,
    @Body() dto: ReportResendDto,
  ): Promise<ReportDeliveryResultDto> {
    return { item: await this.svc.resend(ref.sendId, dto.requestKey, user.id, this.canCrudAll(user)) };
  }

  @Get(':serId/:onDate')
  @ApiOperation({ summary: '리포트 상세 — 입력 순서·제한도 서버 계약으로 내려준다' })
  @ApiParam({ name: 'serId', type: Number })
  @ApiParam({ name: 'onDate', example: '2026-08-27' })
  @ApiOkResponse({ type: ReportDetailDto })
  detail(@CurrentUser() user: RequestUser, @Param() ref: ReportRefDto): Promise<ReportDetailDto> {
    return this.svc.detail(ref.serId, ref.onDate, user.id, this.canCrudAll(user), this.canApprove(user));
  }

  @Put(':serId/:onDate/draft')
  @ApiOperation({ summary: '리포트 임시저장 — 빈 칸을 허용한다', description: reportWriteDescription })
  @ApiBadRequestResponse(reportWriteBadRequest)
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'REPORT_FORBIDDEN: 현재 담당 강사 또는 전체 관리 권한이 필요함.' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'REPORT_LOCKED: 제출 대기/승인 상태는 수정할 수 없음.' })
  @ApiNotFoundResponse(reportMissing)
  @ApiParam({ name: 'serId', type: Number })
  @ApiParam({ name: 'onDate', example: '2026-08-27' })
  @ApiOkResponse({ type: ReportDetailDto })
  saveDraft(
    @CurrentUser() user: RequestUser,
    @Param() ref: ReportRefDto,
    @Body() dto: ReportUpsertDto,
  ): Promise<ReportDetailDto> {
    return this.svc.write(
      ref.serId, ref.onDate, dto, 'draft', user.id, this.canCrudAll(user), this.canApprove(user),
    );
  }

  @Post(':serId/:onDate/submit')
  @ApiOperation({ summary: '리포트 제출 — 3개 입력을 모두 채워야 하며 정산 기준 시각을 최초 1회만 저장한다', description: reportWriteDescription })
  @ApiBadRequestResponse(reportWriteBadRequest)
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'REPORT_FORBIDDEN: 현재 담당 강사 또는 전체 관리 권한이 필요함.' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'REPORT_LOCKED: 제출 대기/승인 상태는 수정할 수 없음.' })
  @ApiNotFoundResponse(reportMissing)
  @ApiParam({ name: 'serId', type: Number })
  @ApiParam({ name: 'onDate', example: '2026-08-27' })
  @ApiCreatedResponse({ type: ReportDetailDto })
  submit(
    @CurrentUser() user: RequestUser,
    @Param() ref: ReportRefDto,
    @Body() dto: ReportUpsertDto,
  ): Promise<ReportDetailDto> {
    return this.svc.write(
      ref.serId, ref.onDate, dto, 'submit', user.id, this.canCrudAll(user), this.canApprove(user),
    );
  }

  @Post(':serId/:onDate/review')
  @ApiOperation({ summary: '제출된 리포트 승인/반려 — 반려 사유 필수, 승인 여부는 정산과 독립',
    description: '부모 SER → REP 잠금으로 최신 상태·담당자를 읽는다. wait와 canApprove를 검증하며 취소 여부를 추가 승인 조건으로 삼지 않는다. 오류 시 저장하지 않고 최신 상세·목록을 조회한다.' })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: '입력 검증 오류, APPROVE_REASON_FORBIDDEN, REJECT_REASON_REQUIRED.' })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'REPORT_REVIEW_FORBIDDEN: 승인 권한이 필요함.' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'REPORT_NOT_WAITING: 현재 승인 대기 상태가 아님.' })
  @ApiNotFoundResponse(reportMissing)
  @ApiParam({ name: 'serId', type: Number })
  @ApiParam({ name: 'onDate', example: '2026-08-27' })
  @ApiCreatedResponse({ type: ReportDetailDto })
  review(
    @CurrentUser() user: RequestUser,
    @Param() ref: ReportRefDto,
    @Body() dto: ReportReviewDto,
  ): Promise<ReportDetailDto> {
    return this.svc.review(
      ref.serId, ref.onDate, dto, user.id, this.canCrudAll(user), this.canApprove(user),
    );
  }
}
