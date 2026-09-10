/** @file-guide
 * 목적: ops.controller.ts — OpsController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

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
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '운영 — 상담 · 컴플레인 · 할 일 · 기획 · 회의 · 마케팅 · 건의',
    description: '§24 FQ는 leads의 name, school, ownerName, reason을 검색한다. 받은 목록의 클라이언트 검색/필터 전환 시 추가 GET은 0회이며 별도 검색 query 계약은 없다.',
  })
  @ApiOkResponse({ type: OpsDto })
  async all(@CurrentUser() user: RequestUser): Promise<OpsDto> {
    return this.svc.all(isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms));
  }
}
