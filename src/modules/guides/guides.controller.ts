import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { hasPerm, isRole, type RequestUser } from '../../common/perm';
import { GuidesDto } from './guides.dto';
import { GuidesService } from './guides.service';

@ApiTags('guides')
@Controller('guides')
export class GuidesController {
  constructor(private readonly svc: GuidesService) {}

  @Get()
  @ApiOperation({ summary: '수업 안내 — 한 번만(GUIDE) · 회차마다(PNOTI) (§41 · §42)' })
  @ApiOkResponse({ type: GuidesDto })
  async all(@CurrentUser() user: RequestUser): Promise<GuidesDto> {
    // 강사는 자기 것만. 판정은 hasPerm 한 곳에서만 한다.
    const canAll = isRole(user.role) && hasPerm(user.role, 'canCrudAll', user.perms);
    return this.svc.all(canAll ? undefined : user.id);
  }
}
