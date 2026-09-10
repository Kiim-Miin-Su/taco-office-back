/** @file-guide
 * 목적: meta.controller.ts — MetaController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MetaDto } from './meta.dto';
import { MetaService } from './meta.service';

/**
 * 화면이 켜질 때 한 번 받아 두는 코드표.
 * 색·이름·정원이 여기서만 나오므로 명세서가 바뀌면 화면이 저절로 따라온다.
 */
@ApiTags('meta')
@Controller('meta')
export class MetaController {
  constructor(private readonly svc: MetaService) {}

  @Get()
  @ApiOperation({ summary: '코드표 — 수업 종류 · 과목 · 강의실 · 줌 · 구성원 · 학생' })
  @ApiOkResponse({ type: MetaDto })
  get(): Promise<MetaDto> {
    return this.svc.all();
  }
}
