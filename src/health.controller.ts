/** @file-guide
 * 목적: health.controller.ts — HealthController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from './auth/public.decorator';
import { OkDto } from './common/http.dto';

@ApiTags('health')
@Controller()
export class HealthController {
  @Public()
  @Get('health')
  @ApiOperation({ summary: '살아 있는지' })
  @ApiOkResponse({ type: OkDto })
  health(): OkDto {
    return { ok: true };
  }
}
