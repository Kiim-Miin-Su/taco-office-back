/** @file-guide
 * 목적: password-reset.service.ts — PasswordResetService (auth)
 * 책임/재사용: 공용 인증/권한 경계만 소유한다. 토큰·쿠키 원문을 노출하지 않고 만료/익명/권한 회수 경계를 회귀로 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 비밀번호 찾기 (N-101 · 대표 결정 2026-09-26 · 아이디는 W10 부터 형식 자유).
 *
 * 「로그인 화면에 비밀번호 찾기 — 등록된 이메일과 휴대폰 코드를 **둘 다** 확인해야 새 비밀번호를 정한다 · 옛 세션은 끊는다 · 모든 역할」.
 *
 * 첫 설정(onboarding.service)과 같은 원장 · 같은 한도 · 같은 문장 함수(auth-code)를 쓰고, 다른 것은 셋이다.
 *   ① **로그인 전 경로다** — 그래서 계정이 있는지 말하지 않는다. 코드 받기는 계정이 없거나 · 확인되지 않았거나 · 한도에 걸렸거나 ·
 *      보내지 못했어도 **같은 모양**으로 답한다(설정 없음 503 만 따로 — 계정과 무관한 서버 상태다). 마치기는 계정 · 코드 문제를
 *      한 문장(RESET_CODE_INVALID)으로 답한다. 로그인이 「아이디 또는 비밀번호가 맞지 않습니다」 하나로 답하는 것과 같은 원칙이다.
 *   ② **코드는 등록 · 확인된 곳으로만 간다** — 받는 곳을 적게 하지 않는다. 쓸 수 있는 계정은 사용 중이고 이메일 · 휴대폰을
 *      둘 다 확인한(첫 설정을 마친) 계정뿐이다. 관리자가 연락처를 바꾸면 확인이 풀리므로(N-104) 확인 안 된 곳으로 가지 않는다.
 *   ③ **첫 설정 상태는 그대로 둔다** — 비밀번호만 바꾸고 옛 세션을 끊는다(credentials_changed_at). 첫 설정을 건너뛰는 길이 아니다.
 *
 * 「지금 비밀번호와 같다」는 **두 코드를 확인한 뒤에만** 말한다 — 코드 없이 비밀번호를 떠보는 길이 되지 않게.
 * 틀린 횟수는 실패한 요청 뒤에도 남는다(거절 값을 커밋한 뒤 던진다 · 첫 설정과 같다).
 */
import { BadRequestException, ConflictException, Inject, Injectable, Logger, type HttpException } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { randomInt } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import {
  LOGIN_ID_ISSUE_MESSAGE, PASSWORD_ISSUE_MESSAGE, PASSWORD_RULE_TEXT, loginIdIssue, normalizeLoginId, passwordIssue,
} from '../lib/account-policy';
import { CHANNEL_SPECS, SENDER, type SendChannel, type SendResult, type Sender } from '../modules/notify/sender';
import {
  CODE_MAX_ATTEMPTS, CODE_RESEND_SECONDS, CODE_TTL_MINUTES, authCodeSecret, codeChannels, codeLimitIssue, codeMessage,
  devEcho, insertCode, notConfigured, secretMissing, verifyCode,
} from './auth-code';
import type {
  PasswordResetCodeRequestDto, PasswordResetCodeResultDto, PasswordResetCompleteDto, PasswordResetInfoDto,
} from './dto/password-reset.dto';

/** 코드 받기의 안내 — 계정이 있든 없든 같은 문장이다(보낸 곳 · 계정 여부를 싣지 않는다) */
const SENT_MESSAGE: Record<SendChannel, string> = {
  email: `입력한 아이디에 확인된 이메일이 있으면 그 주소로 코드를 보냈습니다 — ${CODE_TTL_MINUTES}분 안에 입력해 주세요. `
    + '받지 못했다면 관리자에게 비밀번호 초기화를 요청하세요',
  sms: `입력한 아이디에 확인된 휴대폰이 있으면 그 번호로 코드를 보냈습니다 — ${CODE_TTL_MINUTES}분 안에 입력해 주세요. `
    + '받지 못했다면 관리자에게 비밀번호 초기화를 요청하세요',
};

/** 마치기의 거절 한 문장 — 계정 없음 · 확인 안 됨 · 코드 없음 · 만료 · 잠김 · 틀림을 가르지 않는다 */
export const RESET_CODE_INVALID_MESSAGE =
  `아이디 또는 확인 코드가 맞지 않습니다 — 코드를 확인하거나 다시 받아 주세요(코드는 ${CODE_TTL_MINUTES}분 · ${CODE_MAX_ATTEMPTS}번 틀리면 끝납니다)`;
const codeInvalid = () => new ConflictException({ code: 'RESET_CODE_INVALID', message: RESET_CODE_INVALID_MESSAGE });
const sameAsCurrent = () =>
  new ConflictException({ code: 'SAME_AS_CURRENT', message: '지금 비밀번호와 다른 새 비밀번호를 정해 주세요' });

/** 비밀번호 찾기를 쓸 수 있는 계정의 칸 — 해시는 「지금 비밀번호와 같은가」에만 쓰고 밖으로 내보내지 않는다 */
type Eligible = { id: number; email: string; phone: string; passwordHash: string | null };

@Injectable()
export class PasswordResetService {
  private readonly log = new Logger('PasswordReset');

  constructor(
    private readonly ds: DataSource,
    @Inject(SENDER) private readonly sender: Sender,
  ) {}

  /**
   * 쓸 수 있는 계정 — 사용 중 · 이메일과 휴대폰이 있고 둘 다 확인함. 아이디는 대소문자를 가리지 않는다(로그인과 같다 · W10).
   * `lock` 이면 계정 행을 잡는다 — 같은 계정의 발급 · 확인이 한 줄로 선다(한도를 병렬로 넘지 못하게).
   */
  private async eligible(m: EntityManager | DataSource, loginId: string, lock = false): Promise<Eligible | null> {
    const rows = (await m.query(
      `SELECT id, email, phone, password_hash FROM staff
        WHERE lower(login_id) = lower($1) AND active
          AND email IS NOT NULL AND email_verified AND phone IS NOT NULL AND phone_verified
        ${lock ? 'FOR UPDATE' : ''}`,
      [loginId],
    )) as Array<{ id: string; email: string; phone: string; password_hash: string | null }>;
    // lower(login_id) 유일 색인이 둘을 막지만 판정은 여기서도 닫는다(로그인과 같다)
    if (rows.length !== 1) return null;
    const [r] = rows;
    return { id: Number(r.id), email: r.email, phone: r.phone, passwordHash: r.password_hash };
  }

  info(): PasswordResetInfoDto {
    return {
      passwordRule: PASSWORD_RULE_TEXT,
      codeTtlMinutes: CODE_TTL_MINUTES,
      resendAfterSeconds: CODE_RESEND_SECONDS,
      channels: codeChannels(this.sender),
    };
  }

  /** 적은 아이디 — `loginId`(W10) 또는 옛 화면의 `email`. 모양 거절은 계정과 무관하다 — 계정 여부를 알려 주지 않는다 */
  private loginIdOf(dto: { loginId?: string; email?: string }): string {
    const raw = dto.loginId ?? dto.email ?? '';
    const issue = loginIdIssue(raw);
    if (issue) throw new BadRequestException({ code: 'INVALID_LOGIN_ID', message: LOGIN_ID_ISSUE_MESSAGE[issue] });
    return normalizeLoginId(raw);
  }

  async sendCode(dto: PasswordResetCodeRequestDto): Promise<PasswordResetCodeResultDto> {
    const channel = dto.channel;
    const loginId = this.loginIdOf(dto);
    // 서버 설정이 없으면 모두에게 같은 503 — 이것도 계정과 무관하다(N-105 · 첫 설정과 같은 문장)
    if (!authCodeSecret()) throw secretMissing();
    const ready = this.sender.ready(channel);
    const echo = !ready && devEcho();
    if (!ready && !echo) throw notConfigured(channel);

    const uniform = (expiresAt: Date): PasswordResetCodeResultDto => ({
      channel, message: SENT_MESSAGE[channel], expiresAt: expiresAt.toISOString(), resendAfterSeconds: CODE_RESEND_SECONDS,
    });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const issued = await this.ds.transaction(async (m) => {
      const s = await this.eligible(m, loginId, true);
      if (!s) return null;
      // 발급 한도(60초 · 하루 10번 · 한 시간 5번)는 첫 설정과 같은 예산이다(계정 · 채널마다 · N-105).
      // 걸려도 같은 모양으로 답한다 — 다르게 답하면 그 아이디가 있다는 것이 드러난다
      const limit = await codeLimitIssue(m, s.id, channel);
      if (limit) {
        this.log.warn(`비밀번호 찾기 코드 한도 — 계정 ${s.id} · ${CHANNEL_SPECS[channel].label} · ${limit.code}`);
        return null;
      }
      const to = channel === 'email' ? s.email : s.phone;
      const row = await insertCode(m, {
        staffId: s.id, channel, purpose: 'password_reset', to, masked: CHANNEL_SPECS[channel].mask(to), code,
      });
      return { staffId: s.id, to, row };
    });
    const fallback = new Date(Date.now() + CODE_TTL_MINUTES * 60_000);
    if (!issued) return uniform(fallback);

    const result = uniform(new Date(issued.row.expires_at));
    if (echo) return { ...result, devCode: code };
    const sent = await this.deliver(channel, issued.to, code);
    if (!sent.configured || !sent.ok) {
      // 받지 못한(혹은 받았는지 모르는) 코드는 쓸 수 없게 닫는다. 답은 그대로다 — 보내지 못한 것도 계정이 있다는 뜻이라서
      await this.ds.query('UPDATE auth_code SET consumed_at = now() WHERE id = $1', [issued.row.id]);
      // 받는 곳 · 코드 · 공급자 문장(주소를 되돌려 싣는다)은 남기지 않는다
      this.log.warn(`비밀번호 찾기 코드를 보내지 못했습니다 — 계정 ${issued.staffId} · ${CHANNEL_SPECS[channel].label}`);
    }
    return result;
  }

  /** 문장은 원장 한 곳(auth-code.codeMessage) — 해외 번호는 국제 문자 인증 문장 모양 */
  private async deliver(channel: SendChannel, to: string, code: string): Promise<SendResult> {
    try {
      return await this.sender.send(codeMessage(channel, 'password_reset', to, code));
    } catch {
      return { configured: true, ok: false, providerId: null, error: null };
    }
  }

  async complete(dto: PasswordResetCompleteDto): Promise<void> {
    // 규칙 거절은 계정과 무관하다 — 먼저 답한다(첫 설정과 같은 문장)
    const issue = passwordIssue(dto.password);
    if (issue) throw new BadRequestException({ code: 'PASSWORD_RULE', message: PASSWORD_ISSUE_MESSAGE[issue] });
    if (!authCodeSecret()) throw secretMissing();
    const loginId = this.loginIdOf(dto);
    const found = await this.eligible(this.ds, loginId);
    if (!found) throw codeInvalid();

    // 느린 일(해시 · 비교)은 계정 행 잠금 밖에서 한다. 비교 결과는 두 코드를 확인한 뒤에만 쓴다
    const hash = await bcrypt.hash(dto.password, 10);
    const same = !!found.passwordHash && (await bcrypt.compare(dto.password, found.passwordHash));
    // 서버 시계로 찍는다 — 옛 토큰의 iat 는 이보다 앞이므로 끊긴다(첫 설정 · 관리자 초기화와 같다)
    const changedAt = new Date();

    const outcome: { ok: true } | { error: HttpException } = await this.ds.transaction(async (m) => {
      const s = await this.eligible(m, loginId, true);
      if (!s || s.id !== found.id) return { error: codeInvalid() };
      const byEmail = await verifyCode(m, {
        staffId: s.id, channel: 'email', purpose: 'password_reset', to: s.email, submitted: dto.emailCode,
      });
      if ('error' in byEmail) return { error: codeInvalid() };
      const bySms = await verifyCode(m, {
        staffId: s.id, channel: 'sms', purpose: 'password_reset', to: s.phone, submitted: dto.phoneCode,
      });
      if ('error' in bySms) return { error: codeInvalid() };
      // 잠금 전에 읽은 해시가 그새 바뀌었으면 지금 해시로 다시 본다(드문 경우 — 느려도 정확하게)
      const sameNow = s.passwordHash === found.passwordHash
        ? same
        : !!s.passwordHash && (await bcrypt.compare(dto.password, s.passwordHash));
      // 코드는 닫지 않는다 — 다른 비밀번호로 곧바로 다시 마칠 수 있게
      if (sameNow) return { error: sameAsCurrent() };

      await m.query(
        'UPDATE staff SET password_hash = $2, credentials_changed_at = $3 WHERE id = $1',
        [s.id, hash, changedAt],
      );
      // 쓴 두 코드와 함께 이 계정의 남은 코드도 모두 닫는다(첫 설정 코드 포함 — 옛 코드가 살아 있지 않게)
      await m.query('UPDATE auth_code SET consumed_at = now() WHERE staff_id = $1 AND consumed_at IS NULL', [s.id]);
      // 감사 기록 — 확인한 채널과 세션을 끊었다는 사실만. 비밀번호 · 코드 · 해시 · 연락처는 싣지 않는다
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
         VALUES ($1, 'STAFF', $1, 'password_recover', NULL, $2::jsonb)`,
        [s.id, JSON.stringify({ verified: ['email', 'sms'], sessionsCut: true })],
      );
      return { ok: true as const };
    });
    if ('error' in outcome) throw outcome.error;
  }
}
