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
import {
  ApiBody, ApiCreatedResponse, ApiExtraModels, ApiOkResponse, ApiOperation, ApiTags, getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { hasPerm, isRole, type RequestUser } from '../../common/perm';
import { normalizeChangeRequest, type NormalizedChangeRequest } from '../../lib/change-request';
import { ScheduleService } from '../schedule/schedule.service';
import {
  CancelChangeReqDto, ChangeReqCreateDto, ChangeReqResultDto, DrawerDto, RoomChangeReqDto,
  TeacherChangeReqDto, TimeMoveChangeReqDto, TodoDoneDto, ZoomChangeReqDto,
} from './drawer.dto';
import { DrawerService } from './drawer.service';

@ApiTags('drawer')
@ApiExtraModels(
  TimeMoveChangeReqDto, TeacherChangeReqDto, RoomChangeReqDto, ZoomChangeReqDto, CancelChangeReqDto,
)
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
  @ApiBody({
    schema: {
      oneOf: [
        TimeMoveChangeReqDto, TeacherChangeReqDto, RoomChangeReqDto, ZoomChangeReqDto, CancelChangeReqDto,
      ].map((model) => ({ $ref: getSchemaPath(model) })),
    },
  })
  @ApiCreatedResponse({ type: ChangeReqResultDto })
  async createChangeReq(
    @CurrentUser() user: RequestUser,
    @Body() dto: ChangeReqCreateDto,
  ): Promise<ChangeReqResultDto> {
    const normalized = normalizeChangeRequest(dto);
    if (!normalized.ok) {
      throw new BadRequestException(normalized.issue);
    }
    const change = normalized.value;

    // JSONB 안의 id에는 FK를 걸 수 없으므로 저장 직전에 실제 활성 자원을 확인한다.
    const target = change.reqType === 'teacher'
      ? { kind: 'teacher' as const, id: change.payload.teacherId }
      : change.reqType === 'room' && 'roomId' in change.payload
        ? { kind: 'room' as const, id: change.payload.roomId }
        : change.reqType === 'room' && 'zaccId' in change.payload
          ? { kind: 'zoom' as const, id: change.payload.zaccId }
          : null;
    if (target && !(await this.svc.activeChangeTargetExists(target.kind, target.id))) {
      throw new NotFoundException({ code: 'CHANGE_TARGET_NOT_FOUND', message: '바꿀 자원을 찾을 수 없습니다' });
    }

    const base = await this.svc.occOf(change.serId, change.onDate);
    if (!base) {
      throw new NotFoundException({ code: 'OCCURRENCE_NOT_FOUND', message: '변경할 회차를 찾을 수 없습니다' });
    }

    // 시간·강사·강의실을 바꾸는 요청만 겹침을 본다. 취소는 자리를 비우는 쪽이라 겹칠 수 없다.
    const conflicts = await this.previewConflicts(change, base);
    if (conflicts.length > 0) return { id: null, conflicts };

    const id = await this.svc.createChangeReq(user.id, change);
    return { id, conflicts: [] };
  }

  /** 요청서에 안 적힌 값은 원본 회차에서 가져와 채운다 — 「강사만 바꾸는」 요청도 시각이 필요하다 */
  private async previewConflicts(
    dto: NormalizedChangeRequest,
    base: { startMin: number; endMin: number; teacherId: number | null; roomId: number | null; zaccId: number | null },
  ) {
    if (dto.reqType === 'cancel') return [];

    let roomId = base.roomId;
    let zaccId = base.zaccId;
    if (dto.reqType === 'room') {
      if ('roomId' in dto.payload) {
        roomId = dto.payload.roomId;
        zaccId = null;
      } else {
        roomId = null;
        zaccId = dto.payload.zaccId;
      }
    }

    return this.sched.conflicts({
      onDate: dto.onDate,
      startMin: dto.reqType === 'time_move' ? dto.payload.startMin : base.startMin,
      endMin: dto.reqType === 'time_move' ? dto.payload.endMin : base.endMin,
      teacherId: dto.reqType === 'teacher' ? dto.payload.teacherId : base.teacherId,
      // 물리 강의실과 Zoom 중 하나를 고르면 다른 자원은 비워지는 요청이다.
      roomId,
      zaccId,
      // 자기 자신과는 겹치지 않는다
      exceptSerId: dto.serId,
    });
  }
}
