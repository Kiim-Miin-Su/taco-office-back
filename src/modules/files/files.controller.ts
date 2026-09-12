/** @file-guide
 * 목적: files.controller.ts — FilesController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, Param, ParseIntPipe, Post, Res, StreamableFile } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiPayloadTooLargeResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, type RequestUser } from '../../common/perm';
import { FileRefDto, FileUploadDto } from './files.dto';
import { FilesService } from './files.service';

/**
 * 올린 파일 — **Neon 안에** 둔다 (대표 결정 2026-09-12 · D6 · A-D4).
 *
 * 열람은 로그인한 사람이면 된다. 파일마다 더 좁은 규칙(담당 강사와 매니저만 — D6)은
 * **그 파일을 가리키는 행**이 갖고 있으므로, 각 모듈이 자기 경로에서 좁힌다.
 * 여기서 kind 별 규칙을 또 적으면 같은 판정이 두 곳이 된다.
 */
@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly svc: FilesService) {}

  @Post()
  @Perm('canAdminPage')
  @ApiOperation({
    summary: '파일 올리기 — base64 본문을 Neon 에 넣고 가리킬 주소를 돌려준다',
    description: '8MB 까지. 더 크면 조용히 자르지 않고 FILE_TOO_LARGE 로 거절한다.',
  })
  @ApiCreatedResponse({ type: FileRefDto })
  @ApiPayloadTooLargeResponse({ description: 'code FILE_TOO_LARGE' })
  async upload(@CurrentUser() user: RequestUser, @Body() dto: FileUploadDto): Promise<FileRefDto> {
    return this.svc.upload(user.id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '파일 내려받기 — 본문을 그대로 흘려보낸다' })
  @ApiOkResponse({ description: '파일 본문' })
  async download(@Param('id', ParseIntPipe) id: number, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const file = await this.svc.read(id);
    res.set({
      'Content-Type': file.mime,
      // 이름에 한글이 들어가므로 RFC 5987 형식으로도 함께 싣는다
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Cache-Control': 'private, max-age=3600',
    });
    return new StreamableFile(file.data);
  }
}
