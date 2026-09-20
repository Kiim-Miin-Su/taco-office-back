/** @file-guide
 * 목적: books.controller.ts — BooksController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiPayloadTooLargeResponse, ApiTags } from '@nestjs/swagger';
import {
  BookHistoryDto, BookHistoryQueryDto, BookIssueCreateDto, BookIssueDto, BookIssueProgressDto,
  BookIssueReturnDto, BookIssueTransitionDto, BookPackDto, BookPackPatchDto, BookPacksDto, BookPackWriteDto,
  BookPatchDto, BookTrackingDto, BookVersionCreateDto, BookVersionDto, BooksDto, BookWriteDto, BookWriteResultDto,
} from './books.dto';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, type RequestUser } from '../../common/perm';
import { BooksService } from './books.service';

@ApiTags('books')
@Controller('books')
@Perm('canAdminPage')
export class BooksController {
  constructor(private readonly svc: BooksService) {}

  @Get()
  @ApiOperation({ summary: '교재 서가 — 코드 · 과목 · 쪽수 · SE/TE (§39)' })
  @ApiOkResponse({ type: BooksDto })
  async all(): Promise<BooksDto> {
    return this.svc.all();
  }

  @Post()
  @Perm('canCrudAll')
  @ApiOperation({ summary: '교재 등록 (§39)' })
  @ApiCreatedResponse({ type: BookWriteResultDto, description: '등록된 교재 식별자·코드·이름' })
  @ApiBadRequestResponse({ description: '필드 형식 또는 과목 참조 오류' })
  @ApiConflictResponse({ description: 'BOOK_CODE_DUPLICATE' })
  async create(@CurrentUser() user: RequestUser, @Body() dto: BookWriteDto): Promise<BookWriteResultDto> {
    return this.svc.createBook(user.id, dto);
  }

  @Patch(':id')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '교재 기본 정보 수정 (§39)' })
  @ApiOkResponse({ type: BookWriteResultDto, description: '수정된 교재 식별자·코드·이름' })
  async patch(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: BookPatchDto): Promise<BookWriteResultDto> {
    return this.svc.patchBook(user.id, id, dto);
  }

  @Get('tracking')
  @ApiOperation({ summary: '학생별 교재 트래킹 보드 (§38)' })
  @ApiOkResponse({ type: BookTrackingDto })
  async tracking(): Promise<BookTrackingDto> { return this.svc.tracking(); }

  @Post('issues')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '학생에게 교재 배부/배부 요청 (§38)' })
  @ApiCreatedResponse({ type: BookIssueDto })
  async issue(@CurrentUser() user: RequestUser, @Body() dto: BookIssueCreateDto): Promise<BookIssueDto> {
    return this.svc.createIssue(user.id, dto);
  }

  @Patch('issues/:id/state')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '교재 배부 상태 전이 — 승인 대기→전달 대기→배부 완료 (§38)' })
  @ApiOkResponse({ type: BookIssueDto })
  @ApiConflictResponse({ description: 'ISSUE_INVALID_TRANSITION' })
  async issueState(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: BookIssueTransitionDto,
  ): Promise<BookIssueDto> {
    return this.svc.transitionIssue(user.id, id, dto.state);
  }

  @Patch('issues/:id/progress')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '숙제 페이지 기준 교재 진도 갱신 (§38)' })
  @ApiOkResponse({ type: BookIssueDto })
  async progress(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: BookIssueProgressDto): Promise<BookIssueDto> {
    return this.svc.updateIssueProgress(user.id, id, dto.progressPage);
  }

  @Post('issues/:id/return')
  @HttpCode(HttpStatus.OK)
  @Perm('canCrudAll')
  @ApiOperation({ summary: '교재 회수 (§38·§40)' })
  @ApiOkResponse({ type: BookIssueDto })
  async returnIssue(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: BookIssueReturnDto): Promise<BookIssueDto> {
    return this.svc.returnIssue(user.id, id, dto.returnedOn);
  }

  /* ══ §40 교재 이력 — 읽기만 한다 ═════════════════════════════════════════ */

  @Get('history')
  @ApiOperation({
    summary: '교재 이력 (§40)',
    description: '이 화면에는 쓰기가 없다. 이력은 배부·업로드·교체·안내 같은 **다른 쓰기의 부수효과**로 쌓인다 (원본 §40 「여기에 남는 것」).',
  })
  @ApiOkResponse({ type: BookHistoryDto })
  async history(@Query() query: BookHistoryQueryDto): Promise<BookHistoryDto> {
    return this.svc.historyBoard(query);
  }

  @Get('deliveries')
  @Perm('canAdminPage', 'canGpaPack')
  @ApiOperation({ summary: '자료 전달 목록 (§41)' })
  @ApiOkResponse({ type: BookPacksDto })
  async deliveries(@CurrentUser() user: RequestUser): Promise<BookPacksDto> { return this.svc.packs(user.id); }

  @Post('deliveries')
  @Perm('canAdminPage', 'canGpaPack')
  @ApiOperation({ summary: '자료 전달 만들기 (§41)' })
  @ApiCreatedResponse({ type: BookPackDto })
  async createDelivery(@CurrentUser() user: RequestUser, @Body() dto: BookPackWriteDto): Promise<BookPackDto> {
    return this.svc.createPack(user.id, dto);
  }

  @Patch('deliveries/:id')
  @Perm('canAdminPage', 'canGpaPack')
  @ApiOperation({ summary: '자료 요청 수정 (§41)', description: '전달 완료 건을 수정하면 재전달을 위해 pending으로 되돌린다. 수령 완료 건은 변경하지 않는다.' })
  @ApiOkResponse({ type: BookPackDto })
  async patchDelivery(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: BookPackPatchDto): Promise<BookPackDto> {
    return this.svc.patchPack(user.id, id, dto);
  }

  @Post('deliveries/:id/deliver')
  @HttpCode(HttpStatus.OK)
  @Perm('canAdminPage', 'canGpaPack')
  @ApiOperation({ summary: '코디네이터에게 자료 전달 (§41)' })
  @ApiOkResponse({ type: BookPackDto })
  async deliver(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<BookPackDto> {
    return this.svc.transitionPack(user.id, id, 'delivered');
  }

  @Post('deliveries/:id/receive')
  @HttpCode(HttpStatus.OK)
  @Perm('canAdminPage', 'canGpaPack')
  @ApiOperation({ summary: '지정 코디네이터 수령 확인 (§41)' })
  @ApiOkResponse({ type: BookPackDto })
  async receive(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<BookPackDto> {
    return this.svc.transitionPack(user.id, id, 'received');
  }

  /* ══ §39 판(VERS) ════════════════════════════════════════════════════════ */

  @Post(':id/versions')
  @Perm('canAdminPage')
  @ApiOperation({
    summary: '새 판 올리기 (§39)',
    description: 'SE/TE 파일 본문, 판, 이력(교재 업로드)이 한 트랜잭션에서 함께 저장된다. SE+TE 원본 합계는 3MB까지다.',
  })
  @ApiCreatedResponse({ type: BookVersionDto })
  @ApiPayloadTooLargeResponse({ description: 'code FILE_TOO_LARGE | BOOK_FILES_TOO_LARGE' })
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
