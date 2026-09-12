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
import { Perm, type RequestUser } from '../../common/perm';
import {
  GpaAllocPutDto, GpaBoardDto, GpaBoardQueryDto, GpaStudentDto, GpaUseCreateDto, GpaUseDto, GpaUseStateDto,
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
  async board(@Query() query: GpaBoardQueryDto): Promise<GpaBoardDto> {
    return this.svc.board(query.anchor);
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
  @ApiOperation({ summary: '기록 승인(ok)·되돌림(wait) — 닫힌 사이클은 잠긴다' })
  @ApiOkResponse({ type: GpaUseDto })
  @ApiConflictResponse({ description: 'code CYCLE_CLOSED' })
  @ApiNotFoundResponse({ description: '기록 없음' })
  async setUseState(@Param('id', ParseIntPipe) id: number, @Body() dto: GpaUseStateDto): Promise<GpaUseDto> {
    return this.svc.setUseState(id, dto);
  }

  @Delete('uses/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '대기(wait) 기록 삭제 — 승인분은 USE_APPROVED 로 거절' })
  @ApiOkResponse({ description: '{ ok: true }' })
  @ApiConflictResponse({ description: 'code CYCLE_CLOSED | USE_APPROVED' })
  async deleteUse(@Param('id', ParseIntPipe) id: number): Promise<{ ok: true }> {
    return this.svc.deleteUse(id);
  }

  @Put('allocs')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '배정 upsert — (사이클, 학생) 하나. 0 은 배정 회수. 담당 코디는 마지막 저장자' })
  @ApiOkResponse({ type: GpaStudentDto })
  @ApiConflictResponse({ description: 'code CYCLE_CLOSED' })
  async putAlloc(@CurrentUser() user: RequestUser, @Body() dto: GpaAllocPutDto): Promise<GpaStudentDto> {
    return this.svc.putAlloc(user.id, dto);
  }
}
