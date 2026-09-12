/** @file-guide
 * 목적: books.controller.ts — BooksController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { BookHistoryRowDto, BookVersionCreateDto, BookVersionDto, BooksDto } from './books.dto';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, type RequestUser } from '../../common/perm';
import { BooksService } from './books.service';

@ApiTags('books')
@Controller('books')
export class BooksController {
  constructor(private readonly svc: BooksService) {}

  /**
   * 교재는 **강사도 본다** — 자기 수업에 무엇을 쓰는지 알아야 한다.
   * 그래서 @Perm 을 걸지 않는다. 로그인만 하면 된다.
   */
  @Get()
  @ApiOperation({ summary: '교재 — 코드 · 과목 · 쪽수 · SE/TE (§36)' })
  @ApiOkResponse({ type: BooksDto })
  async all(): Promise<BooksDto> {
    return this.svc.all();
  }

  /* ══ §40 교재 이력 — 읽기만 한다 ═════════════════════════════════════════ */

  @Get('history')
  @ApiOperation({
    summary: '교재 이력 (§40)',
    description: '이 화면에는 쓰기가 없다. 이력은 배부·업로드·교체·안내 같은 **다른 쓰기의 부수효과**로 쌓인다 (원본 §40 「여기에 남는 것」).',
  })
  @ApiQuery({ name: 'limit', required: false, description: '기본 200' })
  @ApiOkResponse({ type: [BookHistoryRowDto] })
  async history(@Query('limit') limit?: string): Promise<BookHistoryRowDto[]> {
    const n = Number(limit);
    return this.svc.history(Number.isInteger(n) && n > 0 && n <= 500 ? n : 200);
  }

  /* ══ §39 판(VERS) ════════════════════════════════════════════════════════ */

  @Post(':id/versions')
  @Perm('canAdminPage')
  @ApiOperation({
    summary: '새 판 올리기 (§39)',
    description: '파일은 POST /files 로 먼저 올리고 그 주소를 준다. 이력(교재 업로드)이 같은 트랜잭션에서 함께 남는다.',
  })
  @ApiCreatedResponse({ type: BookVersionDto })
  @ApiConflictResponse({ description: 'code VERS_DUPLICATE — 같은 교재에 같은 판 이름' })
  @ApiNotFoundResponse({ description: '교재 없음' })
  async addVersion(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: BookVersionCreateDto,
  ): Promise<BookVersionDto> {
    return this.svc.addVersion(user.id, id, dto);
  }

  @Patch('versions/:id/use')
  @Perm('canAdminPage')
  @ApiOperation({
    summary: '이 판을 오늘부터 쓴다 — §39 「판 버튼을 눌러 바꿉니다」',
    description: '시작일을 오늘로 당긴다. 이미 쓰고 있는 판은 다시 당기지 않는다(이력에 같은 일이 두 번 남는다).',
  })
  @ApiOkResponse({ type: BookVersionDto })
  @ApiConflictResponse({ description: 'code VERS_ALREADY_IN_USE' })
  @ApiNotFoundResponse({ description: '판 없음' })
  async useVersion(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<BookVersionDto> {
    return this.svc.useVersion(user.id, id);
  }

}
