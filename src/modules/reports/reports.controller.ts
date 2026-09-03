import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { hasPerm, isRole, type RequestUser } from '../../common/perm';
import {
  ReportDetailDto, ReportListDto, ReportRefDto, ReportUpsertDto, UnwrittenDto,
  ReportReviewDto,
} from './reports.dto';
import { ReportsService } from './reports.service';

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

  @Get(':serId/:onDate')
  @ApiOperation({ summary: '리포트 상세 — 입력 순서·제한도 서버 계약으로 내려준다' })
  @ApiParam({ name: 'serId', type: Number })
  @ApiParam({ name: 'onDate', example: '2026-08-27' })
  @ApiOkResponse({ type: ReportDetailDto })
  detail(@CurrentUser() user: RequestUser, @Param() ref: ReportRefDto): Promise<ReportDetailDto> {
    return this.svc.detail(ref.serId, ref.onDate, user.id, this.canCrudAll(user), this.canApprove(user));
  }

  @Put(':serId/:onDate/draft')
  @ApiOperation({ summary: '리포트 임시저장 — 빈 칸을 허용한다' })
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
  @ApiOperation({ summary: '리포트 제출 — 3개 입력을 모두 채워야 하며 정산 기준 시각을 최초 1회만 저장한다' })
  @ApiParam({ name: 'serId', type: Number })
  @ApiParam({ name: 'onDate', example: '2026-08-27' })
  @ApiOkResponse({ type: ReportDetailDto })
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
  @ApiOperation({ summary: '제출된 리포트 승인/반려 — 반려 사유 필수, 승인 여부는 정산과 독립' })
  @ApiParam({ name: 'serId', type: Number })
  @ApiParam({ name: 'onDate', example: '2026-08-27' })
  @ApiOkResponse({ type: ReportDetailDto })
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
