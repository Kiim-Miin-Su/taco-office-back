/** @file-guide
 * 목적: fake-sender.ts — FakeSender (test)
 * 책임/재사용: 발송 경계(`Sender`)의 시험용 대역 한 벌. 실제 SMTP·SENS 로 나가지 않고 부른 요청을 기록한다. 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import type { SendChannel, SendRequest, SendResult, Sender } from '../src/modules/notify/sender';

/**
 * 채널별로 준비 여부와 답을 바꿀 수 있는 가짜 발송기 — 부른 요청을 기록한다.
 * 기본은 **두 채널 다 설정 없음**(로컬·테스트 환경과 같다). 보호자 발송(DQ3)과 §43 발송 가능 판정이 같은 대역을 쓴다.
 */
export class FakeSender implements Sender {
  readyMap: Record<SendChannel, boolean> = { email: false, sms: false };
  reply: (req: SendRequest) => SendResult = () => ({ configured: true, ok: true, providerId: 'fake-1', error: null });
  calls: SendRequest[] = [];
  ready(channel: SendChannel): boolean { return this.readyMap[channel]; }
  async send(req: SendRequest): Promise<SendResult> {
    this.calls.push(req);
    return this.reply(req);
  }
}
