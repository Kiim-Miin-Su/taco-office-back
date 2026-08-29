import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import { AccountingDto } from './accounting.dto';
import { AccountingService } from './accounting.service';

@ApiTags('accounting')
@Controller('accounting')
export class AccountingController {
  constructor(private readonly svc: AccountingService) {}

  @Get()
  @Perm('canCrudAll') // 회계 탭 자체는 매니저 이상. 금액만 대표 전용이다 (D-R39)
  @ApiOperation({ summary: '회계 — 청구서 · 입금 · 정산. 금액은 대표만 값이 채워진다' })
  @ApiOkResponse({ type: AccountingDto })
  async all(@CurrentUser() user: RequestUser): Promise<AccountingDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canSeeProfit', user.perms);
    return this.svc.all(canSee);
  }
}
