import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { hasPerm, isRole, type RequestUser } from '../../common/perm';
import { OccurrenceListDto } from './schedule.dto';
import { ScheduleService } from './schedule.service';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

@ApiTags('schedule')
@Controller('schedule')
export class ScheduleController {
  constructor(private readonly svc: ScheduleService) {}

  @Get('occurrences')
  @ApiOperation({ summary: '회차 목록 — 일간·주간·월간·학생별·선생님별이 모두 이것을 쓴다' })
  @ApiQuery({ name: 'from', example: '2026-08-24' })
  @ApiQuery({ name: 'to', example: '2026-08-30' })
  @ApiQuery({ name: 'teacherId', required: false })
  @ApiQuery({ name: 'studentId', required: false })
  @ApiQuery({ name: 'roomId', required: false })
  @ApiOkResponse({ type: OccurrenceListDto })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('teacherId') teacherId?: string,
    @Query('studentId') studentId?: string,
    @Query('roomId') roomId?: string,
  ): Promise<OccurrenceListDto> {
    if (!ISO.test(from ?? '') || !ISO.test(to ?? '')) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: 'from · to 는 YYYY-MM-DD 입니다' });
    }
    if (from > to) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: 'from 이 to 보다 뒤입니다' });
    }

    // 강사는 자기 수업만 본다. 화면이 안 걸러도 서버가 거른다 (D-R39).
    // 역할을 직접 비교하지 않는다 — 판정은 hasPerm 한 곳에서만 한다 (eslint 가 막는다).
    const canAll = isRole(user.role) && hasPerm(user.role, 'canCrudAll', user.perms);
    const forced = canAll ? undefined : user.id;

    const items = await this.svc.list({
      from,
      to,
      teacherId: forced ?? (teacherId ? Number(teacherId) : undefined),
      studentId: studentId ? Number(studentId) : undefined,
      roomId: roomId ? Number(roomId) : undefined,
    });
    return { from, to, items };
  }
}
