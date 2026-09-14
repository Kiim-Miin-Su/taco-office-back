/** @file-guide
 * 목적: files.controller.ts — FilesController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, Param, ParseIntPipe, Post, Res, StreamableFile } from '@nestjs/common';
import { ApiCreatedResponse, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiPayloadTooLargeResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, type RequestUser } from '../../common/perm';
import { FileRefDto, FileUploadDto } from './files.dto';
import { FilesService } from './files.service';

/**
 * 올린 파일 — **Neon 안에** 둔다 (대표 결정 2026-09-12 · D6 · A-D4).
 *
 * raw id는 종류·연결 원장·업로더를 service에서 함께 판정한다. 로그인만으로는 어떤 종류도 열지 않는다.
 */
@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly svc: FilesService) {}

  @Post()
  @Perm('canAdminPage')
  @ApiOperation({
    summary: '파일 올리기 — base64 본문을 Neon 에 넣고 가리킬 주소를 돌려준다',
    description: '원본 파일 3MB까지. base64 JSON·Vercel 요청 한도 안에서 실제로 통과하는 값이며, 더 크면 FILE_TOO_LARGE로 거절한다.',
  })
  @ApiCreatedResponse({ type: FileRefDto })
  @ApiPayloadTooLargeResponse({ description: 'code FILE_TOO_LARGE' })
  async upload(@CurrentUser() user: RequestUser, @Body() dto: FileUploadDto): Promise<FileRefDto> {
    return this.svc.upload(user.id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '권한이 확인된 파일 내려받기 — 종류와 연결 원장을 서버가 판정한다' })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ description: '파일 본문', schema: { type: 'string', format: 'binary' } })
  @ApiForbiddenResponse({ description: 'code FILE_FORBIDDEN — 종류·소유·업무 권한 불일치' })
  async download(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const file = await this.svc.readAuthorized(user, id);
    res.set({
      'Content-Type': file.mime,
      // 이름에 한글이 들어가므로 RFC 5987 형식으로도 함께 싣는다
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    });
    return new StreamableFile(file.data);
  }
}
