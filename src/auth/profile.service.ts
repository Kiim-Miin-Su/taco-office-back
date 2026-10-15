/** @file-guide
 * 목적: profile.service.ts — ProfileService (auth)
 * 책임/재사용: 본인 마이페이지(AUTH-SELF-01)의 조회 · 이름 수정 · 연락처 변경을 소유한다. 판정 · 코드 원장 · 받는 곳 정규화는 AuthService · auth-code · 첫 설정 함수를 재사용한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 본인 마이페이지 (AUTH-SELF-01 · 사용자 결정 2026-10-16).
 *
 * 대상은 **언제나 세션의 본인**이다(경로 · 본문에 사람 id 가 없다). 이 경로들은 AllowWhileOnboarding 이 아니므로
 * 필수 초기설정(AUTH-INIT-02)이 남은 계정은 가드에서 403 을 받는다 — 여기서도 쓰기 직전에 잠근 행으로 한 번 더 본다
 * (요청 사이에 관리자가 초기화 · 연락처 수정으로 잠금을 켠 경우).
 *
 * 연락처 변경이 지키는 것(첫 설정 · 비밀번호 찾기와 같은 원장 · 같은 한도):
 *   ① 새 수신처로 받은 `contact_change` 코드 **그리고** 지금 비밀번호가 둘 다 맞기 전에는 지금 값 · 인증 상태가 그대로다.
 *      다른 용도(첫 설정 · 비밀번호 찾기) 코드는 해시 메시지 · 용도 조건이 달라 통하지 않는다.
 *   ② 비밀번호를 틀리면 그 코드의 틀린 횟수에 센다(커밋한 뒤 던진다) — 코드 하나로 비밀번호를 끝없이 떠볼 수 없다.
 *   ③ 성공은 한 transaction 이다 — 그 채널의 값 + 인증 true · 이 계정의 남은 코드 닫기 · 세션 시각(credentials_changed_at) ·
 *      가린 모양만 담은 감사 줄. 이메일은 대소문자 무시 유일(23505 → EMAIL_TAKEN). 그 뒤 새 세션을 발급한다(옛 세션은 끊긴다).
 *   ④ 받는 곳 · 코드 · 비밀번호 원문은 로그 · 오류 문장 · 감사 줄에 남기지 않는다.
 */
import {
  BadGatewayException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomInt } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { Staff } from '../entities';
import { AuthService, credentialSetupRequiredSql } from './auth.service';
import { ONBOARDING_REQUIRED_MESSAGE } from './onboarding.guard';
import { contactTarget, emailTaken, emailTakenByOther } from './onboarding.service';
import { PHONE_COUNTRIES } from '../lib/phone';
import { roleLabel } from '../lib/role-words';
import { writtenRows } from '../lib/sql';
import {
  CHANNEL_SPECS, SENDER, maskEmail, maskPhone, type SendChannel, type SendResult, type Sender,
} from '../modules/notify/sender';
import {
  CODE_MAX_ATTEMPTS, CODE_RESEND_SECONDS, CODE_TTL_MINUTES, authCodeSecret, codeChannels, codeLimitIssue, codeMessage,
  devEcho, insertCode, notConfigured, secretMissing, verifyCode,
} from './auth-code';
import type { OnboardingCodeResultDto } from './dto/onboarding.dto';
import type { ProfileContactChangeDto, ProfileContactCodeRequestDto, ProfileDto, ProfileUpdateDto } from './dto/profile.dto';
import type { Role } from '../common/perm';

type ProfileRow = {
  id: string; login_id: string; name: string; english_name: string | null; role: string; title: string | null;
  email: string | null; email_verified: boolean; phone: string | null; phone_verified: boolean; hired_on: string | null;
};

/** 채널마다 다루는 STAFF 칸 — 코드 상수만 SQL 에 들어간다(입력으로 칸 이름을 만들지 않는다) */
const CONTACT_COLUMNS: Record<SendChannel, { value: 'email' | 'phone'; verified: 'email_verified' | 'phone_verified' }> = {
  email: { value: 'email', verified: 'email_verified' },
  sms: { value: 'phone', verified: 'phone_verified' },
};

const setupRequired = () => new ForbiddenException({ code: 'CREDENTIALS_CHANGE_REQUIRED', message: ONBOARDING_REQUIRED_MESSAGE });
const unchanged = (channel: SendChannel) => new ConflictException({
  code: 'CONTACT_UNCHANGED',
  message: `지금 등록된 ${channel === 'email' ? '이메일' : '휴대폰'}과 같습니다 — 바꿀 새 ${channel === 'email' ? '주소' : '번호'}를 적어 주세요`,
});

@Injectable()
export class ProfileService {
  private readonly log = new Logger('Profile');

  constructor(
    private readonly ds: DataSource,
    @InjectRepository(Staff) private readonly staff: Repository<Staff>,
    private readonly auth: AuthService,
    @Inject(SENDER) private readonly sender: Sender,
  ) {}

  private async row(staffId: number): Promise<ProfileRow> {
    const [r] = (await this.ds.query(
      `SELECT id, login_id, name, english_name, role::text AS role, title, email, email_verified, phone, phone_verified,
              to_char(hired_on,'YYYY-MM-DD') AS hired_on
         FROM staff WHERE id = $1 AND active`,
      [staffId],
    )) as ProfileRow[];
    if (!r) throw new UnauthorizedException('다시 로그인해 주세요');
    return r;
  }

  private toDto(r: ProfileRow): ProfileDto {
    return {
      id: Number(r.id), loginId: r.login_id, name: r.name, englishName: r.english_name,
      roleLabel: roleLabel(r.role as Role), title: r.title,
      email: r.email, emailVerified: r.email_verified === true, phone: r.phone, phoneVerified: r.phone_verified === true,
      hiredOn: r.hired_on,
      contactCodes: {
        // 낱말 · 못 보내는 까닭 · 코드 비밀 값 없음은 원장 한 곳(auth-code.codeChannels) — 첫 설정 · 비밀번호 찾기와 같은 표
        channels: codeChannels(this.sender),
        phoneCountries: PHONE_COUNTRIES.map((c) => ({ ...c })),
        codeTtlMinutes: CODE_TTL_MINUTES,
        resendAfterSeconds: CODE_RESEND_SECONDS,
      },
    };
  }

  async get(staffId: number): Promise<ProfileDto> {
    return this.toDto(await this.row(staffId));
  }

  /** 이름 · 영어 이름 — 보낸 칸만 바꾼다. 아무것도 안 바뀌면 쓰지도 기록하지도 않는다 */
  async update(staffId: number, dto: ProfileUpdateDto): Promise<ProfileDto> {
    const sets: string[] = [];
    const params: unknown[] = [staffId];
    const next: { name?: string; englishName?: string | null } = {};
    if (dto.name !== undefined) next.name = dto.name;
    // null · 앞뒤 공백을 지운 빈 글자는 비운다(NULL) — CHECK staff_english_name_present 가 빈 글자를 마지막으로 막는다
    if (dto.englishName !== undefined) next.englishName = dto.englishName ? dto.englishName : null;

    return this.ds.transaction(async (m) => {
      const [cur] = (await m.query(
        `SELECT s.name, s.english_name, ${credentialSetupRequiredSql('s')} AS required
           FROM staff s WHERE s.id = $1 AND s.active FOR UPDATE`,
        [staffId],
      )) as Array<{ name: string; english_name: string | null; required: boolean }>;
      if (!cur) throw new UnauthorizedException('다시 로그인해 주세요');
      if (cur.required) throw setupRequired();
      // 감사 줄에는 실제로 바뀐 칸만 싣는다(같은 값을 다시 적은 칸은 변경이 아니다)
      const before: Record<string, string | null> = {};
      const after: Record<string, string | null> = {};
      if (next.name !== undefined && next.name !== cur.name) {
        params.push(next.name);
        sets.push(`name = $${params.length}`);
        before.name = cur.name;
        after.name = next.name;
      }
      if (next.englishName !== undefined && next.englishName !== cur.english_name) {
        params.push(next.englishName);
        sets.push(`english_name = $${params.length}`);
        before.englishName = cur.english_name;
        after.englishName = next.englishName;
      }
      if (sets.length > 0) {
        await m.query(`UPDATE staff SET ${sets.join(', ')} WHERE id = $1`, params);
        await m.query(
          `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
           VALUES ($1, 'STAFF', $1, 'profile_update', $2::jsonb, $3::jsonb)`,
          [staffId, JSON.stringify(before), JSON.stringify(after)],
        );
      }
      const [r] = (await m.query(
        `SELECT id, login_id, name, english_name, role::text AS role, title, email, email_verified, phone, phone_verified,
                to_char(hired_on,'YYYY-MM-DD') AS hired_on
           FROM staff WHERE id = $1`,
        [staffId],
      )) as ProfileRow[];
      return this.toDto(r);
    });
  }

  /** 새 수신처로 `contact_change` 코드를 보낸다 — 한도(60초 · 한 시간 5번 · 하루 10번)는 첫 설정 · 비밀번호 찾기와 같은 예산 */
  async sendContactCode(staffId: number, dto: ProfileContactCodeRequestDto): Promise<OnboardingCodeResultDto> {
    const channel = dto.channel;
    const to = contactTarget(channel, dto.target);
    const cur = await this.row(staffId);
    if (cur[CONTACT_COLUMNS[channel].value] === to) throw unchanged(channel);
    if (channel === 'email' && (await emailTakenByOther(this.ds, to, staffId))) throw emailTaken();

    if (!authCodeSecret()) throw secretMissing();
    const ready = this.sender.ready(channel);
    const echo = !ready && devEcho();
    if (!ready && !echo) throw notConfigured(channel);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const masked = CHANNEL_SPECS[channel].mask(to);
    const row = await this.ds.transaction(async (m) => {
      const [locked] = await m.query(
        `SELECT ${credentialSetupRequiredSql('s')} AS required FROM staff s WHERE s.id = $1 AND s.active FOR UPDATE`, [staffId],
      );
      if (!locked) throw new UnauthorizedException('다시 로그인해 주세요');
      if (locked.required) throw setupRequired();
      const limit = await codeLimitIssue(m, staffId, channel);
      if (limit) throw new HttpException(limit, HttpStatus.TOO_MANY_REQUESTS);
      return insertCode(m, { staffId, channel, purpose: 'contact_change', to, masked, code });
    });

    const result: OnboardingCodeResultDto = {
      channel, targetMasked: masked, expiresAt: new Date(row.expires_at).toISOString(), resendAfterSeconds: CODE_RESEND_SECONDS,
    };
    if (echo) return { ...result, devCode: code };

    const sent = await this.deliver(channel, to, code);
    if (!sent.configured || !sent.ok) {
      // 받지 못한 코드는 쓸 수 없게 닫는다. 발송 시도는 횟수에 그대로 센다(공급자 연타 방지) · 받는 곳 · 코드는 남기지 않는다
      await this.ds.query('UPDATE auth_code SET consumed_at = now() WHERE id = $1', [row.id]);
      this.log.warn(`연락처 변경 코드를 보내지 못했습니다 — 계정 ${staffId} · ${CHANNEL_SPECS[channel].label}`);
      if (!sent.configured) throw notConfigured(channel);
      throw new BadGatewayException({
        code: 'SEND_FAILED', message: `${CHANNEL_SPECS[channel].label}로 코드를 보내지 못했습니다 — 잠시 뒤 다시 받아 주세요`,
      });
    }
    return result;
  }

  private async deliver(channel: SendChannel, to: string, code: string): Promise<SendResult> {
    try {
      return await this.sender.send(codeMessage(channel, 'contact_change', to, code));
    } catch {
      return { configured: true, ok: false, providerId: null, error: null };
    }
  }

  /** 새 연락처 저장 — 코드 · 지금 비밀번호 확인 → 값 + 인증 · 코드 닫기 · 세션 시각 · 감사를 한 transaction → 새 세션 */
  async changeContact(staffId: number, dto: ProfileContactChangeDto) {
    const channel = dto.channel;
    const cols = CONTACT_COLUMNS[channel];
    const to = contactTarget(channel, dto.target);
    if (!authCodeSecret()) throw secretMissing();
    const [pre] = (await this.ds.query(
      `SELECT email, phone, password_hash FROM staff WHERE id = $1 AND active`, [staffId],
    )) as Array<{ email: string | null; phone: string | null; password_hash: string | null }>;
    if (!pre) throw new UnauthorizedException('다시 로그인해 주세요');
    if (pre[cols.value] === to) throw unchanged(channel);
    if (channel === 'email' && (await emailTakenByOther(this.ds, to, staffId))) throw emailTaken();

    // 느린 비교는 행 잠금 밖에서 한다. 잠근 뒤 해시가 그새 바뀌었으면 지금 해시로 다시 본다(비밀번호 찾기와 같은 방식)
    const passwordOk = !!pre.password_hash && (await bcrypt.compare(dto.currentPassword, pre.password_hash));
    // 서버 시계로 찍는다 — 새 토큰의 발급 시각이 같은 시계에서 뒤에 나오므로 새 세션이 스스로 끊기지 않는다(첫 설정과 같다)
    const changedAt = new Date();
    let outcome: { ok: true } | { error: HttpException };
    try {
      outcome = await this.ds.transaction(async (m) => {
        const [cur] = (await m.query(
          `SELECT s.email, s.phone, s.email_verified, s.phone_verified, s.password_hash, ${credentialSetupRequiredSql('s')} AS required
             FROM staff s WHERE s.id = $1 AND s.active FOR UPDATE`,
          [staffId],
        )) as Array<{
          email: string | null; phone: string | null; email_verified: boolean; phone_verified: boolean;
          password_hash: string | null; required: boolean;
        }>;
        if (!cur) return { error: new UnauthorizedException('다시 로그인해 주세요') };
        if (cur.required) return { error: setupRequired() };
        if (cur[cols.value] === to) return { error: unchanged(channel) };
        const byCode = await verifyCode(m, { staffId, channel, purpose: 'contact_change', to, submitted: dto.code });
        if ('error' in byCode) return byCode;
        const ok = cur.password_hash === pre.password_hash
          ? passwordOk
          : !!cur.password_hash && (await bcrypt.compare(dto.currentPassword, cur.password_hash));
        if (!ok) {
          // 비밀번호 틀림도 그 코드의 틀린 횟수다 — 코드를 닫지 않고(맞게 다시 적을 수 있게) 횟수만 남긴다
          const [bumped] = writtenRows<{ attempts: number }>(await m.query(
            'UPDATE auth_code SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [byCode.id],
          ));
          const left = Math.max(0, CODE_MAX_ATTEMPTS - Number(bumped?.attempts ?? CODE_MAX_ATTEMPTS));
          return {
            error: new ConflictException({
              code: 'CURRENT_PASSWORD_MISMATCH',
              message: left > 0
                ? `지금 비밀번호가 맞지 않습니다 — ${left}번 더 시도할 수 있습니다`
                : '지금 비밀번호가 맞지 않습니다 — 더 시도할 수 없으니 코드를 다시 받아 주세요',
            }),
          };
        }

        await m.query(
          `UPDATE staff SET ${cols.value} = $2, ${cols.verified} = true, credentials_changed_at = $3 WHERE id = $1`,
          [staffId, to, changedAt],
        );
        // 쓴 코드와 함께 이 계정의 남은 코드도 모두 닫는다 — 다른 수신처로 받아 둔 코드가 나중에 살아 있지 않게
        await m.query('UPDATE auth_code SET consumed_at = now() WHERE staff_id = $1 AND consumed_at IS NULL', [staffId]);
        const mask = channel === 'email' ? maskEmail : maskPhone;
        const before = cur[cols.value];
        await m.query(
          `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
           VALUES ($1, 'STAFF', $1, 'contact_change', $2::jsonb, $3::jsonb)`,
          [
            staffId,
            JSON.stringify({ channel, value: before ? mask(before) : null, verified: cur[cols.verified] === true }),
            JSON.stringify({ channel, value: mask(to), verified: true, sessionsCut: true }),
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

    this.log.log(`연락처를 바꿨습니다 — 계정 ${staffId} · ${CHANNEL_SPECS[channel].label}`);
    const fresh = await this.staff.findOne({ where: { id: staffId, active: true } });
    if (!fresh) throw new UnauthorizedException('다시 로그인해 주세요');
    return this.auth.issueSession(fresh);
  }
}
