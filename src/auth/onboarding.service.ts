/** @file-guide
 * 목적: onboarding.service.ts — OnboardingService (auth)
 * 책임/재사용: 공용 인증/권한 경계만 소유한다. 토큰·쿠키 원문을 노출하지 않고 만료/익명/권한 회수 경계를 회귀로 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 계정 첫 설정 (W8 · 대표 지시 2026-09-26).
 *
 * 「운영 시 초기 비밀번호는 모두 (초기 비밀번호 — 값은 src/lib/account-policy.ts 한 곳) · 첫 로그인 시 아이디 및 비밀번호 강제 변경 · phone · email 인증 필수
 *  (변경 안 하면 홈 페이지 접속 불가, 자동 리다이렉션)」.
 *
 * 세 가지를 지킨다.
 *   ① **코드와 받는 곳 원문을 남기지 않는다** — 원장(auth_code)에는 서버 비밀로 만든 HMAC 과 가린 받는 곳만 있다.
 *      로그 · 오류 문장 · LOG 표에도 코드 · 받는 곳 · 해시 · 비밀번호가 나가지 않는다(가린 모양만).
 *   ② **횟수 제한은 원장에서 센다** — 서버리스라 메모리 상태가 요청 사이에 남지 않는다.
 *      같은 계정 행을 FOR UPDATE 로 잡고 세므로 동시에 두 번 눌러도 한 줄씩 선다.
 *   ③ **틀린 횟수는 실패한 요청 뒤에도 남는다** — 거절을 던지면 트랜잭션이 되돌려져 횟수가 사라지고,
 *      그러면 다섯 번 제한이 없는 것과 같다. 그래서 틀림은 「거절 값」으로 돌려받아 **커밋한 뒤** 던진다.
 *      계정 행 잠금 덕에 병렬 추측도 한 줄로 서서 다섯 번을 넘지 못한다.
 *
 * 아이디 강제 변경의 뜻(결정 · W8): 새 아이디(이메일)는 **반드시 다시 적고 그 주소로 받은 코드로 확인**한다.
 * 지금 이메일과 같아도 되지만 그 주소가 실제로 코드를 받을 때만이다 — 자리표시 주소는 확인할 수 없으니 사실상 바뀐다.
 */
import {
  BadGatewayException, BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, type EntityManager } from 'typeorm';
import { randomInt } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { Staff } from '../entities';
import { AuthService } from './auth.service';
import {
  PASSWORD_ISSUE_MESSAGE, PASSWORD_RULE_TEXT, normalizeLoginEmail, normalizeMobile, passwordIssue,
} from '../lib/account-policy';
import { PHONE_COUNTRIES } from '../lib/phone';
import {
  CHANNEL_SPECS, SENDER, isEmail, maskEmail, maskPhone, type SendChannel, type SendResult, type Sender,
} from '../modules/notify/sender';
import {
  CODE_RESEND_SECONDS, CODE_TTL_MINUTES, authCodeSecret, codeChannels, codeLimitIssue, codeMessage, devEcho, insertCode,
  notConfigured, secretMissing, verifyCode,
} from './auth-code';
import type {
  OnboardingCodeRequestDto, OnboardingCodeResultDto, OnboardingCompleteDto, OnboardingInfoDto,
} from './dto/onboarding.dto';

/** staff.email varchar(120) — 더 긴 주소는 저장 전에 400 으로 막는다(DB 오류 문장으로 새지 않게) */
const EMAIL_MAX = 120;

/** 휴대폰 모양 거절 — 해외 번호도 받는다(N-103). 번호 원문은 싣지 않는다 */
export const INVALID_PHONE_MESSAGE = '휴대폰 번호 형식이 아닙니다 — 국가번호를 고르고 번호를 적어 주세요(한국은 010 으로 시작)';

const notRequired = () => new ConflictException({ code: 'ONBOARDING_NOT_REQUIRED', message: '이미 첫 설정을 마친 계정입니다' });
const emailTaken = () => new ConflictException({ code: 'EMAIL_TAKEN', message: '이미 다른 계정이 쓰는 이메일입니다 — 다른 주소를 적어 주세요' });

@Injectable()
export class OnboardingService {
  private readonly log = new Logger('Onboarding');

  constructor(
    private readonly ds: DataSource,
    @InjectRepository(Staff) private readonly staff: Repository<Staff>,
    private readonly auth: AuthService,
    @Inject(SENDER) private readonly sender: Sender,
  ) {}

  /** 첫 설정 판정에 필요한 칸만 — 비밀번호 해시는 「지금 비밀번호와 같은가」에만 쓰고 밖으로 내보내지 않는다 */
  private async current(staffId: number) {
    const [s] = (await this.ds.query(
      `SELECT email, phone, password_hash, must_change_credentials AS must FROM staff WHERE id = $1 AND active`,
      [staffId],
    )) as Array<{ email: string; phone: string | null; password_hash: string | null; must: boolean }>;
    if (!s) throw new UnauthorizedException('다시 로그인해 주세요');
    return s;
  }

  /** 받는 곳을 저장 · 비교 모양으로 — 이메일은 아이디 규칙(소문자 · 공백 없음), 휴대폰은 한국 숫자만 · 해외 `+국가번호…`(lib/phone) */
  private target(channel: SendChannel, raw: string): string {
    if (channel === 'email') {
      const email = normalizeLoginEmail(raw);
      if (!isEmail(email) || email.length > EMAIL_MAX) {
        throw new BadRequestException({ code: 'INVALID_EMAIL', message: '이메일 형식이 아닙니다 — 예: kim@tnacademy.kr' });
      }
      return email;
    }
    const phone = normalizeMobile(raw);
    if (!phone) throw new BadRequestException({ code: 'INVALID_PHONE', message: INVALID_PHONE_MESSAGE });
    return phone;
  }

  /** 다른 계정이 이미 쓰는 이메일인가 — 대소문자를 가리지 않는다(비활성 계정 포함 · 유일 색인과 같은 범위) */
  private async emailTaken(m: EntityManager | DataSource, email: string, staffId: number): Promise<boolean> {
    const rows = await m.query('SELECT 1 FROM staff WHERE lower(email) = $1 AND id <> $2 LIMIT 1', [email, staffId]);
    return rows.length > 0;
  }

  async info(staffId: number): Promise<OnboardingInfoDto> {
    const s = await this.current(staffId);
    return {
      required: s.must,
      loginId: s.email,
      phoneMasked: s.phone ? maskPhone(s.phone) : null,
      passwordRule: PASSWORD_RULE_TEXT,
      codeTtlMinutes: CODE_TTL_MINUTES,
      resendAfterSeconds: CODE_RESEND_SECONDS,
      // 낱말 · 못 보내는 까닭 · 코드 비밀 값 없음(N-105)은 원장 한 곳(auth-code.codeChannels) — 비밀번호 찾기와 같은 표
      channels: codeChannels(this.sender),
      // 국가번호 고르기의 나라 목록 — 저장 · 발송 규칙과 같은 표(lib/phone · N-103)
      phoneCountries: PHONE_COUNTRIES.map((c) => ({ ...c })),
    };
  }

  async sendCode(staffId: number, dto: OnboardingCodeRequestDto): Promise<OnboardingCodeResultDto> {
    const s = await this.current(staffId);
    if (!s.must) throw notRequired();
    const channel = dto.channel;
    const to = this.target(channel, dto.target);
    if (channel === 'email' && (await this.emailTaken(this.ds, to, staffId))) throw emailTaken();

    // 운영에 코드 비밀 값이 없으면 줄을 만들지 않는다(N-105 · 대표 결정 2026-09-26 「운영용 코드 비밀 값 분리」)
    if (!authCodeSecret()) throw secretMissing();
    const ready = this.sender.ready(channel);
    const echo = !ready && devEcho();
    // 보낼 수 없으면 줄을 만들지 않는다 — 받지도 못한 코드가 원장에 「쓸 수 있는」 채로 남지 않게
    if (!ready && !echo) throw notConfigured(channel);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const masked = CHANNEL_SPECS[channel].mask(to);
    const row = await this.ds.transaction(async (m) => {
      const [cur] = await m.query(
        'SELECT must_change_credentials AS must FROM staff WHERE id = $1 AND active FOR UPDATE', [staffId],
      );
      if (!cur) throw new UnauthorizedException('다시 로그인해 주세요');
      if (!cur.must) throw notRequired();
      // 발급 한도(60초 · 하루 10번 · 한 시간 5번)는 원장 한 곳이 센다 — 비밀번호 찾기와 같은 함수 · 같은 예산
      const limit = await codeLimitIssue(m, staffId, channel);
      if (limit) throw new HttpException(limit, HttpStatus.TOO_MANY_REQUESTS);
      return insertCode(m, { staffId, channel, purpose: 'onboarding', to, masked, code });
    });

    const result: OnboardingCodeResultDto = {
      channel, targetMasked: masked, expiresAt: new Date(row.expires_at).toISOString(), resendAfterSeconds: CODE_RESEND_SECONDS,
    };
    if (echo) return { ...result, devCode: code };

    const sent = await this.deliver(channel, to, code);
    if (!sent.configured || !sent.ok) {
      // 받지 못한(혹은 받았는지 모르는) 코드는 쓸 수 없게 닫는다. 발송 시도는 횟수에 그대로 센다(공급자 연타 방지)
      await this.ds.query('UPDATE auth_code SET consumed_at = now() WHERE id = $1', [row.id]);
      // 받는 곳 · 코드 · 공급자 문장(주소를 되돌려 싣는다)은 남기지 않는다
      this.log.warn(`첫 설정 코드를 보내지 못했습니다 — 계정 ${staffId} · ${CHANNEL_SPECS[channel].label}`);
      if (!sent.configured) throw notConfigured(channel);
      throw new BadGatewayException({
        code: 'SEND_FAILED', message: `${CHANNEL_SPECS[channel].label}로 코드를 보내지 못했습니다 — 잠시 뒤 다시 받아 주세요`,
      });
    }
    return result;
  }

  /** 제목 · 본문에 내부 코드를 싣지 않는다. 문자는 SMS 한 통(90바이트) 안에 든다 — 문장은 원장 한 곳(auth-code.codeMessage) */
  private async deliver(channel: SendChannel, to: string, code: string): Promise<SendResult> {
    try {
      return await this.sender.send(codeMessage(channel, 'onboarding', to, code));
    } catch {
      return { configured: true, ok: false, providerId: null, error: null };
    }
  }

  async complete(staffId: number, dto: OnboardingCompleteDto) {
    const s = await this.current(staffId);
    if (!s.must) throw notRequired();
    const email = this.target('email', dto.email);
    const phone = this.target('sms', dto.phone);
    // 코드 확인은 해시가 필요하다 — 운영에 비밀 값이 없으면 확인 전에 같은 503 으로 답한다(N-105)
    if (!authCodeSecret()) throw secretMissing();
    const issue = passwordIssue(dto.password);
    if (issue) throw new BadRequestException({ code: 'PASSWORD_RULE', message: PASSWORD_ISSUE_MESSAGE[issue] });
    if (s.password_hash && (await bcrypt.compare(dto.password, s.password_hash))) {
      throw new ConflictException({ code: 'SAME_AS_CURRENT', message: '지금 비밀번호와 다른 새 비밀번호를 정해 주세요' });
    }
    if (await this.emailTaken(this.ds, email, staffId)) throw emailTaken();

    // 해시는 잠금 밖에서 만든다(느린 일을 계정 행 잠금 안에 두지 않는다)
    const hash = await bcrypt.hash(dto.password, 10);
    // 서버 시계로 찍는다 — 새 토큰의 iat 가 같은 시계에서 뒤에 나오므로 새 토큰이 스스로 끊기지 않는다(DB 시계 어긋남과 무관)
    const changedAt = new Date();
    let outcome: { ok: true } | { error: HttpException };
    try {
      outcome = await this.ds.transaction(async (m) => {
        const [cur] = await m.query(
          `SELECT email, phone, must_change_credentials AS must, email_verified, phone_verified
             FROM staff WHERE id = $1 AND active FOR UPDATE`,
          [staffId],
        );
        if (!cur) return { error: new UnauthorizedException('다시 로그인해 주세요') };
        if (!cur.must) return { error: notRequired() };
        const byEmail = await verifyCode(m, { staffId, channel: 'email', purpose: 'onboarding', to: email, submitted: dto.emailCode });
        if ('error' in byEmail) return byEmail;
        const bySms = await verifyCode(m, { staffId, channel: 'sms', purpose: 'onboarding', to: phone, submitted: dto.phoneCode });
        if ('error' in bySms) return bySms;

        await m.query(
          `UPDATE staff SET email = $2, password_hash = $3, phone = $4, email_verified = true, phone_verified = true,
                            must_change_credentials = false, credentials_changed_at = $5
            WHERE id = $1`,
          [staffId, email, hash, phone, changedAt],
        );
        // 쓴 두 코드와 함께 이 계정의 남은 코드도 모두 닫는다 — 나중에 다시 첫 설정이 걸려도 옛 코드가 살아 있지 않게
        await m.query(
          'UPDATE auth_code SET consumed_at = now() WHERE (id = ANY($1::bigint[]) OR staff_id = $2) AND consumed_at IS NULL',
          [[byEmail.id, bySms.id], staffId],
        );
        // 감사 기록 — 가린 이메일 · 휴대폰과 상태 칸만. 비밀번호 · 코드 · 해시 · 원문 연락처는 싣지 않는다
        await m.query(
          `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
           VALUES ($1, 'STAFF', $1, 'onboarding', $2::jsonb, $3::jsonb)`,
          [
            staffId,
            JSON.stringify({
              email: maskEmail(cur.email), phone: cur.phone ? maskPhone(cur.phone) : null,
              emailVerified: cur.email_verified, phoneVerified: cur.phone_verified, mustChangeCredentials: true,
            }),
            JSON.stringify({
              email: maskEmail(email), phone: maskPhone(phone),
              emailVerified: true, phoneVerified: true, mustChangeCredentials: false,
            }),
          ],
        );
        return { ok: true as const };
      });
    } catch (e) {
      // 확인과 저장 사이에 다른 계정이 같은 이메일을 가져간 경우 — 유일 제약이 막고 같은 거절로 답한다
      if ((e as { code?: string })?.code === '23505') throw emailTaken();
      throw e;
    }
    if ('error' in outcome) throw outcome.error;

    const fresh = await this.staff.findOne({ where: { id: staffId, active: true } });
    if (!fresh) throw new UnauthorizedException('다시 로그인해 주세요');
    return this.auth.issueSession(fresh);
  }
}
