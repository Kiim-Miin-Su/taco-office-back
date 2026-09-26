/** @file-guide
 * 목적: auth-code.ts — CODE_TTL_MINUTES, CODE_RESEND_SECONDS, CODE_HOURLY_LIMIT, CODE_DAILY_LIMIT, CODE_MAX_ATTEMPTS, authCodeSecret, codeLimitIssue, insertCode, verifyCode, codeMessage, codeChannels 등 (auth)
 * 책임/재사용: 인증 코드 원장(auth_code)의 발급 · 한도 · 확인 · 문장을 한 곳에서 소유한다. 첫 설정(W8)과 비밀번호 찾기(N-101)가 같이 쓴다. 코드 · 받는 곳 원문을 남기지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 인증 코드 원장 한 곳 (W8 첫 설정 · N-101 비밀번호 찾기 · N-105 한도와 비밀 값 — 대표 결정 2026-09-26).
 *
 * 세 가지를 지킨다(첫 설정 때 정한 것 그대로).
 *   ① **코드와 받는 곳 원문을 남기지 않는다** — 원장에는 서버 비밀로 만든 HMAC 과 가린 받는 곳만 있다.
 *   ② **횟수 제한은 원장에서 센다** — 서버리스라 메모리 상태가 요청 사이에 남지 않는다. 계정 행을 잠그고 센다.
 *   ③ **틀린 횟수는 실패한 요청 뒤에도 남는다** — 확인은 거절을 던지지 않고 값으로 돌려준다(부르는 쪽이 커밋한 뒤 던진다).
 *
 * 용도(`purpose`)가 둘이다 — 첫 설정 코드로 비밀번호를 바꾸거나 그 반대가 되지 않게 확인이 용도를 함께 본다
 * (해시 메시지에도 용도가 들어간다). 발급 한도는 용도와 무관하게 **계정 · 채널**마다 센다 — 문자 요금은 용도를 가리지 않는다.
 */
import { ConflictException, ServiceUnavailableException, type HttpException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { writtenRows } from '../lib/sql';
import { CHANNEL_SPECS, SEND_CHANNELS, type SendChannel, type SendRequest, type Sender } from '../modules/notify/sender';

/** 코드 유효 시간(분) · 같은 채널 다시 받기 간격(초) · 한 시간 발급 한도 · 하루(24시간) 발급 한도 · 코드 하나의 틀림 한도 */
export const CODE_TTL_MINUTES = 10;
export const CODE_RESEND_SECONDS = 60;
export const CODE_HOURLY_LIMIT = 5;
/** N-105 (대표 결정 2026-09-26) — 문자 요금을 생각한 하루 한도. 계정 · 채널마다 최근 24시간 */
export const CODE_DAILY_LIMIT = 10;
export const CODE_MAX_ATTEMPTS = 5;

export const AUTH_CODE_PURPOSES = ['onboarding', 'password_reset'] as const;
export type AuthCodePurpose = (typeof AUTH_CODE_PURPOSES)[number];

/**
 * 코드 해시 키 (N-105 · 대표 결정 2026-09-26 「운영용 코드 비밀 값 분리」).
 * 운영(NODE_ENV=production)은 **`AUTH_CODE_SECRET` 만** 쓴다 — 없으면 null 이고 코드를 보내지 않는다(503).
 * 개발 · 시험은 없으면 Access 서명 비밀(AuthService 와 같은 기본값)을 쓴다 — 메시지에 용도를 붙여 두 해시가 섞이지 않는다.
 * 요청마다 읽는다(시험이 환경을 바꿔 확인한다).
 */
export function authCodeSecret(): string | null {
  const own = process.env.AUTH_CODE_SECRET?.trim();
  if (own) return own;
  if (process.env.NODE_ENV === 'production') return null;
  return process.env.JWT_SECRET ?? 'dev-only-change-me';
}

/** 운영에 코드 비밀 값이 없을 때 — 화면 안내와 거절이 같은 문장을 쓴다 */
export const SECRET_MISSING_REASON = '인증 코드 비밀 값(AUTH_CODE_SECRET)이 서버에 없어 코드를 보내지 못합니다';

export const secretMissing = () => new ServiceUnavailableException({
  code: 'AUTH_CODE_SECRET_MISSING', message: `${SECRET_MISSING_REASON} — 관리자에게 알려 주세요`,
});

/**
 * 개발용 코드 되돌려 주기 — **운영이 아니고** 서버에 `AUTH_CODE_DEV_ECHO=on` 이 있을 때만.
 * 발송 설정이 없는 로컬에서 끝까지 시험하려는 자리다. 운영 빌드(NODE_ENV=production)는 값과 무관하게 꺼진다.
 */
export const devEcho = (): boolean => process.env.NODE_ENV !== 'production' && process.env.AUTH_CODE_DEV_ECHO === 'on';

function hmac(message: string): string {
  const secret = authCodeSecret();
  if (!secret) throw secretMissing();
  return createHmac('sha256', secret).update(message).digest('hex');
}

/** 받는 곳 해시 — 용도와 무관하다(같은 주소 · 번호는 같은 해시) */
export const targetHash = (channel: SendChannel, to: string) => hmac(`target:${channel}:${to}`);

/**
 * 코드 해시 — 용도마다 메시지가 다르다. 첫 설정은 W8 때의 모양을 그대로 둔다(배포 순간 살아 있는 코드가 틀리지 않게).
 * 시험이 원장 줄을 직접 만들 때도 이 함수를 쓴다(해시 규칙을 시험에 다시 적지 않는다).
 */
export const codeHash = (purpose: AuthCodePurpose, staffId: number, channel: SendChannel, code: string) =>
  hmac(purpose === 'onboarding' ? `code:${staffId}:${channel}:${code}` : `${purpose}:${staffId}:${channel}:${code}`);

export type CodeLimit = { code: 'CODE_TOO_SOON' | 'CODE_DAILY_LIMIT' | 'CODE_LIMIT'; message: string };

/**
 * 발급 한도 — 60초 간격 · 하루 10번 · 한 시간 5번(이 차례로 · 하루 한도가 걸리면 한 시간을 기다려도 소용없다).
 * 부르는 쪽이 계정 행을 잠근 트랜잭션 안에서 부른다. 걸리면 거절 값을, 아니면 null.
 */
export async function codeLimitIssue(m: EntityManager, staffId: number, channel: SendChannel): Promise<CodeLimit | null> {
  const [last] = await m.query(
    `SELECT GREATEST(0, ceil(extract(epoch FROM created_at + make_interval(secs => $3) - now())))::int AS wait
       FROM auth_code WHERE staff_id = $1 AND channel = $2 ORDER BY created_at DESC LIMIT 1`,
    [staffId, channel, CODE_RESEND_SECONDS],
  );
  if (last && last.wait > 0) {
    return { code: 'CODE_TOO_SOON', message: `코드를 방금 보냈습니다 — ${last.wait}초 뒤에 다시 받을 수 있습니다` };
  }
  const [{ day, hour }] = await m.query(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS day,
            count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour
       FROM auth_code WHERE staff_id = $1 AND channel = $2`,
    [staffId, channel],
  );
  if (day >= CODE_DAILY_LIMIT) {
    return {
      code: 'CODE_DAILY_LIMIT',
      message: `코드는 하루(24시간)에 ${CODE_DAILY_LIMIT}번까지 받을 수 있습니다 — 내일 다시 받거나 관리자에게 알려 주세요`,
    };
  }
  if (hour >= CODE_HOURLY_LIMIT) {
    return { code: 'CODE_LIMIT', message: `코드는 한 시간에 ${CODE_HOURLY_LIMIT}번까지 받을 수 있습니다 — 잠시 뒤 다시 시도해 주세요` };
  }
  return null;
}

/** 코드 한 줄을 남긴다 — HMAC 과 가린 받는 곳만. 만료는 DB 시계로 찍는다(만료 판정도 DB 시계라 어긋나지 않는다) */
export async function insertCode(
  m: EntityManager,
  row: { staffId: number; channel: SendChannel; purpose: AuthCodePurpose; to: string; masked: string; code: string },
): Promise<{ id: string; expires_at: Date }> {
  const [inserted] = await m.query(
    `INSERT INTO auth_code (staff_id, channel, purpose, target_hash, target_masked, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7)) RETURNING id, expires_at`,
    [
      row.staffId, row.channel, row.purpose, targetHash(row.channel, row.to), row.masked,
      codeHash(row.purpose, row.staffId, row.channel, row.code), CODE_TTL_MINUTES,
    ],
  );
  return inserted as { id: string; expires_at: Date };
}

export type Verified = { id: string } | { error: HttpException };

/** 거절 문장에서 어느 칸의 코드인지 부르는 이름 — 화면의 입력 칸 이름과 같다 */
const FIELD: Record<SendChannel, string> = { email: '이메일', sms: '휴대폰' };

/**
 * 코드 하나 확인 — 그 계정 · 채널 · **용도** · **받는 곳**으로 받은 가장 새 코드만 본다.
 * 거절은 던지지 않고 값으로 돌려준다(틀린 횟수를 커밋하려고 · 위 ③). 문장은 칸 이름 · 남은 횟수를 말한다 —
 * 계정이 있는지 숨겨야 하는 자리(비밀번호 찾기)는 부르는 쪽이 한 문장으로 바꿔 답한다.
 */
export async function verifyCode(
  m: EntityManager,
  q: { staffId: number; channel: SendChannel; purpose: AuthCodePurpose; to: string; submitted: string },
): Promise<Verified> {
  const conflict = (code: string, message: string) => ({ error: new ConflictException({ code, message }) });
  const [row] = (await m.query(
    `SELECT id, code_hash, attempts, (expires_at <= now()) AS expired
       FROM auth_code
      WHERE staff_id = $1 AND channel = $2 AND purpose = $3 AND target_hash = $4 AND consumed_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`,
    [q.staffId, q.channel, q.purpose, targetHash(q.channel, q.to)],
  )) as Array<{ id: string; code_hash: string; attempts: number; expired: boolean }>;
  const field = FIELD[q.channel];
  if (!row) {
    return conflict('CODE_NOT_REQUESTED', `그 ${q.channel === 'email' ? '주소' : '번호'}로 받은 코드가 없습니다 — 코드를 다시 받아 주세요`);
  }
  if (row.expired) return conflict('CODE_EXPIRED', `${field} 코드가 만료됐습니다 — 코드를 다시 받아 주세요`);
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    return conflict('CODE_LOCKED', `${field} 코드를 ${CODE_MAX_ATTEMPTS}번 틀려 더 쓸 수 없습니다 — 코드를 다시 받아 주세요`);
  }
  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(codeHash(q.purpose, q.staffId, q.channel, q.submitted), 'hex');
  if (expected.length === actual.length && timingSafeEqual(expected, actual)) return { id: row.id };

  // UPDATE … RETURNING 은 드라이버가 [행, 수] 로 돌려준다 — 공용 풀이(lib/sql.writtenRows)로 읽는다
  const [bumped] = writtenRows<{ attempts: number }>(await m.query(
    'UPDATE auth_code SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [row.id],
  ));
  const left = Math.max(0, CODE_MAX_ATTEMPTS - Number(bumped?.attempts ?? CODE_MAX_ATTEMPTS));
  return conflict('CODE_MISMATCH', left > 0
    ? `${field} 코드가 맞지 않습니다 — ${left}번 더 시도할 수 있습니다`
    : `${field} 코드가 맞지 않습니다 — 더 시도할 수 없으니 코드를 다시 받아 주세요`);
}

/**
 * 코드를 담은 메일 · 문자 — 제목 · 본문에 내부 코드를 싣지 않는다. 문자는 SMS 한 통(90바이트) 안에 든다(시험이 바이트를 잰다).
 * 해외 번호(`+…` · N-103)는 SENS 국제 문자 규정의 인증 문장 모양 「[회사명] verification: 숫자」 그대로 보낸다
 * (여러 나라가 이 모양만 받는다 · 영문이라 받는 나라의 글꼴 · 부호화와 무관하다).
 */
export function codeMessage(channel: SendChannel, purpose: AuthCodePurpose, to: string, code: string): SendRequest {
  const what = purpose === 'onboarding' ? '첫 설정' : '비밀번호 찾기';
  if (channel === 'email') {
    return {
      channel, to,
      subject: purpose === 'onboarding' ? '[티엔아카데미] 이메일 확인 코드' : '[티엔아카데미] 비밀번호 찾기 코드',
      body: `티엔아카데미 백오피스 ${what} — 이메일 확인 코드는 ${code} 입니다.\n`
        + `${CODE_TTL_MINUTES}분 안에 입력해 주세요. 직접 요청하지 않았다면 이 메일은 무시해 주세요.`,
    };
  }
  if (to.trim().startsWith('+')) return { channel, to, body: `[TN Academy] verification: ${code}` };
  return {
    channel, to,
    body: purpose === 'onboarding'
      ? `[티엔아카데미] 휴대폰 확인 코드 ${code} · ${CODE_TTL_MINUTES}분 안에 입력해 주세요`
      : `[티엔아카데미] 비밀번호 찾기 코드 ${code} · ${CODE_TTL_MINUTES}분 안에 입력해 주세요`,
  };
}

/** 코드 채널 하나의 준비 여부 — 발송기가 준비됐고(또는 개발용 되돌려 주기) 운영이면 코드 비밀 값이 있어야 한다 */
export function channelReady(senderReady: boolean): { ready: boolean; secretMissing: boolean } {
  const secret = authCodeSecret() !== null;
  return { ready: secret && (senderReady || devEcho()), secretMissing: !secret };
}

export const notConfigured = (channel: SendChannel) => new ServiceUnavailableException({
  code: 'SENDER_NOT_CONFIGURED', message: `${CHANNEL_SPECS[channel].notReadyReason} — 관리자에게 알려 주세요`,
});

/**
 * 화면의 코드 채널 표 — 첫 설정 · 비밀번호 찾기가 같이 쓴다. 낱말 · 못 보내는 까닭은 발송기 채널 표 한 곳에서 온다.
 * 개발용 되돌려 주기가 켜져 있으면 단추를 연다. 운영에 코드 비밀 값이 없으면(N-105) 두 채널 다 그 까닭으로 잠근다 —
 * 눌렀을 때 503 을 받기 전에 화면이 먼저 말한다.
 */
export function codeChannels(sender: Sender): Array<{ channel: SendChannel; label: string; ready: boolean; notReadyReason: string | null }> {
  return SEND_CHANNELS.map((channel) => {
    const state = channelReady(sender.ready(channel));
    return {
      channel, label: CHANNEL_SPECS[channel].label, ready: state.ready,
      notReadyReason: state.ready ? null : state.secretMissing ? SECRET_MISSING_REASON : CHANNEL_SPECS[channel].notReadyReason,
    };
  });
}
