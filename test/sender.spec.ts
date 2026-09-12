/** @file-guide
 * 목적: sender.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 발송 경계 — 대표 환경 변수(`SMTP_*` · `SENS_*`)가 있는 곳에서만 실제로 나간다.
 *
 * 여기서 증명하는 것은 **「보낸 척하지 않는다」** 하나다. 키가 없으면 `configured:false` 로
 * 답하고 시도조차 하지 않는다 — 로컬에서 성공으로 적히면 원장이 그 순간 거짓이 된다.
 */
import { ConfigService } from '@nestjs/config';
import { LiveSender } from '../src/modules/notify/live.sender';
import { isEmail, phoneDigits } from '../src/modules/notify/sender';

const cfg = (values: Record<string, string>) =>
  new LiveSender({ get: (k: string) => values[k] } as unknown as ConfigService);

describe('보내기 전에 거른다 — 공급자 에러로 알게 되면 늦다', () => {
  it.each([
    ['010-1234-5678', '01012345678'],
    ['01012345678', '01012345678'],
    ['+82 10 1234 5678', null],
    ['1234', null],
    ['', null],
  ])('번호 %s → %s', (raw, want) => expect(phoneDigits(raw)).toBe(want));

  it.each([
    ['a@b.co', true], ['이름@도메인.한국', true],
    ['a@b', false], ['@b.co', false], ['a b@c.co', false], ['', false],
  ])('주소 %s → %s', (raw, want) => expect(isEmail(raw)).toBe(want));
});

describe('키가 없으면 보낸 척하지 않는다 (C48)', () => {
  const empty = cfg({});

  it('메일 설정이 없으면 ready=false 이고 시도하지 않는다', async () => {
    expect(empty.ready('email')).toBe(false);
    await expect(empty.send({ channel: 'email', to: 'a@b.co', body: 'x' }))
      .resolves.toMatchObject({ configured: false, ok: false, providerId: null });
  });

  it('문자 설정이 없으면 ready=false 이고 시도하지 않는다', async () => {
    expect(empty.ready('sms')).toBe(false);
    await expect(empty.send({ channel: 'sms', to: '01012345678', body: 'x' }))
      .resolves.toMatchObject({ configured: false, ok: false });
  });

  it('설정이 반쪽이면 없는 것으로 본다 — 반쯤 뜬 발송기가 가장 고치기 어렵다', () => {
    expect(cfg({ SMTP_HOST: 'smtp.x.com' }).ready('email')).toBe(false);
    expect(cfg({ SENS_SERVICE_ID: 'svc', SENS_ACCESS_KEY: 'k' }).ready('sms')).toBe(false);
  });

  it('키가 다 있으면 ready=true 다 — 실제 전송은 여기서 하지 않는다', () => {
    const full = cfg({
      SMTP_HOST: 'smtp.x.com', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'a@b.co',
      SENS_SERVICE_ID: 'svc', SENS_ACCESS_KEY: 'k', SENS_SECRET_KEY: 's', SENS_FROM: '01000000000',
    });
    expect(full.ready('email')).toBe(true);
    expect(full.ready('sms')).toBe(true);
  });

  it('설정이 있어도 받는 곳 모양이 틀리면 나가지 않는다', async () => {
    const full = cfg({
      SMTP_HOST: 'smtp.x.com', SMTP_USER: 'u', SMTP_PASS: 'p',
      SENS_SERVICE_ID: 'svc', SENS_ACCESS_KEY: 'k', SENS_SECRET_KEY: 's', SENS_FROM: '01000000000',
    });
    await expect(full.send({ channel: 'sms', to: '1234', body: 'x' }))
      .resolves.toMatchObject({ configured: true, ok: false, error: '휴대폰 번호 모양이 아닙니다' });
    await expect(full.send({ channel: 'email', to: 'nope', body: 'x' }))
      .resolves.toMatchObject({ configured: true, ok: false, error: '메일 주소 모양이 아닙니다' });
  });
});
