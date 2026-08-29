import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import { OpsDto } from './ops.dto';
import { OpsService } from './ops.service';

@ApiTags('ops')
@Controller('ops')
export class OpsController {
  constructor(private readonly svc: OpsService) {}

  @Get()
  @Perm('canCrudAll')
  @ApiOperation({ summary: '운영 — 상담 · 컴플레인 · 할 일 · 기획 · 회의 · 마케팅 · 건의' })
  @ApiOkResponse({ type: OpsDto })
  async all(@CurrentUser() user: RequestUser): Promise<OpsDto> {
    return this.svc.all(isRole(user.role) && hasPerm(user.role, 'canSeeProfit', user.perms));
  }
}
