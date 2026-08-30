import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  @ApiOkResponse({ type: LoginResultDto })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResultDto> {
    const { accessToken, refreshToken, user } = await this.auth.login(dto.email, dto.password);
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions());
    return { accessToken, user };
  }

  @Public()
  @Post('refresh')
  @ApiOperation({ summary: '재발급 — 쿠키만 보고 판단한다' })
  @ApiOkResponse({ type: RefreshResultDto })
  async refresh(@Req() req: Request): Promise<RefreshResultDto> {
    return this.auth.refresh(String(req.cookies?.[REFRESH_COOKIE] ?? ''));
  }

  @Public()
  @Post('logout')
  @ApiOperation({ summary: '로그아웃 — 쿠키를 지운다' })
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
