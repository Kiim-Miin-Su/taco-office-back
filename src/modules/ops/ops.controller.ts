/** @file-guide
 * 목적: ops.controller.ts — OpsController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, canCeoApprovePlan, canCeoComment, hasPerm, isRole, type RequestUser } from '../../common/perm';
import {
  ComplaintCreateDto, ComplaintDto, ComplaintPatchDto,
  LeadCreateDto, LeadDto, LeadFailDto, LeadPatchDto, LeadResumeDto, LeadStageMoveDto, LeadTouchWriteDto,
  MfbCommentWriteDto, MfbEditDto, MfbReplyWriteDto, MfbThreadDto, OpsDto,
  PlanDetailDto, PlanDueDecisionDto, PlanPatchDto, PlanReviewDto, PlanStageMoveDto,
  MeetingAttendDto, MeetingDetailDto, MeetingNoticeResultDto, MeetingTaskCreateDto, MinutesWriteDto,
  MeetingCreateDto, MeetingCreateResultDto, OpsQueryDto, PlanCreateDto, PlanCreateResultDto, PlanTaskCreateDto,
  MarketingCreateDto, MarketingDto,
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
      // 지정 공개 기획을 볼 수 있는 셋 중 하나 — 결재권자(대표 판정 · N-72). 보고서·결재와 같은 판정이다
      isRole(user.role) && canCeoApprovePlan(user.role),
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

  @Patch('leads/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '문의 핵심정보 수정 — 이름 · 학교 · 유입 경로 · 담당 · 학년',
    description: '카드 머리의 사실만 바꾼다. 단계·접촉·진단·배치·등록 정보는 각 전용 경로를 사용하며, 바꾸기 전후는 LOG에 같은 트랜잭션으로 남긴다.',
  })
  @ApiOkResponse({ type: LeadDto })
  @ApiConflictResponse({ description: 'code EMPTY_PATCH | LEAD_NAME_REQUIRED' })
  @ApiNotFoundResponse({ description: 'LEAD_NOT_FOUND | STAFF_NOT_FOUND' })
  patchLead(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: LeadPatchDto): Promise<LeadDto> {
    return this.svc.patchLead(user.id, id, dto);
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
    summary: '상담 실패 전이 — 이전 단계를 명시값으로 보존 (v2 §24 · N-25 §4-17 · C35 · W11 N-87)',
    description: 'fail_from 은 전이 순간의 실제 단계를 서버가 기록한다 — 추정이 아니라 사실이다. 그 단계가 곧 §24 중단 지점이다(중단 지점을 묻지 않는다 · 옛 stop_at 은 건드리지 않는다). '
      + '상담 건을 잠그고 단계를 다시 본다 — 등록 확정과 겹치면 뒤에 온 쪽이 409 다(등록된 건이 실패로 덮이지 않는다). 도달 기록(append-only)에 failed 를 남긴다. '
      + 'nextOn 이 있으면 같은 트랜잭션에 메모 접촉 한 줄을 남겨 실패만 저장되는 부분 성공을 막는다(A-08).',
  })
  @ApiCreatedResponse({ type: LeadDto })
  @ApiConflictResponse({ description: 'code ALREADY_FAILED | ENROLLED_LOCKED | LEAD_STAGE_CHANGED' })
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
    description: '레거시(stop_at 만 있는) 건은 추정하지 않는다 — 미분류로 거절하고 단계 지정을 요구한다 (N-25). 옛 stop_at 은 읽기 전용 기록이라 지우지 않는다 (W11 N-87). '
      + '상담 건을 잠그고 실패인지 다시 본다 — 「바로 수업 등록」과 겹치면 뒤에 온 쪽이 409 NOT_FAILED 다.',
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
  @ApiConflictResponse({ description: 'code ALREADY_ENROLLED | STUDENT_DUPLICATE | STUDENT_SAME_NAME | 시간표 겹침 | MONTH_CLOSED — 등록 실패 건도 되살리기 없이 바로 등록한다(원본 §24 「바로 수업 등록」 · 실패 이력은 도달 기록·LOG 에 남는다)' })
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
  @ApiConflictResponse({ description: 'code ALREADY_ENROLLED | STUDENT_DUPLICATE | STUDENT_SAME_NAME | 시간표 겹침 | MONTH_CLOSED — 등록 실패 건도 되살리기 없이 바로 등록한다(원본 §24 「바로 수업 등록」 · 실패 이력은 도달 기록·LOG 에 남는다)' })
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
    // 「수강 종료 · 환불」 단추가 서는지는 돈 권한이 정한다 — 목록 응답과 같은 값이어야 한다 (S5)
    return this.svc.createComplaint(user.id, isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms), dto);
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
    return this.svc.patchComplaint(user.id, isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms), id, dto);
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

  /* ══ §59 「+ 오늘 한 것」 (x5 · g6 59-3) ═══════════════════════════════ */

  @Post('marketing')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '§59 「+ 오늘 한 것」 — 마케팅 활동 한 줄 · URL 첨부',
    description:
      '날짜를 안 주면 오늘, 담당을 안 주면 나다. 채널·항목은 지금 코드 일곱·일곱이다(원문 어휘 맞춤은 열린 결정 N-29 ①). '
      + '그만둔 사람은 담당이 될 수 없다. 응답은 GET /ops 의 marketing 줄과 같은 모양이다. 감사 줄(LOG MKT create)이 같은 트랜잭션이다.',
  })
  @ApiCreatedResponse({ type: MarketingDto })
  @ApiConflictResponse({ description: 'code MKT_TITLE_REQUIRED | MKT_WORD_UNKNOWN' })
  @ApiNotFoundResponse({ description: 'STAFF_NOT_FOUND — 담당이 없거나 그만둔 사람' })
  createMarketing(@CurrentUser() user: RequestUser, @Body() dto: MarketingCreateDto): Promise<MarketingDto> {
    return this.svc.createMarketing(user.id, isRole(user.role) && hasPerm(user.role, 'canMoney', user.perms), dto);
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
    summary: '담당자 답변 · 보류 — 코멘트를 쓴 대표에게만 알림 (원문 §60)',
    description: '「담당자 답변은 대표에게만」. 어느 코멘트에 대한 답인지 parentId 로 들고 있어야 「고쳤습니다」 판정이 한 곳에 산다. '
      + 'kind=hold 는 「보류」(W11 N-29 ③) — 카드는 「확인 필요」로 남고 코멘트마다 한 번이다.',
  })
  @ApiCreatedResponse({ type: [MfbThreadDto] })
  @ApiConflictResponse({ description: 'code NOT_A_COMMENT | NOT_OWNER | MFB_ALREADY_HELD | MFB_ALREADY_FIXED' })
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
    const out = await this.svc.planDetail(id, isRole(user.role) && canCeoApprovePlan(user.role), user.id);
    if (!out) throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: '기획을 찾을 수 없습니다' });
    return out;
  }

  @Patch('plans/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '§65 본문 고치기 — 목표 · 리서치 · 결정 요청 · 제목 · 기한 (S6)',
    description:
      'research 를 쓰는 길은 이것뿐이다 — 그전에는 읽기와 화면 칸만 있고 시드 말고는 아무도 못 채워 §65 「3 · 리서치」가 영원히 「—」였다. '
      + '보낸 칸만 고친다(null 은 지우고 없는 키는 그대로 둔다). 고칠 수 있는 단계는 draft·rework 뿐이고 막힌 문장은 읽기의 editBlockedReason 과 같다. '
      + '기한은 승인 전에만 바꾼다 — 승인된 날짜를 담당이 옮기면 대표의 승인이 거짓이 된다. '
      + '공개 범위(share · pickIds · W11 N-72)는 본문이 아니라 단계와 무관하게 바꾸고, 담당 · 결재권자만 바꾼다(감사 줄 PLAN · share). '
      + '새 기한을 내면 반려 표시(dueRejectedOn)가 빈다(N-95).',
  })
  @ApiOkResponse({ type: PlanDetailDto })
  @ApiConflictResponse({ description: 'code PLAN_LOCKED | PLAN_DUE_APPROVED | PLAN_TITLE_REQUIRED | PLAN_PICK_NOT_PICKED | PLAN_SHARE_REQUIRED' })
  @ApiForbiddenResponse({ description: 'PLAN_SHARE_FORBIDDEN — 공개 범위는 담당 · 결재권자만' })
  @ApiNotFoundResponse({ description: 'PLAN_NOT_FOUND (보이지 않는 기획 포함) · STAFF_NOT_FOUND' })
  async patchPlan(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PlanPatchDto,
  ): Promise<PlanDetailDto> {
    return this.svc.patchPlan(user.id, isRole(user.role) && canCeoApprovePlan(user.role), id, dto);
  }

  @Patch('plans/:id/stage')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '§61 단계 이동 — 왼쪽에서 오른쪽으로 올립니다 (S6)',
    description:
      "stage='review' 로 가는 길이 여기서 처음 생긴다 — 그전에는 createPlan(draft)과 reviewPlan(approved|rework) 둘뿐이라 API 로 만든 기획은 §69 「결재 대기」에 영영 안 잡혔다. "
      + '전이표(PLAN_NEXT_STAGES)는 draft·rework → review · approved → done 이고 **결재는 여기 없다**(:id/review 가 자기 결재 금지·기한 승인 선행·사유 필수를 지나서 옮긴다). '
      + '다시 올리면 지난 보완 요청 사유를 지운다.',
  })
  @ApiOkResponse({ type: PlanDetailDto })
  @ApiConflictResponse({ description: 'code PLAN_STAGE_LOCKED | PLAN_STAGE_INVALID' })
  @ApiNotFoundResponse({ description: 'PLAN_NOT_FOUND' })
  async movePlanStage(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PlanStageMoveDto,
  ): Promise<PlanDetailDto> {
    return this.svc.movePlanStage(user.id, isRole(user.role) && canCeoApprovePlan(user.role), id, dto);
  }

  @Post('plans/:id/due')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '기한 승인 · 반려 — 대표 전용 (원문 §65)',
    description: '반려는 기한을 지운다 — 승인 안 된 날짜가 §62 기한 표에 남으면 「대표를 지나오지 않은 마감」이 섞인다. '
      + '반려된 날짜 · 순간 · 사람은 행에 남는다(N-95 · §61 「기한 반려」 칩). '
      + '**대표가 본 날짜(dueOn)를 함께 보낸다** — 서버가 행을 잠그고 지금 날짜가 다르면 409 PLAN_DUE_CHANGED(본 적 없는 날짜에 도장이 찍히지 않는다 · PB-12-2).',
  })
  @ApiCreatedResponse({ type: PlanDetailDto })
  @ApiConflictResponse({ description: 'code CEO_ONLY | NO_DUE | DUE_ALREADY_APPROVED | PLAN_DUE_CHANGED' })
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
    description: '화면이 단추를 숨기는 것과 별개로 서버가 막는다 (DUE_NOT_APPROVED). '
      + '행을 잠근 채 판정하고 검토 요청 단계일 때만 쓴다 — 동시에 들어온 결재가 먼저 커밋된 결재를 덮지 않는다(PB-12-2).',
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

  @Post('plans/:id/tasks')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '§65 「+ 대표 지시」 — 기획에 과제(TODO) 한 줄 · 담당 알림 · 감사 줄을 한 트랜잭션에서 (w5 · 65-4)',
    description:
      '과제는 TODO(src=plan · plan_id) 한 줄이다 — §62 기한 표·§61 「과제 N/M」·§64 할 일이 같은 줄을 읽는다. '
      + '기획 결재 권한이 있어야 하고 끝난 기획에는 더하지 않는다. 막힌 문장은 읽기의 addTaskBlockedReason 과 같다.',
  })
  @ApiCreatedResponse({ type: PlanDetailDto })
  @ApiConflictResponse({ description: 'code CEO_ONLY | PLAN_DONE | TASK_TITLE_REQUIRED' })
  @ApiNotFoundResponse({ description: 'PLAN_NOT_FOUND · STAFF_NOT_FOUND' })
  async addPlanTask(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PlanTaskCreateDto,
  ): Promise<PlanDetailDto> {
    return this.svc.addPlanTask(user.id, isRole(user.role) && canCeoApprovePlan(user.role), id, dto);
  }

  /* ══ §66 회의 상세 ═════════════════════════════════════════════════════ */

  /** 운영 화면 권한 — `@Perm('canAdminPage', 'canCrudAll')` 과 같은 판정(역할을 직접 견주지 않는다 · D-R39) */
  private static canManage(user: RequestUser): boolean {
    return isRole(user.role) && hasPerm(user.role, 'canAdminPage', user.perms) && hasPerm(user.role, 'canCrudAll', user.perms);
  }

  // 이 경로에는 @Perm 이 없다 — 참석자 본인(강사 포함)이 안내 알림을 받고 여는 곳이다(N-32). 거르기는 서비스가 한다(별도 가드)
  @Get('meetings/:id')
  @ApiOperation({
    summary: '§66 회의 상세 — 참석 · 사전 자료 · 속기록 · 할 일',
    description: '참석은 세 값이다 — 아직 답 안 함(null) · 참석 · 불참. null 을 false 로 접지 않는다. '
      + '운영 권한(canAdminPage · canCrudAll)이 없어도 **참석자 본인**은 연다(W11 · N-32 · 「안내 보내기」 알림 링크가 오는 곳) — '
      + '둘 다 아니면 없는 것과 같다(404). 고치기 · 안내 · 내 응답 단추가 서는지는 canEdit · canSendNotice · canRespond 가 말한다.',
  })
  @ApiOkResponse({ type: MeetingDetailDto })
  @ApiNotFoundResponse({ description: '회의 없음 · 운영 권한도 없고 참석자도 아님' })
  async meetingDetail(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<MeetingDetailDto> {
    const out = await this.svc.meetingDetail(id, { id: user.id, canManage: OpsController.canManage(user) });
    if (!out) throw new NotFoundException({ code: 'MEETING_NOT_FOUND', message: '회의를 찾을 수 없습니다' });
    return out;
  }

  @Post('meetings/:id/notice')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '§66 「안내 보내기」 — 참석자(직원)에게 알림 한 건씩 (W11 · N-32)',
    description: '본문은 서버가 사실로만 조립한다 — 회의 이름 · 일시 · 강의실 또는 줌 계정 · 참가 링크. 줌 비밀번호는 넣지 않는다. '
      + '보내는 사람 · 그만둔 사람에게는 보내지 않는다. 알림 링크는 이 회의 상세이고, 받은 사람이 거기서 참석 · 불참을 누른다.',
  })
  @ApiCreatedResponse({ type: MeetingNoticeResultDto })
  @ApiNotFoundResponse({ description: '회의 없음' })
  @ApiConflictResponse({ description: 'MEETING_NOTICE_BLOCKED — 취소된 회의 · 받을 참석자 없음(문장은 noticeBlockedReason 과 같다)' })
  sendMeetingNotice(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<MeetingNoticeResultDto> {
    return this.svc.sendMeetingNotice(user.id, id);
  }

  // @Perm 이 없다 — 참석자면 역할과 무관하다(강사 참석자 포함 · N-32). 「참석자 본인인가」는 서비스가 본다(별도 가드)
  @Post('meetings/:id/attend')
  @ApiOperation({
    summary: '§66 참석 응답 — 본인이 자기 줄만 참석 · 불참 (W11 · N-32)',
    description: '대리 입력은 없다 — 보낸 사람 자신의 참석 줄만 바뀐다. 날이 지나도 답하지 않은 줄은 「응답 대기」 그대로다.',
  })
  @ApiCreatedResponse({ type: MeetingDetailDto })
  @ApiNotFoundResponse({ description: '회의 없음 · 운영 권한도 없고 참석자도 아님' })
  @ApiForbiddenResponse({ description: 'MEETING_NOT_ATTENDEE — 운영 권한은 있지만 참석자로 적히지 않음' })
  respondMeeting(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MeetingAttendDto,
  ): Promise<MeetingDetailDto> {
    return this.svc.respondMeeting({ id: user.id, canManage: OpsController.canManage(user) }, id, dto.confirmed);
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
