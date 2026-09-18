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
  GuideBodyDto, GuideCopyResultDto, GuideDraftCreateDto, GuideDto, GuideHistoryDto, GuideHistoryQueryDto,
  GuideStudentsDto, GuideTemplateDto, GuideTemplateWriteDto, GuidesDto, ZoomNoticeResultDto, ZoomNoticeWriteDto,
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

  @Post(':id/copy')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '나머지 학생에게 복사 — 그룹 수업 안내 (§43 · F-61)',
    description:
      '같은 규칙·같은 날·같은 사유의 다른 학생 **초안**에만 옮긴다. 이미 쓴 형제는 덮지 않고 이유를 돌려준다. '
      + '머리말은 받는 학생 것으로 다시 만든다 — 그대로 옮기면 남의 이름이 학부모에게 간다.',
  })
  @ApiCreatedResponse({ type: GuideCopyResultDto })
  @ApiConflictResponse({ description: 'code GUIDE_COPY_EMPTY · GUIDE_COPY_NO_SIBLING' })
  @ApiNotFoundResponse({ description: '안내 없음' })
  async copyBody(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<GuideCopyResultDto> {
    return this.svc.copyBody(user.id, id);
  }

  /* ══ §43 회차 안내의 「강사 안내」 — 줌 안내 ═══════════════════════════════ */

  @Post('zoom-notice')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '줌 안내 — 온라인 회차의 강사에게 보낸다 (§43 · §12 준비 · F-63)',
    description:
      '강사 수신함에 줄이 남는다(NOTI · PNOTI sent_at) — 강사 화면의 알림 칸은 N-26 이 닫혀야 붙는다. '
      + '학부모 줄은 「보낼 것」으로 남는다 — 수신처가 없다(N-42). '
      + '회차 키는 (serId, onDate) 다. 비밀번호는 본문에 싣지 않는다.',
  })
  @ApiCreatedResponse({ type: ZoomNoticeResultDto })
  @ApiConflictResponse({
    description: 'code ZOOM_NOTICE_NOT_ONLINE · ZOOM_NOTICE_CANCELED · ZOOM_NOTICE_NO_TEACHER · ZOOM_NOTICE_NO_ACCOUNT · ZOOM_NOTICE_ALREADY',
  })
  @ApiNotFoundResponse({ description: 'code OCCURRENCE_NOT_FOUND' })
  async sendZoomNotice(
    @CurrentUser() user: RequestUser,
    @Body() dto: ZoomNoticeWriteDto,
  ): Promise<ZoomNoticeResultDto> {
    return this.svc.sendZoomNotice(user.id, dto);
  }

}
