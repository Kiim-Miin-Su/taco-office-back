/** @file-guide
 * 목적: reports.controller.ts — ReportsController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorDto } from '../../common/http.dto';
import { CurrentUser } from '../../auth/current-user.decorator';
import { hasPerm, isRole, type RequestUser } from '../../common/perm';
import {
  ReportDeliveryCreateDto, ReportDeliveryQueryDto, ReportDeliveryQueueDto, ReportDeliveryResultDto,
  ReportDetailDto, ReportDeliveryHistoryQueryDto, ReportListDto, ReportRefDto, ReportResendDto,
  ReportReviewDto, ReportSendHistoryListDto, ReportSendRefDto, ReportUpsertDto, UnwrittenDto,
  ReportQueryDto, ReportTeacherQueryDto,
} from './reports.dto';
import { ReportsService } from './reports.service';

const reportWriteDescription = '입력은 content/progress/homework 3칸이다. 부모 SER 잠금 후 최신 일정·출결·담당자와 REP 상태를 검증한다. 상태/권한 오류는 저장하지 않으며 최신 상세·목록을 다시 조회해야 한다.';
const reportWriteBadRequest = { type: ApiErrorDto, description: '입력 검증 오류, REPORT_FIELD_REQUIRED(제출 필수), REPORT_NOT_ALLOWED, REPORT_CANCELED, REPORT_NOT_ENDED.' };
const reportMissing = { type: ApiErrorDto, description: 'REPORT_NOT_FOUND: 리포트가 없음. 최신 목록에서 다시 선택한다.' };

@ApiTags('reports')
@ApiBadRequestResponse({ type: ApiErrorDto, description: '날짜/안전한 정수 ID/상태/추가 키 검증 오류. from > to이면 BAD_RANGE. DB 조회·저장 전에 거절한다' })
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
  private scope(user: RequestUser, asked?: number, reviewQueue = false): number | undefined {
    const canReadAll = this.canCrudAll(user) || (reviewQueue && this.canApprove(user));
    return canReadAll ? asked : user.id;
  }

  @Get()
  @ApiOperation({ summary: '리포트 목록', description: 'from/to는 실제 KST 수업일 범위(양끝 포함). 회차 투영 없는 보존 이력만 원래 날짜로 표시/조회한다. 상세 참조는 각 응답의 serId/onDate를 사용한다.' })
  @ApiOkResponse({ type: ReportListDto })
  async list(
    @CurrentUser() user: RequestUser,
    @Query() query: ReportQueryDto,
  ): Promise<ReportListDto> {
    const { from, to, teacherId, state } = query;
    if (from && to && from > to) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: 'from 이 to 보다 뒤입니다' });
    }
    const reviewQueue = state === 'wait' || state === 'rej';
    return { items: await this.svc.list({ from, to, teacherId: this.scope(user, teacherId, reviewQueue), state }) };
  }

  @Get('unwritten')
  @ApiOperation({ summary: '§47 안 쓴 리포트 — 강사별 밀린 건수와 예상 차감' })
  @ApiOkResponse({ type: UnwrittenDto })
  async unwritten(
    @CurrentUser() user: RequestUser,
    @Query() query: ReportTeacherQueryDto,
  ): Promise<UnwrittenDto> {
    return this.svc.unwritten(this.scope(user, query.teacherId));
  }

  @Get('deliveries')
  @ApiOperation({ summary: '§48·§49 학생별 리포트 발송 큐 — 없으면 KST 어제', description: 'onDate는 실제 KST 수업일이다. 옮긴 회차도 해당 날짜의 학생 묶음에 포함하며 상세 조회는 개별 리포트의 원래 onDate를 사용한다. 일정 또는 출결이 취소된 회차는 신규 발송 대상에서 제외한다. 이미 보낸 이력과 재발송 원본은 보존한다.' })
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
  @ApiOperation({ summary: '학생 1명의 승인된 리포트 PNG를 private Blob에 보존하고 발송 이력 생성', description: '업로드 후 준비된 부모 SER→REP 순서로 잠그고 현재 날짜/일정·출결 취소/승인 집합과 출력 원문을 재검증한다. 재검증 시 새 미작성 수업이 포함되면 발송을 거절한다. 변경된 PNG/본문 혼합 저장은 거절하고 이번 요청의 업로드만 보상 삭제한다. 같은 요청 키의 완료 이력은 재사용한다.' })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: '입력/PNG 형식 오류 또는 REPORT_DELIVERY_EMPTY/FILES_MISMATCH: 현재 발송 대상·출력과 달라짐. 큐를 재조회해 PNG를 다시 생성한다.' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'REPORT_DELIVERY_INCOMPLETE/NOT_APPROVED/ALREADY_SENT/REQUEST_KEY_REUSED: 현재 작성·승인·발송 상태나 요청 키 충돌. 큐/이력을 다시 조회한다.' })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'REPORT_DELIVERY_FORBIDDEN: 현재 전체 관리 권한이 필요함.' })
  @ApiCreatedResponse({ type: ReportDeliveryResultDto })
  async deliver(
    @CurrentUser() user: RequestUser,
    @Body() dto: ReportDeliveryCreateDto,
  ): Promise<ReportDeliveryResultDto> {
    return { item: await this.svc.deliver(dto, user.id, this.canCrudAll(user)) };
  }

  @Post('deliveries/:sendId/resend')
  @ApiOperation({ summary: '기존 본문·Blob을 변경 없이 재발송하고 새 감사행 생성', description: '원본 RSEND 행을 잠그고 발송 당시 날짜/본문/파일 URL을 재사용한다. 동일 요청 키의 동시 재시도는 하나의 감사행, 서로 다른 키는 별도 재발송이다. 현재 수업 메타데이터로 이력을 덮어쓰지 않는다.' })
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
