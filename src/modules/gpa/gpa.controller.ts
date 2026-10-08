/** @file-guide
 * 목적: gpa.controller.ts — GpaController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOkResponse, ApiOperation, ApiTags,
} from '@nestjs/swagger';
import { Perm } from '../../common/perm';
import { GpaBoardDto, GpaBoardQueryDto } from './gpa.dto';
import { GpaService } from './gpa.service';

@ApiTags('gpa')
@Controller('gpa')
export class GpaController {
  constructor(private readonly svc: GpaService) {}

  @Get()
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: 'GPA 과거 원장 — 사이클·규정·학생별 잔여·타임라인 (읽기 전용)',
    description: '최신 수정사항으로 신규 GPA 기능은 퇴역했다. 기존 확정 원장만 관리자에게 읽기 전용으로 제공하며 발송 경로에 싣지 않는다.',
  })
  @ApiOkResponse({ type: GpaBoardDto })
  async board(@Query() query: GpaBoardQueryDto): Promise<GpaBoardDto> {
    return this.svc.board(query.anchor);
  }
}
