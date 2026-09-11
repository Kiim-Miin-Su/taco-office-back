/** @file-guide
 * 목적: teacher.controller.ts — TeacherController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import type { RequestUser } from '../../common/perm';
import { TeacherHomeDto } from './teacher.dto';
import { TeacherService } from './teacher.service';

@ApiTags('teacher')
@Controller('teacher')
export class TeacherController {
  constructor(private readonly svc: TeacherService) {}

  @Get('home')
  @ApiOperation({ summary: '강사 홈 — 오늘·다가오는 수업·주간 요약·오늘 할 일·내 설정 (강사 덱 §7~9)' })
  @ApiOkResponse({ type: TeacherHomeDto })
  @ApiForbiddenResponse({ description: '강사 전용 — 다른 역할은 관리자 화면을 쓴다' })
  async home(@CurrentUser() user: RequestUser): Promise<TeacherHomeDto> {
    // 강사 전용 표면 — 시급이 실리므로 역할·본인 고정을 서버가 한다. 관리자 미리보기는 별도 결정 뒤에.
    if (user.role !== 'teacher') throw new ForbiddenException('강사 전용 화면입니다');
    return this.svc.home(user.id);
  }
}
