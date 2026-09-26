/** @file-guide
 * 목적: password-reset.controller.ts — PasswordResetController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation,
  ApiServiceUnavailableResponse, ApiTags,
} from '@nestjs/swagger';
import { Public } from './public.decorator';
import { PasswordResetService } from './password-reset.service';
import {
  PasswordResetCodeRequestDto, PasswordResetCodeResultDto, PasswordResetCompleteDto, PasswordResetInfoDto,
} from './dto/password-reset.dto';
import { ApiErrorDto } from '../common/http.dto';

const unavailable = {
  type: ApiErrorDto,
  description: 'SENDER_NOT_CONFIGURED(발송 설정 없음) · AUTH_CODE_SECRET_MISSING(운영에 코드 비밀 값 없음 · N-105) — 계정과 무관한 서버 상태',
};

/**
 * 비밀번호 찾기 (N-101 · 대표 결정 2026-09-26) — 로그인 전 화면이 부른다(@Public · 토큰 없음). 아이디는 형식 자유(W10).
 * 계정이 있는지 알려 주지 않는다: 코드 받기는 늘 같은 모양 · 마치기는 한 문장(RESET_CODE_INVALID).
 */
@ApiTags('auth')
@Controller('auth/password-reset')
export class PasswordResetController {
  constructor(private readonly reset: PasswordResetService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: '비밀번호 찾기 안내 — 비밀번호 규칙 · 코드 유효 시간 · 코드 채널',
    description: '낱말(채널 이름 · 못 보내는 까닭 · 비밀번호 규칙)은 서버가 준다. 계정과 무관한 안내만 싣는다.',
  })
  @ApiOkResponse({ type: PasswordResetInfoDto })
  info(): PasswordResetInfoDto {
    return this.reset.info();
  }

  @Public()
  @Post('codes')
  @ApiOperation({
    summary: '코드 받기 — 그 아이디에 등록 · 확인된 이메일 또는 휴대폰으로 6자리',
    description: '계정이 없거나 · 확인되지 않았거나 · 한도(60초 · 한 시간 5번 · 하루 10번)에 걸렸거나 · 보내지 못해도 **같은 201** 이다'
      + '(계정 여부를 알려 주지 않는다). 코드와 받는 곳 원문은 저장하지 않는다.',
  })
  @ApiCreatedResponse({ type: PasswordResetCodeResultDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'BAD_REQUEST(입력 모양) · INVALID_LOGIN_ID(빈 아이디 · 띄어쓰기 · 120자 넘음 — 계정과 무관한 모양 거절)' })
  @ApiServiceUnavailableResponse(unavailable)
  codes(@Body() dto: PasswordResetCodeRequestDto): Promise<PasswordResetCodeResultDto> {
    return this.reset.sendCode(dto);
  }

  @Public()
  @Post('complete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: '새 비밀번호 정하기 — 아이디 · 두 코드(이메일 · 휴대폰) · 새 비밀번호를 한 번에',
    description: '성공하면 본문 없음 — 새 비밀번호로 다시 로그인한다. 그 전에 발급된 이 계정의 토큰은 모두 401 이 된다(옛 세션을 끊는다). '
      + '첫 설정 상태는 바꾸지 않는다.',
  })
  @ApiNoContentResponse({ description: '비밀번호를 바꿨다. 응답 본문 없음.' })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'BAD_REQUEST(입력 모양) · PASSWORD_RULE(규칙 문장 그대로) · INVALID_LOGIN_ID' })
  @ApiConflictResponse({
    type: ApiErrorDto,
    description: 'RESET_CODE_INVALID(계정 · 코드 문제를 가르지 않는 한 문장 · 틀린 횟수는 남는다) · SAME_AS_CURRENT(두 코드를 확인한 뒤에만)',
  })
  @ApiServiceUnavailableResponse(unavailable)
  async complete(@Body() dto: PasswordResetCompleteDto): Promise<void> {
    await this.reset.complete(dto);
  }
}
