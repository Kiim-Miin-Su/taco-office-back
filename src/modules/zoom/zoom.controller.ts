/** @file-guide
 * 목적: zoom.controller.ts — ZoomController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, type RequestUser } from '../../common/perm';
import {
  ZoomAccountCreateDto, ZoomAcctDto, ZoomAccountPatchDto, ZoomAssignDto, ZoomAssignResultDto,
  ZoomBoardDto, ZoomBoardQueryDto, ZoomAccountParamsDto,
} from './zoom.dto';
import { ZoomService } from './zoom.service';

/**
 * 줌 계정 관리 — **§21 서랍의 「줌 계정 관리」가 가는 자리**.
 *
 * 이 화면은 원본 61컷에 없다. 서랍에 단추만 있고 목적지가 없었다 —
 * 대표 결정(2026-09-12)으로 **신설한다.** 서랍은 그대로 「칸이 비었는지」만 보여 주고,
 * 고치는 일은 전부 여기서 한다.
 *
 * 비밀(`login_secret`·`meeting_pw_enc`)은 **어느 응답에도 싣지 않는다.** 저장은 AES-256-GCM 이고
 * 열람은 별도 경로다 — 목록을 여는 것만으로 비밀이 브라우저에 내려가면 가린 뜻이 없다.
 */
@ApiTags('zoom')
@Controller('zoom')
export class ZoomController {
  constructor(private readonly svc: ZoomService) {}

  @Get()
  @Perm('canAdminPage')
  @ApiOperation({
    summary: '줌 계정과 하루 점유 격자 (§21)',
    description: '점유는 `ser_occ` 에서 센다 — 「지금 가능」·「만석 시간대」도 같은 배열에서 센다.',
  })
  @ApiOkResponse({ type: ZoomBoardDto })
  async board(@Query() query: ZoomBoardQueryDto): Promise<ZoomBoardDto> {
    return this.svc.board(query.onDate);
  }

  @Post('accounts')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '줌 계정 추가 — 비밀은 암호화해 저장하고 응답에 싣지 않는다' })
  @ApiCreatedResponse({ type: ZoomAcctDto })
  @ApiConflictResponse({ description: 'code ZACC_LABEL_TAKEN' })
  async create(@CurrentUser() user: RequestUser, @Body() dto: ZoomAccountCreateDto): Promise<ZoomAcctDto> {
    return this.svc.create(user.id, dto);
  }

  @Patch('accounts/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '줌 계정 고치기 — 끄면 새 배정에서 빠지고, 이미 붙은 회차는 건드리지 않는다' })
  @ApiOkResponse({ type: ZoomAcctDto })
  @ApiNotFoundResponse({ description: 'code ZACC_NOT_FOUND' })
  async patch(
    @CurrentUser() user: RequestUser,
    @Param() params: ZoomAccountParamsDto,
    @Body() dto: ZoomAccountPatchDto,
  ): Promise<ZoomAcctDto> {
    return this.svc.patch(user.id, params.id, dto);
  }

  @Post('assign')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '줌 계정 배정 — 회차 하나 또는 규칙 전체 (§43 「계정 배정 →」 · §19 「강의실 바꾸기」의 줌 모양)',
    description: '정본은 ZASSIGN 이고 `ser_occ.zacc_id` 는 투영이다. 겹치면 EXCLUDE 가 막고 통째로 되돌아간다.',
  })
  @ApiCreatedResponse({ type: ZoomAssignResultDto })
  @ApiConflictResponse({ description: 'code ZACC_INACTIVE | ZOOM_ASSIGN_NOT_ONLINE | ZOOM_ASSIGN_CANCELED | MONTH_CLOSED | RESOURCE_CONFLICT' })
  async assign(@CurrentUser() user: RequestUser, @Body() dto: ZoomAssignDto): Promise<ZoomAssignResultDto> {
    return this.svc.assign(user.id, dto);
  }
}
