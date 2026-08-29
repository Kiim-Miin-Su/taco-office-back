import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import { ConsultingListDto } from './consulting.dto';
import { ConsultingService } from './consulting.service';

@ApiTags('consulting')
@Controller('consulting')
export class ConsultingController {
  constructor(private readonly svc: ConsultingService) {}

  @Get()
  @Perm('canCrudAll')
  @ApiOperation({ summary: '컨설팅 — 건 · 학생 · 회차 기록 (§29 · §30)' })
  @ApiOkResponse({ type: ConsultingListDto })
  async all(@CurrentUser() user: RequestUser): Promise<ConsultingListDto> {
    if (!isRole(user.role)) return { items: [], canSeeAmounts: false };
    return this.svc.all(
      user.id,
      hasPerm(user.role, 'canSeeProfit', user.perms),
      hasPerm(user.role, 'canHide', user.perms), // §76 — 비공개 컨설팅 열람
    );
  }
}
