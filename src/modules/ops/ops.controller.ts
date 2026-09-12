/** @file-guide
 * 목적: ops.controller.ts — OpsController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiConflictResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, canCeoApprovePlan, canCeoComment, hasPerm, isRole, type RequestUser } from '../../common/perm';
import {
  LeadDto, LeadFailDto, LeadResumeDto, MfbCommentWriteDto, MfbEditDto, MfbReplyWriteDto, MfbThreadDto, OpsDto,
  PlanDetailDto, PlanDueDecisionDto, PlanReviewDto,
} from './ops.dto';
import { OpsService } from './ops.service';

@ApiTags('ops')
@Controller('ops')
export class OpsController {
  constructor(private readonly svc: OpsService) {}

  @Get()
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '운영 — 상담 · 컴플레인 · 할 일 · 기획 · 회의 · 마케팅 · 건의',
    description: '§24 FQ는 leads의 name, school, ownerName, reason을 검색한다. 받은 목록의 클라이언트 검색/필터 전환 시 추가 GET은 0회이며 별도 검색 query 계약은 없다.',
  })
  @ApiOkResponse({ type: OpsDto })
  async all(@CurrentUser() user: RequestUser): Promise<OpsDto> {
    return this.svc.all(
      user.id,
      isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms),
      isRole(user.role) && canCeoComment(user.role),
    );
  }

  @Post('leads/:id/fail')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '상담 실패 전이 — 이전 단계를 명시값으로 보존 (v2 §24 · N-25 §4-17 · C35)',
    description: 'fail_from 은 전이 순간의 실제 단계를 서버가 기록한다 — 추정이 아니라 사실이다. 도달 기록(append-only)에 failed 를 남긴다.',
  })
  @ApiOkResponse({ type: LeadDto })
  @ApiConflictResponse({ description: 'code ALREADY_FAILED | ENROLLED_LOCKED' })
  @ApiNotFoundResponse({ description: '상담 건 없음' })
  async failLead(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LeadFailDto,
  ): Promise<LeadDto> {
    return this.svc.failLead(user.id, id, dto);
  }

  @Post('leads/:id/resume')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '실패 건 되살리기 — 지정값 → fail_from 명시값 → 도달 기록 역순, 없으면 UNCLASSIFIED',
    description: '레거시(stop_at 만 있는) 건은 추정하지 않는다 — 미분류로 거절하고 단계 지정을 요구한다 (N-25).',
  })
  @ApiOkResponse({ type: LeadDto })
  @ApiConflictResponse({ description: 'code NOT_FAILED | UNCLASSIFIED' })
  @ApiNotFoundResponse({ description: '상담 건 없음' })
  async resumeLead(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LeadResumeDto,
  ): Promise<LeadDto> {
    return this.svc.resumeLead(user.id, id, dto);
  }

  /* ══ §60 대표 피드백 ═══════════════════════════════════════════════════ */

  @Post('marketing/:id/comments')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '대표 코멘트 — 관리자 전원에게 알림 (원문 §60)',
    description: '「대표가 코멘트를 남기면 관리자 전원에게 알림이 갑니다」. 쓸 때의 종류를 kind 로 적는다 — 쓴 사람의 지금 역할로 되짚지 않는다.',
  })
  @ApiOkResponse({ type: [MfbThreadDto] })
  @ApiConflictResponse({ description: 'code CEO_ONLY' })
  @ApiNotFoundResponse({ description: '마케팅 활동 없음' })
  async comment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MfbCommentWriteDto,
  ): Promise<MfbThreadDto[]> {
    return this.svc.comment(user.id, isRole(user.role) && canCeoComment(user.role), id, dto);
  }

  @Post('marketing/:id/replies')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '담당자 답변 — 코멘트를 쓴 대표에게만 알림 (원문 §60)',
    description: '「담당자 답변은 대표에게만」. 어느 코멘트에 대한 답인지 parentId 로 들고 있어야 「고쳤습니다」 판정이 한 곳에 산다.',
  })
  @ApiOkResponse({ type: [MfbThreadDto] })
  @ApiConflictResponse({ description: 'code NOT_A_COMMENT | NOT_OWNER' })
  @ApiNotFoundResponse({ description: '코멘트 없음' })
  async reply(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MfbReplyWriteDto,
  ): Promise<MfbThreadDto[]> {
    return this.svc.reply(user.id, id, dto);
  }

  @Patch('marketing/feedback/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '답 고치기 — 자기가 쓴 글만 (원문 §60)' })
  @ApiOkResponse({ type: [MfbThreadDto] })
  @ApiConflictResponse({ description: 'code NOT_AUTHOR' })
  @ApiNotFoundResponse({ description: '글 없음' })
  async editPost(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MfbEditDto,
  ): Promise<MfbThreadDto[]> {
    return this.svc.editPost(user.id, id, dto);
  }

  /* ══ §62 기획 기한 · §65 기획 보고서 ═══════════════════════════════════ */

  @Get('plans/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '§65 기획 보고서 — 목표 · 과제 · 리서치 · 결정 요청',
    description: '단추가 열리는지도 서버가 정한다 — 원문 §61·§65 「대표는 기한을 먼저 승인해야 최종 승인이 열립니다」. 막힌 이유를 문장으로 함께 내려보낸다.',
  })
  @ApiOkResponse({ type: PlanDetailDto })
  @ApiNotFoundResponse({ description: '기획 없음' })
  async planDetail(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PlanDetailDto> {
    const out = await this.svc.planDetail(id, isRole(user.role) && canCeoApprovePlan(user.role));
    if (!out) throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: '기획을 찾을 수 없습니다' });
    return out;
  }

  @Post('plans/:id/due')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '기한 승인 · 반려 — 대표 전용 (원문 §65)',
    description: '반려는 기한을 지운다 — 승인 안 된 날짜가 §62 기한 표에 남으면 「대표를 지나오지 않은 마감」이 섞인다.',
  })
  @ApiOkResponse({ type: PlanDetailDto })
  @ApiConflictResponse({ description: 'code CEO_ONLY | NO_DUE | DUE_ALREADY_APPROVED' })
  @ApiNotFoundResponse({ description: '기획 없음' })
  async decidePlanDue(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PlanDueDecisionDto,
  ): Promise<PlanDetailDto> {
    return this.svc.decidePlanDue(user.id, isRole(user.role) && canCeoApprovePlan(user.role), id, dto);
  }

  @Post('plans/:id/review')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '최종 승인 · 보완 요청 — 기한이 먼저 승인돼야 열린다 (원문 §61·§65)',
    description: '화면이 단추를 숨기는 것과 별개로 서버가 막는다 (DUE_NOT_APPROVED).',
  })
  @ApiOkResponse({ type: PlanDetailDto })
  @ApiConflictResponse({ description: 'code DUE_NOT_APPROVED | NOT_REVIEWABLE | REASON_REQUIRED' })
  @ApiNotFoundResponse({ description: '기획 없음' })
  async reviewPlan(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PlanReviewDto,
  ): Promise<PlanDetailDto> {
    return this.svc.reviewPlan(user.id, isRole(user.role) && canCeoApprovePlan(user.role), id, dto);
  }
}
