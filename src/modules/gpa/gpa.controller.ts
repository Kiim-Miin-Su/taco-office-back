/** @file-guide
 * 목적: gpa.controller.ts — GpaController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import {
  ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { OkDto } from '../../common/http.dto';
import { Perm, type RequestUser } from '../../common/perm';
import {
  GpaAllocPutDto, GpaBoardDto, GpaBoardQueryDto, GpaCycleCloseResultDto, GpaStudentDto, GpaUseCreateDto, GpaUseDto, GpaUseStateDto,
} from './gpa.dto';
import { GpaService } from './gpa.service';

@ApiTags('gpa')
@Controller('gpa')
export class GpaController {
  constructor(private readonly svc: GpaService) {}

  @Get()
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: 'GPA 관리 보드 — 사이클·규정·학생별 잔여·타임라인 (v2 §4.5·§82 · N-13 채택)',
    description: '배정 − 사용(ok) − 대기(wait) = 잔여는 서버 한 곳이 계산한다. 학부모 비공개(D-R30) — 발송 경로에 싣지 않는다.',
  })
  @ApiOkResponse({ type: GpaBoardDto })
  async board(@CurrentUser() user: RequestUser, @Query() query: GpaBoardQueryDto): Promise<GpaBoardDto> {
    return this.svc.board(query.anchor, user.id);
  }

  @Post('uses')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '회차 소비 기록 — wait 로 등록, 포인트는 규정 스냅샷. 초과는 막지 않고 화면이 붉게 안내한다' })
  @ApiCreatedResponse({ type: GpaUseDto })
  @ApiConflictResponse({ description: 'code CYCLE_CLOSED(닫힌 사이클) | OUT_OF_CYCLE(창 밖 날짜)' })
  async createUse(@CurrentUser() user: RequestUser, @Body() dto: GpaUseCreateDto): Promise<GpaUseDto> {
    return this.svc.createUse(user.id, dto);
  }

  @Patch('uses/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '기록 승인(ok)·되돌림(wait) — 기록한 사람은 승인하지 못한다 · 닫힌 사이클은 잠긴다' })
  @ApiOkResponse({ type: GpaUseDto })
  @ApiConflictResponse({ description: 'code CYCLE_CLOSED | SELF_APPROVAL_FORBIDDEN' })
  @ApiNotFoundResponse({ description: '기록 없음' })
  async setUseState(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: GpaUseStateDto,
  ): Promise<GpaUseDto> {
    // 승인자를 서버가 고정한다 — 이 경로는 2026-09-20 전까지 actor 를 받지도 않았고,
    // 그래서 누가 승인했는지 남지도 자기 기록을 막지도 못했다
    return this.svc.setUseState(id, user.id, dto);
  }

  @Delete('uses/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '대기(wait) 기록 삭제 — 승인분은 USE_APPROVED 로 거절' })
  @ApiOkResponse({ type: OkDto })
  @ApiConflictResponse({ description: 'code CYCLE_CLOSED | USE_APPROVED' })
  async deleteUse(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<OkDto> {
    // 지운 사람을 서버가 고정한다 — 이 경로도 actor 를 받지 않아 하드 삭제가 흔적 없이 지나갔다 (S7)
    return this.svc.deleteUse(id, user.id);
  }

  @Put('allocs')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '배정 upsert — (사이클, 학생) 하나. 0 은 배정 회수. 담당 코디는 마지막 저장자' })
  @ApiOkResponse({ type: GpaStudentDto })
  @ApiConflictResponse({ description: 'code CYCLE_CLOSED' })
  async putAlloc(@CurrentUser() user: RequestUser, @Body() dto: GpaAllocPutDto): Promise<GpaStudentDto> {
    return this.svc.putAlloc(user.id, dto);
  }

  @Post('cycles/:id/close')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '사이클 마감 — O-150 「4주마다 — GPA 사이클 마감」 (C95)',
    description: '열려 있고 끝날이 지났고 승인 대기가 0 일 때만. closed_at/by 도장 · 잔여는 소멸(D-R29 · 이월 없음) · 다음 사이클이 없으면 끝날 다음 날부터 4주를 연다 · LOG.',
  })
  @ApiCreatedResponse({ type: GpaCycleCloseResultDto })
  @ApiNotFoundResponse({ description: '사이클 없음' })
  @ApiConflictResponse({ description: 'code CYCLE_CLOSED(이미 마감) · CYCLE_NOT_ENDED(끝날 전) · CYCLE_HAS_WAIT(승인 대기 남음)' })
  async closeCycle(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<GpaCycleCloseResultDto> {
    return this.svc.closeCycle(user.id, id);
  }
}
