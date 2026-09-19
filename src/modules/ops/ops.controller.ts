/** @file-guide
 * 목적: ops.controller.ts — OpsController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, canCeoApprovePlan, canCeoComment, hasPerm, isRole, type RequestUser } from '../../common/perm';
import {
  ComplaintCreateDto, ComplaintDto, ComplaintPatchDto,
  LeadCreateDto, LeadDto, LeadFailDto, LeadResumeDto, LeadStageMoveDto, LeadTouchWriteDto,
  MfbCommentWriteDto, MfbEditDto, MfbReplyWriteDto, MfbThreadDto, OpsDto,
  PlanDetailDto, PlanDueDecisionDto, PlanReviewDto,
  MeetingDetailDto, MeetingTaskCreateDto, MinutesWriteDto,
  MeetingCreateDto, MeetingCreateResultDto, OpsQueryDto, PlanCreateDto, PlanCreateResultDto,
} from './ops.dto';
import { OpsService } from './ops.service';
import { EnrollResultDto, LeadEnrollDto } from './enroll.dto';
import { LeadEnrollService } from './enroll.service';
import { TeacherChangeDto, TeacherChangeResultDto } from './teacher-change.dto';
import { TeacherChangeService } from './teacher-change.service';

@ApiTags('ops')
@Controller('ops')
export class OpsController {
  constructor(private readonly svc: OpsService, private readonly enrollSvc: LeadEnrollService, private readonly tcSvc: TeacherChangeService) {}

  @Get()
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '운영 — 상담 · 컴플레인 · 할 일 · 기획 · 회의 · 마케팅 · 건의',
    description: '§24 FQ는 leads의 name, school, ownerName, reason을 검색한다. 받은 목록의 클라이언트 검색/필터 전환 시 추가 GET은 0회이며 별도 검색 query 계약은 없다.',
  })
  @ApiOkResponse({ type: OpsDto })
  async all(@CurrentUser() user: RequestUser, @Query() query: OpsQueryDto): Promise<OpsDto> {
    return this.svc.all(
      user.id,
      isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms),
      isRole(user.role) && canCeoComment(user.role),
      query,
    );
  }

  /* ══ 「+ 회의 잡기」 · 「+ 기획 올리기」 (C96 · N-46 ① 나머지) ═══════════════ */

  @Post('meetings')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '§63 「+ 회의 잡기」 — 시간표에 회차를 만들고 그 회차에 회의를 건다',
    description:
      '시각·강의실·온라인을 MTREC 에 적지 않는다. SER(ONCE · kind=meeting · sub=회의 종류)를 한 트랜잭션에서 만들고 '
      + 'mtrec.ser_id 로 잇는다 — 그래야 「11:00–12:00」도 「1호」도 「온라인 TN」도 한 곳에서 나오고 '
      + '겹침을 ser_occ 의 EXCLUDE 가 막는다(C95 컨설팅 회차와 같은 길). '
      + '줌 계정은 기존 assignIn 이 붙이고 다시 투영해 그때 겹침이 판정된다. '
      + '참석자는 답하기 전까지 「응답 대기」(confirmed NULL · C57)이고 그것이 §63 의 「대기 4」다. '
      + '주관자는 시간표의 「강사」 자리라 그 사람이 겹치면 막힌다.',
  })
  @ApiCreatedResponse({ type: MeetingCreateResultDto })
  @ApiConflictResponse({ description: 'RESOURCE_CONFLICT(같은 시간에 주관자·강의실·줌) · BAD_RANGE · MEETING_PLACE' })
  createMeeting(@CurrentUser() user: RequestUser, @Body() dto: MeetingCreateDto): Promise<MeetingCreateResultDto> {
    return this.svc.createMeeting(user.id, dto);
  }

  @Post('plans')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '§61 「+ 기획 올리기」 — 언제나 첫 단계',
    description:
      '단계를 받지 않는다(올린 기획은 언제나 첫 단계 · 옮기는 길은 §61 보드와 결재다 — 화면이 정하면 전이표가 두 벌이 된다). '
      + '기한은 제안일 뿐이라 due_approved_at 은 비어 있고 대표가 승인해야 최종 승인이 열린다(C56).',
  })
  @ApiCreatedResponse({ type: PlanCreateResultDto })
  createPlan(@CurrentUser() user: RequestUser, @Body() dto: PlanCreateDto): Promise<PlanCreateResultDto> {
    return this.svc.createPlan(user.id, dto);
  }

  /* ══ 「+ 신규 문의」 · 단계 이동 · 접촉 기록 (C90 · N-45 · N-44 · A-01 · A-02 · A-03) ═══ */

  @Post('leads')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '「+ 신규 문의」 — 유입은 언제나 1차 상담 (C90 · 테스트 시나리오 A-01 · N-45)',
    description: '이름 · 학교 · 유입 경로(여섯 갈래 · lead_source_words CHECK) · 담당 · 첫 접촉 한 줄. 단계는 받지 않는다. 도달 기록(first)과 첫 접촉(적었으면)과 LOG 가 같은 트랜잭션.',
  })
  @ApiCreatedResponse({ type: LeadDto })
  @ApiConflictResponse({ description: 'code LEAD_NAME_REQUIRED | LEAD_SOURCE_INVALID' })
  @ApiNotFoundResponse({ description: 'STAFF_NOT_FOUND' })
  createLead(@CurrentUser() user: RequestUser, @Body() dto: LeadCreateDto): Promise<LeadDto> {
    return this.svc.createLead(user.id, dto);
  }

  @Patch('leads/:id/stage')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '단계 이동 — 전이표의 다음 단계로만 · 같은 트랜잭션에 도달 기록 (C90 · N-45 · A-02)',
    description: '받아 주는 값은 LeadDto.nextStages 다. 등록·등록 실패는 끝난 결과라 409 LEAD_LOCKED(등록은 enroll · 실패는 fail/resume). 전이표 밖은 409 LEAD_STAGE_INVALID(문장에 갈 수 있는 곳).',
  })
  @ApiOkResponse({ type: LeadDto })
  @ApiConflictResponse({ description: 'code LEAD_LOCKED | LEAD_STAGE_INVALID' })
  @ApiNotFoundResponse({ description: 'LEAD_NOT_FOUND' })
  moveLeadStage(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: LeadStageMoveDto): Promise<LeadDto> {
    return this.svc.moveLeadStage(user.id, id, dto);
  }

  @Post('leads/:id/touches')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '접촉 기록 한 줄 — 누가 · 언제 · 어떻게 · 한 줄 · 다음은 언제 (C90 · N-44 · A-03)',
    description: 'append-only. 상담 예약(book)의 nextOn 이 상담 날짜다 — 「상담 오늘·지남」 · 「사후 관리 임박·밀림」 은 마지막 접촉의 nextOn 으로 서버가 센다.',
  })
  @ApiCreatedResponse({ type: LeadDto })
  @ApiConflictResponse({ description: 'code LEAD_TOUCH_NOTE_REQUIRED | LEAD_TOUCH_KIND_INVALID' })
  @ApiNotFoundResponse({ description: 'LEAD_NOT_FOUND' })
  addLeadTouch(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: LeadTouchWriteDto): Promise<LeadDto> {
    return this.svc.addLeadTouch(user.id, id, dto);
  }

  @Post('leads/:id/fail')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '상담 실패 전이 — 이전 단계를 명시값으로 보존 (v2 §24 · N-25 §4-17 · C35)',
    description: 'fail_from 은 전이 순간의 실제 단계를 서버가 기록한다 — 추정이 아니라 사실이다. 도달 기록(append-only)에 failed 를 남긴다.',
  })
  @ApiCreatedResponse({ type: LeadDto })
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
  @ApiCreatedResponse({ type: LeadDto })
  @ApiConflictResponse({ description: 'code NOT_FAILED | UNCLASSIFIED' })
  @ApiNotFoundResponse({ description: '상담 건 없음' })
  async resumeLead(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LeadResumeDto,
  ): Promise<LeadDto> {
    return this.svc.resumeLead(user.id, id, dto);
  }

  /* ══ 등록 확정 (C91 · A-05) ═══════════════════════════════════════════════ */

  @Post('leads/:id/enroll/preview')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '등록 확정 미리보기 — 쓰기 0 (C91 · A-05 · A-06 · A-07)',
    description: '같은 트랜잭션을 끝까지 돌리고 되돌린다 — 겹침(409)·강사 불가 시간·첫 수업일·청구액이 실제와 같다. 화면이 짓지 않는다 (D-R37).',
  })
  @ApiCreatedResponse({ type: EnrollResultDto })
  @ApiConflictResponse({ description: 'code ALREADY_ENROLLED | LEAD_FAILED | STUDENT_DUPLICATE | STUDENT_SAME_NAME | 시간표 겹침 | MONTH_CLOSED' })
  @ApiNotFoundResponse({ description: 'LEAD_NOT_FOUND | STUDENT_NOT_FOUND | 교재 없음' })
  enrollPreview(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: LeadEnrollDto): Promise<EnrollResultDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.enrollSvc.preview(user.id, id, dto, canSee);
  }

  @Post('leads/:id/enroll')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '등록 확정 — 한 트랜잭션에 일곱 가지 (C91 · 테스트 시나리오 A-05)',
    description: 'STU(동명이인은 학년·학교로) → ENR → SER+SER_STU(시간표 쓰기 그대로 · 겹치면 409 로 전부 되돌린다) → 첫 달 청구서(§53 · 단가 없으면 건너뛰고 이유) '
      + '→ 교재 요청(wait) 또는 「교재 배정이 필요합니다」 알림 → 첫 수업 안내 초안 → 강사·관리자 알림 → LEAD enrolled + 도달 기록 + LOG.',
  })
  @ApiCreatedResponse({ type: EnrollResultDto })
  @ApiConflictResponse({ description: 'code ALREADY_ENROLLED | LEAD_FAILED | STUDENT_DUPLICATE | STUDENT_SAME_NAME | 시간표 겹침 | MONTH_CLOSED' })
  @ApiNotFoundResponse({ description: 'LEAD_NOT_FOUND | STUDENT_NOT_FOUND | 교재 없음' })
  enroll(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: LeadEnrollDto): Promise<EnrollResultDto> {
    const canSee = isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms);
    return this.enrollSvc.enroll(user.id, id, dto, canSee);
  }

  /* ══ §67 컴플레인 접수 · 처리 · 강사 교체 (C93 · J-96 · J-97 · J-98 · J-101 · N-46 ①) ═══ */

  @Post('complaints')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '「+ 접수」 — 접수는 언제나 received (C93 · 테스트 시나리오 J-96 · N-46 ①)',
    description: '갈래 · 학생 · 내용 · 담당 · 기한 · 심각도. 담당을 정했으면 그 사람에게 알림, LOG 는 같은 트랜잭션. 상태는 받지 않는다.',
  })
  @ApiCreatedResponse({ type: ComplaintDto })
  @ApiNotFoundResponse({ description: 'STUDENT_NOT_FOUND | STAFF_NOT_FOUND' })
  createComplaint(@CurrentUser() user: RequestUser, @Body() dto: ComplaintCreateDto): Promise<ComplaintDto> {
    return this.svc.createComplaint(user.id, dto);
  }

  @Patch('complaints/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '카드 처리 — 담당 · 단계 · 조치 · 결과 · 기한 · 심각도 (C93 · J-101)',
    description: '보낸 칸만 고친다. 대응(acting)은 담당이 있어야 하고 마무리(closed)는 결과가 있어야 한다 — 원본 §67 칸의 한 줄이 그렇게 말한다.',
  })
  @ApiOkResponse({ type: ComplaintDto })
  @ApiConflictResponse({ description: 'code CPL_OWNER_REQUIRED | CPL_RESULT_REQUIRED | EMPTY_PATCH' })
  @ApiNotFoundResponse({ description: 'CPL_NOT_FOUND | STAFF_NOT_FOUND' })
  patchComplaint(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ComplaintPatchDto): Promise<ComplaintDto> {
    return this.svc.patchComplaint(user.id, id, dto);
  }

  @Post('teacher-change/preview')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '강사 교체 미리보기 — 쓰기 0 (C93 · J-97 · D-46 · N-132)',
    description: '같은 트랜잭션을 끝까지 돌리고 되돌린다 — 겹침(409)·불가 시간·옮겨 갈 회차·정산 달이 실제와 같다. 화면이 짓지 않는다 (D-R37).',
  })
  @ApiCreatedResponse({ type: TeacherChangeResultDto })
  @ApiConflictResponse({ description: '시간표 겹침 RESOURCE_CONFLICT | MONTH_CLOSED' })
  @ApiNotFoundResponse({ description: 'STAFF_NOT_FOUND | CPL_NOT_FOUND' })
  teacherChangePreview(@CurrentUser() user: RequestUser, @Body() dto: TeacherChangeDto): Promise<TeacherChangeResultDto> {
    return this.tcSvc.preview(user.id, dto);
  }

  @Post('teacher-change')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '강사 교체 — 여섯 단계를 한 트랜잭션에 (C93 · 테스트 시나리오 J-97 · D-46 · N-132 · D-45 · F-62)',
    description: '스케줄(규칙마다 기존 patch · day=이번만 · from=그 날부터 규칙을 가른다) → 안내 초안(GUIDE teacher_change) → 학부모 안내(PNOTI · 보낼 것) '
      + '→ 교재 확인(읽기) → 정산 시수(회차가 옮겨 가므로 시트가 따라온다 · 확정된 달은 알린다) → 새 강사·원래 강사·관리자 알림 → 컴플레인이면 teacher_changed + 대응. 겹치면 전부 되돌린다.',
  })
  @ApiCreatedResponse({ type: TeacherChangeResultDto })
  @ApiConflictResponse({ description: '시간표 겹침 RESOURCE_CONFLICT | MONTH_CLOSED' })
  @ApiNotFoundResponse({ description: 'STAFF_NOT_FOUND | CPL_NOT_FOUND' })
  teacherChange(@CurrentUser() user: RequestUser, @Body() dto: TeacherChangeDto): Promise<TeacherChangeResultDto> {
    return this.tcSvc.apply(user.id, dto);
  }

  /* ══ §60 대표 피드백 ═══════════════════════════════════════════════════ */

  @Post('marketing/:id/comments')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '대표 코멘트 — 관리자 전원에게 알림 (원문 §60)',
    description: '「대표가 코멘트를 남기면 관리자 전원에게 알림이 갑니다」. 쓸 때의 종류를 kind 로 적는다 — 쓴 사람의 지금 역할로 되짚지 않는다.',
  })
  @ApiCreatedResponse({ type: [MfbThreadDto] })
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
  @ApiCreatedResponse({ type: [MfbThreadDto] })
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
  @ApiCreatedResponse({ type: PlanDetailDto })
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
  @ApiCreatedResponse({ type: PlanDetailDto })
  @ApiConflictResponse({ description: 'code DUE_NOT_APPROVED | NOT_REVIEWABLE | REASON_REQUIRED' })
  @ApiNotFoundResponse({ description: '기획 없음' })
  async reviewPlan(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PlanReviewDto,
  ): Promise<PlanDetailDto> {
    return this.svc.reviewPlan(user.id, isRole(user.role) && canCeoApprovePlan(user.role), id, dto);
  }

  /* ══ §66 회의 상세 ═════════════════════════════════════════════════════ */

  @Get('meetings/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '§66 회의 상세 — 참석 · 사전 자료 · 속기록 · 할 일',
    description: '참석은 세 값이다 — 아직 답 안 함(null) · 참석 · 불참. null 을 false 로 접지 않는다.',
  })
  @ApiOkResponse({ type: MeetingDetailDto })
  @ApiNotFoundResponse({ description: '회의 없음' })
  async meetingDetail(@Param('id', ParseIntPipe) id: number): Promise<MeetingDetailDto> {
    const out = await this.svc.meetingDetail(id);
    if (!out) throw new NotFoundException({ code: 'MEETING_NOT_FOUND', message: '회의를 찾을 수 없습니다' });
    return out;
  }

  @Post('meetings/:id/minutes')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '속기록 저장 — 누가 언제 저장했는지 서버가 남긴다 (원문 §66)',
    description: '화면이 보낸 시각을 믿지 않는다. 시계가 틀린 기계에서 저장하면 회의록의 순서가 뒤집힌다.',
  })
  @ApiCreatedResponse({ type: MeetingDetailDto })
  @ApiNotFoundResponse({ description: '회의 없음' })
  async writeMinutes(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MinutesWriteDto,
  ): Promise<MeetingDetailDto> {
    return this.svc.writeMinutes(user.id, id, dto);
  }

  @Post('meetings/:id/todos')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '할 일 배정 — TODO 와 담당자 알림을 한 트랜잭션에서 (원문 §66 연동)',
    description: '밖에서 알림을 보내면 할 일은 안 만들어졌는데 알림만 가서 받은 사람이 자기 목록에서 그것을 못 찾는다 (D-R43).',
  })
  @ApiCreatedResponse({ type: MeetingDetailDto })
  @ApiNotFoundResponse({ description: '회의 없음 · 담당자 없음' })
  async assignMeetingTask(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MeetingTaskCreateDto,
  ): Promise<MeetingDetailDto> {
    return this.svc.assignMeetingTask(user.id, id, dto);
  }
}
