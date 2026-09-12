/** @file-guide
 * 목적: catalog.controller.ts — CatalogController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse,
  ApiOperation, ApiTags,
} from '@nestjs/swagger';
import { Perm } from '../../common/perm';
import {
  CatalogDto, KindCreateDto, KindPatchDto, KindRowsDto, SubCreateDto, SubPatchDto, SubRowDto,
} from './catalog.dto';
import { CatalogService } from './catalog.service';

/**
 * 프로그램·과목 관리 — **§18 서랍의 「프로그램 · 과목 전체 열기」가 가는 자리**.
 *
 * 이 화면도 원본 61컷에 없다. 서랍에 단추만 있고 목적지가 없었다 —
 * 대표 결정(2026-09-12)으로 신설한다.
 *
 * **지우기는 없다.** 시간표가 이 낱말로 저장돼 있어서, 지우면 지난 학기 기록이 이름을 잃는다.
 * 과목은 `active` 로 끄고, 프로그램은 원문에 끄는 자리조차 없어 고치기만 둔다 —
 * 원문에 없는 동작을 지어내지 않는다 (D-R44).
 */
@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Get()
  @Perm('canAdminPage')
  @ApiOperation({ summary: '프로그램·과목 목록 — 몇 개가 이 낱말을 쓰고 있는지 함께 센다 (§18)' })
  @ApiOkResponse({ type: CatalogDto })
  async all(): Promise<CatalogDto> {
    return this.svc.all();
  }

  @Post('kinds')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '프로그램 추가 — 리포트 대상이면 서식이 있어야 한다' })
  @ApiCreatedResponse({ type: KindRowsDto })
  @ApiConflictResponse({ description: 'code KIND_KEY_TAKEN' })
  @ApiBadRequestResponse({ description: 'code REP_FORM_REQUIRED' })
  async createKind(@Body() dto: KindCreateDto): Promise<KindRowsDto> {
    return this.svc.createKind(dto);
  }

  @Patch('kinds/:key')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '프로그램 고치기 — 코드(key)는 바꾸지 않는다. 시간표가 그 낱말로 저장돼 있다' })
  @ApiOkResponse({ type: KindRowsDto })
  @ApiNotFoundResponse({ description: 'code KIND_NOT_FOUND' })
  async patchKind(@Param('key') key: string, @Body() dto: KindPatchDto): Promise<KindRowsDto> {
    return this.svc.patchKind(key, dto);
  }

  @Post('subs')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '과목 추가' })
  @ApiCreatedResponse({ type: SubRowDto })
  @ApiConflictResponse({ description: 'code SUB_KEY_TAKEN' })
  async createSub(@Body() dto: SubCreateDto): Promise<SubRowDto> {
    return this.svc.createSub(dto);
  }

  @Patch('subs/:key')
  @Perm('canCrudAll')
  @ApiOperation({ summary: '과목 고치기 — 끄면 새 수업에서 고를 수 없고, 이미 도는 수업은 그대로 둔다' })
  @ApiOkResponse({ type: SubRowDto })
  @ApiNotFoundResponse({ description: 'code SUB_NOT_FOUND' })
  async patchSub(@Param('key') key: string, @Body() dto: SubPatchDto): Promise<SubRowDto> {
    return this.svc.patchSub(key, dto);
  }
}
