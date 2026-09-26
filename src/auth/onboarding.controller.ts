/** @file-guide
 * 목적: onboarding.controller.ts — OnboardingController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import {
  ApiBadGatewayResponse, ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiOkResponse, ApiOperation,
  ApiServiceUnavailableResponse, ApiTags, ApiTooManyRequestsResponse, ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { OnboardingService } from './onboarding.service';
import { AllowWhileOnboarding } from './allow-while-onboarding.decorator';
import { CurrentUser } from './current-user.decorator';
import type { RequestUser } from '../common/perm';
import { LoginResultDto } from './dto/auth.dto';
import {
  OnboardingCodeRequestDto, OnboardingCodeResultDto, OnboardingCompleteDto, OnboardingInfoDto,
} from './dto/onboarding.dto';
// 쿠키 속성은 auth/cookie.ts 한 곳에서만 만든다 — 로그인과 같은 쿠키를 같은 속성으로 놓는다
import { REFRESH_COOKIE, cookieOptions } from './cookie';
import { ApiErrorDto } from '../common/http.dto';

const unauthorized = { type: ApiErrorDto, description: 'UNAUTHORIZED: 로그인이 필요하다(첫 설정도 Access 토큰으로만 연다).' };
const notRequired = 'ONBOARDING_NOT_REQUIRED(이미 첫 설정을 마친 계정)';

/**
 * 계정 첫 설정 (W8 · W10 · 대표 지시 2026-09-26) — 「첫 로그인 시 주요 인증(휴대폰 · 이메일) 및 비밀번호 재설정」 · 아이디는 바꾸지 않는다.
 * 첫 설정 전 계정이 부를 수 있는 보호 경로는 이 셋과 `GET /auth/me` 뿐이다(OnboardingGuard).
 */
@ApiTags('auth')
@AllowWhileOnboarding()
@Controller('auth/onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  @ApiOperation({
    summary: '첫 설정 안내 — 해야 하는지 · 아이디(바꾸지 않는다) · 등록된 이메일 · 휴대폰(가린 모양) · 비밀번호 규칙 · 코드 채널',
    description: '낱말(채널 이름 · 못 보내는 까닭 · 비밀번호 규칙)은 서버가 준다. 첫 설정이 필요 없는 계정은 required=false.',
  })
  @ApiOkResponse({ type: OnboardingInfoDto })
  @ApiUnauthorizedResponse(unauthorized)
  info(@CurrentUser() user: RequestUser): Promise<OnboardingInfoDto> {
    return this.onboarding.info(user.id);
  }

  @Post('codes')
  @ApiOperation({
    summary: '인증 코드 받기 — 확인할 이메일 또는 휴대폰으로 6자리',
    description: '코드와 받는 곳 원문은 저장하지 않는다(HMAC · 가린 모양만). 10분 유효 · 같은 채널 60초 간격 · 한 시간 5번 · 하루 10번'
      + '(계정 · 채널마다 · 비밀번호 찾기와 같은 예산 · N-105). 휴대폰은 해외 번호도 받는다(`+국가번호 번호` · N-103).',
  })
  @ApiCreatedResponse({ type: OnboardingCodeResultDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'BAD_REQUEST(입력 모양) · INVALID_EMAIL · INVALID_PHONE(목록 밖 나라 포함)' })
  @ApiUnauthorizedResponse(unauthorized)
  @ApiConflictResponse({ type: ApiErrorDto, description: `${notRequired} · EMAIL_TAKEN(다른 계정의 이메일 · 대소문자 무관)` })
  @ApiTooManyRequestsResponse({
    type: ApiErrorDto, description: 'CODE_TOO_SOON(60초 안) · CODE_DAILY_LIMIT(하루 10번 · N-105) · CODE_LIMIT(한 시간 5번)',
  })
  @ApiBadGatewayResponse({ type: ApiErrorDto, description: 'SEND_FAILED — 공급자가 거절 · 그 코드는 쓸 수 없게 닫는다' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorDto,
    description: 'SENDER_NOT_CONFIGURED(발송 설정 없음) · AUTH_CODE_SECRET_MISSING(운영에 코드 비밀 값 없음 · N-105) — 코드 줄을 만들지 않는다',
  })
  codes(@CurrentUser() user: RequestUser, @Body() dto: OnboardingCodeRequestDto): Promise<OnboardingCodeResultDto> {
    return this.onboarding.sendCode(user.id, dto);
  }

  @Post('complete')
  @ApiOperation({
    summary: '첫 설정 마치기 — 확인한 이메일 · 휴대폰과 두 코드 · 새 비밀번호를 한 번에(아이디는 그대로)',
    description: '성공하면 로그인과 같다: Access 는 본문, Refresh 는 httpOnly 쿠키. 그 전에 발급된 이 계정의 토큰은 모두 401 이 된다.',
  })
  @ApiCreatedResponse({ type: LoginResultDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'BAD_REQUEST(입력 모양) · INVALID_EMAIL · INVALID_PHONE · PASSWORD_RULE(규칙 문장 그대로)' })
  @ApiUnauthorizedResponse(unauthorized)
  @ApiConflictResponse({
    type: ApiErrorDto,
    description: `${notRequired} · SAME_AS_CURRENT · EMAIL_TAKEN · CODE_NOT_REQUESTED · CODE_EXPIRED · CODE_LOCKED · CODE_MISMATCH(틀린 횟수는 남는다)`,
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorDto, description: 'AUTH_CODE_SECRET_MISSING — 운영에 코드 비밀 값이 없어 코드를 확인할 수 없다(N-105)' })
  async complete(
    @CurrentUser() user: RequestUser,
    @Body() dto: OnboardingCompleteDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResultDto> {
    const { accessToken, refreshToken, user: me } = await this.onboarding.complete(user.id, dto);
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions());
    return { accessToken, user: me };
  }
}
