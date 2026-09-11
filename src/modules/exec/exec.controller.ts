/** @file-guide
 * 목적: exec.controller.ts — ExecController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import { ExecDto, ExecQueryDto } from './exec.dto';
import { ExecService } from './exec.service';

@ApiTags('exec')
@Controller('exec')
export class ExecController {
  constructor(private readonly svc: ExecService) {}

  @Get()
  @Perm('canCrudAll')
  @ApiOperation({ summary: '대표 보고 — 집계는 저장하지 않는다 (§69 · D-R4 · D-R39)' })
  @ApiOkResponse({ type: ExecDto })
  async range(
    @CurrentUser() user: RequestUser,
    @Query() query: ExecQueryDto,
  ): Promise<ExecDto> {
    const { from, to } = query;
    if (from > to) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: 'from 이 to 보다 뒤입니다' });
    }
    return this.svc.range(from, to, isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms));
  }
}
