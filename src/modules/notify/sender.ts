/** @file-guide
 * 목적: sender.ts — SENDER, Sender, SendRequest, SendResult (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
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

export const SENDER = Symbol('SENDER');

export type SendChannel = 'email' | 'sms';

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

/** 메일 주소인가 — 보내기 전에 한 번 거른다 (공급자 에러로 알게 되면 늦다) */
export function isEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw.trim());
}
