import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { hasPerm, isRole, type RequestUser } from '../../common/perm';
import { ReportListDto, UnwrittenDto } from './reports.dto';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  /** 강사면 자기 것으로 좁힌다 — 화면이 안 걸러도 서버가 거른다 (D-R39) */
  private scope(user: RequestUser, asked?: string): number | undefined {
    const all = isRole(user.role) && hasPerm(user.role, 'canCrudAll', user.perms);
    return all ? (asked ? Number(asked) : undefined) : user.id;
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
    return { items: await this.svc.list({ from, to, teacherId: this.scope(user, teacherId), state }) };
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
}
