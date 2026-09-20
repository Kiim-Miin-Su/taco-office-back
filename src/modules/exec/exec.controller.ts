/** @file-guide
 * 목적: exec.controller.ts — ExecController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { ApiErrorDto } from '../../common/http.dto';
import { Perm, approvalFlowScope, hasPerm, isRole, type RequestUser } from '../../common/perm';
import {
  ExecDto, ExecMemoWriteDto, ExecQueryDto, ExecReportParamsDto,
  ExecReportWriteResultDto, ExecReviewDto, ExecSubmitDto,
} from './exec.dto';
import { ExecService } from './exec.service';

@ApiTags('exec')
@Controller('exec')
export class ExecController {
  constructor(private readonly svc: ExecService) {}

  @Get()
  @Perm('canCrudAll')
  @ApiOperation({ summary: '대표 보고 — 집계는 저장하지 않는다 (§69 · D-R4 · D-R39)' })
  @ApiOkResponse({ type: ExecDto })
  async range(
    @CurrentUser() user: RequestUser,
    @Query() query: ExecQueryDto,
  ): Promise<ExecDto> {
    const { from, to } = query;
    if (from > to) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: 'from 이 to 보다 뒤입니다' });
    }
    return this.svc.range(
      from, to,
      isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms),
      { id: user.id, canApprove: isRole(user.role) && hasPerm(user.role, 'canApprove', user.perms) },
    );
  }

  /**
   * §69 「숫자만으로는 모를 것」 — 영역별 한 줄을 적는다.
   *
   * 원본의 여섯 칸은 **담당이 서로 다르다**(회계는 Grace, 운영은 김범준…). 그래서 보낸 칸만
   * 합치고 안 보낸 칸은 그대로 둔다 — 한 사람이 저장할 때마다 남의 줄이 사라지면 안 된다.
   */
  @Patch('report')
  @Perm('canCrudAll')
  @ApiOperation({
    summary: '§69 영역 메모 저장 — 보낸 칸만 합친다 (작성 중 · 반려된 것만)',
    description: '주기 키 날짜는 서버가 정규화한다 (D-R23 — 주간=월요일 · 월간=1일). '
      + '이미 올렸거나 결재된 보고는 409 RPT_LOCKED 다 — 대표가 본 것과 저장된 것이 달라지면 서명이 거짓이 된다.',
  })
  @ApiOkResponse({ type: ExecReportWriteResultDto })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'RPT_LOCKED — 이미 올린 보고' })
  saveMemo(
    @CurrentUser() user: RequestUser,
    @Body() dto: ExecMemoWriteDto,
  ): Promise<ExecReportWriteResultDto> {
    return this.svc.saveMemo(dto, user.id);
  }

  @Post('report/submit')
  @Perm('canCrudAll')
  @ApiOperation({
    summary: '§69 「대표께 올리기」 — 한 줄이라도 적어야 올라간다 (D-R14)',
    description: '숫자는 저장하지 않으므로(D-R4) 사람이 더한 것은 메모뿐이다. 하나도 없으면 409 RPT_EMPTY.',
  })
  @ApiCreatedResponse({ type: ExecReportWriteResultDto })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'RPT_EMPTY · RPT_LOCKED' })
  submit(
    @CurrentUser() user: RequestUser,
    @Body() dto: ExecSubmitDto,
  ): Promise<ExecReportWriteResultDto> {
    return this.svc.submit(dto, user.id);
  }

  /**
   * §73 결재 — **대표만** 한다. 받는 사람은 `lib/approval` 이 정한다
   * (`APPROVAL_FLOW_RECIPIENT.rpt === 'ceo'`) — 역할을 여기서 다시 비교하지 않는다.
   */
  @Post('report/:id/review')
  @Perm('canCrudAll')
  @ApiOperation({
    summary: '§73 대표 보고 결재 — 승인 · 반려 (반려는 사유 필수 · D-R13)',
    description: '받는 사람은 lib/approval 의 APPROVAL_FLOW_RECIPIENT.rpt 가 정한다 — 대표다. '
      + '올라온(sent) 보고만 결재할 수 있다.',
  })
  @ApiCreatedResponse({ type: ExecReportWriteResultDto })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: '대표가 아니면 결재하지 않는다' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'RPT_NOT_SENT — 올라오지 않은 보고' })
  review(
    @CurrentUser() user: RequestUser,
    @Param() params: ExecReportParamsDto,
    @Body() dto: ExecReviewDto,
  ): Promise<ExecReportWriteResultDto> {
    if (!(isRole(user.role) && approvalFlowScope(user.role, user.perms) === 'all')) {
      throw new ForbiddenException({ code: 'NOT_APPROVER', message: '대표 보고는 대표가 결재합니다' });
    }
    return this.svc.review(params.id, dto, user.id);
  }
}
