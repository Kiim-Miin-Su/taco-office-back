/** @file-guide
 * 목적: lead-plan.controller.ts — LeadPlanController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * `/ops/leads/{id}/plan` · `/hold/extend` · `/appts` · `/appts/{kind}`(지우기) · `/appts/schedule` — 상담 배치안 초안 · 보류 연장 · 2차/진단 일정 (wave3 g3 · 23-15 · 23-16).
 * 경로·권한은 같은 상담 카드의 다른 쓰기(`/ops/leads/{id}/touches` 등)와 같다 — 운영 화면 권한(canAdminPage · canCrudAll).
 * OpsController 생성자에 끼우지 않고 따로 둔다 — 운영 계약 스위트가 그 생성자를 대역으로 세운다(진단 점수 컨트롤러와 같은 까닭).
 * 응답의 상담 한 줄은 `OpsService.leadOne` 이 만든다 — `GET /ops` 와 같은 SELECT · 같은 판정이다. 단가는 금액 권한 플래그로만 가른다(D-R39).
 */
import { Body, Controller, Delete, HttpCode, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import { LeadApptBookDto, LeadApptParamsDto, LeadApptWriteDto, LeadPlanWriteDto } from './lead-plan.dto';
import { LeadPlanService } from './lead-plan.service';
import { LeadApptScheduleResultDto, LeadDto } from './ops.dto';
import { OpsService } from './ops.service';

const canSeeMoney = (user: RequestUser) => isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);

@ApiTags('ops')
@Controller('ops/leads')
export class LeadPlanController {
  constructor(private readonly svc: LeadPlanService, private readonly ops: OpsService) {}

  @Put(':id/plan')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '배치안 초안 통째로 바꾸기 — 과목 · 주 N회 · 강사 (23-16 · 24-07)',
    description: '보낸 줄로 바꿔 적는다(빈 배열 = 비우기 · 8줄까지). 단가는 받지 않는다 — 읽을 때 적은 날의 단가표(RATE)가 붙고 금액 권한이 있을 때만 내려간다. '
      + '깔때기 안(1차 · 2차 대기 · 2차 상담 · 보류)에서만 — 등록·실패 건은 409 LEAD_PLAN_LOCKED. LOG(LEAD plan) 가 같은 트랜잭션.',
  })
  @ApiOkResponse({ type: LeadDto })
  @ApiConflictResponse({ description: 'LEAD_PLAN_LOCKED' })
  @ApiNotFoundResponse({ description: 'LEAD_NOT_FOUND | KIND_NOT_FOUND | SUB_NOT_FOUND | STAFF_NOT_FOUND' })
  async savePlan(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: LeadPlanWriteDto): Promise<LeadDto> {
    await this.svc.savePlan(user.id, id, dto);
    return this.ops.leadOne(id, canSeeMoney(user));
  }

  @Post(':id/hold/extend')
  @HttpCode(200)
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '「연장 +2일」 — 보류 재확인 날짜를 이틀 늘린다 (23-16)',
    description: '유효 재확인 날짜(적어 둔 날짜 · 없으면 보류에 들어온 날 + 2일)에 이틀을 더해 LEAD.recheck_on 에 적는다. 보류가 아니면 409 LEAD_NOT_HOLD. LOG(LEAD hold_extend).',
  })
  @ApiOkResponse({ type: LeadDto })
  @ApiConflictResponse({ description: 'LEAD_NOT_HOLD' })
  @ApiNotFoundResponse({ description: 'LEAD_NOT_FOUND' })
  async extendHold(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<LeadDto> {
    await this.svc.extendHold(user.id, id);
    return this.ops.leadOne(id, canSeeMoney(user));
  }

  @Put(':id/appts')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '2차 · 진단 일정 한 줄 — 날짜 · 시각 · 강의실/온라인 (23-15)',
    description: '종류(diag · second)마다 한 줄 — 같은 종류를 다시 보내면 고쳐 적는다. 이미 시간표에 만든 줄은 409 LEAD_APPT_SCHEDULED(시간표에서 옮긴다). '
      + '깔때기 밖은 409 LEAD_APPT_LOCKED · 끝이 시작보다 앞이면 409 BAD_RANGE · 온라인에 강의실이면 409 LEAD_APPT_PLACE. LOG(LEAD appt).',
  })
  @ApiOkResponse({ type: LeadDto })
  @ApiConflictResponse({ description: 'LEAD_APPT_LOCKED | LEAD_APPT_SCHEDULED | LEAD_APPT_PLACE | BAD_RANGE' })
  @ApiNotFoundResponse({ description: 'LEAD_NOT_FOUND | ROOM_NOT_FOUND' })
  async saveAppt(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: LeadApptWriteDto): Promise<LeadDto> {
    await this.svc.saveAppt(user.id, id, dto);
    return this.ops.leadOne(id, canSeeMoney(user));
  }

  @Delete(':id/appts/:kind')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '2차 · 진단 일정 한 줄 지우기 — 아직 시간표에 만들지 않은 줄만 (23-15)',
    description: '잘못 잡은 일정을 카드에서 걷어낸다. 이미 시간표에 만든 줄은 409 LEAD_APPT_SCHEDULED — 회차·리포트는 시간표가 정본이라 여기서 지우지 않는다'
      + '(시간표에서 회차를 지우면 연결이 풀려 다시 지울 수 있다). 없는 줄 404 LEAD_APPT_NOT_FOUND · 깔때기 밖 409 LEAD_APPT_LOCKED. LOG(LEAD appt_delete · before).',
  })
  @ApiOkResponse({ type: LeadDto })
  @ApiBadRequestResponse({ description: '모르는 종류(diag · second 만)' })
  @ApiConflictResponse({ description: 'LEAD_APPT_LOCKED | LEAD_APPT_SCHEDULED' })
  @ApiNotFoundResponse({ description: 'LEAD_NOT_FOUND | LEAD_APPT_NOT_FOUND' })
  async deleteAppt(@CurrentUser() user: RequestUser, @Param() params: LeadApptParamsDto): Promise<LeadDto> {
    await this.svc.deleteAppt(user.id, params.id, params.kind);
    return this.ops.leadOne(params.id, canSeeMoney(user));
  }

  @Post(':id/appts/schedule')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '「스케줄에 N건 만들기」 — 아직 시간표에 없는 일정마다 회차(ONCE)를 만들고 잇는다 (23-15)',
    description: '기존 시간표 쓰기(ScheduleWriteService.create)를 한 트랜잭션에서 부른다 — 진단 = 진단고사 종류, 2차 = 상담 종류, 강사 자리 = 상담 담당. '
      + '겹침은 시간표 EXCLUDE 가 막는다 → 409 RESOURCE_CONFLICT(전부 되돌린다). 만들 것이 없으면 409 LEAD_APPT_NONE · 코드표에 종류가 없으면 409 LEAD_APPT_CODE_MISSING. '
      + '담당의 불가 시간은 막지 않고 unavailable 로 돌려준다.',
  })
  @ApiCreatedResponse({ type: LeadApptScheduleResultDto })
  @ApiConflictResponse({ description: 'LEAD_APPT_LOCKED | LEAD_APPT_NONE | LEAD_APPT_CODE_MISSING | RESOURCE_CONFLICT' })
  @ApiNotFoundResponse({ description: 'LEAD_NOT_FOUND' })
  async scheduleAppts(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<LeadApptScheduleResultDto> {
    const { created, unavailable } = await this.svc.scheduleAppts(user.id, id);
    return { lead: await this.ops.leadOne(id, canSeeMoney(user)), created, unavailable };
  }

  @Post(':id/appts/book')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '「상담 일정 잡기」 — 날짜 · 시각 · 담당 · 방식을 한 번에: 시간표 회차 · 담당 지정 · 1차 → 2차 대기 · 상담 예약 접촉 (A-02)',
    description: '한 트랜잭션 — 적기(PUT appts 와 같은 판정) → 담당 지정(상담 건의 담당이 바뀐다) → 시간표 회차(ONCE · 진단 = 진단고사, 2차 = 상담 · 입학 상담 · 강사 자리 = 담당) '
      + '→ 1차면 2차 대기로(도달 기록 · 그 밖 단계는 그대로) → 상담 예약 접촉(다음은 그날) → LOG(LEAD appt_book). '
      + '겹치면 409 RESOURCE_CONFLICT 로 전부 되돌린다. 이미 시간표에 만든 종류 409 LEAD_APPT_SCHEDULED · 깔때기 밖 409 LEAD_APPT_LOCKED · '
      + '그만둔 담당 404 STAFF_NOT_FOUND · 담당 빠짐 400. 담당의 불가 시간은 막지 않고 unavailable 로 돌려준다.',
  })
  @ApiCreatedResponse({ type: LeadApptScheduleResultDto })
  @ApiConflictResponse({ description: 'LEAD_APPT_LOCKED | LEAD_APPT_SCHEDULED | LEAD_APPT_PLACE | LEAD_APPT_CODE_MISSING | RESOURCE_CONFLICT | BAD_RANGE' })
  @ApiNotFoundResponse({ description: 'LEAD_NOT_FOUND | STAFF_NOT_FOUND | ROOM_NOT_FOUND' })
  async bookAppt(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: LeadApptBookDto): Promise<LeadApptScheduleResultDto> {
    const { created, unavailable } = await this.svc.bookAppt(user.id, id, dto);
    return { lead: await this.ops.leadOne(id, canSeeMoney(user)), created, unavailable };
  }
}
