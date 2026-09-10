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
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '컨설팅 — 단계 보드 · 목록 · 회차 기록 (§26 · §27 · §31)',
    description: '최종 canAdminPage와 canCrudAll이 모두 필요하다. 공개 범위로 투영된 items의 stage(contract/running/done)를 클라이언트에서 필터링하며 추가 GET은 0이다. 전체/단계 건수는 같은 items에서 파생하고 금액·상세 공개 권한을 변경하지 않는다.',
  })
  @ApiOkResponse({ type: ConsultingListDto })
  async all(@CurrentUser() user: RequestUser): Promise<ConsultingListDto> {
    if (!isRole(user.role)) return { items: [], canSeeAmounts: false };
    return this.svc.all(
      user.id,
      hasPerm(user.role, 'canMoney', user.perms),
      hasPerm(user.role, 'canHide', user.perms), // §76 — 비공개 컨설팅 열람
    );
  }
}
