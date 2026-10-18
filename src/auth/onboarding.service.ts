/** @file-guide
 * 목적: onboarding.service.ts — OnboardingService (auth)
 * 책임/재사용: 공용 인증/권한 경계만 소유한다. 토큰·쿠키 원문을 노출하지 않고 만료/익명/권한 회수 경계를 회귀로 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 계정 첫 설정 (W8 · W10 · 대표 지시 2026-09-26).
 *
 * W8: 「첫 로그인 시 비밀번호 강제 변경 · phone · email 인증 필수 (변경 안 하면 홈 페이지 접속 불가, 자동 리다이렉션)」.
 * W10: 「매니저가 아이디 비번 만들면 db 에 저장 → 초기 설정 시 주요 인증 및 비번 재설정」 — **아이디는 여기서 바꾸지 않는다**
 * (매니저가 정한 그대로다 · 형식 자유). 이메일은 연락 · 인증용이고, 코드로 확인한 주소가 그 계정의 이메일이 된다.
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
 * 이메일 확인의 뜻(W8 · W10): 이메일은 **반드시 다시 적고 그 주소로 받은 코드로 확인**한다.
 * 매니저가 적어 둔 이메일과 같아도 되지만 그 주소가 실제로 코드를 받을 때만이다 — 비워 두고 만든 계정은 여기서 처음 적는다.
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
import { AuthService, credentialSetupRequiredSql } from './auth.service';
import {
  PASSWORD_ISSUE_MESSAGE, PASSWORD_RULE_TEXT, normalizeEmail, normalizeMobile, passwordIssue,
} from '../lib/account-policy';
import { PHONE_COUNTRIES } from '../lib/phone';
import {
  CHANNEL_SPECS, SENDER, isEmail, maskEmail, maskPhone, type SendChannel, type SendResult, type Sender,
} from '../modules/notify/sender';
import {
  CODE_RESEND_SECONDS, CODE_TTL_MINUTES, authCodeSecret, codeChannels, codeLimitIssue, codeMessage, devEcho, insertCode,
  notConfigured, onboardingProofs, secretMissing, verifyCode, type OnboardingProof,
} from './auth-code';
import type {
  OnboardingCodeRequestDto, OnboardingCodeResultDto, OnboardingCompleteDto, OnboardingInfoDto, OnboardingVerifyDto,
} from './dto/onboarding.dto';

/** staff.email varchar(120) — 더 긴 주소는 저장 전에 400 으로 막는다(DB 오류 문장으로 새지 않게) */
const EMAIL_MAX = 120;

/** 휴대폰 모양 거절 — 해외 번호도 받는다(N-103). 번호 원문은 싣지 않는다 */
export const INVALID_PHONE_MESSAGE = '휴대폰 번호 형식이 아닙니다 — 국가번호를 고르고 번호를 적어 주세요(한국은 010 으로 시작)';

const notRequired = () => new ConflictException({ code: 'ONBOARDING_NOT_REQUIRED', message: '이미 첫 설정을 마친 계정입니다' });

/**
 * 「설정 마치기」를 아직 못 하는 까닭 — 남은 인증을 말한다. 안내(completeBlockedReason)와 마치기의 409 가 같은 문장을 쓴다
 * (단추가 잠긴 까닭과 서버 거절이 갈리지 않게 · D-R39). 둘 다 끝났으면 null.
 */
export function onboardingIncomplete(proofs: Record<SendChannel, OnboardingProof | null>): string | null {
  const left = [proofs.email ? null : '이메일', proofs.sms ? null : '휴대폰 번호'].filter((x): x is string => x !== null);
  return left.length > 0 ? `${left.join(' · ')} 인증을 먼저 마쳐 주세요 — 각 칸의 「인증하기」를 눌러 주세요` : null;
}
const notVerified = (message: string) => new ConflictException({ code: 'CONTACT_NOT_VERIFIED', message });
export const emailTaken = () => new ConflictException({ code: 'EMAIL_TAKEN', message: '이미 다른 계정이 쓰는 이메일입니다 — 다른 주소를 적어 주세요' });

/**
 * 받는 곳을 저장 · 비교 모양으로 — 이메일은 소문자 · 공백 없음, 휴대폰은 한국 숫자만 · 해외 `+국가번호…`(lib/phone).
 * 첫 설정과 본인 연락처 변경(AUTH-SELF-01 · ProfileService)이 같은 함수를 쓴다 — 두 길의 저장 모양이 갈리지 않게.
 */
export function contactTarget(channel: SendChannel, raw: string): string {
  if (channel === 'email') {
    const email = normalizeEmail(raw);
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
export async function emailTakenByOther(m: EntityManager | DataSource, email: string, staffId: number): Promise<boolean> {
  const rows = await m.query('SELECT 1 FROM staff WHERE lower(email) = $1 AND id <> $2 LIMIT 1', [email, staffId]);
  return rows.length > 0;
}

@Injectable()
export class OnboardingService {
  private readonly log = new Logger('Onboarding');

  constructor(
    private readonly ds: DataSource,
    @InjectRepository(Staff) private readonly staff: Repository<Staff>,
    private readonly auth: AuthService,
    @Inject(SENDER) private readonly sender: Sender,
  ) {}

  /**
   * 첫 설정 판정에 필요한 칸만 — 비밀번호 해시는 「지금 비밀번호와 같은가」에만 쓰고 밖으로 내보내지 않는다.
   * `must` 는 AUTH-INIT-02 판정(잠금 · 두 인증) 그대로다 — 증거 없이 면제된 계정도 여기서 마칠 수 있어야 교착이 없다.
   */
  private async current(staffId: number) {
    const [s] = (await this.ds.query(
      `SELECT s.login_id, s.email, s.phone, s.password_hash, s.credentials_changed_at, ${credentialSetupRequiredSql('s')} AS must
         FROM staff s WHERE s.id = $1 AND s.active`,
      [staffId],
    )) as Array<{
      login_id: string; email: string | null; phone: string | null; password_hash: string | null;
      credentials_changed_at: Date | null; must: boolean;
    }>;
    if (!s) throw new UnauthorizedException('다시 로그인해 주세요');
    return s;
  }

  /** 이번 첫 설정의 채널별 증거 — 계정에 적힌 이메일 · 휴대폰과 마지막 자격 변경 시각으로 센다(auth-code 한 곳) */
  private proofs(
    m: EntityManager | DataSource, staffId: number,
    s: { email: string | null; phone: string | null; credentials_changed_at: Date | null },
  ) {
    return onboardingProofs(m, { staffId, email: s.email, phone: s.phone, since: s.credentials_changed_at });
  }

  private target(channel: SendChannel, raw: string): string {
    return contactTarget(channel, raw);
  }

  private emailTaken(m: EntityManager | DataSource, email: string, staffId: number): Promise<boolean> {
    return emailTakenByOther(m, email, staffId);
  }

  async info(staffId: number): Promise<OnboardingInfoDto> {
    const s = await this.current(staffId);
    // 첫 설정이 필요 없는 계정은 증거를 셀 까닭이 없다 — 화면은 required=false 로 일정에 보낸다
    const proofs = s.must ? await this.proofs(this.ds, staffId, s) : { email: null, sms: null };
    return {
      required: s.must,
      // 아이디는 매니저가 정한 그대로 — 첫 설정은 보여 주기만 한다(W10)
      loginId: s.login_id,
      emailMasked: s.email ? maskEmail(s.email) : null,
      phoneMasked: s.phone ? maskPhone(s.phone) : null,
      passwordRule: PASSWORD_RULE_TEXT,
      codeTtlMinutes: CODE_TTL_MINUTES,
      resendAfterSeconds: CODE_RESEND_SECONDS,
      // 낱말 · 못 보내는 까닭 · 코드 비밀 값 없음(N-105)은 원장 한 곳(auth-code.codeChannels) — 비밀번호 찾기와 같은 표
      channels: codeChannels(this.sender),
      // 국가번호 고르기의 나라 목록 — 저장 · 발송 규칙과 같은 표(lib/phone · N-103)
      phoneCountries: PHONE_COUNTRIES.map((c) => ({ ...c })),
      emailVerifiedMasked: proofs.email?.masked ?? null,
      phoneVerifiedMasked: proofs.sms?.masked ?? null,
      completeBlockedReason: s.must ? onboardingIncomplete(proofs) : null,
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
        `SELECT ${credentialSetupRequiredSql('s')} AS must FROM staff s WHERE s.id = $1 AND s.active FOR UPDATE`, [staffId],
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

  /**
   * 채널 하나 인증하기 (사용자 지시 2026-10-19 「이메일 인증하기와 휴대폰 번호 인증하기 버튼이 있어야 함」).
   * 코드가 맞으면 ① 그 코드에 인증 시각을 찍어 이번 첫 설정의 증거로 남기고(닫지 않는다) ② 같은 채널의 다른 열린 코드를 닫고
   * ③ 그 주소 · 번호를 계정에 적는다 — 새로 고쳐도 「인증 완료」가 남고, 마치기는 새 비밀번호만 받는다.
   * STAFF 의 두 인증 칸 · 잠금은 여기서 바꾸지 않는다 — 판정(credentialSetupRequired)이 새 비밀번호 없이 풀리지 않게
   * 「설정 마치기」 한 곳이 함께 바꾼다. 틀린 횟수는 실패한 요청 뒤에도 남는다(값으로 돌려받아 커밋한 뒤 던진다).
   */
  async verify(staffId: number, dto: OnboardingVerifyDto): Promise<OnboardingInfoDto> {
    const s = await this.current(staffId);
    if (!s.must) throw notRequired();
    const channel = dto.channel;
    const to = this.target(channel, dto.target);
    if (!authCodeSecret()) throw secretMissing();
    if (channel === 'email' && (await this.emailTaken(this.ds, to, staffId))) throw emailTaken();

    let outcome: { ok: true } | { error: HttpException };
    try {
      outcome = await this.ds.transaction(async (m) => {
        const [cur] = await m.query(
          `SELECT s.email, s.phone, ${credentialSetupRequiredSql('s')} AS must FROM staff s WHERE s.id = $1 AND s.active FOR UPDATE`,
          [staffId],
        );
        if (!cur) return { error: new UnauthorizedException('다시 로그인해 주세요') };
        if (!cur.must) return { error: notRequired() };
        const checked = await verifyCode(m, { staffId, channel, purpose: 'onboarding', to, submitted: dto.code });
        if ('error' in checked) return checked;

        await m.query('UPDATE auth_code SET verified_at = now() WHERE id = $1', [checked.id]);
        // 증거는 채널마다 마지막으로 인증한 주소 · 번호 하나다 — 같은 채널의 다른 열린 첫 설정 코드는 닫는다
        await m.query(
          `UPDATE auth_code SET consumed_at = now()
            WHERE staff_id = $1 AND channel = $2 AND purpose = 'onboarding' AND consumed_at IS NULL AND id <> $3`,
          [staffId, channel, checked.id],
        );
        // 칸 이름은 채널 낱말에서 고른 상수다(입력 글자를 SQL 에 잇지 않는다)
        await m.query(
          channel === 'email' ? 'UPDATE staff SET email = $2 WHERE id = $1' : 'UPDATE staff SET phone = $2 WHERE id = $1',
          [staffId, to],
        );
        // 감사 기록 — 채널과 가린 받는 곳만. 코드 · 해시 · 원문 연락처는 싣지 않는다
        const mask = CHANNEL_SPECS[channel].mask;
        const before = channel === 'email' ? cur.email : cur.phone;
        await m.query(
          `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
           VALUES ($1, 'STAFF', $1, 'onboarding_verify', $2::jsonb, $3::jsonb)`,
          [
            staffId,
            JSON.stringify({ channel, target: before ? mask(before) : null }),
            JSON.stringify({ channel, target: mask(to), verified: true }),
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
    return this.info(staffId);
  }

  /**
   * 첫 설정 마치기 — 새 비밀번호만 받는다(2026-10-19). 이메일 · 휴대폰은 「인증하기」가 계정에 적었고, 여기서는 이번 차례의
   * 두 증거(auth-code.onboardingProofs)를 계정 행을 잠근 채 다시 센 뒤 두 인증 칸 · 잠금 해제 · 새 비밀번호를 한 transaction 으로
   * 저장한다. 증거가 모자라면 409 CONTACT_NOT_VERIFIED — 아무것도 저장하지 않는다(D7 「저장 0」).
   */
  async complete(staffId: number, dto: OnboardingCompleteDto) {
    const s = await this.current(staffId);
    if (!s.must) throw notRequired();
    // 증거 확인에도 해시가 필요하다 — 운영에 비밀 값이 없으면 같은 503 으로 답한다(N-105)
    if (!authCodeSecret()) throw secretMissing();
    // 서버 설정 누락(INITIAL_PASSWORD_REQUIRED 503)과 비밀번호 규칙은 DB 를 읽기 전에 답한다(설정이 없으면 쓰기 · 조회 0)
    const issue = passwordIssue(dto.password);
    if (issue) throw new BadRequestException({ code: 'PASSWORD_RULE', message: PASSWORD_ISSUE_MESSAGE[issue] });
    if (s.password_hash && (await bcrypt.compare(dto.password, s.password_hash))) {
      throw new ConflictException({ code: 'SAME_AS_CURRENT', message: '지금 비밀번호와 다른 새 비밀번호를 정해 주세요' });
    }
    // 남은 인증이 있으면 느린 해시를 만들기 전에 답한다 — 판정은 아래 잠금 안에서 한 번 더 한다(그 사이 바뀌어도 잠금 안의 답이 이긴다)
    const early = onboardingIncomplete(await this.proofs(this.ds, staffId, s));
    if (early) throw notVerified(early);

    // 해시는 잠금 밖에서 만든다(느린 일을 계정 행 잠금 안에 두지 않는다)
    const hash = await bcrypt.hash(dto.password, 10);
    // 서버 시계로 찍는다 — 새 토큰의 iat 가 같은 시계에서 뒤에 나오므로 새 토큰이 스스로 끊기지 않는다(DB 시계 어긋남과 무관)
    const changedAt = new Date();
    const outcome = await this.ds.transaction(async (m): Promise<{ ok: true } | { error: HttpException }> => {
      const [cur] = await m.query(
        `SELECT s.email, s.phone, s.credentials_changed_at, s.must_change_credentials AS must_raw,
                ${credentialSetupRequiredSql('s')} AS must, s.email_verified, s.phone_verified
           FROM staff s WHERE s.id = $1 AND s.active FOR UPDATE`,
        [staffId],
      );
      if (!cur) return { error: new UnauthorizedException('다시 로그인해 주세요') };
      if (!cur.must) return { error: notRequired() };
      const proofs = await this.proofs(m, staffId, cur);
      const blocked = onboardingIncomplete(proofs);
      if (blocked) return { error: notVerified(blocked) };

      await m.query(
        `UPDATE staff SET password_hash = $2, email_verified = true, phone_verified = true,
                          must_change_credentials = false, credentials_changed_at = $3
          WHERE id = $1`,
        [staffId, hash, changedAt],
      );
      // 증거 두 줄과 함께 이 계정의 남은 코드도 모두 닫는다 — 나중에 다시 첫 설정이 걸려도 옛 코드 · 옛 증거가 살아 있지 않게
      await m.query('UPDATE auth_code SET consumed_at = now() WHERE staff_id = $1 AND consumed_at IS NULL', [staffId]);
      // 감사 기록 — 가린 이메일 · 휴대폰과 상태 칸만. 비밀번호 · 코드 · 해시 · 원문 연락처는 싣지 않는다
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
         VALUES ($1, 'STAFF', $1, 'onboarding', $2::jsonb, $3::jsonb)`,
        [
          staffId,
          JSON.stringify({
            email: cur.email ? maskEmail(cur.email) : null, phone: cur.phone ? maskPhone(cur.phone) : null,
            // 저장돼 있던 잠금 값 그대로 — 증거 없이 면제됐던 계정(false)도 기록에서 구분된다(AUTH-INIT-02)
            emailVerified: cur.email_verified, phoneVerified: cur.phone_verified, mustChangeCredentials: cur.must_raw === true,
          }),
          JSON.stringify({
            email: cur.email ? maskEmail(cur.email) : null, phone: cur.phone ? maskPhone(cur.phone) : null,
            emailVerified: true, phoneVerified: true, mustChangeCredentials: false,
          }),
        ],
      );
      return { ok: true as const };
    });
    if ('error' in outcome) throw outcome.error;

    const fresh = await this.staff.findOne({ where: { id: staffId, active: true } });
    if (!fresh) throw new UnauthorizedException('다시 로그인해 주세요');
    return this.auth.issueSession(fresh);
  }
}
