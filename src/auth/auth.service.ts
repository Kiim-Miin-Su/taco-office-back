import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { Staff } from '../entities';
import { permsOf, type Role } from '../common/perm';
import type { MeDto } from './dto/auth.dto';
import type { JwtPayload } from './jwt.strategy';

/** jsonwebtoken 의 expiresIn 은 '15m' 같은 문자열 리터럴 타입을 받는다 */
type Expires = NonNullable<Parameters<JwtService['sign']>[1]>['expiresIn'];

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(Staff) private readonly staff: Repository<Staff>,
    private readonly jwt: JwtService,
  ) {}

  /**
   * 사람별 권한 예외. **평소에는 전부 null** 이고 role 에서 파생한다 (D-R39).
   * 하나라도 값이 들어 있을 때만 토큰에 싣는다 — 토큰을 쓸데없이 키우지 않는다.
   */
  private overridesOf(s: Staff) {
    const o = {
      canMoney: s.canMoney,
      canWage: s.canWage,
      canApprove: s.canApprove,
      canHide: s.canHide,
      canGpaPack: s.canGpaPack,
    };
    return Object.values(o).some((v) => v !== null && v !== undefined) ? o : null;
  }

  toMe(s: Staff): MeDto {
    const role = s.role as Role;
    return {
      id: Number(s.id),
      name: s.name,
      role,
      title: s.title,
      ...permsOf(role, this.overridesOf(s)),
    };
  }

  async login(email: string, password: string) {
    const s = await this.staff.findOne({ where: { email, active: true } });
    // 계정이 없는 것과 비밀번호가 틀린 것을 **같은 문구**로 답한다 —
    // 다르게 답하면 어떤 이메일이 등록돼 있는지 밖에서 알아낼 수 있다.
    const fail = () => new UnauthorizedException('이메일 또는 비밀번호가 맞지 않습니다');
    if (!s) throw fail();

    if (!s.passwordHash || !(await bcrypt.compare(password, s.passwordHash))) throw fail();

    const me = this.toMe(s);
    return { accessToken: this.signAccess(s), refreshToken: this.signRefresh(s), user: me };
  }

  private payload(s: Staff): JwtPayload {
    return {
      sub: Number(s.id),
      name: s.name,
      role: s.role,
      perms: this.overridesOf(s),
    };
  }

  signAccess(s: Staff): string {
    return this.jwt.sign(this.payload(s), {
      secret: process.env.JWT_SECRET ?? 'dev-only-change-me',
      expiresIn: (process.env.JWT_EXPIRES ?? '15m') as Expires,
    });
  }

  signRefresh(s: Staff): string {
    return this.jwt.sign(
      { sub: Number(s.id) },
      {
        secret: process.env.JWT_REFRESH_SECRET ?? 'dev-only-change-me-too',
        expiresIn: (process.env.JWT_REFRESH_EXPIRES ?? '14d') as Expires,
      },
    );
  }

  async refresh(token: string) {
    let sub: number;
    try {
      ({ sub } = this.jwt.verify<{ sub: number }>(token, {
        secret: process.env.JWT_REFRESH_SECRET ?? 'dev-only-change-me-too',
      }));
    } catch {
      throw new UnauthorizedException('다시 로그인해 주세요');
    }
    const s = await this.staff.findOne({ where: { id: sub, active: true } });
    if (!s) throw new UnauthorizedException('다시 로그인해 주세요');
    return { accessToken: this.signAccess(s) };
  }

  async me(id: number): Promise<MeDto> {
    const s = await this.staff.findOne({ where: { id, active: true } });
    if (!s) throw new UnauthorizedException('다시 로그인해 주세요');
    return this.toMe(s);
  }
}
