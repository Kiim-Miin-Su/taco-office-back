/** @file-guide
 * 목적: auth.controller.ts — AuthController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, LoginResultDto, MeDto, RefreshResultDto } from './dto/auth.dto';
import { Public } from './public.decorator';
import { CurrentUser } from './current-user.decorator';
import type { RequestUser } from '../common/perm';
// 쿠키 속성은 auth/cookie.ts 한 곳에서만 만든다 — 여기서 다시 적으면 도메인이 갈린다
import { REFRESH_COOKIE, cookieOptions, clearOptions } from './cookie';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @ApiOperation({ summary: '로그인 — Access 는 본문, Refresh 는 httpOnly 쿠키' })
  @ApiCreatedResponse({ type: LoginResultDto })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response): Promise<LoginResultDto> {
    const { accessToken, refreshToken, user } = await this.auth.login(dto.email, dto.password);
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions());
    return { accessToken, user };
  }

  @Public()
  @Post('refresh')
  @ApiOperation({ summary: '재발급 — 쿠키만 보고 판단한다' })
  @ApiCreatedResponse({ type: RefreshResultDto })
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
  @ApiOperation({ summary: '내 정보 — **권한 플래그를 서버가 내려준다** (D-R39)' })
  @ApiOkResponse({ type: MeDto })
  me(@CurrentUser() user: RequestUser): Promise<MeDto> {
    return this.auth.me(user.id);
  }
}
