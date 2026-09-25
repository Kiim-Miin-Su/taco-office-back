/** @file-guide
 * 목적: lead-diag.controller.ts — LeadDiagController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * `/ops/leads/{id}/diag` — 상담 단계 진단 점수 (DQ1 · A-04 · v2 §23).
 * 경로·권한은 같은 상담 카드의 다른 쓰기(`/ops/leads/{id}/touches` 등)와 같다 — 운영 화면 권한(canAdminPage · canCrudAll).
 * OpsController 생성자에 끼우지 않고 따로 둔다 — 운영 계약 스위트가 그 생성자를 대역으로 세운다.
 */
import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiBadRequestResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, type RequestUser } from '../../common/perm';
import { LeadDiagListDto, LeadDiagWriteDto } from './lead-diag.dto';
import { LeadDiagService } from './lead-diag.service';

@ApiTags('ops')
@Controller('ops/leads')
export class LeadDiagController {
  constructor(private readonly svc: LeadDiagService) {}

  @Get(':id/diag')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '진단 점수 이력 — 최근 것이 앞 · 담당자가 고를 레벨 낱말 (DQ1 · A-04)',
    description: '점수(영어·수학·인터뷰)와 담당자가 고른 레벨·교재. 서버는 점수로 레벨을 정하지 않는다(자동 판정·자동 배치 없음). 등록되면 studentId 가 서고 같은 줄이 그 학생의 진단으로 읽힌다.',
  })
  @ApiOkResponse({ type: LeadDiagListDto })
  @ApiNotFoundResponse({ description: 'LEAD_NOT_FOUND' })
  history(@Param('id', ParseIntPipe) id: number): Promise<LeadDiagListDto> {
    return this.svc.history(id);
  }

  @Post(':id/diag')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '진단 점수 한 줄 — append-only · 같은 트랜잭션에 LOG (DQ1 · A-04)',
    description: '보낸 칸만 새 줄에 들어간다(지난 줄은 그대로 · 가장 최근 줄이 지금 값). 점수는 0 이상 정수(만점·경계 없음). 레벨·교재는 담당자가 고른 값 그대로 저장한다.',
  })
  @ApiCreatedResponse({ type: LeadDiagListDto })
  @ApiBadRequestResponse({ description: '입력 검증 실패 | LEAD_DIAG_EMPTY' })
  @ApiNotFoundResponse({ description: 'LEAD_NOT_FOUND | BOOK_NOT_FOUND' })
  append(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: LeadDiagWriteDto): Promise<LeadDiagListDto> {
    return this.svc.append(user.id, id, dto);
  }
}
