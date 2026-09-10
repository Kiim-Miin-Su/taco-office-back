/** @file-guide
 * 목적: schedule.controller.ts — ScheduleController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorDto } from '../../common/http.dto';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import {
  AttendanceMutationResultDto, AttendanceWriteDto, HorizonDto, OccurrenceCreateDto, OccurrenceDeleteDto, OccurrenceListDto,
  OccurrenceMoveDto, OccurrencePasteDto, OccurrencePatchDto, RosterPatchDto, RosterResultDto,
  WriteResultDto, OccurrenceQueryDto, ScheduleParamsDto, AttendanceParamsDto,
} from './schedule.dto';
import { ScheduleService } from './schedule.service';
import { ScheduleWriteService } from './schedule.write.service';
import { ScheduleAttendanceService } from './schedule.attendance.service';
import { horizon } from './schedule.project';

@ApiTags('schedule')
@ApiBadRequestResponse({ type: ApiErrorDto, description: '입력 오류. 일정 쓰기의 코드표·직원·강의실·학생 참조가 없으면 REFERENCE_NOT_FOUND. 저장 전체를 취소하며 {code,message}로 반환한다' })
@Controller('schedule')
export class ScheduleController {
  constructor(
    private readonly svc: ScheduleService,
    private readonly write: ScheduleWriteService,
    private readonly attendance: ScheduleAttendanceService,
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

    // 강사는 자기 수업만 본다. 화면이 안 걸러도 서버가 거른다 (D-R39).
    // 역할을 직접 비교하지 않는다 — 판정은 hasPerm 한 곳에서만 한다 (eslint 가 막는다).
    const canAll = isRole(user.role) && hasPerm(user.role, 'canCrudAll', user.perms);
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

  @Get('horizon')
  @ApiOperation({ summary: '펼쳐 둔 기간 — 화면이 「비었다」와 「아직 안 펼쳤다」를 구분한다' })
  @ApiOkResponse({ type: HorizonDto })
  bounds(): HorizonDto {
    return { ...horizon(), clamped: false };
  }

  @Put(':serId/:onDate/attendance')
  @Perm('canCrudAttendance')
  @ApiOperation({ summary: '종료 회차 출결 확정/정정 — 현재값 ATT와 append-only LOG를 함께 저장' })
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
  @ApiOperation({ summary: '회차 출결 현재값 초기화 — 삭제 전 값은 LOG에 보존' })
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
  create(@Body() dto: OccurrenceCreateDto): Promise<WriteResultDto> {
    return this.write.create(dto);
  }

  @Post('paste')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '회차 1~50건 복제 — 결과는 새 SER, EXC는 따라오지 않는다 (D-R19)' })
  @ApiCreatedResponse({ type: WriteResultDto })
  paste(@Body() dto: OccurrencePasteDto): Promise<WriteResultDto> {
    return this.write.paste(dto);
  }

  @Post('move')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '다중 선택 회차 이동 — 전부 저장되거나 전부 되돌아간다 (C-7)' })
  @ApiCreatedResponse({ type: WriteResultDto })
  moveMany(@Body() dto: OccurrenceMoveDto): Promise<WriteResultDto> {
    return this.write.moveMany(dto);
  }

  @Patch(':serId')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '수업 고치기 — scope 로 이번만·향후·모두를 가른다 (D-R16)' })
  @ApiOkResponse({ type: WriteResultDto })
  patch(
    @Param() params: ScheduleParamsDto,
    @Body() dto: OccurrencePatchDto,
  ): Promise<WriteResultDto> {
    return this.write.patch(params.serId, dto);
  }

  @Delete(':serId')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '수업 취소·휴강 — 참조가 있으면 지우지 않고 기간을 마감한다' })
  @ApiOkResponse({ type: WriteResultDto })
  remove(
    @Param() params: ScheduleParamsDto,
    @Body() dto: OccurrenceDeleteDto,
  ): Promise<WriteResultDto> {
    return this.write.remove(params.serId, dto);
  }

  @Patch(':serId/roster')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '수강 학생 넣고 빼기 — 「그날만 빼기」가 D-R21 이다 (§12 · §79)' })
  @ApiOkResponse({ type: RosterResultDto })
  roster(
    @Param() params: ScheduleParamsDto,
    @Body() dto: RosterPatchDto,
  ): Promise<RosterResultDto> {
    return this.write.roster(params.serId, dto);
  }
}
