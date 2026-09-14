/** @file-guide
 * 목적: guides.controller.ts — GuidesController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, type RequestUser } from '../../common/perm';
import {
  GuideBodyDto, GuideDraftCreateDto, GuideDto, GuideHistoryDto, GuideHistoryQueryDto,
  GuideStudentsDto, GuideTemplateDto, GuideTemplateWriteDto, GuidesDto,
} from './guides.dto';
import { GuidesService } from './guides.service';

@ApiTags('guides')
@Controller('guides')
export class GuidesController {
  constructor(private readonly svc: GuidesService) {}

  @Get()
  @Perm('canAdminPage')
  @ApiOperation({ summary: '수업 안내 — 한 번만(GUIDE) · 회차마다(PNOTI) (§43)' })
  @ApiOkResponse({ type: GuidesDto })
  async all(): Promise<GuidesDto> {
    return this.svc.all();
  }

  @Get('students')
  @Perm('canAdminPage')
  @ApiOperation({ summary: '안내 학생별 — 최신 유효 안내·교재·진단 projection (§44)' })
  @ApiOkResponse({ type: GuideStudentsDto })
  async students(): Promise<GuideStudentsDto> {
    return this.svc.students();
  }

  @Get('history')
  @Perm('canAdminPage')
  @ApiOperation({ summary: '안내 이력과 필요한데 없는 안내 — 일·주·월 (§45)' })
  @ApiOkResponse({ type: GuideHistoryDto })
  async history(@Query() query: GuideHistoryQueryDto): Promise<GuideHistoryDto> {
    return this.svc.history(query);
  }

  @Post('drafts')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '필요한데 없는 안내를 초안으로 만들기 (§45)',
    description: '화면은 회차/학생 id만 보낸다. 서버가 첫 수업·강사 교체를 다시 판정하고 중복 생성은 같은 GUIDE로 수렴시킨다.',
  })
  @ApiCreatedResponse({ type: GuideDto })
  @ApiConflictResponse({ description: 'code GUIDE_CANDIDATE_STALE | GUIDE_CREATE_RACE' })
  async createDraft(@CurrentUser() user: RequestUser, @Body() dto: GuideDraftCreateDto): Promise<GuideDto> {
    return this.svc.createDraft(user.id, dto);
  }

  /* ══ §43 머리의 「문구 관리」 — 문구 틀 ═══════════════════════════════════ */

  @Get('templates')
  @Perm('canAdminPage')
  @ApiOperation({
    summary: '문구 틀 목록 (§43 「문구 관리」)',
    description: '틀은 안내와 끊어져 있다 — 안내를 만들 때 본문을 복사해 넣고, 그 뒤로 틀을 고쳐도 이미 쓴 안내는 안 바뀐다.',
  })
  @ApiOkResponse({ type: [GuideTemplateDto] })
  async templates(): Promise<GuideTemplateDto[]> {
    return this.svc.templates();
  }

  @Post('templates')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '문구 틀 추가 — 이름이 겹치면 막는다' })
  @ApiCreatedResponse({ type: GuideTemplateDto })
  @ApiConflictResponse({ description: 'code GTPL_DUPLICATE' })
  async createTemplate(@Body() dto: GuideTemplateWriteDto): Promise<GuideTemplateDto> {
    return this.svc.createTemplate(dto);
  }

  @Patch('templates/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '문구 틀 고치기 — 이미 쓴 안내는 안 바뀐다' })
  @ApiOkResponse({ type: GuideTemplateDto })
  @ApiConflictResponse({ description: 'code GTPL_DUPLICATE' })
  @ApiNotFoundResponse({ description: '문구 없음' })
  async patchTemplate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: GuideTemplateWriteDto,
  ): Promise<GuideTemplateDto> {
    return this.svc.patchTemplate(id, dto);
  }

  /* ══ §43 「안내 작성」 ════════════════════════════════════════════════════ */

  @Put(':id/body')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '안내 작성 — 쓰면 보낼 준비가 된다 (§43)',
    description: '상태 낱말은 화면이 보내지 않는다. 「썼다」만 주면 어느 상태가 되는지는 서버가 정한다 (D-R18).',
  })
  @ApiOkResponse({ type: GuideDto })
  @ApiConflictResponse({ description: 'code GUIDE_ALREADY_SENT — 이미 보낸 안내는 고치지 않는다' })
  @ApiNotFoundResponse({ description: '안내 없음' })
  async writeBody(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: GuideBodyDto,
  ): Promise<GuideDto> {
    return this.svc.writeBody(user.id, id, dto);
  }

}
