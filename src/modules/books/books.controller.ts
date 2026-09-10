/** @file-guide
 * 목적: books.controller.ts — BooksController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BooksDto } from './books.dto';
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
}
