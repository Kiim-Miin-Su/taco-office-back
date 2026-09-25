/** @file-guide
 * 목적: perm.guard.ts — RequestUser, PermGuard (auth)
 * 책임/재사용: 공용 인증/권한 경계만 소유한다. 토큰·쿠키 원문을 노출하지 않고 만료/익명/권한 회수 경계를 회귀로 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERM_KEY } from './perm.decorator';
import { hasPerm, isRole, type PermName } from './perm';

/** JwtStrategy 가 request.user 에 넣어 주는 것 */
export interface RequestUser {
  id: number;
  name: string;
  role: string;
  perms?: Partial<Record<PermName, boolean | null>> | null;
  /**
   * 첫 설정(아이디=이메일 · 비밀번호 · 휴대폰 · 이메일 인증)을 끝내야 하는 계정인가 (W8 · 2026-09-26).
   * 현재 STAFF 에서 매 요청 다시 읽는다 — 켜져 있으면 OnboardingGuard 가 첫 설정 경로 밖을 403 으로 막는다.
   * 선택 칸인 이유: 요청 사용자를 직접 만드는 시험 대역이 많다. 빠지면 잠기지 않은 계정으로 본다(서버는 늘 채운다).
   */
  mustChange?: boolean;
}

@Injectable()
export class PermGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const need = this.reflector.getAllAndOverride<PermName[]>(PERM_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // @Perm 이 없으면 이 가드는 판단하지 않는다. 인증은 JwtAuthGuard 의 몫이다.
    if (!need || need.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<{ user?: RequestUser }>();
    const user = req.user;
    if (!user || !isRole(user.role)) throw new ForbiddenException('권한을 확인할 수 없습니다');

    const missing = need.filter((n) => !hasPerm(user.role as never, n, user.perms));
    if (missing.length) {
      // 무엇이 없어서 막혔는지 남긴다 — "권한 없음" 만으로는 운영에서 못 고친다
      throw new ForbiddenException(`이 작업에는 ${missing.join(', ')} 권한이 필요합니다`);
    }
    return true;
  }
}
