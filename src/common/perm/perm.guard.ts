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
