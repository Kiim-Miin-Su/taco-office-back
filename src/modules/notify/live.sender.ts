/** @file-guide
 * 목적: live.sender.ts — LiveSender (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import {
  isEmail, phoneDigits, type SendChannel, type Sender, type SendRequest, type SendResult,
} from './sender';

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
    this.mail ??= nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
    return this.mail;
  }

  private sens(): { serviceId: string; accessKey: string; secretKey: string; from: string } | null {
    const serviceId = this.cfg.get<string>('SENS_SERVICE_ID');
    const accessKey = this.cfg.get<string>('SENS_ACCESS_KEY');
    const secretKey = this.cfg.get<string>('SENS_SECRET_KEY');
    const from = this.cfg.get<string>('SENS_FROM');
    return serviceId && accessKey && secretKey && from ? { serviceId, accessKey, secretKey, from } : null;
  }

  ready(channel: SendChannel): boolean {
    return channel === 'email' ? this.smtp() !== null : this.sens() !== null;
  }

  async send(req: SendRequest): Promise<SendResult> {
    return req.channel === 'email' ? this.sendMail(req) : this.sendSms(req);
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
      const error = e instanceof Error ? e.message : String(e);
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

    const url = `/sms/v2/services/${s.serviceId}/messages`;
    const ts = String(Date.now());
    const sig = createHmac('sha256', s.secretKey)
      .update(`POST ${url}\n${ts}\n${s.accessKey}`)
      .digest('base64');
    try {
      const res = await fetch(`https://sens.apigw.ntruss.com${url}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'x-ncp-apigw-timestamp': ts,
          'x-ncp-iam-access-key': s.accessKey,
          'x-ncp-apigw-signature-v2': sig,
        },
        body: JSON.stringify({
          // 90자를 넘으면 SENS 가 LMS 를 요구한다 — 글자 수로 우리가 고른다
          type: [...req.body].length > 90 ? 'LMS' : 'SMS',
          from: s.from,
          content: req.body,
          subject: req.subject,
          messages: [{ to }],
        }),
      });
      const text = await res.text();
      if (!res.ok) return { configured: true, ok: false, providerId: null, error: `SENS ${res.status} ${text.slice(0, 200)}` };
      const parsed = JSON.parse(text) as { requestId?: string };
      return { configured: true, ok: true, providerId: parsed.requestId ?? null, error: null };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log.warn(`문자 발송 실패: ${error}`);
      return { configured: true, ok: false, providerId: null, error };
    }
  }
}
