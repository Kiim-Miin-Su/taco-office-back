/** @file-guide
 * 목적: board.controller.ts — BoardController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { hasPerm, isRole, type RequestUser } from '../../common/perm';
import { BoardDto, BoardQueryDto } from './board.dto';
import { boardRangeIssue } from './board.rules';
import { BoardService } from './board.service';

@ApiTags('board')
@Controller('board')
export class BoardController {
  constructor(private readonly svc: BoardService) {}

  @Get()
  @ApiOperation({
    summary: '수업 현황판 — 회차·강사×요일·주차별 4마크를 매번 계산한다 (§34~§36 · D-R4)',
  })
  @ApiOkResponse({ type: BoardDto })
  async range(@CurrentUser() user: RequestUser, @Query() query: BoardQueryDto): Promise<BoardDto> {
    const issue = boardRangeIssue(query.from, query.to);
    if (issue) throw new BadRequestException({ code: 'BAD_RANGE', message: issue });
    const canAll = isRole(user.role) && hasPerm(user.role, 'canCrudAll', user.perms);
    return this.svc.range({
      from: query.from,
      to: query.to,
      teacherId: canAll ? query.teacherId : user.id,
      subKey: query.subKey,
    });
  }
}
