/** @file-guide
 * 목적: guardians.controller.ts — GuardiansController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 보호자와 선택 발송 (DQ3 대표 답변 2026-09-25 · N-42).
 *
 * **모든 길이 관리자 전용이다** — `@Perm('canAdminPage', 'canCrudAll')`. 보호자 연락처는 강사에게 내려가지 않는다
 * (강사 응답 어디에도 이 DTO 를 쓰지 않는다). 역할 문자열은 보지 않는다 (D-R39).
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { ApiErrorDto } from '../../common/http.dto';
import { Perm, type RequestUser } from '../../common/perm';
import {
  GuardianChannelsDto, GuardianCreateDto, GuardianDto, GuardianListDto, GuardianParamsDto, GuardianPatchDto,
  GuardianSendDto, GuardianSendResultDto,
} from './guardians.dto';
import { GuardiansService } from './guardians.service';

@ApiTags('guardians')
@Controller()
export class GuardiansController {
  constructor(private readonly svc: GuardiansService) {}

  @Get('students/:id/guardians')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '학생의 보호자 — 사용 중이 먼저, 사용 중지는 뒤 (연락처 포함 · 관리 화면 전용)' })
  @ApiOkResponse({ type: GuardianListDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'code STUDENT_NOT_FOUND' })
  list(@Param() params: GuardianParamsDto): Promise<GuardianListDto> {
    return this.svc.list(params.id);
  }

  @Post('students/:id/guardians')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '보호자 추가 — 메일·휴대폰 중 하나는 있어야 한다',
    description: '휴대폰은 숫자만 저장한다. 대표로 고르면 같은 학생의 전 대표는 내려간다. 대표를 고르지 않았고 대표가 없으면 이 사람이 대표다.',
  })
  @ApiCreatedResponse({ type: GuardianDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'code GUARDIAN_CONTACT_REQUIRED | GUARDIAN_CHANNEL_CONTACT' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'code STUDENT_NOT_FOUND' })
  create(
    @CurrentUser() user: RequestUser,
    @Param() params: GuardianParamsDto,
    @Body() dto: GuardianCreateDto,
  ): Promise<GuardianDto> {
    return this.svc.create(params.id, dto, user.id);
  }

  @Get('guardians/channels')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '지금 보낼 수 있는 채널 — 메일(SMTP)·문자(SENS). 설정이 없으면 까닭과 함께 잠긴다' })
  @ApiOkResponse({ type: GuardianChannelsDto })
  channels(): GuardianChannelsDto {
    return this.svc.channels();
  }

  @Post('guardians/send')
  @HttpCode(200)
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '보호자 선택 발송 — 고른 보호자 × 고른 채널마다 한 번, 원장에 한 줄',
    description:
      '서버가 그 학생의 사용 중 보호자인지 · 그 채널을 받는지 · PNOTI 가 그 학생의 학부모 줄인지 다시 본다. '
      + '채널 설정이 없으면 보내지 않고 not_configured 로 남긴다(보낸 척하지 않는다). '
      + 'PNOTI.sent_at 은 실제로 나간 줄이 하나라도 있을 때만 찍힌다. 같은 requestKey 는 앞선 결과를 돌려준다.',
  })
  @ApiOkResponse({ type: GuardianSendResultDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'code GUARDIAN_NOT_OF_STUDENT | GUARDIAN_INACTIVE | GUARDIAN_CHANNEL_MISMATCH | PNOTI_NOT_OF_STUDENT' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'code REQUEST_KEY_REUSED — 다른 학생에게 쓴 키' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'code STUDENT_NOT_FOUND' })
  send(@CurrentUser() user: RequestUser, @Body() dto: GuardianSendDto): Promise<GuardianSendResultDto> {
    return this.svc.send(dto, user.id);
  }

  @Patch('guardians/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '보호자 고치기 — 보낸 칸만 바꾼다. null 은 비운다. active:true 는 다시 쓰기',
    description: '연락처를 비우면 그 채널 받기도 꺼진다. 사용 중지한 보호자는 active:true 와 함께만 고친다.',
  })
  @ApiOkResponse({ type: GuardianDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'code GUARDIAN_CONTACT_REQUIRED | GUARDIAN_CHANNEL_CONTACT' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'code GUARDIAN_INACTIVE' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'code GUARDIAN_NOT_FOUND' })
  patch(
    @CurrentUser() user: RequestUser,
    @Param() params: GuardianParamsDto,
    @Body() dto: GuardianPatchDto,
  ): Promise<GuardianDto> {
    return this.svc.patch(params.id, dto, user.id);
  }

  @Delete('guardians/:id')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({
    summary: '보호자 사용 중지 — 지우지 않는다(발송 원장이 가리킨다). 대표였으면 대표도 내려간다',
  })
  @ApiOkResponse({ type: GuardianDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'code GUARDIAN_NOT_FOUND' })
  deactivate(@CurrentUser() user: RequestUser, @Param() params: GuardianParamsDto): Promise<GuardianDto> {
    return this.svc.deactivate(params.id, user.id);
  }
}
