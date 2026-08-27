import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { isRole, type PermName } from '../common/perm';

export interface JwtPayload {
  sub: number;
  name: string;
  role: string;
  /** STAFF 의 권한 컬럼. 평소에는 없다 — role 에서 파생한다 (D-R39) */
  perms?: Partial<Record<PermName, boolean | null>> | null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET ?? 'dev-only-change-me',
    });
  }

  validate(payload: JwtPayload) {
    // 토큰에 담긴 역할이 우리가 아는 넷 중 하나가 아니면 통과시키지 않는다.
    // 예전 토큰(head · adm · coord)이 남아 있을 수 있다 — 조용히 흘려보내면 가드가 오판한다.
    if (!isRole(payload.role)) throw new UnauthorizedException('다시 로그인해 주세요');
    return { id: payload.sub, name: payload.name, role: payload.role, perms: payload.perms };
  }
}
