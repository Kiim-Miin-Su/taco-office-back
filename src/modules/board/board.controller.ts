import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { hasPerm, isRole, type RequestUser } from '../../common/perm';
import { BoardDto } from './board.dto';
import { BoardService } from './board.service';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

@ApiTags('board')
@Controller('board')
export class BoardController {
  constructor(private readonly svc: BoardService) {}

  @Get()
  @ApiOperation({ summary: '수업 현황판 — 교재·안내·줌·리포트 4마크를 매번 계산한다 (§34 · D-R4)' })
  @ApiQuery({ name: 'from', example: '2026-08-24' })
  @ApiQuery({ name: 'to', example: '2026-08-30' })
  @ApiOkResponse({ type: BoardDto })
  async range(
    @CurrentUser() user: RequestUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<BoardDto> {
    if (!ISO.test(from ?? '') || !ISO.test(to ?? '')) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: 'from · to 는 YYYY-MM-DD 입니다' });
    }
    if (from > to) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: 'from 이 to 보다 뒤입니다' });
    }
    const canAll = isRole(user.role) && hasPerm(user.role, 'canCrudAll', user.perms);
    return this.svc.range(from, to, canAll ? undefined : user.id);
  }
}
