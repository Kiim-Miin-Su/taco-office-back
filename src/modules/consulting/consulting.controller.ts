/** @file-guide
 * 목적: consulting.controller.ts — ConsultingController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse, ApiNoContentResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, canCeoApproveConsultingClose, hasPerm, isRole, type RequestUser } from '../../common/perm';
import {
  ConsAccountingDto, ConsAccountRowDto, ConsCloseDto, ConsCloseResultDto, ConsItemDto, ConsItemsEditDto, ConsItemToggleDto,
  ConsPaymentCreateDto, ConsSessionCreateDto, ConsSessionsResultDto, ConsSessionWriteDto, ConsStudentsDto, ConsToInvoiceDto, ConsultingCreateDto,
  ConsultingDetailDto, ConsultingFeedbackCreateDto, ConsultingFeedbackDto, ConsultingFileDto,
  ConsultingFileCreateDto, ConsultingListDto, ConsultingPatchDto, ConsultingSessionDto, ConsultingShareUpdateDto,
} from './consulting.dto';

/** 예외 종료 승인 권한 — 판정은 perm.ts 한 줄(ceoGate 계열)이다. 역할 문자열을 여기서 비교하지 않는다 (D-R39 · N-18-a) */
const approveClose = (user: RequestUser): boolean => isRole(user.role) && canCeoApproveConsultingClose(user.role);
import { ConsultingSessionService } from './consulting-session.service';
import { ConsultingService } from './consulting.service';

@ApiTags('consulting')
@Controller('consulting')
export class ConsultingController {
  constructor(private readonly svc: ConsultingService, private readonly sessions: ConsultingSessionService) {}

  @Post()
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    operationId: 'create',
    summary: '컨설팅 시작 — §29',
    description: 'stage=contract, contractStep=1은 서버가 정한다. amount는 이 계약 작성 화면의 입력값이며 생성 권한은 canMoney와 분리한다.',
  })
  @ApiCreatedResponse({ type: ConsultingDetailDto })
  @ApiConflictResponse({ description: 'code CONS_PICK_REQUIRED · CONS_PICK_FORBIDDEN · CONS_DATE_ORDER' })
  async create(@CurrentUser() user: RequestUser, @Body() dto: ConsultingCreateDto): Promise<ConsultingDetailDto> {
    const canMoney = isRole(user.role) ? hasPerm(user.role, 'canMoney', user.perms) : false;
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.create(user.id, canMoney, canHide, dto);
  }

  @Get()
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '컨설팅 — 단계 보드 · 목록 · 회차 기록 (§26 · §27 · §31)',
    description: '최종 canAdminPage와 canCrudAll이 모두 필요하다. 공개 범위로 투영된 items의 stage(contract/running/done)를 클라이언트에서 필터링하며 추가 GET은 0이다. 전체/단계 건수는 같은 items에서 파생하고 금액·상세 공개 권한을 변경하지 않는다.',
  })
  @ApiOkResponse({ type: ConsultingListDto })
  async all(@CurrentUser() user: RequestUser): Promise<ConsultingListDto> {
    // 역할이 없으면 볼 것도 없다 — 칸 이름까지 내려보내지 않는다
    if (!isRole(user.role)) return { items: [], canSeeAmounts: false, canSetPrivate: false, stages: [] };
    const canHide = hasPerm(user.role, 'canHide', user.perms); // §76 — 비공개 컨설팅 열람
    return this.svc.all(
      user.id,
      hasPerm(user.role, 'canMoney', user.perms),
      canHide,
      await this.svc.consultingLineShown(canHide), // N-94 컨설팅 비공개 — 줄 금액
    );
  }

  @Patch(':id/items/:itemId')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '진행 항목 체크/해제 — 47D-B 유일 쓰기 (N-18 §4-17)',
    description: '공개 범위(csCanFull)·종료 잠금은 서버가 판정한다. 진행률 숫자는 저장하지 않는다 — 원장 행만 바뀐다.',
  })
  @ApiOkResponse({ type: ConsItemDto })
  @ApiForbiddenResponse({ description: '내용이 공개 범위 밖 (수납만 공개 등)' })
  @ApiNotFoundResponse({ description: '보이지 않는 건·없는 항목 — 존재를 누출하지 않는다' })
  @ApiConflictResponse({ description: 'code ITEM_LOCKED — 종료된 건' })
  async toggleItem(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: ConsItemToggleDto,
  ): Promise<ConsItemDto> {
    // @Perm 가드가 매니저 이상을 이미 보장한다 — isRole 은 타입 좁힘용이다 (all() 과 같은 규약)
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.toggleItem(user.id, canHide, id, itemId, dto);
  }

  /* ══ W11 · 원문 §31 「항목 수정」 · 항목 「파일」 (N-18-a · N-63) ═══════════════════════════════ */

  @Patch(':id/items')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '항목 수정 — 더하기 · 이름 바꾸기 · 빼기 (원문 §31 · N-18-a DQ5 대안)',
    description:
      '바꾸는 것만 보낸다(목록 통째가 아니다). 더한 항목은 source=manual · 맨 뒤 순번. 끝낸 항목 · 기본 항목 빼기 · 파일이 붙은 항목 빼기는 409. '
      + '건의 활동 원장(cons_event)과 감사 원장(log · 앞뒤 목록)에 같은 트랜잭션으로 남는다. 9유형 기본 항목표는 넣지 않는다(보류).',
  })
  @ApiOkResponse({ type: [ConsItemDto], description: '바뀐 뒤의 항목 전부(순번 차례)' })
  @ApiForbiddenResponse({ description: '내용이 공개 범위 밖' })
  @ApiNotFoundResponse({ description: '보이지 않는 건 · CONS_ITEM_NOT_FOUND' })
  @ApiConflictResponse({ description: 'code ITEM_LOCKED · CONS_ITEM_DONE · CONS_ITEM_TEMPLATE · CONS_ITEM_HAS_FILES · CONS_ITEM_LIMIT · EMPTY_PATCH (400 CONS_ITEM_DUPLICATE · CONS_ITEM_OP_DUPLICATE · CONS_ITEM_LABEL_REQUIRED)' })
  async editItems(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ConsItemsEditDto): Promise<ConsItemDto[]> {
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.editItems(user.id, canHide, id, dto);
  }

  @Post(':id/items/:itemId/files')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '항목 파일 올리기 — 항목마다 최대 6개 (N-63 · 계약 파일 10개와 따로 센다)',
    description: '계약 파일과 같은 업로드(base64 · 3MB)와 같은 권한 판정(공개 범위 csCanFull). 종료된 건은 409.',
  })
  @ApiCreatedResponse({ type: ConsultingFileDto })
  @ApiNotFoundResponse({ description: '보이지 않는 건 · CONS_ITEM_NOT_FOUND' })
  @ApiConflictResponse({ description: 'code ITEM_LOCKED · CONS_ITEM_FILE_LIMIT' })
  async addItemFile(
    @CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Param('itemId', ParseIntPipe) itemId: number, @Body() dto: ConsultingFileCreateDto,
  ): Promise<ConsultingFileDto> {
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.addItemFile(user.id, canHide, id, itemId, dto);
  }

  @Delete(':id/items/:itemId/files/:fileId')
  @Perm('canAdminPage', 'canCrudAll')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '항목 파일 빼기 — 종료 전 건만 · 감사 원장에 남는다 (N-63 · N-73)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'CONS_ITEM_FILE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'code ITEM_LOCKED' })
  async removeItemFile(
    @CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number, @Param('fileId', ParseIntPipe) fileId: number,
  ): Promise<void> {
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.removeItemFile(user.id, canHide, id, itemId, fileId);
  }

  /* ══ §28 컨설팅 회계 ═══════════════════════════════════════════════════ */

  @Get('accounting')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '컨설팅 회계 — 계약 금액 · 받은 돈 · 남은 돈 (§28)',
    description:
      '머리 세 칸과 줄의 「남음」을 **서버가 뺀다** (D-R37). 화면이 계약 − 받음을 다시 하면 가려진 줄에서 합계가 갈린다. '
      + "원문 규칙 「수납만 공개(vis='pay')여도 이 화면의 금액은 보입니다」는 새 판정이 아니라 csCanAmount 그대로다.",
  })
  @ApiOkResponse({ type: ConsAccountingDto })
  async accounting(@CurrentUser() user: RequestUser): Promise<ConsAccountingDto> {
    if (!isRole(user.role)) return { items: [], totalAmount: null, totalPaid: null, totalDue: null, canSeeAmounts: false };
    const canHide = hasPerm(user.role, 'canHide', user.perms);
    return this.svc.accounting(
      user.id,
      hasPerm(user.role, 'canMoney', user.perms),
      canHide,
      await this.svc.consultingLineShown(canHide), // N-94 — 줄 금액만 가리고 머리 합계는 그대로
    );
  }


  @Get('students')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '컨설팅 학생별 — CONS 를 학생 기준으로 재구성 (§27)',
    description:
      '원문 규칙 「**csCan() 으로 볼 수 있는 것만 집계합니다**」 그대로다 — 안 보이는 건은 건수에도 합계에도 안 들어간다. '
      + '기록 회차·끝낸 항목·받은 돈·건수를 **서버가 센다** (D-R37). 화면이 배열 길이를 세면 내용이 잠긴 건에서 「항목 0/0」이 된다. '
      + '한 건에 학생이 여럿이면 그 학생들 모두의 줄에 걸린다(슬라이드 29 「학생 여러 명」).',
  })
  @ApiOkResponse({ type: ConsStudentsDto })
  async students(@CurrentUser() user: RequestUser): Promise<ConsStudentsDto> {
    if (!isRole(user.role)) return { items: [], canSeeAmounts: false };
    const canHide = hasPerm(user.role, 'canHide', user.perms);
    return this.svc.students(
      user.id,
      hasPerm(user.role, 'canMoney', user.perms),
      canHide,
      await this.svc.consultingLineShown(canHide), // N-94 컨설팅 비공개 — 건 · 학생 줄 금액
    );
  }

  @Get(':id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ operationId: 'detail', summary: '계약 5단계 상세 — §30' })
  @ApiOkResponse({ type: ConsultingDetailDto })
  async detail(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<ConsultingDetailDto> {
    const canMoney = isRole(user.role) ? hasPerm(user.role, 'canMoney', user.perms) : false;
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.detail(user.id, canMoney, canHide, id, approveClose(user), await this.svc.consultingLineShown(canHide));
  }

  @Patch(':id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    operationId: 'updateCore',
    summary: '계약 핵심정보 수정 — 계약 작업 전',
    description: '계약 1단계에서만 학생 · 요청자 · 담당 · 금액 · 약정 회차 · 기간을 바꾼다. 종류는 기본 항목과 결합되어 있고 공개 범위는 전용 PATCH가 있으므로 받지 않는다. 전후 값은 LOG에 남긴다.',
  })
  @ApiOkResponse({ type: ConsultingDetailDto })
  @ApiConflictResponse({ description: 'code CONS_CORE_LOCKED | CONS_DATE_ORDER | EMPTY_PATCH' })
  @ApiNotFoundResponse({ description: '컨설팅 건 · 담당 없음' })
  async updateCore(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ConsultingPatchDto): Promise<ConsultingDetailDto> {
    const canMoney = isRole(user.role) ? hasPerm(user.role, 'canMoney', user.perms) : false;
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.updateCore(user.id, canMoney, canHide, id, dto);
  }

  @Patch(':id/share')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ operationId: 'updateShare', summary: '계약 공개 범위 변경 — §29·§30' })
  @ApiOkResponse({ type: ConsultingDetailDto })
  async updateShare(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ConsultingShareUpdateDto): Promise<ConsultingDetailDto> {
    const canMoney = isRole(user.role) ? hasPerm(user.role, 'canMoney', user.perms) : false;
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.updateShare(user.id, canMoney, canHide, id, dto);
  }

  @Post(':id/contract-files')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ operationId: 'addContractFile', summary: '계약서 초안/수정본 추가 — §30, 전체 파일 최대 10개' })
  @ApiCreatedResponse({ type: ConsultingFileDto })
  async addContractFile(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ConsultingFileCreateDto): Promise<ConsultingFileDto> {
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.addContractFile(user.id, canHide, id, dto);
  }

  @Delete(':id/contract-files/:fileId')
  @Perm('canAdminPage', 'canCrudAll')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ operationId: 'removeContractFile', summary: '계약서 초안/수정본 제거 — §30' })
  @ApiNoContentResponse()
  async removeContractFile(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Param('fileId', ParseIntPipe) fileId: number): Promise<void> {
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.removeContractFile(user.id, canHide, id, fileId);
  }

  @Post(':id/feedback')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ operationId: 'addFeedback', summary: '계약서 피드백 추가 — §30' })
  @ApiCreatedResponse({ type: ConsultingFeedbackDto })
  async addFeedback(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ConsultingFeedbackCreateDto): Promise<ConsultingFeedbackDto> {
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.addFeedback(user.id, canHide, id, dto);
  }

  @Post(':id/feedback/:feedbackId/resolve')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ operationId: 'markFeedbackResolved', summary: '피드백 수정 완료 표시 — §30' })
  @ApiCreatedResponse({ type: ConsultingFeedbackDto })
  async markFeedbackResolved(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Param('feedbackId', ParseIntPipe) feedbackId: number): Promise<ConsultingFeedbackDto> {
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.markFeedbackResolved(user.id, canHide, id, feedbackId);
  }

  @Post(':id/deliver')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ operationId: 'deliverContract', summary: '학부모 전달 완료 기록 — §30' })
  @ApiCreatedResponse({ type: ConsultingDetailDto })
  async deliverContract(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<ConsultingDetailDto> {
    const canMoney = isRole(user.role) ? hasPerm(user.role, 'canMoney', user.perms) : false;
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.deliverContract(user.id, canMoney, canHide, id);
  }

  @Post(':id/signed-files')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ operationId: 'addSignedFile', summary: '학부모 서명본 등록 — §30' })
  @ApiCreatedResponse({ type: ConsultingFileDto })
  async addSignedFile(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ConsultingFileCreateDto): Promise<ConsultingFileDto> {
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.addSignedFile(user.id, canHide, id, dto);
  }

  @Delete(':id')
  @Perm('canAdminPage', 'canCrudAll')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'archive',
    summary: '컨설팅 안전 보관 — 물리 삭제 없음',
    description: '받은 돈 · 살아 있는 전환 청구서 · 회차 기록이 있으면 409 CONS_ARCHIVE_BLOCKED(PB-11 · 상세의 archiveBlockedReason 과 같은 문장). 지운 것은 감사 원장에 남는다.',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'code CONS_ARCHIVE_BLOCKED' })
  async archive(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number): Promise<void> {
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.archive(user.id, canHide, id);
  }

  /* ══ C95 · §31 회차 · 종료 (테스트 시나리오 I-91 · I-95 · N-18 채택) ═══════════════════════════════ */

  @Post(':id/sessions/preview')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '회차 잡기 미리보기 — 같은 트랜잭션을 돌리고 되돌린다 (쓰기 0)',
    description: '날짜마다 「시간표의 기존 회차에 연결」인지 「하루짜리 회차를 새로 만듦」인지, 순번, 시각, 불가 시간 알림을 돌려준다. 화면은 세지 않는다 (D-R37).',
  })
  @ApiCreatedResponse({ type: ConsSessionsResultDto })
  @ApiConflictResponse({ description: 'code CONS_NOT_RUNNING · CONS_LOCKED · RESOURCE_CONFLICT(겹침 — 어느 날짜인지 문장에)' })
  async previewSessions(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ConsSessionCreateDto): Promise<ConsSessionsResultDto> {
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.sessions.addSessions(user.id, canHide, id, dto, true);
  }

  @Post(':id/sessions')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '회차 잡기 — 날짜 여러 개 (I-91 「날짜 3개 고르기」 · 원본 §2 「CONS.sess → SER → TODO」)',
    description: '진행(running) 중인 건만. 날짜마다 cons_sess(순번은 서버 · 「누가」는 담당 · 학생) · 담당의 할 일 · 시간표 회차(있으면 연결, 없으면 ScheduleWriteService.create — 겹침은 EXCLUDE 409 로 전부 되돌아간다) · cons_event. 담당이 남이면 알림.',
  })
  @ApiCreatedResponse({ type: ConsSessionsResultDto })
  @ApiNotFoundResponse({ description: '보이지 않는 건 · STAFF_NOT_FOUND' })
  @ApiConflictResponse({ description: 'code CONS_NOT_RUNNING(수납 전) · CONS_LOCKED(종료) · RESOURCE_CONFLICT · 400 CONS_SESSION_TIME_REQUIRED · CONS_STAFF_REQUIRED · STAFF_INACTIVE' })
  async addSessions(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ConsSessionCreateDto): Promise<ConsSessionsResultDto> {
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.sessions.addSessions(user.id, canHide, id, dto, false);
  }

  @Patch(':id/sessions/:sessId')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '회차 육하원칙 — 보낸 칸만 (§31 누가 · 무엇을 · 왜 · 어떻게)',
    description: '무엇을·왜·어떻게가 다 적히면 그 회차의 할 일을 끝낸 것으로 접는다. 종료된 건은 409 CONS_LOCKED.',
  })
  @ApiOkResponse({ type: ConsultingSessionDto })
  @ApiNotFoundResponse({ description: '보이지 않는 건 · CONS_SESSION_NOT_FOUND' })
  @ApiConflictResponse({ description: 'code CONS_LOCKED · EMPTY_PATCH' })
  async writeSession(
    @CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Param('sessId', ParseIntPipe) sessId: number, @Body() dto: ConsSessionWriteDto,
  ): Promise<ConsultingSessionDto> {
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.sessions.writeSession(user.id, canHide, id, sessId, dto);
  }

  @Post(':id/close/preview')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '종료 미리보기 — 안내문 본문과 회차 수를 돌려주고 되돌린다 (쓰기 0 · 예외 종료도 같은 모양)' })
  @ApiCreatedResponse({ type: ConsCloseResultDto })
  @ApiForbiddenResponse({ description: 'code CONS_CLOSE_EXCEPTION_FORBIDDEN — 예외 종료 승인 권한 없음' })
  @ApiConflictResponse({ description: 'code CONS_ALREADY_DONE · CONS_NOT_RUNNING · CONS_ITEMS_LEFT · CONS_SESSIONS_LEFT · CONS_SESSIONS_PLANNED · CONS_CLOSE_EXCEPTION_NOT_NEEDED' })
  async previewClose(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ConsCloseDto): Promise<ConsCloseResultDto> {
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.sessions.close(user.id, canHide, id, dto, true, approveClose(user));
  }

  @Post(':id/close')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '컨설팅 종료 — I-95 · 원본 §26 「종료 · 마무리하고 안내」',
    description:
      'N-18 채택 「필수 항목 + 약정 회차 후 명시 종료」를 서버가 판정한다. stage=done · 종료일 · 학생마다 학부모 안내 행(PNOTI parent · 문구 틀 선택 · 발송처는 N-42) · cons_event closed · 담당 알림. '
      + '예외 종료(exception.reason · N-18-a 채택) — 필수 항목 · 약정 회차만 남은 진행 중 건을 승인 권한자가 사유와 함께 닫는다(남은 것 · 사유 · 승인자는 감사 원장). 학부모 안내는 고른 문구 틀이나 적은 글만(400 CONS_CLOSE_NOTICE_REQUIRED).',
  })
  @ApiCreatedResponse({ type: ConsCloseResultDto })
  @ApiNotFoundResponse({ description: '보이지 않는 건 · GTPL_NOT_FOUND' })
  @ApiForbiddenResponse({ description: 'code CONS_CLOSE_EXCEPTION_FORBIDDEN — 예외 종료 승인 권한 없음' })
  @ApiConflictResponse({ description: 'code CONS_ALREADY_DONE · CONS_NOT_RUNNING · CONS_ITEMS_LEFT · CONS_SESSIONS_LEFT · CONS_SESSIONS_PLANNED · CONS_CLOSE_EXCEPTION_NOT_NEEDED' })
  async close(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ConsCloseDto): Promise<ConsCloseResultDto> {
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.sessions.close(user.id, canHide, id, dto, false, approveClose(user));
  }

  @Post(':id/payments')
  @Perm('canAdminPage', 'canCrudAll', 'canMoney')
  @ApiOperation({
    summary: '납부 넣기 — §28 동작 ①',
    description: 'cons_pay 원장에 한 줄 더한다. 받은 합은 저장하지 않는다 — 읽을 때 원장을 더한다 (D-R37).',
  })
  @ApiCreatedResponse({ type: ConsAccountRowDto, description: '바뀐 줄 하나 — 화면이 숫자를 다시 만들지 않게' })
  @ApiForbiddenResponse({ description: '금액이 공개 범위 밖' })
  @ApiNotFoundResponse({ description: '보이지 않는 건 — 존재를 누출하지 않는다' })
  @ApiConflictResponse({ description: 'code CONS_PAY_LOCKED(종료된 건) | CONS_PAY_NOT_READY(서명 전) | OVERPAY(남은 금액 초과) | PAY_REQUEST_KEY_REUSED(같은 요청 키 · 다른 내용 · N-132)' })
  async addPayment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConsPaymentCreateDto,
  ): Promise<ConsAccountRowDto> {
    const canMoney = isRole(user.role) ? hasPerm(user.role, 'canMoney', user.perms) : false;
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.addPayment(user.id, canMoney, canHide, id, dto);
  }

  @Post(':id/invoice')
  @Perm('canAdminPage', 'canCrudAll', 'canMoney')
  @ApiOperation({
    summary: '청구서로 전환 — §28 동작 ② · 연동 「INV 에 csid 로 연결」',
    description:
      '**남은 돈으로** 청구서를 낸다. 계약 전액으로 내면 이미 받은 돈이 §53 미수금에 한 번 더 얹힌다. '
      + '전환 뒤에도 납부 기록은 cons_pay 에 그대로 남는다 — cs_id 는 연결이지 소유가 아니다. '
      + '받는 학생은 사람이 고른다(studentId · 학생이 여럿이면 필수 · 한 명이면 비워도 그 학생 · N-33 ②). 감사 원장에 남는다(N-73).',
  })
  @ApiCreatedResponse({ type: ConsAccountRowDto })
  @ApiForbiddenResponse({ description: '금액이 공개 범위 밖' })
  @ApiNotFoundResponse({ description: '보이지 않는 건' })
  @ApiConflictResponse({
    description: 'code CONS_INV_EXISTS · CONS_INV_NOT_PAID_STEP · CONS_INV_NOTHING_DUE · CONS_INV_STUDENT_AMBIGUOUS(학생이 여럿인데 고르지 않음 · 학생 없음) · '
      + 'MONTH_CLOSED(전환 청구서의 달 — 오늘의 달 — 이 마감됨 · 발행 · 이월과 같은 문장) · 400 CONS_INV_STUDENT_INVALID',
  })
  async toInvoice(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConsToInvoiceDto,
  ): Promise<ConsAccountRowDto> {
    const canMoney = isRole(user.role) ? hasPerm(user.role, 'canMoney', user.perms) : false;
    const canHide = isRole(user.role) ? hasPerm(user.role, 'canHide', user.perms) : false;
    return this.svc.toInvoice(user.id, canMoney, canHide, id, dto);
  }
}
