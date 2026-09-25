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
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException,
  Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiBody, ApiConflictResponse, ApiCreatedResponse, ApiExtraModels, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { ApiErrorDto, OkDto } from '../../common/http.dto';
import { approvalFlowScope, Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import { normalizeChangeRequest, type NormalizedChangeRequest } from '../../lib/change-request';
import { ScheduleService } from '../schedule/schedule.service';
import {
  CancelChangeReqDto, ChangeReqCreateDto, ChangeReqResultDto, DrawerDto, DrawerQueryDto,
  ChreqReviewDto, MemberDto, NotiReadAllDto, ReqReviewDto, ReqReviewResultDto, RoomChangeReqDto,
  StaffActiveDto, StaffCreateDto, StaffCreatedDto, StaffHandoverDto, StaffParamsDto, StaffPatchDto,
  TeacherChangeReqDto, TimeMoveChangeReqDto, TodoClearDto, TodoClearRequestDto, TodoCreateDto, TodoCreateResultDto,
  TodoParamsDto, TodoPatchDto, ZoomChangeReqDto,
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
      canEditTodoDue: role !== null && hasPerm(role, 'canAdminPage', user.perms) && hasPerm(role, 'canCrudAll', user.perms),
      // §17 사용자 표 CRUD 의 줄 단추 — 쓰기 경로의 @Perm('canAdminPage','canCrudAll') 과 같은 둘 (W8)
      canManageStaff: role !== null && hasPerm(role, 'canAdminPage', user.perms) && hasPerm(role, 'canCrudAll', user.perms),
      canWage: role !== null && hasPerm(role, 'canWage', user.perms),
      approvalFlowScope: role === null ? 'none' as const : approvalFlowScope(role, user.perms),
    };
  }

  @Get()
  @ApiOperation({ summary: '서랍 여덟 칸을 한 번에 — 승인함/결재 흐름 정규화 포함 (D-R26 · D-R34)' })
  @ApiOkResponse({ type: DrawerDto })
  all(@CurrentUser() user: RequestUser, @Query() q: DrawerQueryDto): Promise<DrawerDto> {
    const { canApprove, canSeeAll, canWage, canManageStaff, approvalFlowScope: flowScope } = this.gate(user);
    // notiWindow=all 은 **보여 주는 범위**만 넓힌다 — 지운 적이 없으므로 예전 것이 그대로 나온다 (N-7 · D-16)
    return this.svc.all(user.id, canApprove, canSeeAll, q.notiWindow === 'all', flowScope, canWage, canManageStaff);
  }

  /* ══ §17 구성원 (C97 · 테스트 시나리오 D-41) · 사용자 표 CRUD (W8 · 대표 지시 2026-09-26) ═══════════ */

  @Post('staff')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '「+ 구성원」 — 강사·매니저 계정을 만든다 (C97 · D-41 · W8)',
    description: '이름 · 이메일(유일 · 로그인 아이디) · 역할 둘 · 직함 · 시간대(tzg) · 휴대폰(숫자만) · 입사일 · 기본 시급(적으면 같은 트랜잭션에 WAGE 한 줄 · 소급 없음). '
      + '**비밀번호는 받지 않는다** — 서버가 초기 비밀번호로 만들고 첫 설정(아이디·비밀번호 변경 · 휴대폰·이메일 확인)을 건다. '
      + '응답에 넘겨줄 정보(loginId · initialPassword)가 이때만 실린다. 대표·관리자 계정은 이 길로 만들지 않는다.',
  })
  @ApiCreatedResponse({ type: StaffCreatedDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'BAD_REQUEST(허용 밖 필드 — password 포함) | STAFF_PHONE_INVALID' })
  @ApiConflictResponse({ description: 'code STAFF_EMAIL_TAKEN | TZ_UNKNOWN | WAGE_SAME_DAY' })
  @ApiForbiddenResponse({ description: 'code WAGE_SET_FORBIDDEN — 시급을 적었는데 canWage 가 없다 (S4)' })
  createStaff(@CurrentUser() user: RequestUser, @Body() dto: StaffCreateDto): Promise<StaffCreatedDto> {
    // 만들기는 canCrudAll, **시급은 canWage** — 다른 권한이므로 따로 넘긴다 (S4)
    return this.svc.createStaff(user.id, this.gate(user).canWage, dto);
  }

  @Patch('staff/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '§17 「수정」 — 강사·매니저 줄의 이름 · 이메일 · 휴대폰 · 직함 · 시간대 · 역할 · 입사일 (W8)',
    description: '보낸 칸만 바꾼다. 대표·관리자 줄은 403 STAFF_PROTECTED, 자기 역할은 403 SELF_ROLE. 이메일을 바꾸면 이메일 확인이, 휴대폰을 바꾸면 휴대폰 확인이 풀린다. 시급은 「시급 수정」에서만.',
  })
  @ApiOkResponse({ type: MemberDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'BAD_REQUEST(형식 · 허용 밖 필드 · 역할 ceo/admin) | STAFF_PHONE_INVALID' })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'STAFF_PROTECTED | SELF_ROLE' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STAFF_NOT_FOUND' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'STAFF_EMAIL_TAKEN | TZ_UNKNOWN | EMPTY_PATCH' })
  updateStaff(
    @CurrentUser() user: RequestUser, @Param() p: StaffParamsDto, @Body() dto: StaffPatchDto,
  ): Promise<MemberDto> {
    return this.svc.updateStaff(user.id, this.gate(user).canWage, p.id, dto);
  }

  @Post('staff/:id/password-reset')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '§17 「비밀번호 초기화」 — 초기 비밀번호로 되돌리고 첫 설정을 다시 건다 (W8)',
    description: '자기 것은 403 SELF_RESET(첫 설정 흐름으로 바꾼다), 대표·관리자 줄은 403 STAFF_PROTECTED. 그 계정의 이전 로그인은 끊긴다(credentials_changed_at). 응답은 넘겨줄 정보 — 기록(log)에는 비밀번호가 없다.',
  })
  @ApiCreatedResponse({ type: StaffHandoverDto })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'STAFF_PROTECTED | SELF_RESET' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STAFF_NOT_FOUND' })
  resetStaffPassword(@CurrentUser() user: RequestUser, @Param() p: StaffParamsDto): Promise<StaffHandoverDto> {
    return this.svc.resetStaffPassword(user.id, p.id);
  }

  @Patch('staff/:id/active')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '§17 「사용 중지」·「다시 사용」 (W8)',
    description: '사용 중지된 계정은 다음 요청부터 인증이 막히고 로그인도 안 된다(기존 활성 검사). 자기 것은 403 SELF_ACTIVE, 대표·관리자 줄은 403 STAFF_PROTECTED. 같은 값이면 그대로 돌려준다.',
  })
  @ApiOkResponse({ type: MemberDto })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'STAFF_PROTECTED | SELF_ACTIVE' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STAFF_NOT_FOUND' })
  setStaffActive(
    @CurrentUser() user: RequestUser, @Param() p: StaffParamsDto, @Body() dto: StaffActiveDto,
  ): Promise<MemberDto> {
    return this.svc.setStaffActive(user.id, this.gate(user).canWage, p.id, dto.active);
  }

  @Delete('staff/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '§17 「삭제」 — 기록이 하나도 없는 계정만 지운다 (W8)',
    description: '잘못 만든 계정을 치우는 길이다. 시급 줄 · 할 일 · 알림 · 수업 등 이 계정을 가리키는 행이 하나라도 있으면 409 STAFF_HAS_RECORDS — 사용 중지로 막는다. 자기 것은 403 SELF_DELETE, 대표·관리자 줄은 403 STAFF_PROTECTED.',
  })
  @ApiOkResponse({ type: OkDto })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'STAFF_PROTECTED | SELF_DELETE' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STAFF_NOT_FOUND' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'STAFF_HAS_RECORDS' })
  async deleteStaff(@CurrentUser() user: RequestUser, @Param() p: StaffParamsDto): Promise<OkDto> {
    await this.svc.deleteStaff(user.id, p.id);
    return { ok: true };
  }

  @Patch('todos/:id')
  @ApiOperation({ summary: '§15·§64 할 일 완료·기한 변경', description: 'done만 바꾸면 기존 주고받은 범위. dueOn(null 삭제 포함)은 canAdminPage와 canCrudAll이 모두 필요하다. 생략한 필드·제목·담당·출처는 보존한다.' })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'BAD_REQUEST: 안전한 양의 ID, boolean, 실재 날짜 및 허용 필드 검증 실패' })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'TODO_DUE_FORBIDDEN: 기한 변경 권한 부족. 혼합 done도 저장하지 않음' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'NOT_FOUND: 없는 행 또는 기존 완료 범위 밖' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'EMPTY_PATCH: done/dueOn 모두 생략' })
  @ApiOkResponse({ type: OkDto })
  async todoDone(
    @CurrentUser() user: RequestUser,
    @Param() params: TodoParamsDto,
    @Body() dto: TodoPatchDto,
  ): Promise<OkDto> {
    const { canSeeAll, canEditTodoDue } = this.gate(user);
    // null 삭제도 기한 변경이다. 기존 강사의 done-only 권한은 유지한다.
    if (dto.dueOn !== undefined && !canEditTodoDue) {
      throw new ForbiddenException({ code: 'TODO_DUE_FORBIDDEN', message: '할 일 기한을 바꿀 권한이 없습니다' });
    }
    const hit = await this.svc.patchTodo(params.id, dto, user.id, canSeeAll);
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

  /**
   * 요청서에 안 적힌 값은 원본 회차에서 가져와 채운다 — 「강사만 바꾸는」 요청도 시각이 필요하다.
   *
   * 날짜는 **그 회차가 실제로 놓인 날**(`base.date`)이다. 요청서의 `onDate` 는 규칙이 찍은 날(EXC 키)이라
   * 다른 날로 옮긴 회차에서는 엉뚱한 날의 겹침을 보게 된다. 키는 저장(`createChangeReq`)과 반영(patch)에만 쓴다.
   */
  private async previewConflicts(
    dto: NormalizedChangeRequest,
    base: {
      startMin: number; endMin: number; teacherId: number | null; roomId: number | null; zaccId: number | null;
      date: string;
    },
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
      onDate: base.date,
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
