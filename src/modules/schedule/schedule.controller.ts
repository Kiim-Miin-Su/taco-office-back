/** @file-guide
 * 목적: schedule.controller.ts — ScheduleController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorDto } from '../../common/http.dto';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import {
  AttendanceMutationResultDto, AttendanceWriteDto, HorizonDto, OccurrenceCreateDto, OccurrenceDeleteDto, OccurrenceListDto,
  OccurrenceMoveDto, OccurrencePasteDto, OccurrencePatchDto, RosterPatchDto, RosterResultDto,
  WriteResultDto, OccurrenceQueryDto, ScheduleParamsDto, AttendanceParamsDto, ScheduleUndoDto,
  LessonTrackingDto, LessonTrackingQueryDto,
  ConflictPreviewDto, ConflictQueryDto,
  DayCancelDto, DayCancelResultDto,
  StudentParamsDto, StudentResumeParamsDto, StudentPauseWriteDto, StudentResumeWriteDto, StudentPauseResultDto,
} from './schedule.dto';
import { ScheduleService } from './schedule.service';
import { ScheduleWriteService } from './schedule.write.service';
import { ScheduleAttendanceService } from './schedule.attendance.service';
import { SchedulePauseService } from './schedule.pause.service';
import { horizon } from './schedule.project';

const missingOccurrenceResponse = {
  type: ApiErrorDto,
  description: 'NOT_FOUND: 수업 없음. OCCURRENCE_NOT_FOUND: 원래 onDate가 현재 규칙의 회차가 아님(분할/삭제 후 오래된 참조 포함). 저장하지 않으며 최신 목록에서 다시 선택해야 한다.',
};
const attendanceWriteDescription = '일정 변경과 같은 부모 SER를 먼저 잠근 뒤 최신 투영 회차의 종료/취소 여부를 검사한다. '
  + '정상 재투영은 사라진 회차로 오인하지 않는다. 종료 전 또는 취소된 회차는 ATTENDANCE_NOT_AVAILABLE409, '
  + '없는 회차는 OCCURRENCE_NOT_FOUND404이며 ATT/LOG를 저장하지 않는다.';

@ApiTags('schedule')
@ApiBadRequestResponse({ type: ApiErrorDto, description: '입력 오류. 일정 쓰기의 코드표·직원·강의실·학생 참조가 없으면 REFERENCE_NOT_FOUND. 최종 상속 시간 또는 일정 DB 시간 제약 위반은 BAD_RANGE. 저장 전체를 취소하며 {code,message}로 반환한다' })
@Controller('schedule')
export class ScheduleController {
  constructor(
    private readonly svc: ScheduleService,
    private readonly write: ScheduleWriteService,
    private readonly attendance: ScheduleAttendanceService,
    private readonly pauses: SchedulePauseService,
  ) {}

  @Get('occurrences')
  @ApiOperation({ summary: '회차 목록 — 일간·주간·월간·학생별·선생님별이 모두 이것을 쓴다' })
  @ApiOkResponse({ type: OccurrenceListDto })
  async list(
    @CurrentUser() user: RequestUser,
    @Query() query: OccurrenceQueryDto,
  ): Promise<OccurrenceListDto> {
    const { from, to, teacherId, studentId, roomId } = query;
    if (from > to) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: 'from 이 to 보다 뒤입니다' });
    }

    // 관리자 시간표 화면에 들어갈 수 없는 사람은 자기 수업만 본다. 화면과 서버가 같은
    // canAdminPage 결론을 써야 개인 화면인데 전체 회차가 내려가는 권한 조합이 생기지 않는다 (D-R39).
    // 역할을 직접 비교하지 않는다 — 판정은 hasPerm 한 곳에서만 한다 (eslint 가 막는다).
    const canAll = isRole(user.role) && hasPerm(user.role, 'canAdminPage', user.perms);
    const canCrudAttendance = isRole(user.role)
      && hasPerm(user.role, 'canCrudAttendance', user.perms);
    const forced = canAll ? undefined : user.id;

    const items = await this.svc.list({
      from,
      to,
      teacherId: forced ?? teacherId,
      studentId,
      roomId,
      canCrudAttendance,
    });
    return { from, to, items };
  }

  /* ══ 쓰기 — 자원 + scope 한 형태로만 받는다 (D-R16 · D-R21) ═══════════
     동작마다 엔드포인트를 만들면 같은 3범위 판정이 여러 곳에 흩어진다.       */

  /**
   * §79 수강 학생 — 창을 열 때만 부른다.
   *
   * 회차 목록에 끼워 넣으면 한 주치 회차마다 학생별 질의가 붙는다. 창은 눌러야 열리므로
   * 여기서 한 번 가져온다.
   */
  @Get('tracking')
  @Perm('canAdminPage')
  @ApiOperation({
    summary: '§79 수강 학생 — 정원 · 교재 · 안내 · 30일 출결 · 미수 · 최신 리포트 3건',
    description: '금액(단가·총액·미수)은 canMoney 인 사람에게만 값이 간다 (D-R39). 진도 평균은 ISSUE.progress_page/LIB.pages의 기존 교재 산식을 재사용하며 미확인은 null이다.',
  })
  @ApiOkResponse({ type: LessonTrackingDto })
  @ApiNotFoundResponse({ description: '회차 없음' })
  async tracking(
    @CurrentUser() user: RequestUser,
    @Query() query: LessonTrackingQueryDto,
  ): Promise<LessonTrackingDto> {
    const canMoney = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    const out = await this.svc.tracking(query.serId, query.onDate, canMoney);
    if (!out) {
      throw new NotFoundException({
        code: 'OCCURRENCE_NOT_FOUND',
        message: '해당 날짜의 수업 회차를 찾을 수 없습니다',
      });
    }
    return out;
  }

  /**
   * 겹침 미리보기 — **누구와 겹치는지**를 돌려준다 (§19 · D-R43).
   *
   * 지금까지 화면이 받는 신호는 **떨어뜨린 뒤의 409** 하나뿐이었고, 그 문구는
   * 「같은 시간에 강사·강의실·줌이 이미 잡혀 있습니다」라 **누구와 부딪혔는지 말하지 않는다.**
   * 계산은 `ScheduleService.conflicts()` 에 이미 있었고 §19 변경 요청만 그 길로 가고 있었다.
   *
   * **막는 것은 DB 이고 이것은 설명할 뿐이다.** 여기서 비었다고 저장을 건너뛰지 않는다 —
   * 그 사이에 남이 그 자리를 잡을 수 있다.
   */
  @Get('conflicts')
  @Perm('canCrudAll')
  @ApiOperation({
    summary: '겹침 미리보기 — 무엇과·누구와 겹치는가',
    description: '막는 것은 ser_occ 의 EXCLUDE 이고 이 응답은 설명이다. 비어 있어도 저장을 건너뛰지 않는다. '
      + '강사·강의실·줌 중 준 자원만 본다 — 하나도 주지 않으면 빈 배열이다.',
  })
  @ApiOkResponse({ type: ConflictPreviewDto })
  async conflicts(@Query() query: ConflictQueryDto): Promise<ConflictPreviewDto> {
    if (query.startMin >= query.endMin) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: '끝 시각이 시작 시각보다 앞입니다' });
    }
    const conflicts = await this.svc.conflicts({
      // service 의 파라미터 이름은 `onDate` 지만 쓰이는 곳은 span 을 만드는 날짜다 (lib/sql.spanOf)
      onDate: query.date,
      startMin: query.startMin,
      endMin: query.endMin,
      teacherId: query.teacherId ?? null,
      roomId: query.roomId ?? null,
      zaccId: query.zaccId ?? null,
      exceptSerId: query.exceptSerId ?? null,
    });
    return { conflicts };
  }

  @Get('horizon')
  @ApiOperation({ summary: '펼쳐 둔 기간 — 화면이 「비었다」와 「아직 안 펼쳤다」를 구분한다' })
  @ApiOkResponse({ type: HorizonDto })
  bounds(): HorizonDto {
    return { ...horizon(), clamped: false };
  }

  @Put(':serId/:onDate/attendance')
  @Perm('canCrudAttendance')
  @ApiOperation({ summary: '종료 회차 출결 확정/정정 — 현재값 ATT와 append-only LOG를 함께 저장', description: attendanceWriteDescription })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'ATTENDANCE_NOT_AVAILABLE: 최신 회차가 종료 전 또는 취소됨' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'OCCURRENCE_NOT_FOUND: 회차 없음' })
  @ApiOkResponse({ type: AttendanceMutationResultDto })
  saveAttendance(
    @CurrentUser() user: RequestUser,
    @Param() params: AttendanceParamsDto,
    @Body() dto: AttendanceWriteDto,
  ): Promise<AttendanceMutationResultDto> {
    return this.attendance.save(params.serId, params.onDate, dto, user.id);
  }

  @Delete(':serId/:onDate/attendance')
  @Perm('canCrudAttendance')
  @ApiOperation({ summary: '회차 출결 현재값 초기화 — 삭제 전 값은 LOG에 보존', description: attendanceWriteDescription })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'ATTENDANCE_NOT_AVAILABLE: 최신 회차가 종료 전 또는 취소됨' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'OCCURRENCE_NOT_FOUND: 회차 없음. ATTENDANCE_NOT_FOUND: 초기화할 출결 없음' })
  @ApiOkResponse({ type: AttendanceMutationResultDto })
  clearAttendance(
    @CurrentUser() user: RequestUser,
    @Param() params: AttendanceParamsDto,
  ): Promise<AttendanceMutationResultDto> {
    return this.attendance.clear(params.serId, params.onDate, user.id);
  }

  @Post()
  @Perm('canCrudAll')
  @ApiOperation({ summary: '수업 만들기 — 겹치면 DB 가 409 로 막는다 (D-R43)' })
  @ApiCreatedResponse({ type: WriteResultDto })
  create(@CurrentUser() user: RequestUser | undefined, @Body() dto: OccurrenceCreateDto): Promise<WriteResultDto> {
    return user ? this.write.create(dto, user.id) : this.write.create(dto);
  }

  @Post('paste')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '회차 1~50건 복제 — 결과는 새 SER, EXC는 따라오지 않는다 (D-R19)' })
  @ApiCreatedResponse({ type: WriteResultDto })
  paste(@CurrentUser() user: RequestUser | undefined, @Body() dto: OccurrencePasteDto): Promise<WriteResultDto> {
    return user ? this.write.paste(dto, user.id) : this.write.paste(dto);
  }

  @Post('move')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '다중 선택 회차 이동 — 전부 저장되거나 전부 되돌아간다 (C-7)' })
  @ApiCreatedResponse({ type: WriteResultDto })
  moveMany(@CurrentUser() user: RequestUser | undefined, @Body() dto: OccurrenceMoveDto): Promise<WriteResultDto> {
    return user ? this.write.moveMany(dto, user.id) : this.write.moveMany(dto);
  }

  @Post('day-cancel')
  @Perm('canCrudAll')
  @ApiOperation({
    summary: '그날 전체 휴강 — 공휴일·학원 전체 휴원 (테스트 시나리오 C-33 · N-133)',
    description: '그날의 취소 아닌 회차 전부를 같은 사유·처리로 접는다. 한 트랜잭션이라 하나가 막히면 전부 되돌아간다. '
      + '학원 사정·공휴일·강사 결강은 차감할 수 없다 (CANCEL_DEDUCT_FORBIDDEN). 알림은 M-125 규칙 그대로 남긴다.',
  })
  @ApiCreatedResponse({ type: DayCancelResultDto })
  @ApiNotFoundResponse({ description: 'code NO_OCCURRENCES — 그날 회차가 없다', type: ApiErrorDto })
  @ApiBadRequestResponse({ description: 'code CANCEL_DEDUCT_FORBIDDEN | CANCEL_REASON_REQUIRED', type: ApiErrorDto })
  dayCancel(@CurrentUser() user: RequestUser | undefined, @Body() dto: DayCancelDto): Promise<DayCancelResultDto> {
    return this.write.dayCancel(dto, user?.id);
  }

  /* ══ 휴원 · 복귀 (C92-c · 테스트 시나리오 C-36 · C-37) ═══════════════════
     학생 카드(§79 학생 트래킹)의 「휴원」·「복귀」. 회차를 지우지 않고 기간 하나를 적는다 —
     시간표·§54·명단이 그 기간을 「그날만 빠짐」과 같은 것으로 읽는다. */

  @Post('students/:studentId/pause')
  @Perm('canCrudAll')
  @ApiOperation({
    summary: '학생 휴원 — 기간 안의 회차가 시간표·청구에서 빠진다. 회차는 그대로다 (C-36)',
    description: '종료일을 비우면 복귀 처리 전까지다. 같은 학생의 기간이 겹치면 409 PAUSE_OVERLAP (DB EXCLUDE). '
      + '「빠지는 회차 수」는 서버가 센다. 지난 기간도 잡을 수 있지만 이미 발행한 청구서는 바뀌지 않는다 (청구서는 INSERT 뿐이다).',
  })
  @ApiCreatedResponse({ type: StudentPauseResultDto })
  @ApiNotFoundResponse({ description: 'code STUDENT_NOT_FOUND', type: ApiErrorDto })
  @ApiConflictResponse({ description: 'code PAUSE_OVERLAP — 이미 잡힌 휴원 기간과 겹친다', type: ApiErrorDto })
  @ApiBadRequestResponse({ description: 'code BAD_RANGE — 종료일이 시작일보다 앞', type: ApiErrorDto })
  pauseStudent(
    @CurrentUser() user: RequestUser,
    @Param() params: StudentParamsDto,
    @Body() dto: StudentPauseWriteDto,
  ): Promise<StudentPauseResultDto> {
    return this.pauses.pause(params.studentId, dto, user.id);
  }

  @Post('students/:studentId/pause/:pauseId/resume')
  @Perm('canCrudAll')
  @ApiOperation({
    summary: '학생 복귀 — 복귀일부터 회차가 돌아온다. 기간은 이력으로 남는다 (C-37)',
    description: '휴원 종료일을 복귀 전날로 당기고 누가·언제 복귀시켰는지 남긴다. 복귀일은 시작일 다음 날부터이며 '
      + '원래 종료일 뒤로는 못 잡는다 (BAD_RANGE). 이미 복귀 처리한 기록은 409 PAUSE_ALREADY_RESUMED.',
  })
  @ApiCreatedResponse({ type: StudentPauseResultDto })
  @ApiNotFoundResponse({ description: 'code PAUSE_NOT_FOUND — 그 학생의 휴원 기록이 아니다', type: ApiErrorDto })
  @ApiConflictResponse({ description: 'code PAUSE_ALREADY_RESUMED', type: ApiErrorDto })
  @ApiBadRequestResponse({ description: 'code BAD_RANGE', type: ApiErrorDto })
  resumeStudent(
    @CurrentUser() user: RequestUser,
    @Param() params: StudentResumeParamsDto,
    @Body() dto: StudentResumeWriteDto,
  ): Promise<StudentPauseResultDto> {
    return this.pauses.resume(params.studentId, params.pauseId, dto, user.id);
  }

  @Post('undo')
  @Perm('canCrudAll')
  @ApiOperation({
    summary: '직전 일정 쓰기 되돌리기 — 같은 행이 다시 바뀌었으면 409',
    description: '서명된10분 토큰의 직후 스냅숏과 현재 DB가 같을 때만 직전 스냅숏을 복원한다. 토큰의 actor와 현재 사용자가 달라도 거절한다.',
  })
  @ApiCreatedResponse({ type: WriteResultDto })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'UNDO_STALE: 토큰 발급 뒤 같은 일정이 다시 변경됨' })
  undo(@CurrentUser() user: RequestUser, @Body() dto: ScheduleUndoDto): Promise<WriteResultDto> {
    return this.write.undo(user.id, dto.token);
  }

  @Patch(':serId')
  @Perm('canCrudAll')
  @ApiNotFoundResponse(missingOccurrenceResponse)
  @ApiOperation({
    summary: '수업 고치기 — scope 로 이번만·향후·모두를 가른다 (D-R16)',
    description: '같은 SER의 쓰기는 부모 행 잠금 획득 순서로 처리하며 최신 저장값으로 부분 변경을 검증한다. '
      + '생략한 필드는 보존하고 this의 null 시간·날짜는 원본 상속으로 되돌린다. '
      + 'SER/EXC 저장과 회차 투영은 한 transaction이다. 버전 충돌 검출/멱등 키 계약은 제공하지 않는다.',
  })
  @ApiOkResponse({ type: WriteResultDto })
  patch(
    @CurrentUser() user: RequestUser | undefined,
    @Param() params: ScheduleParamsDto,
    @Body() dto: OccurrencePatchDto,
  ): Promise<WriteResultDto> {
    return user ? this.write.patch(params.serId, dto, undefined, user.id) : this.write.patch(params.serId, dto);
  }

  @Delete(':serId')
  @Perm('canCrudAll')
  @ApiNotFoundResponse(missingOccurrenceResponse)
  @ApiOperation({
    summary: '수업 취소·휴강 — 참조가 있으면 지우지 않고 기간을 마감한다',
    description: 'scope=this 가 휴강이다 (§12 「휴강 · 수정」). cancelKind·cancelTreat 를 함께 보내면 사유와 처리(이월·차감·보강 이관)를 '
      + 'EXC 에 새기고 M-125 알림을 남긴다. 학원 사정·공휴일·강사 결강은 차감할 수 없다(CANCEL_DEDUCT_FORBIDDEN). '
      + '둘 다 비우면 옛 방식(취소만 · 기본 정책 이월)이다. future·all 은 수업 종료라 사유를 받지 않는다(CANCEL_SCOPE).',
  })
  @ApiBadRequestResponse({ description: 'code CANCEL_DEDUCT_FORBIDDEN | CANCEL_REASON_REQUIRED | CANCEL_SCOPE', type: ApiErrorDto })
  @ApiOkResponse({ type: WriteResultDto })
  remove(
    @CurrentUser() user: RequestUser | undefined,
    @Param() params: ScheduleParamsDto,
    @Body() dto: OccurrenceDeleteDto,
  ): Promise<WriteResultDto> {
    return user ? this.write.remove(params.serId, dto, undefined, user.id) : this.write.remove(params.serId, dto);
  }

  @Patch(':serId/roster')
  @Perm('canCrudAll')
  @ApiNotFoundResponse({ ...missingOccurrenceResponse,
    description: `${missingOccurrenceResponse.description} STUDENT_NOT_FOUND: 학생 없음.`,
  })
  @ApiOperation({ summary: '수강 학생 넣고 빼기 — 「그날만 빼기」가 D-R21 이다 (§12 · §79)' })
  @ApiOkResponse({ type: RosterResultDto })
  roster(
    @CurrentUser() user: RequestUser | undefined,
    @Param() params: ScheduleParamsDto,
    @Body() dto: RosterPatchDto,
  ): Promise<RosterResultDto> {
    return user ? this.write.roster(params.serId, dto, user.id) : this.write.roster(params.serId, dto);
  }
}
