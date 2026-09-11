/** @file-guide
 * 목적: consulting.controller.ts — ConsultingController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, Param, ParseIntPipe, Patch } from '@nestjs/common';
import { ApiConflictResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import { ConsItemDto, ConsItemToggleDto, ConsultingListDto } from './consulting.dto';
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

  @Patch(':id/items/:itemId')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '진행 항목 체크/해제 — 47D-B 유일 쓰기 (N-18 §4-17)',
    description: '공개 범위(csCanFull)·종료 잠금은 서버가 판정한다. 진행률 숫자는 저장하지 않는다 — 원장 행만 바뀐다.',
  })
  @ApiOkResponse({ type: ConsItemDto })
  @ApiForbiddenResponse({ description: '내용이 공개 범위 밖 (수납만 공개 등)' })
  @ApiNotFoundResponse({ description: '보이지 않는 건·없는 항목 — 존재를 누출하지 않는다' })
  @ApiConflictResponse({ description: 'code ITEM_LOCKED — 종료된 건' })
  async toggleItem(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: ConsItemToggleDto,
  ): Promise<ConsItemDto> {
    // @Perm 가드가 매니저 이상을 이미 보장한다 — isRole 은 타입 좁힘용이다 (all() 과 같은 규약)
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.toggleItem(user.id, canHide, id, itemId, dto);
  }
}
