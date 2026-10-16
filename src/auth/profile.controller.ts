/** @file-guide
 * 목적: profile.controller.ts — ProfileController (controller)
 * 책임/재사용: 본인 마이페이지(AUTH-SELF-01) HTTP DTO/경로와 Swagger를 연결하고 ProfileService에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, Patch, Post, Res } from '@nestjs/common';
import {
  ApiBadGatewayResponse, ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse, ApiOkResponse,
  ApiOperation, ApiServiceUnavailableResponse, ApiTags, ApiTooManyRequestsResponse, ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ProfileService } from './profile.service';
import { CurrentUser } from './current-user.decorator';
import type { RequestUser } from '../common/perm';
import { LoginResultDto } from './dto/auth.dto';
import { OnboardingCodeResultDto } from './dto/onboarding.dto';
import { ProfileContactChangeDto, ProfileContactCodeRequestDto, ProfileDto, ProfileUpdateDto } from './dto/profile.dto';
// 쿠키 속성은 auth/cookie.ts 한 곳에서만 만든다 — 로그인 · 첫 설정과 같은 쿠키를 같은 속성으로 놓는다
import { REFRESH_COOKIE, cookieOptions } from './cookie';
import { ApiErrorDto } from '../common/http.dto';

const unauthorized = { type: ApiErrorDto, description: 'UNAUTHORIZED: 로그인이 필요하다 · 비활성 계정.' };
const setupRequired = {
  type: ApiErrorDto,
  description: 'CREDENTIALS_CHANGE_REQUIRED — 필수 초기설정(휴대폰 · 이메일 인증 · 비밀번호 교체)이 남은 계정은 이 경로를 쓸 수 없다(AUTH-INIT-02).',
};

/**
 * 본인 마이페이지 (AUTH-SELF-01 · 사용자 결정 2026-10-16). 모든 역할이 **자기 것만** 읽고 고친다 — 경로 · 본문에 사람 id 가 없다.
 * `AllowWhileOnboarding` 을 붙이지 않는다: 필수 초기설정이 남은 계정은 OnboardingGuard 가 403 으로 막는다.
 */
@ApiTags('auth')
@Controller('auth/profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get()
  @ApiOperation({
    summary: '내 프로필 — 아이디 · 이름 · 영어 이름 · 역할 이름 · 직함 · 이메일/휴대폰과 인증 여부 · 입사일 · 연락처 변경 코드 안내',
    description: '본인 화면에 필요한 최소 정보만 싣는다(비밀번호 해시 · 권한 예외 · 세션 시각 없음). 권한 판정은 MeDto 플래그다.',
  })
  @ApiOkResponse({ type: ProfileDto })
  @ApiUnauthorizedResponse(unauthorized)
  @ApiForbiddenResponse(setupRequired)
  get(@CurrentUser() user: RequestUser): Promise<ProfileDto> {
    return this.profile.get(user.id);
  }

  @Patch()
  @ApiOperation({
    summary: '이름 · 영어 이름 고치기 — 생략하면 그대로 · 영어 이름 null/빈 글자는 비운다',
    description: '이름은 비울 수 없고 1~40자(앞뒤 공백 제외)다. role · id · 인증 여부 · 이메일 · 휴대폰 같은 칸을 실으면 400 이다 '
      + '(연락처는 contact-change 로만 바뀐다). 바뀐 칸이 있을 때만 감사 줄을 남긴다.',
  })
  @ApiOkResponse({ type: ProfileDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'BAD_REQUEST — 이름 비움 · 40자 초과 · 허용하지 않은 칸' })
  @ApiUnauthorizedResponse(unauthorized)
  @ApiForbiddenResponse(setupRequired)
  update(@CurrentUser() user: RequestUser, @Body() dto: ProfileUpdateDto): Promise<ProfileDto> {
    return this.profile.update(user.id, dto);
  }

  @Post('contact-codes')
  @ApiOperation({
    summary: '새 이메일 · 휴대폰으로 확인 코드 받기 — 6자리 · 10분',
    description: '코드와 받는 곳 원문은 저장하지 않는다(HMAC · 가린 모양만). 같은 채널 60초 간격 · 한 시간 5번 · 하루 10번'
      + '(계정 · 채널마다 · 첫 설정 · 비밀번호 찾기와 같은 예산). 지금 값과 같은 수신처는 409 CONTACT_UNCHANGED.',
  })
  @ApiCreatedResponse({ type: OnboardingCodeResultDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'BAD_REQUEST(입력 모양) · INVALID_EMAIL · INVALID_PHONE' })
  @ApiUnauthorizedResponse(unauthorized)
  @ApiForbiddenResponse(setupRequired)
  @ApiConflictResponse({ type: ApiErrorDto, description: 'CONTACT_UNCHANGED · EMAIL_TAKEN(다른 계정의 이메일 · 대소문자 무관)' })
  @ApiTooManyRequestsResponse({ type: ApiErrorDto, description: 'CODE_TOO_SOON · CODE_DAILY_LIMIT · CODE_LIMIT' })
  @ApiBadGatewayResponse({ type: ApiErrorDto, description: 'SEND_FAILED — 공급자가 거절 · 그 코드는 쓸 수 없게 닫는다' })
  @ApiServiceUnavailableResponse({ type: ApiErrorDto, description: 'SENDER_NOT_CONFIGURED · AUTH_CODE_SECRET_MISSING — 코드 줄을 만들지 않는다' })
  codes(@CurrentUser() user: RequestUser, @Body() dto: ProfileContactCodeRequestDto): Promise<OnboardingCodeResultDto> {
    return this.profile.sendContactCode(user.id, dto);
  }

  @Post('contact-change')
  @ApiOperation({
    summary: '새 이메일 · 휴대폰 저장 — 그 수신처로 받은 코드와 지금 비밀번호를 한 번에',
    description: '둘 다 맞으면 한 transaction 으로 그 채널의 값과 인증을 저장하고 남은 코드를 닫고 세션 시각을 바꾼다 — '
      + '그 전에 발급된 이 계정의 토큰은 모두 401 이 되고, 응답이 새 세션이다(Access 는 본문 · Refresh 는 httpOnly 쿠키). '
      + '실패하면 지금 값 · 인증 상태는 그대로다. 비밀번호 틀림은 그 코드의 틀린 횟수에 센다.',
  })
  @ApiCreatedResponse({ type: LoginResultDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'BAD_REQUEST(입력 모양) · INVALID_EMAIL · INVALID_PHONE' })
  @ApiUnauthorizedResponse(unauthorized)
  @ApiForbiddenResponse(setupRequired)
  @ApiConflictResponse({
    type: ApiErrorDto,
    description: 'CONTACT_UNCHANGED · EMAIL_TAKEN · CODE_NOT_REQUESTED · CODE_EXPIRED · CODE_LOCKED · CODE_MISMATCH · CURRENT_PASSWORD_MISMATCH',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorDto, description: 'AUTH_CODE_SECRET_MISSING — 운영 코드 비밀 값 없음' })
  async change(
    @CurrentUser() user: RequestUser,
    @Body() dto: ProfileContactChangeDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResultDto> {
    const { accessToken, refreshToken, user: me } = await this.profile.changeContact(user.id, dto);
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions());
    return { accessToken, user: me };
  }
}
