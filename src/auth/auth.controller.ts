/** @file-guide
 * 목적: auth.controller.ts — AuthController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { ApiBadRequestResponse, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, LoginResultDto, MeDto, RefreshResultDto } from './dto/auth.dto';
import { Public } from './public.decorator';
import { CurrentUser } from './current-user.decorator';
import type { RequestUser } from '../common/perm';
// 쿠키 속성은 auth/cookie.ts 한 곳에서만 만든다 — 여기서 다시 적으면 도메인이 갈린다
import { REFRESH_COOKIE, cookieOptions, clearOptions } from './cookie';
import { ApiErrorDto } from '../common/http.dto';

const authUnauthorized = { type: ApiErrorDto, description: 'UNAUTHORIZED: 인증 정보/서명/만료/숫자 계정 식별자가 유효하지 않음. 로그인 실패는 refresh/replay하지 않는다. 보호 요청은 refresh 후에도401이면 세션을 종료한다.' };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @ApiOperation({ summary: '로그인 — Access 는 본문, Refresh 는 httpOnly 쿠키' })
  @ApiCreatedResponse({ type: LoginResultDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'BAD_REQUEST: 이메일·비밀번호 최소8자·추가 키 검증 실패.' })
  @ApiUnauthorizedResponse(authUnauthorized)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response): Promise<LoginResultDto> {
    const { accessToken, refreshToken, user } = await this.auth.login(dto.email, dto.password);
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions());
    return { accessToken, user };
  }

  @Public(REFRESH_COOKIE)
  @Post('refresh')
  @ApiOperation({ summary: '재발급 — 쿠키만 보고 판단한다' })
  @ApiCreatedResponse({ type: RefreshResultDto })
  @ApiUnauthorizedResponse(authUnauthorized)
  async refresh(@Req() req: Request): Promise<RefreshResultDto> {
    return this.auth.refresh(String(req.cookies?.[REFRESH_COOKIE] ?? ''));
  }

  @Public()
  @Post('logout')
  @ApiOperation({ summary: '로그아웃 — 쿠키를 지운다' })
  @ApiNoContentResponse({ description: 'Refresh 쿠키 제거. 응답 본문 없음.' })
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(REFRESH_COOKIE, clearOptions());
    res.status(204);
  }

  @Get('me')
  @ApiOperation({ summary: '내 정보 — **권한 플래그를 서버가 내려준다** (D-R39)', description: '현재 활성 STAFF의 역할·예외에서 파생한다. 보호 API도 요청 인증 시 같은 현재 계정을 읽으며 발급 당시 JWT 권한을 재사용하지 않는다. 비활성/삭제 계정은401. 이미 처리 중인 요청의 commit 직전 회수나 브라우저의 실시간 Me 갱신을 보장하지 않는다.' })
  @ApiOkResponse({ type: MeDto })
  @ApiUnauthorizedResponse(authUnauthorized)
  me(@CurrentUser() user: RequestUser): Promise<MeDto> {
    return this.auth.me(user.id);
  }
}
