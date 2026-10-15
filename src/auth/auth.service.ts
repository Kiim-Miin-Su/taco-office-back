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
  /** 내부 자격 버전 — STAFF.credentialsChangedAt의 ms 값. 업무 DTO에는 내보내지 않는다. */
  cv?: number;
}

/** Access/Refresh가 공유한다. ORM에 누락 식별자를 전달하면 조건이 무시될 수 있다. */
export const isJwtSubject = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** 필수 초기설정 판정에 쓰는 STAFF 칸 셋 — 엔티티 · 원시 SQL 행 어느 쪽에서 와도 같은 함수로 본다 */
export interface CredentialSetupState {
  mustChangeCredentials: boolean | null | undefined;
  emailVerified: boolean | null | undefined;
  phoneVerified: boolean | null | undefined;
}

/**
 * AUTH-INIT-02 (사용자 결정 2026-10-16) — 필수 초기설정(휴대폰 인증 · 이메일 인증 · 비밀번호 교체)이 남았는가. **판정은 여기 한 곳**이다.
 * currentUser(→ OnboardingGuard) · MeDto.mustChangeCredentials · 로그인/첫 설정 결과 · 첫 설정 경로의 must 검사 ·
 * 구성원 목록 칩이 모두 이 함수(또는 같은 식의 `credentialSetupRequiredSql`)를 쓴다. 역할 · 로그인 ID 로 면제하지 않는다.
 *
 * 완료 증거 = 잠금 해제(must=false) **그리고** 두 인증(email_verified · phone_verified). 근거(2026-10-16 writer 전수 대조):
 *  - 1763600000000 은 기존 행을 보정하지 않았다(email_verified 기본 false) — 옛 계정 · 초기3계정 면제는 증거가 없다.
 *  - email_verified=true 를 쓰는 곳은 첫 설정 완료(두 코드 + 새 비밀번호 + 잠금 해제를 한 transaction)와,
 *    이미 완료한 계정만 부를 수 있는 본인 연락처 변경(ProfileService)뿐이다.
 *  - 남이 비밀번호를 다시 정하는 경로(관리자 초기화 · 운영 전환 · 초기 발급)는 must=true 를 함께 켠다. 관리자의 연락처 수정은
 *    바뀐 채널의 인증을 끄고 must=true 를 켠다(N-104). 비밀번호 찾기는 두 인증 계정만 쓰고 must 를 건드리지 않는다.
 *  - 예외: 1769700000000 이전 초기 발급 코드는 개명 시 must=false 로 공통 비밀번호를 덮었다 — 그 뒤에 첫 설정 기록이 없는
 *    「완료처럼 보이는」 계정은 migration 1769700000000 이 세어서 멈춘다(추정 보정 금지).
 * 이 판정을 바꾸면 SQL 식 · migration preflight · 계약 문서 · 구성원 칩 · 시험을 같은 청크에서 함께 바꾼다.
 */
export const credentialSetupRequired = (s: CredentialSetupState): boolean =>
  s.mustChangeCredentials === true || s.emailVerified !== true || s.phoneVerified !== true;

/** 같은 판정의 SQL 식 — 원시 SQL 로 STAFF 를 읽는 곳(첫 설정 · 프로필 · 구성원 목록)이 쓴다. alias 는 코드 상수만 넘긴다 */
export const credentialSetupRequiredSql = (alias: string): string =>
  `(${alias}.must_change_credentials OR NOT ${alias}.email_verified OR NOT ${alias}.phone_verified)`;

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
        'mustChangeCredentials', 'emailVerified', 'phoneVerified', 'credentialsChangedAt',
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
   * 권고안 채택(R118-06): 새 토큰은 발급 때 읽은 STAFF의 ms 자격 버전과 현재 값을 비교한다.
   * 같은 초 reset·늦은 로그인 발급 경합도 닫는다. cv가 없는 옛 토큰은 변경 다음 초 이후만 허용한다.
   * DB timestamp를 JS Date로 읽는 기존 ms 정밀도를 사용한다. 같은 1ms의 복수 reset을 구별하려면
   * 별도 단조 증가 DB 버전이 필요하며 그 변경은 인증·migration·운영 인계·portfolio를 함께 갱신한다.
   */
  private assertIssuedAfterReset(s: Staff, iat: unknown, cv?: unknown): void {
    const currentVersion = this.credentialVersion(s);
    if (cv !== undefined) {
      if (typeof cv !== 'number' || !Number.isSafeInteger(cv) || cv < 0 || cv !== currentVersion) {
        throw new UnauthorizedException('다시 로그인해 주세요');
      }
      return;
    }
    if (!s.credentialsChangedAt) {
      return;
    }
    const cutoff = Math.floor(currentVersion / 1000);
    if (typeof iat !== 'number' || !Number.isSafeInteger(iat) || iat <= cutoff) {
      throw new UnauthorizedException('다시 로그인해 주세요');
    }
  }

  /** 세션 시계 대신 DB의 자격 변경 버전을 사용해 stale STAFF로 뒤늦게 만든 토큰도 구별한다. */
  private credentialVersion(s: Staff): number {
    const version = s.credentialsChangedAt ? new Date(s.credentialsChangedAt).getTime() : 0;
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new UnauthorizedException('다시 로그인해 주세요');
    }
    return version;
  }

  /** 서명된 옛 권한을 재사용하지 않는다. PermGuard와 모든 service가 같은 현재 사용자로 판정한다. */
  async currentUser(id: number, iat?: number, cv?: unknown): Promise<RequestUser> {
    const s = await this.activeStaff(id);
    this.assertIssuedAfterReset(s, iat, cv);
    return {
      id: Number(s.id), name: s.name, role: s.role, perms: this.overridesOf(s),
      // 첫 설정 잠금은 토큰이 아니라 현재 STAFF 가 정한다 — OnboardingGuard 가 이 값만 본다(AUTH-INIT-02 판정 한 곳)
      mustChange: credentialSetupRequired(s),
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
      // 화면이 첫 설정으로 보낼지 여기서만 안다 — 늘 채운다(W8). 가드와 같은 판정(AUTH-INIT-02)
      mustChangeCredentials: credentialSetupRequired(s),
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
      cv: this.credentialVersion(s),
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
      { sub: Number(s.id), cv: this.credentialVersion(s) },
      {
        secret: process.env.JWT_REFRESH_SECRET ?? 'dev-only-change-me-too',
        expiresIn: (process.env.JWT_REFRESH_EXPIRES ?? '14d') as Expires,
      },
    );
  }

  async refresh(token: string) {
    let sub: unknown;
    let iat: unknown;
    let cv: unknown;
    try {
      ({ sub, iat, cv } = this.jwt.verify<{ sub?: unknown; iat?: unknown; cv?: unknown }>(token, {
        secret: process.env.JWT_REFRESH_SECRET ?? 'dev-only-change-me-too',
      }));
    } catch {
      throw new UnauthorizedException('다시 로그인해 주세요');
    }
    const s = await this.activeStaff(sub);
    // Refresh 도 같은 재설정 시각으로 끊는다 — Access 만 끊으면 쿠키로 새 Access 를 다시 받아 간다
    this.assertIssuedAfterReset(s, iat, cv);
    return { accessToken: this.signAccess(s) };
  }

  async me(id: number): Promise<MeDto> {
    const s = await this.activeStaff(id);
    return this.toMe(s);
  }
}
