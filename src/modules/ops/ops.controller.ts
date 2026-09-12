/** @file-guide
 * 목적: ops.controller.ts — OpsController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiConflictResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, hasPerm, isRole, type RequestUser } from '../../common/perm';
import { LeadDto, LeadFailDto, LeadResumeDto, OpsDto } from './ops.dto';
import { OpsService } from './ops.service';

@ApiTags('ops')
@Controller('ops')
export class OpsController {
  constructor(private readonly svc: OpsService) {}

  @Get()
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '운영 — 상담 · 컴플레인 · 할 일 · 기획 · 회의 · 마케팅 · 건의',
    description: '§24 FQ는 leads의 name, school, ownerName, reason을 검색한다. 받은 목록의 클라이언트 검색/필터 전환 시 추가 GET은 0회이며 별도 검색 query 계약은 없다.',
  })
  @ApiOkResponse({ type: OpsDto })
  async all(@CurrentUser() user: RequestUser): Promise<OpsDto> {
    return this.svc.all(isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms));
  }

  @Post('leads/:id/fail')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '상담 실패 전이 — 이전 단계를 명시값으로 보존 (v2 §24 · N-25 §4-17 · C35)',
    description: 'fail_from 은 전이 순간의 실제 단계를 서버가 기록한다 — 추정이 아니라 사실이다. 도달 기록(append-only)에 failed 를 남긴다.',
  })
  @ApiOkResponse({ type: LeadDto })
  @ApiConflictResponse({ description: 'code ALREADY_FAILED | ENROLLED_LOCKED' })
  @ApiNotFoundResponse({ description: '상담 건 없음' })
  async failLead(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LeadFailDto,
  ): Promise<LeadDto> {
    return this.svc.failLead(user.id, id, dto);
  }

  @Post('leads/:id/resume')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '실패 건 되살리기 — 지정값 → fail_from 명시값 → 도달 기록 역순, 없으면 UNCLASSIFIED',
    description: '레거시(stop_at 만 있는) 건은 추정하지 않는다 — 미분류로 거절하고 단계 지정을 요구한다 (N-25).',
  })
  @ApiOkResponse({ type: LeadDto })
  @ApiConflictResponse({ description: 'code NOT_FAILED | UNCLASSIFIED' })
  @ApiNotFoundResponse({ description: '상담 건 없음' })
  async resumeLead(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LeadResumeDto,
  ): Promise<LeadDto> {
    return this.svc.resumeLead(user.id, id, dto);
  }
}
