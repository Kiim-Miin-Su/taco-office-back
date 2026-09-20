/** @file-guide
 * 목적: drawer.controller.ts — DrawerController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 우측 서랍 — §14~§21.
 *
 * **한 번 열면 한 번만 부른다.** 칸이 여덟인데 엔드포인트를 여덟 개 두면
 * 서랍을 열 때마다 왕복이 여덟 번이고, 칸끼리 숫자가 어긋난다
 * (배지에는 3건인데 목록에는 2건인 상태가 정확히 그래서 생긴다).
 *
 * 쓰기는 할 일 생성/체크/완료 정리 · 알림 읽음 · 변경 요청 넣기다.
 * **승인과 반려는 여기서 하지 않는다** (D-R27). 줄을 누르면 그 화면으로 간다.
 */
import {
  BadRequestException, Body, Controller, Delete, Get, NotFoundException,
  Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import {
  ApiBody, ApiConflictResponse, ApiCreatedResponse, ApiExtraModels, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags, getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { OkDto } from '../../common/http.dto';
import { approvalFlowScope, Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import { normalizeChangeRequest, type NormalizedChangeRequest } from '../../lib/change-request';
import { ScheduleService } from '../schedule/schedule.service';
import {
  CancelChangeReqDto, ChangeReqCreateDto, ChangeReqResultDto, DrawerDto, DrawerQueryDto,
  ChreqReviewDto, MemberDto, NotiReadAllDto, ReqReviewDto, ReqReviewResultDto, RoomChangeReqDto,
  StaffCreateDto, TeacherChangeReqDto, TimeMoveChangeReqDto, TodoClearDto, TodoClearRequestDto, TodoCreateDto, TodoCreateResultDto,
  TodoDoneDto, ZoomChangeReqDto,
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
      canWage: role !== null && hasPerm(role, 'canWage', user.perms),
      approvalFlowScope: role === null ? 'none' as const : approvalFlowScope(role, user.perms),
    };
  }

  @Get()
  @ApiOperation({ summary: '서랍 여덟 칸을 한 번에 — 승인함/결재 흐름 정규화 포함 (D-R26 · D-R34)' })
  @ApiOkResponse({ type: DrawerDto })
  all(@CurrentUser() user: RequestUser, @Query() q: DrawerQueryDto): Promise<DrawerDto> {
    const { canApprove, canSeeAll, canWage, approvalFlowScope: flowScope } = this.gate(user);
    // notiWindow=all 은 **보여 주는 범위**만 넓힌다 — 지운 적이 없으므로 예전 것이 그대로 나온다 (N-7 · D-16)
    return this.svc.all(user.id, canApprove, canSeeAll, q.notiWindow === 'all', flowScope, canWage);
  }

  /* ══ §17 구성원 (C97 · 테스트 시나리오 D-41) ═══════════════════════════════ */

  @Post('staff')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '「+ 구성원」 — 강사·매니저 계정을 만든다 (C97 · D-41)',
    description: '이름 · 이메일(유일) · 첫 비밀번호(해시로만 저장 · 응답에 없다) · 역할 둘 · 직함 · 시간대(tzg) · 입사일 · 기본 시급(적으면 같은 트랜잭션에 WAGE 한 줄 · 소급 없음). 대표·관리자 계정은 이 길로 만들지 않는다.',
  })
  @ApiCreatedResponse({ type: MemberDto })
  @ApiConflictResponse({ description: 'code STAFF_EMAIL_TAKEN | TZ_UNKNOWN | WAGE_SAME_DAY' })
  @ApiForbiddenResponse({ description: 'code WAGE_SET_FORBIDDEN — 시급을 적었는데 canWage 가 없다 (S4)' })
  createStaff(@CurrentUser() user: RequestUser, @Body() dto: StaffCreateDto): Promise<MemberDto> {
    // 만들기는 canCrudAll, **시급은 canWage** — 다른 권한이므로 따로 넘긴다 (S4)
    return this.svc.createStaff(user.id, this.gate(user).canWage, dto);
  }

  @Patch('todos/:id')
  @ApiOperation({ summary: '§15 할 일 체크 — 내가 주고받은 것만' })
  @ApiOkResponse({ type: OkDto })
  async todoDone(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TodoDoneDto,
  ): Promise<OkDto> {
    const { canSeeAll } = this.gate(user);
    const hit = await this.svc.setTodoDone(id, dto.done, user.id, canSeeAll);
    // 남의 할 일이면 「없다」로 답한다 — 「있는데 권한이 없다」를 흘리지 않는다
    if (!hit) throw new NotFoundException({ code: 'NOT_FOUND', message: '할 일을 찾을 수 없습니다' });
    return { ok: true };
  }

  @Post('todos')
  @ApiOperation({ summary: '§15 수동 할 일 만들기 — 다른 사람 배정은 canCrudAll만' })
  @ApiCreatedResponse({ type: TodoCreateResultDto })
  createTodo(
    @CurrentUser() user: RequestUser,
    @Body() dto: TodoCreateDto,
  ): Promise<TodoCreateResultDto> {
    return this.svc.createTodo(user.id, this.gate(user).canSeeAll, dto);
  }

  @Delete('todos/completed')
  @ApiOperation({
    summary: '§15 끝난 것 지우기 — **화면이 보여 준 그것만** (S4)',
    description: '화면이 지금 「끝난 것」으로 세고 있는 id 들을 받는다. 서버는 그중 아직 끝나 있고 이 사람이 볼 수 있는 행만 지우고 그 줄을 통째로 log 에 남긴다. 단추의 숫자와 지워지는 수가 같다 (D-R39).',
  })
  @ApiOkResponse({ type: TodoClearDto })
  async clearDoneTodos(@CurrentUser() user: RequestUser, @Body() dto: TodoClearRequestDto): Promise<TodoClearDto> {
    return { ok: true, deleted: await this.svc.clearDoneTodos(user.id, this.gate(user).canSeeAll, dto.ids) };
  }

  @Patch('notis/:id/read')
  @ApiOperation({ summary: '§16 알림 읽음' })
  @ApiOkResponse({ type: OkDto })
  async notiRead(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<OkDto> {
    const hit = await this.svc.markNotiRead(id, user.id);
    if (!hit) throw new NotFoundException({ code: 'NOT_FOUND', message: '알림을 찾을 수 없습니다' });
    return { ok: true };
  }

  @Patch('notis/read-all')
  @ApiOperation({
    summary: '§16 「전부 읽음으로 표시」 — 내게 온 안 읽은 알림 전부',
    description: '보이는 창(30일)과 무관하게 내 것 전부를 읽음으로 바꾼다. 행을 지우지 않는다 (N-7).',
  })
  @ApiOkResponse({ type: NotiReadAllDto })
  async notiReadAll(@CurrentUser() user: RequestUser): Promise<NotiReadAllDto> {
    return { ok: true, marked: await this.svc.markAllNotisRead(user.id) };
  }

  @Post('requests/:id/review')
  @Perm('canApprove')
  @ApiOperation({
    summary: '§14 승인 대기함 — 요청 승인·반려 (승인하면 **실제로 적용된다**)',
    description:
      '원문 §14 는 줄마다 반려·승인을 갖는다(D-R27 의 「이동만」은 §75 결재 흐름의 규칙이고, '
      + 'D-R13 반려 사유 필수의 절 칸에는 14 가 있다). 승인은 시급이면 WAGE 새 줄(from_date=승인일·소급 없음·D8), '
      + '시간대면 STAFF.tz 를 바꾼다. 그 밖의 갈래는 적용 대상이 없어 상태만 닫는다. '
      + '잠금·적용·LOG·NOTI 가 한 트랜잭션이다.',
  })
  @ApiCreatedResponse({ type: ReqReviewResultDto })
  async reviewRequest(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReqReviewDto,
  ): Promise<ReqReviewResultDto> {
    return this.svc.reviewRequest(id, user.id, dto, this.gate(user).canWage);
  }

  @Post('change-requests/:id/review')
  @Perm('canApprove')
  @ApiOperation({
    summary: '§20 변경 요청 **반영**·반려 — 반영하면 시간표가 실제로 바뀐다',
    description:
      '원문 §20 안내 그대로: 「겹치면 넣을 수 없습니다 · 반영하면 시간표가 바뀌고 이력에 남습니다」. '
      + '반영은 기존 일정 쓰기(patch·remove)를 그대로 타므로 3범위·겹침·참조 방어가 한 벌이다. '
      + '범위는 apply_all 이면 이후 전체, 아니면 이 회차만이다(D-R16). '
      + '시간표 변경과 요청 종결이 한 트랜잭션이라, 겹쳐서 막히면 요청도 대기로 되돌아간다. '
      + '줌 계정 변경은 아직 배정 경로가 없어 CHREQ_NOT_APPLICABLE 로 거절한다.',
  })
  @ApiCreatedResponse({ type: ReqReviewResultDto })
  async reviewChangeRequest(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChreqReviewDto,
  ): Promise<ReqReviewResultDto> {
    return this.svc.reviewChangeRequest(id, user.id, dto);
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

    const { canSeeAll } = this.gate(user);
    const base = await this.svc.occOf(change.serId, change.onDate);
    // 목록과 같은 경계: 강사는 본인 회차만 요청한다. 타인/미지정 회차는 존재도 공개하지 않는다.
    // 자원 조회·충돌 설명보다 먼저 검사해 다른 수업의 정보가 응답에 섞이지 않게 한다.
    if (!base || (!canSeeAll && base.teacherId !== user.id)) {
      throw new NotFoundException({ code: 'OCCURRENCE_NOT_FOUND', message: '변경할 회차를 찾을 수 없습니다' });
    }

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
