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
  OnboardingCodeRequestDto, OnboardingCodeResultDto, OnboardingCompleteDto, OnboardingInfoDto, OnboardingVerifyDto,
} from './dto/onboarding.dto';
// 쿠키 속성은 auth/cookie.ts 한 곳에서만 만든다 — 로그인과 같은 쿠키를 같은 속성으로 놓는다
import { REFRESH_COOKIE, cookieOptions } from './cookie';
import { ApiErrorDto } from '../common/http.dto';

const unauthorized = { type: ApiErrorDto, description: 'UNAUTHORIZED: 로그인이 필요하다(첫 설정도 Access 토큰으로만 연다).' };
const notRequired = 'ONBOARDING_NOT_REQUIRED(이미 첫 설정을 마친 계정)';

/**
 * 계정 첫 설정 (W8 · W10 · 대표 지시 2026-09-26) — 「첫 로그인 시 주요 인증(휴대폰 · 이메일) 및 비밀번호 재설정」 · 아이디는 바꾸지 않는다.
 * 첫 설정 전 계정이 부를 수 있는 보호 경로는 이 넷과 `GET /auth/me` 뿐이다(OnboardingGuard).
 * 순서(2026-10-19 사용자 지시 「이메일 인증하기와 휴대폰 번호 인증하기 버튼」): 코드 받기 → 채널마다 인증하기 → 새 비밀번호로 마치기.
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

  @Post('verify')
  @ApiOperation({
    summary: '채널 하나 인증하기 — 코드를 받은 이메일 또는 휴대폰과 그 코드',
    description: '맞으면 그 주소 · 번호가 계정에 적히고 이번 첫 설정의 증거로 남는다(같은 채널의 다른 열린 코드는 닫는다). '
      + '두 인증 칸 · 잠금은 마치기가 새 비밀번호와 함께 바꾼다. 응답은 갱신된 첫 설정 안내다.',
  })
  @ApiCreatedResponse({ type: OnboardingInfoDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'BAD_REQUEST(입력 모양 · 코드 여섯 자리) · INVALID_EMAIL · INVALID_PHONE' })
  @ApiUnauthorizedResponse(unauthorized)
  @ApiConflictResponse({
    type: ApiErrorDto,
    description: `${notRequired} · EMAIL_TAKEN · CODE_NOT_REQUESTED · CODE_EXPIRED · CODE_LOCKED · CODE_MISMATCH(틀린 횟수는 남는다)`,
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorDto, description: 'AUTH_CODE_SECRET_MISSING — 운영 코드 비밀 값 없음(N-105)' })
  verify(@CurrentUser() user: RequestUser, @Body() dto: OnboardingVerifyDto): Promise<OnboardingInfoDto> {
    return this.onboarding.verify(user.id, dto);
  }

  @Post('complete')
  @ApiOperation({
    summary: '첫 설정 마치기 — 새 비밀번호(아이디는 그대로 · 이메일 · 휴대폰은 「인증하기」가 이미 증명했다)',
    description: '이번 첫 설정의 두 인증 증거를 다시 확인한 뒤 두 인증 · 잠금 해제 · 새 비밀번호를 한 transaction 으로 저장한다. '
      + '성공하면 로그인과 같다: Access 는 본문, Refresh 는 httpOnly 쿠키. 그 전에 발급된 이 계정의 토큰은 모두 401 이 된다.',
  })
  @ApiCreatedResponse({ type: LoginResultDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'BAD_REQUEST(입력 모양) · PASSWORD_RULE(규칙 문장 그대로)' })
  @ApiUnauthorizedResponse(unauthorized)
  @ApiConflictResponse({
    type: ApiErrorDto,
    description: `${notRequired} · CONTACT_NOT_VERIFIED(남은 인증 — 안내의 completeBlockedReason 과 같은 문장 · 저장 0) · SAME_AS_CURRENT`,
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorDto, description: 'AUTH_CODE_SECRET_MISSING — 운영 코드 비밀 값 없음(N-105) | INITIAL_PASSWORD_REQUIRED — 서버 비밀번호 정책 설정 누락/불완전, 기존 자격 유지' })
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
