/** @file-guide
 * 목적: guardians-deliver.spec.ts (test)
 * 책임/재사용: 보호자 발송의 공급자 한 번 호출(`GuardiansService.deliver`)이 멈춘 공급자에 묶이지 않는지 검증한다. DB 없이 돈다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 보안 검토 0925 #1 — 공급자가 답하지 않아도 한 통은 제한 시간 안에 「실패(확인 필요)」로 끝난다.
 * 그래야 서버리스 30초 안에 원장이 남고, 재시도가 이미 나간 메시지를 다시 보내지 않는다.
 */
import type { DataSource } from 'typeorm';
import { GuardiansService } from '../src/modules/guardians/guardians.service';
import { SEND_TIMEOUT_MS } from '../src/modules/notify/sender';
import { FakeSender } from './fake-sender';

describe('보호자 발송 — 한 통의 상한 시간 (보안 검토 0925)', () => {
  afterEach(() => jest.useRealTimers());

  it('공급자가 멈추면 상한 시간 뒤 failed 로 돌려준다 — 도착 여부는 확인 필요라고 적는다', async () => {
    jest.useFakeTimers();
    const fake = new FakeSender();
    fake.readyMap = { email: true, sms: true };
    fake.send = () => new Promise(() => undefined);
    const service = new GuardiansService({} as DataSource, fake);

    const pending = service['deliver']('email', 'a@b.co', '제목', '본문');
    await jest.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 2_000);
    await expect(pending).resolves.toMatchObject({
      configured: true, ok: false, providerId: null, error: expect.stringContaining('확인이 필요합니다'),
    });
  });

  it('공급자가 제때 답하면 그 답을 그대로 쓰고 타이머를 남기지 않는다', async () => {
    const fake = new FakeSender();
    fake.readyMap = { email: true, sms: true };
    const service = new GuardiansService({} as DataSource, fake);
    await expect(service['deliver']('sms', '01012345678', '제목', '본문'))
      .resolves.toEqual({ configured: true, ok: true, providerId: 'fake-1', error: null });
  });
});
