/** @file-guide
 * 목적: live.sender.ts — LiveSender (config)
 * 책임/재사용: 기존 런타임/빌드/검사 설정을 유지한다. 의존성·배포·비밀값 변경은 별도 근거와 검증 없이는 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import {
  cutBytes, isEmail, LMS_MAX_BYTES, LMS_SUBJECT_MAX_BYTES, phoneDigits, scrubContact, SEND_TIMEOUT_MS, smsBytes, SMS_MAX_BYTES,
  type SendChannel, type Sender, type SendRequest, type SendResult,
} from './sender';

/** 채널 하나의 공급자 구현 — 설정이 있는가 · 보낸다 */
interface ChannelAdapter {
  ready(): boolean;
  send(req: SendRequest): Promise<SendResult>;
}

/**
 * 실제로 내보내는 구현 — 메일은 SMTP, 문자는 네이버 클라우드 **SENS**.
 *
 * 키가 없으면 **보낸 척하지 않는다.** `configured: false` 로 답한다 — 로컬·테스트에서
 * 성공으로 적히면 「보냈다는데 안 왔다」가 되고, 그때는 원장이 이미 거짓이다.
 */
@Injectable()
export class LiveSender implements Sender {
  private readonly log = new Logger('Sender');
  private mail: Transporter | null = null;

  constructor(private readonly cfg: ConfigService) {}

  private smtp(): Transporter | null {
    const host = this.cfg.get<string>('SMTP_HOST');
    const user = this.cfg.get<string>('SMTP_USER');
    const pass = this.cfg.get<string>('SMTP_PASS');
    if (!host || !user || !pass) return null;
    const port = Number(this.cfg.get<string>('SMTP_PORT') ?? 587);
    // 제한 시간 — 공급자가 멈추면 요청 전체(서버리스 30초)가 죽고, 이미 나간 메일의 원장이 사라진 채 재시도가 다시 보낸다(보안 검토 0925 #1)
    this.mail ??= nodemailer.createTransport({
      host, port, secure: port === 465, auth: { user, pass },
      connectionTimeout: SEND_TIMEOUT_MS, greetingTimeout: SEND_TIMEOUT_MS, socketTimeout: SEND_TIMEOUT_MS,
    });
    return this.mail;
  }

  private sens(): { serviceId: string; accessKey: string; secretKey: string; from: string } | null {
    const serviceId = this.cfg.get<string>('SENS_SERVICE_ID');
    const accessKey = this.cfg.get<string>('SENS_ACCESS_KEY');
    const secretKey = this.cfg.get<string>('SENS_SECRET_KEY');
    const from = this.cfg.get<string>('SENS_FROM');
    return serviceId && accessKey && secretKey && from ? { serviceId, accessKey, secretKey, from } : null;
  }

  /**
   * **채널 추가 자리 ③** — 채널마다 공급자 하나. `Record<SendChannel, …>` 라서 `sender.SEND_CHANNELS` 에
   * 낱말을 더하고 여기를 비워 두면 컴파일이 멈춘다. 전에는 `channel === 'email' ? 메일 : 문자` 삼항이라
   * 셋째 채널이 조용히 **문자로** 나갔을 자리다.
   */
  private readonly adapters: Record<SendChannel, ChannelAdapter> = {
    email: { ready: () => this.smtp() !== null, send: (req) => this.sendMail(req) },
    sms: { ready: () => this.sens() !== null, send: (req) => this.sendSms(req) },
  };

  ready(channel: SendChannel): boolean {
    return this.adapters[channel].ready();
  }

  async send(req: SendRequest): Promise<SendResult> {
    return this.adapters[req.channel].send(req);
  }

  private async sendMail(req: SendRequest): Promise<SendResult> {
    const tx = this.smtp();
    if (!tx) return { configured: false, ok: false, providerId: null, error: 'SMTP 설정이 없습니다' };
    if (!isEmail(req.to)) return { configured: true, ok: false, providerId: null, error: '메일 주소 모양이 아닙니다' };
    try {
      const info = await tx.sendMail({
        from: this.cfg.get<string>('MAIL_FROM') ?? this.cfg.get<string>('SMTP_USER'),
        to: req.to.trim(),
        subject: req.subject ?? '',
        text: req.body,
        attachments: req.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      });
      return { configured: true, ok: true, providerId: info.messageId ?? null, error: null };
    } catch (e) {
      // 공급자 거절 문장은 받는 주소를 되돌려 싣는다 — 로그·원장에 원문이 남지 않게 가린다 (DQ3)
      const error = scrubContact(e instanceof Error ? e.message : String(e), 'email', req.to);
      this.log.warn(`메일 발송 실패: ${error}`);
      return { configured: true, ok: false, providerId: null, error };
    }
  }

  /**
   * SENS SMS — 서명은 `ACCESS_KEY` 와 `SECRET_KEY` 로 HMAC-SHA256 한 뒤 base64 다.
   * 문서가 요구하는 서명 문자열은 「method \n url \n timestamp \n accessKey」이며, 사이는 공백이다.
   */
  private async sendSms(req: SendRequest): Promise<SendResult> {
    const s = this.sens();
    if (!s) return { configured: false, ok: false, providerId: null, error: 'SENS 설정이 없습니다' };
    const to = phoneDigits(req.to);
    if (!to) return { configured: true, ok: false, providerId: null, error: '휴대폰 번호 모양이 아닙니다' };
    const bytes = smsBytes(req.body);
    if (bytes > LMS_MAX_BYTES) {
      return { configured: true, ok: false, providerId: null, error: `문자 본문이 너무 깁니다 — ${LMS_MAX_BYTES.toLocaleString('ko-KR')}바이트(한글 약 1,000자)까지 보낼 수 있습니다` };
    }
    const lms = bytes > SMS_MAX_BYTES;

    const url = `/sms/v2/services/${s.serviceId}/messages`;
    const ts = String(Date.now());
    const sig = createHmac('sha256', s.secretKey)
      .update(`POST ${url}\n${ts}\n${s.accessKey}`)
      .digest('base64');
    try {
      const res = await fetch(`https://sens.apigw.ntruss.com${url}`, {
        method: 'POST',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'x-ncp-apigw-timestamp': ts,
          'x-ncp-iam-access-key': s.accessKey,
          'x-ncp-apigw-signature-v2': sig,
        },
        body: JSON.stringify({
          // SMS 는 90바이트까지 — 넘으면 LMS. 제목은 LMS 에만 싣고 40바이트로 자른다 (smsBytes · 한글 2바이트)
          type: lms ? 'LMS' : 'SMS',
          from: s.from,
          content: req.body,
          ...(lms && req.subject ? { subject: cutBytes(req.subject, LMS_SUBJECT_MAX_BYTES) } : {}),
          messages: [{ to }],
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        return { configured: true, ok: false, providerId: null, error: scrubContact(`SENS ${res.status} ${text.slice(0, 200)}`, 'sms', req.to) };
      }
      const parsed = JSON.parse(text) as { requestId?: string };
      return { configured: true, ok: true, providerId: parsed.requestId ?? null, error: null };
    } catch (e) {
      const error = scrubContact(e instanceof Error ? e.message : String(e), 'sms', req.to);
      this.log.warn(`문자 발송 실패: ${error}`);
      return { configured: true, ok: false, providerId: null, error };
    }
  }
}
