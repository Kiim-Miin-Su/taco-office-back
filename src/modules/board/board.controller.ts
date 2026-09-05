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
