/** @file-guide
 * 목적: auth.service.ts — JwtPayload, isJwtSubject, AuthService (auth)
 * 책임/재사용: 공용 인증/권한 경계만 소유한다. 토큰·쿠키 원문을 노출하지 않고 만료/익명/권한 회수 경계를 회귀로 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Raw, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { Staff } from '../entities';
import { isRole, permsOf, type Role, type PermName, type RequestUser } from '../common/perm';
import type { MeDto } from './dto/auth.dto';
import { roleLabel } from '../lib/role-words';
import { normalizeLoginId } from '../lib/account-policy';

/** JWT 발급/검증 형상. role/perms는 호환용 snapshot이며 요청 권한의 권위는 현재 STAFF다. */
export interface JwtPayload {
  sub: number;
  name: string;
  role: string;
  perms?: Partial<Record<PermName, boolean | null>> | null;
  /** 발급 시각(초) — jsonwebtoken 이 넣는다. 자격이 다시 정해진 시각보다 앞선 토큰을 끊는 데 쓴다 (W8) */
  iat?: number;
}

/** Access/Refresh가 공유한다. ORM에 누락 식별자를 전달하면 조건이 무시될 수 있다. */
export const isJwtSubject = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** jsonwebtoken 의 expiresIn 은 '15m' 같은 문자열 리터럴 타입을 받는다 */
type Expires = NonNullable<Parameters<JwtService['sign']>[1]>['expiresIn'];

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(Staff) private readonly staff: Repository<Staff>,
    private readonly jwt: JwtService,
  ) {}

  /**
   * 권한 검수에는 비밀번호/연락처를 읽지 않는다. PK 조회로 현재 활성 계정만 허용한다.
   * 첫 설정 잠금 · 자격 재설정 시각(W8)도 **같은 한 번의 조회**로 읽는다 — 요청마다 조회가 늘지 않는다.
   */
  private async activeStaff(id: unknown): Promise<Staff> {
    if (!isJwtSubject(id)) throw new UnauthorizedException('다시 로그인해 주세요');
    const s = await this.staff.findOne({
      where: { id, active: true },
      select: [
        'id', 'name', 'title', 'role', 'canMoney', 'canWage', 'canApprove', 'canHide', 'canGpaPack',
        'mustChangeCredentials', 'credentialsChangedAt',
      ],
    });
    if (!s || !isRole(s.role)) throw new UnauthorizedException('다시 로그인해 주세요');
    return s;
  }

  /**
   * 자격이 다시 정해진 뒤에는 그 전에 발급된 토큰을 받지 않는다 (W8).
   *
   * 초기 비밀번호는 계정을 만든 사람도 안다 — 첫 설정 · 관리자 비밀번호 초기화 · 운영 전환이
   * `credentials_changed_at` 을 찍으면 그보다 **먼저 발급된** Access · Refresh 는 전부 끊긴다(만든 사람의 세션 포함).
   * `iat` 는 초 단위라 같은 초 안의 비교는 허용 쪽으로 기운다(floor) — 방금 발급한 새 토큰이 스스로 끊기지 않게.
   * 재설정 시각이 있는데 `iat` 가 없는 토큰은 판정할 수 없으니 끊는다.
   */
  private assertIssuedAfterReset(s: Staff, iat: unknown): void {
    if (!s.credentialsChangedAt) return;
    const cutoff = Math.floor(new Date(s.credentialsChangedAt).getTime() / 1000);
    if (typeof iat !== 'number' || !Number.isFinite(iat) || iat < cutoff) {
      throw new UnauthorizedException('다시 로그인해 주세요');
    }
  }

  /** 서명된 옛 권한을 재사용하지 않는다. PermGuard와 모든 service가 같은 현재 사용자로 판정한다. */
  async currentUser(id: number, iat?: number): Promise<RequestUser> {
    const s = await this.activeStaff(id);
    this.assertIssuedAfterReset(s, iat);
    return {
      id: Number(s.id), name: s.name, role: s.role, perms: this.overridesOf(s),
      // 첫 설정 잠금은 토큰이 아니라 현재 STAFF 가 정한다 — OnboardingGuard 가 이 값만 본다
      mustChange: s.mustChangeCredentials === true,
    };
  }

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
      // 서랍 §17 묶음 머리와 **같은 표**에서 꺼낸다 — 두 곳이 다른 낱말을 쓰지 않는다 (D-R18)
      roleLabel: roleLabel(role),
      ...permsOf(role, this.overridesOf(s)),
      // 화면이 첫 설정으로 보낼지 여기서만 안다 — 늘 채운다(W8)
      mustChangeCredentials: s.mustChangeCredentials === true,
    };
  }

  /** 로그인 · 첫 설정 완료가 같은 모양으로 세션을 연다 — Access(본문) · Refresh(쿠키로 나갈 값) · Me */
  issueSession(s: Staff) {
    return { accessToken: this.signAccess(s), refreshToken: this.signRefresh(s), user: this.toMe(s) };
  }

  async login(loginId: string, password: string) {
    // 아이디는 형식이 자유이고(W10 · 대표 지시 2026-09-26) 대소문자를 가리지 않는다(W8) — 저장된 모양과 달라도 같은 계정이다.
    // 비교는 DB 의 lower() 한 곳에서 한다 — JS 와 DB 의 소문자 규칙이 갈리는 글자가 있어도 색인과 같은 판정이다.
    // 둘 이상 맞으면 어느 쪽인지 고르지 않는다(lower(login_id) 유일 색인이 그런 행을 막지만 판정은 여기서도 닫는다).
    const id = normalizeLoginId(loginId);
    const fail = () => new UnauthorizedException('아이디 또는 비밀번호가 맞지 않습니다');
    if (!id) throw fail();
    const found = await this.staff.find({
      where: { loginId: Raw((col) => `lower(${col}) = lower(:login)`, { login: id }), active: true },
      take: 2,
    });
    // 계정이 없는 것과 비밀번호가 틀린 것을 **같은 문구**로 답한다 —
    // 다르게 답하면 어떤 아이디가 등록돼 있는지 밖에서 알아낼 수 있다.
    if (found.length !== 1) throw fail();
    const s = found[0];

    if (!s.passwordHash || !(await bcrypt.compare(password, s.passwordHash))) throw fail();

    return this.issueSession(s);
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
    let sub: unknown;
    let iat: unknown;
    try {
      ({ sub, iat } = this.jwt.verify<{ sub?: unknown; iat?: unknown }>(token, {
        secret: process.env.JWT_REFRESH_SECRET ?? 'dev-only-change-me-too',
      }));
    } catch {
      throw new UnauthorizedException('다시 로그인해 주세요');
    }
    const s = await this.activeStaff(sub);
    // Refresh 도 같은 재설정 시각으로 끊는다 — Access 만 끊으면 쿠키로 새 Access 를 다시 받아 간다
    this.assertIssuedAfterReset(s, iat);
    return { accessToken: this.signAccess(s) };
  }

  async me(id: number): Promise<MeDto> {
    const s = await this.activeStaff(id);
    return this.toMe(s);
  }
}
