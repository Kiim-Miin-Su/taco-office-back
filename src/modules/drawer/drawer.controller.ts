/**
 * 우측 서랍 — §14~§21.
 *
 * **한 번 열면 한 번만 부른다.** 칸이 여덟인데 엔드포인트를 여덟 개 두면
 * 서랍을 열 때마다 왕복이 여덟 번이고, 칸끼리 숫자가 어긋난다
 * (배지에는 3건인데 목록에는 2건인 상태가 정확히 그래서 생긴다).
 *
 * 쓰기는 셋뿐이다 — 할 일 체크 · 알림 읽음 · 변경 요청 넣기.
 * **승인과 반려는 여기서 하지 않는다** (D-R27). 줄을 누르면 그 화면으로 간다.
 */
import {
  BadRequestException, Body, Controller, Get, NotFoundException,
  Param, ParseIntPipe, Patch, Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { hasPerm, isRole, type RequestUser } from '../../common/perm';
import { ScheduleService } from '../schedule/schedule.service';
import {
  ChangeReqCreateDto, ChangeReqResultDto, DrawerDto, TodoDoneDto,
} from './drawer.dto';
import { DrawerService } from './drawer.service';

@ApiTags('drawer')
@Controller('drawer')
export class DrawerController {
  constructor(
    private readonly svc: DrawerService,
    // 겹침 설명은 스케줄이 갖는다 — 같은 판정을 두 벌 쓰지 않는다 (§19)
    private readonly sched: ScheduleService,
  ) {}

  /** 역할 → 두 가지 판정. 비교는 언제나 hasPerm 한 곳에서만 (D-R39) */
  private gate(user: RequestUser) {
    const role = isRole(user.role) ? user.role : null;
    return {
      canApprove: role !== null && hasPerm(role, 'canApprove', user.perms),
      canSeeAll: role !== null && hasPerm(role, 'canCrudAll', user.perms),
    };
  }

  @Get()
  @ApiOperation({ summary: '서랍 여덟 칸을 한 번에 — 결재 5종 정규화 포함 (D-R26 · D-R34)' })
  @ApiOkResponse({ type: DrawerDto })
  all(@CurrentUser() user: RequestUser): Promise<DrawerDto> {
    const { canApprove, canSeeAll } = this.gate(user);
    return this.svc.all(user.id, canApprove, canSeeAll);
  }

  @Patch('todos/:id')
  @ApiOperation({ summary: '§15 할 일 체크 — 내가 주고받은 것만' })
  async todoDone(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TodoDoneDto,
  ): Promise<{ ok: true }> {
    const { canSeeAll } = this.gate(user);
    const hit = await this.svc.setTodoDone(id, dto.done, user.id, canSeeAll);
    // 남의 할 일이면 「없다」로 답한다 — 「있는데 권한이 없다」를 흘리지 않는다
    if (!hit) throw new NotFoundException({ code: 'NOT_FOUND', message: '할 일을 찾을 수 없습니다' });
    return { ok: true };
  }

  @Patch('notis/:id/read')
  @ApiOperation({ summary: '§16 알림 읽음' })
  async notiRead(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ ok: true }> {
    const hit = await this.svc.markNotiRead(id, user.id);
    if (!hit) throw new NotFoundException({ code: 'NOT_FOUND', message: '알림을 찾을 수 없습니다' });
    return { ok: true };
  }

  @Post('change-requests')
  @ApiOperation({
    summary: '§19 변경 요청 넣기 — 겹치면 **누구와** 겹치는지 돌려주고 넣지 않는다',
  })
  @ApiOkResponse({ type: ChangeReqResultDto })
  async createChangeReq(
    @CurrentUser() user: RequestUser,
    @Body() dto: ChangeReqCreateDto,
  ): Promise<ChangeReqResultDto> {
    // 사유가 없으면 받지 않는다 — 뒤에서 판단할 사람이 근거 없이 판단하게 된다 (D-R13 과 같은 이유)
    if (!dto.reason?.trim()) {
      throw new BadRequestException({ code: 'REASON_REQUIRED', message: '사유를 적어야 제출됩니다' });
    }

    // 시간·강사·강의실을 바꾸는 요청만 겹침을 본다. 취소는 자리를 비우는 쪽이라 겹칠 수 없다.
    const conflicts = await this.previewConflicts(dto);
    if (conflicts.length > 0) return { id: null, conflicts };

    const id = await this.svc.createChangeReq(user.id, dto);
    return { id, conflicts: [] };
  }

  /** 요청서에 안 적힌 값은 원본 회차에서 가져와 채운다 — 「강사만 바꾸는」 요청도 시각이 필요하다 */
  private async previewConflicts(dto: ChangeReqCreateDto) {
    if (dto.reqType === 'cancel' || !dto.serId || !dto.onDate) return [];
    const base = await this.svc.occOf(dto.serId, dto.onDate);
    if (!base) return [];

    const p = (dto.payload ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : undefined);

    return this.sched.conflicts({
      onDate: dto.onDate,
      startMin: n(p.startMin) ?? base.startMin,
      endMin: n(p.endMin) ?? base.endMin,
      teacherId: n(p.teacherId) ?? base.teacherId,
      roomId: n(p.roomId) ?? base.roomId,
      zaccId: n(p.zaccId) ?? base.zaccId,
      // 자기 자신과는 겹치지 않는다
      exceptSerId: dto.serId,
    });
  }
}
