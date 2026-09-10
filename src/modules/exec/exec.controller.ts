/** @file-guide
 * 목적: exec.controller.ts — ExecController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

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
    return this.svc.range(from, to, isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms));
  }
}
