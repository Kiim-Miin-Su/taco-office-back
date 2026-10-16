/** @file-guide
 * 목적: files.controller.ts — FilesController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, ConflictException, Controller, Get, Param, ParseIntPipe, Post, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiPayloadTooLargeResponse, ApiProduces, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, type RequestUser } from '../../common/perm';
import { BookPdfPresignedRequestDto, BookPdfPresignedResultDto, BookPdfUploadIntentDto, BookPdfUploadUrlDto, FileDownloadTargetDto, FileRefDto, FileUploadDto } from './files.dto';
import { FilesService } from './files.service';

/**
 * 일반 파일과 기존 교재 본문은 Neon에 두고, 신규 교재 PDF 본문은 비공개 Blob에 둔다.
 *
 * raw id는 종류·연결 원장·업로더를 service에서 함께 판정한다. 로그인만으로는 어떤 종류도 열지 않는다.
 */
@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly svc: FilesService) {}

  @Post('book-pdf-upload')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '신규 교재 PDF의 비공개 Blob 업로드 의도·경로 발급', description: '파일당 1GB. 본문은 API를 거치지 않으며 대용량은 정식 SDK의 multipart 발급 경로를 사용한다.' })
  @ApiCreatedResponse({ type: BookPdfUploadUrlDto })
  async bookPdfUpload(@CurrentUser() user: RequestUser, @Body() dto: BookPdfUploadIntentDto): Promise<BookPdfUploadUrlDto> {
    return this.svc.bookPdfUploadIntent(user.id, dto);
  }

  @Post('book-pdf-presigned')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '현재 사용자의 미사용 PDF 의도에 정식 SDK multipart 서명 발급', description: 'Bearer 인증·현재 권한과 의도 소유자·유효기간·정확한 경로·최대 bytes를 확인한다. 완료 여부는 기존 판 저장에서 HEAD·PDF 서명을 다시 검사한다.' })
  @ApiCreatedResponse({ type: BookPdfPresignedResultDto })
  @ApiBadRequestResponse({ description: 'BOOK_PDF_MISMATCH | BOOK_PDF_UPLOAD_REQUEST_INVALID' })
  @ApiNotFoundResponse({ description: 'BOOK_PDF_UPLOAD_NOT_FOUND — 소유자 또는 경로 불일치' })
  @ApiConflictResponse({ description: 'BOOK_PDF_UPLOAD_EXPIRED — 소비 완료 또는 만료' })
  @ApiServiceUnavailableResponse({ description: 'BOOK_PDF_MULTIPART_NOT_CONFIGURED — 발급 설정 누락' })
  async bookPdfPresigned(
    @CurrentUser() user: RequestUser,
    @Body() dto: BookPdfPresignedRequestDto,
    @Req() request: Request,
  ): Promise<BookPdfPresignedResultDto> {
    return this.svc.bookPdfPresignedUpload(user.id, dto, request);
  }

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

  @Get(':id/download-target')
  @ApiOperation({ summary: '현재 권한을 확인해 DB 파일 또는 짧게 유효한 비공개 PDF URL을 돌려준다' })
  @ApiOkResponse({ type: FileDownloadTargetDto })
  @ApiForbiddenResponse({ description: 'code FILE_FORBIDDEN' })
  async downloadTarget(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<FileDownloadTargetDto> {
    return this.svc.downloadTarget(user, id);
  }

  @Get(':id')
  @ApiOperation({ summary: '권한이 확인된 파일 내려받기 — 종류와 연결 원장을 서버가 판정한다' })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ description: '파일 본문', schema: { type: 'string', format: 'binary' } })
  @ApiForbiddenResponse({ description: 'code FILE_FORBIDDEN — 종류·소유·업무 권한 불일치' })
  async download(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const file = await this.svc.readAuthorized(user, id);
    if (!file.data) {
      throw new ConflictException({ code: 'FILE_DIRECT_DOWNLOAD', message: '이 PDF는 다운로드 URL을 통해 받아야 합니다' });
    }
    res.set({
      'Content-Type': file.mime,
      // 이름에 한글이 들어가므로 RFC 5987 형식으로도 함께 싣는다
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'X-Content-Type-Options': 'nosniff',
      // 계약서·영수증·학생 리포트가 브라우저/중간 캐시에 남지 않게 한다.
      'Cache-Control': 'no-store',
    });
    return new StreamableFile(file.data);
  }
}
