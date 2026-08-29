import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import { ExecDto } from './exec.dto';
import { ExecService } from './exec.service';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

@ApiTags('exec')
@Controller('exec')
export class ExecController {
  constructor(private readonly svc: ExecService) {}

  @Get()
  @Perm('canCrudAll')
  @ApiOperation({ summary: '대표 보고 — 집계는 저장하지 않는다 (§69 · D-R4 · D-R39)' })
  @ApiQuery({ name: 'from', example: '2026-08-01' })
  @ApiQuery({ name: 'to', example: '2026-08-31' })
  @ApiOkResponse({ type: ExecDto })
  async range(
    @CurrentUser() user: RequestUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<ExecDto> {
    if (!ISO.test(from ?? '') || !ISO.test(to ?? '')) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: 'from · to 는 YYYY-MM-DD 입니다' });
    }
    if (from > to) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: 'from 이 to 보다 뒤입니다' });
    }
    return this.svc.range(from, to, isRole(user.role) && hasPerm(user.role, 'canSeeProfit', user.perms));
  }
}
