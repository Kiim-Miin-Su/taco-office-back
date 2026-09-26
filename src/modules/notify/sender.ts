/** @file-guide
 * 목적: sender.ts — SENDER, SendChannel, SendAttachment, SendRequest, SendResult 등 (config)
 * 책임/재사용: 기존 런타임/빌드/검사 설정을 유지한다. 의존성·배포·비밀값 변경은 별도 근거와 검증 없이는 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 바깥으로 나가는 발송의 **경계** — 메일(SMTP)과 문자(SENS).
 *
 * 대표 환경 변수는 이미 `.env.local` 과 Vercel 에 들어 있다 (대표 확인 2026-09-12):
 * `SMTP_HOST/PORT/USER/PASS` · `MAIL_FROM` · `SENS_SERVICE_ID/ACCESS_KEY/SECRET_KEY/SENS_FROM`.
 *
 * 두 가지를 분명히 한다.
 *   ① 부르는 쪽(리포트 전달·수업 안내·계약서 전달)은 **SMTP 도 SENS 도 모른다.** 이 인터페이스만 안다.
 *   ② 키가 없는 환경(로컬·테스트)에서는 **보낸 척하지 않는다.** `configured=false` 로 답하고
 *      부르는 쪽이 「보내지 못했다」를 원장에 남긴다. 조용히 성공으로 적는 것이 가장 나쁘다.
 */

import { maskMobile, phoneParts } from '../../lib/phone';

export const SENDER = Symbol('SENDER');

/* ══ 채널 추가 자리 — 한 곳 (DQ3 대표 답변 2026-09-25) ═══════════════════════════════
 *
 * 대표 답변: 「현재 사용되는 이메일과 Naver SENS 만 이용해서 구현하고, 추후에 확장 가능하게 주석과 구조화할 것」.
 * 그래서 지금 채널은 **둘뿐**이다 — 메일(SMTP)·문자(SENS). 알림톡·카카오 등은 만들지 않는다.
 *
 * 채널을 하나 더하는 날 고치는 곳 (이 순서로 — 앞의 것이 뒤의 것을 **컴파일 오류로** 불러낸다):
 *   ① 아래 `SEND_CHANNELS` 에 낱말 하나. `SendChannel` 은 이 배열에서 나온다.
 *   ② 아래 `CHANNEL_SPECS` 에 그 채널의 이름·받는 곳 정규화·가림 — `Record<SendChannel, …>` 라 빠뜨리면 안 뜬다.
 *   ③ `live.sender.ts` 의 `adapters` 에 공급자 구현(ready·send) — 같은 이유로 빠뜨리면 안 뜬다.
 *   ④ `guardians.service.ts` 의 `RECEIVES`(보호자가 그 채널을 받는가)와 보호자 표의 `receive_<채널>`·연락처 칸.
 *   ⑤ DB CHECK `guardian_send_channel` 을 넓히는 마이그레이션 · `docs/contracts/db/erd.dbml`.
 * 부르는 쪽(보호자 발송·리포트 전달…)은 채널 이름을 모른 채 이 배열을 돈다 — 화면의 채널 칩도 서버가 준다.
 */
export const SEND_CHANNELS = ['email', 'sms'] as const;

export type SendChannel = (typeof SEND_CHANNELS)[number];

export function isSendChannel(v: unknown): v is SendChannel {
  return typeof v === 'string' && (SEND_CHANNELS as readonly string[]).includes(v);
}

export interface SendAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendRequest {
  channel: SendChannel;
  /** 메일 주소 또는 휴대폰 번호 */
  to: string;
  /** 메일 제목 — 문자에는 쓰이지 않는다 */
  subject?: string;
  body: string;
  attachments?: SendAttachment[];
}

export interface SendResult {
  /** 보낼 수 있는 설정이 있었나 — false 면 시도조차 하지 않았다 */
  configured: boolean;
  ok: boolean;
  /** 공급자가 준 식별자 (메일 messageId · SENS requestId) */
  providerId: string | null;
  /** 실패했으면 왜 — 사람이 읽을 수 있게 */
  error: string | null;
}

export interface Sender {
  send(req: SendRequest): Promise<SendResult>;
  /** 이 채널을 지금 보낼 수 있는가 — 화면이 단추를 잠그는 데 쓴다 */
  ready(channel: SendChannel): boolean;
}

/** 휴대폰 번호를 SENS 가 받는 모양으로 — 숫자만 남긴다. 아니면 null 이다 */
export function phoneDigits(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return /^0\d{9,10}$/.test(digits) ? digits : null;
}

/**
 * 문자를 보낼 곳 — 한국 번호는 숫자만(SENS 기본 국가 82), 해외 번호(`+…` · N-103)는 SENS 가 따로 받는 국가번호와 국내 번호로 가른다.
 * 모양이 아니면 null 이다 — 보내지 않는다. 보호자 번호(한국만)는 앞의 `phoneDigits` 모양 그대로 지난다.
 */
export function smsDestination(raw: string): { countryCode: string | null; to: string } | null {
  if (raw.trim().startsWith('+')) {
    const parts = phoneParts(raw);
    return parts ? { countryCode: parts.country, to: parts.national } : null;
  }
  const digits = phoneDigits(raw);
  return digits ? { countryCode: null, to: digits } : null;
}

/** 메일 주소인가 — 보내기 전에 한 번 거른다 (공급자 에러로 알게 되면 늦다) */
export function isEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw.trim());
}

/** 메일 주소 가림 — `ab***@example.com`. 도메인은 남긴다(어느 메일로 갔는지는 알아야 한다) */
export function maskEmail(raw: string): string {
  const [local = '', domain = ''] = raw.trim().split('@');
  const head = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  // 원장 칸(guardian_send.to_masked)은 80자다 — 긴 도메인이 발송 **뒤에** INSERT 를 깨뜨리지 않게 여기서 자른다(보안 검토 0925 #3)
  return `${head}***@${domain}`.slice(0, 80);
}

/**
 * 문자 길이는 **바이트**로 잰다 — SENS 는 SMS 90바이트 · LMS 본문 2,000바이트 · LMS 제목 40바이트이고
 * 한글은 2바이트(EUC-KR)다. 글자 수로 고르면 46~90자 한글 문자가 SMS 로 나가 거절된다(보안 검토 0925 #2).
 */
export function smsBytes(text: string): number {
  let n = 0;
  for (const ch of text) n += ch.codePointAt(0)! < 0x80 ? 1 : 2;
  return n;
}

/**
 * 공급자 한 번의 제한 시간 — 서버리스 함수는 30초에 끊긴다(vercel.json maxDuration).
 * 한 요청이 여러 곳에 보내므로 한 곳이 멈춰도 나머지와 원장이 살아남게 짧게 둔다(보안 검토 0925 #1).
 */
export const SEND_TIMEOUT_MS = 8_000;

export const SMS_MAX_BYTES = 90;
export const LMS_MAX_BYTES = 2000;
export const LMS_SUBJECT_MAX_BYTES = 40;

/** 바이트 한도 안으로 자른다 — 글자 중간을 끊지 않는다 */
export function cutBytes(text: string, max: number): string {
  let n = 0;
  let out = '';
  for (const ch of text) {
    const w = ch.codePointAt(0)! < 0x80 ? 1 : 2;
    if (n + w > max) break;
    n += w;
    out += ch;
  }
  return out;
}

/**
 * 휴대폰 가림 — `010-****-1234`. 해외 번호(`+…` · N-103)는 나라를 남겨 `+1 ****0123`. 숫자 모양이 아니면 끝 두 자리만 남긴다.
 */
export function maskPhone(raw: string): string {
  const abroad = maskMobile(raw);
  if (abroad) return abroad;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) return `***${digits.slice(-2)}`;
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

/**
 * 채널마다 다른 것 — 화면에 보일 이름 · 받는 곳을 저장·발송 모양으로 바꾸기 · 원장·로그에 남길 가린 모양.
 * **채널 추가 자리 ②** (위 `SEND_CHANNELS` 주석). 낱말은 서버가 준다 — 화면이 「메일」·「문자」를 다시 적지 않는다.
 */
export interface ChannelSpec {
  label: string;
  /** 설정이 없을 때 화면에 보일 까닭 — 단추를 잠그고 이 말을 붙인다 */
  notReadyReason: string;
  /** 저장·발송 모양 — 모양이 아니면 null */
  normalize(raw: string): string | null;
  mask(to: string): string;
}

export const CHANNEL_SPECS: Record<SendChannel, ChannelSpec> = {
  email: {
    label: '메일',
    notReadyReason: '메일 발송 설정이 없어 보내지 못합니다',
    normalize: (raw) => (isEmail(raw) ? raw.trim() : null),
    mask: maskEmail,
  },
  sms: {
    label: '문자',
    notReadyReason: '문자 발송 설정이 없어 보내지 못합니다',
    normalize: phoneDigits,
    mask: maskPhone,
  },
};

/**
 * 공급자 오류 문장에서 받는 곳 원문을 가린다 — SMTP·SENS 는 거절 사유에 주소·번호를 되돌려 싣는다.
 * 그 문장이 로그·원장·응답으로 가면 **연락처가 새어 나간다**. 원문과 숫자만 뽑은 모양 둘 다 바꾼다.
 */
export function scrubContact(text: string, channel: SendChannel, to: string): string {
  const masked = CHANNEL_SPECS[channel].mask(to);
  // 번호는 공급자가 숫자만으로 되돌려 주기도 한다 — 문자 채널에서만 숫자 모양도 찾는다(메일 주소의 숫자는 건드리지 않는다).
  // 해외 번호는 국가번호를 뗀 국내 번호로 되돌려 올 수도 있다 — 그 모양도 찾는다(N-103)
  const sms = channel === 'sms';
  const needles = [to.trim(), sms ? to.replace(/\D/g, '') : '', sms ? (smsDestination(to)?.to ?? '') : '']
    .filter((n) => n.length >= 4)
    // 긴 것부터 바꾼다 — 짧은 것이 긴 것의 일부를 먼저 바꾸면 긴 것이 남는다
    .sort((a, b) => b.length - a.length);
  return needles.reduce((out, n) => out.split(n).join(masked), text);
}
