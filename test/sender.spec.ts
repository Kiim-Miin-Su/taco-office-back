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
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as dotenv from 'dotenv';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveSender } from '../src/modules/notify/live.sender';
import * as nodemailer from 'nodemailer';
import {
  cutBytes, isEmail, LMS_MAX_BYTES, maskEmail, phoneDigits, SEND_TIMEOUT_MS, smsBytes,
} from '../src/modules/notify/sender';

// SMTP 는 실제로 열지 않는다 — 만든 설정만 본다
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn().mockResolvedValue({ messageId: 'm-1' }) })),
}));

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

/**
 * 보안 검토 0925 — 발송이 멈추거나 거절되는 자리를 보내기 전에 막는다.
 * SENS 는 SMS 90바이트 · LMS 본문 2,000바이트 · LMS 제목 40바이트이고 한글은 2바이트다.
 */
describe('문자 길이는 바이트로 잰다 · 제한 시간을 건다 (보안 검토 0925)', () => {
  const FULL = {
    SMTP_HOST: 'smtp.x.com', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'a@b.co',
    SENS_SERVICE_ID: 'svc', SENS_ACCESS_KEY: 'k', SENS_SECRET_KEY: 's', SENS_FROM: '01000000000',
  };
  let fetchSpy: jest.SpyInstance;
  const sent = () => JSON.parse(fetchSpy.mock.calls[0][1].body as string) as { type: string; subject?: string };

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ requestId: 'r-1' }), { status: 202 })));
  });
  afterEach(() => fetchSpy.mockRestore());

  it('바이트 셈 — ASCII 1 · 한글 2 · 자르기는 글자 중간을 끊지 않는다', () => {
    expect(smsBytes('abc')).toBe(3);
    expect(smsBytes('안내')).toBe(4);
    expect(smsBytes('A안')).toBe(3);
    expect(cutBytes('안녕하세요', 5)).toBe('안녕');
    expect(cutBytes('ab안', 3)).toBe('ab');
  });

  it('한글 45자(90바이트)는 SMS · 46자(92바이트)는 LMS — 글자 수로 고르던 때는 둘 다 SMS 였다', async () => {
    const live = cfg(FULL);
    await live.send({ channel: 'sms', to: '01012345678', subject: '제목', body: '가'.repeat(45) });
    expect(sent()).toMatchObject({ type: 'SMS' });
    expect(sent().subject).toBeUndefined();

    fetchSpy.mockClear();
    await live.send({ channel: 'sms', to: '01012345678', subject: '제목', body: '가'.repeat(46) });
    expect(sent()).toMatchObject({ type: 'LMS', subject: '제목' });
  });

  it('LMS 제목은 40바이트로 자른다 — 한글 20자', async () => {
    await cfg(FULL).send({ channel: 'sms', to: '01012345678', subject: '가'.repeat(30), body: '나'.repeat(100) });
    expect(sent().subject).toBe('가'.repeat(20));
  });

  it('2,000바이트를 넘는 본문은 공급자를 부르지 않고 실패로 돌려준다', async () => {
    const res = await cfg(FULL).send({ channel: 'sms', to: '01012345678', body: '가'.repeat(LMS_MAX_BYTES / 2 + 1) });
    expect(res).toMatchObject({ configured: true, ok: false, providerId: null });
    expect(res.error).toContain('2,000바이트');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // N-103 (대표 결정 2026-09-26) — 해외 번호는 SENS 국제 문자로 · 한국 번호 요청은 지금과 한 글자도 다르지 않다
  it('해외 번호는 countryCode 와 국가번호를 뗀 번호로 보내고 · 한국 번호 요청에는 countryCode 가 없다', async () => {
    const live = cfg(FULL);
    await live.send({ channel: 'sms', to: '+14155550123', body: '[TN Academy] verification: 123456' });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body as string)).toMatchObject({
      type: 'SMS', countryCode: '1', messages: [{ to: '4155550123' }],
    });
    fetchSpy.mockClear();
    await live.send({ channel: 'sms', to: '01012345678', body: 'x' });
    const domestic = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(domestic).not.toHaveProperty('countryCode');
    expect(domestic).toMatchObject({ messages: [{ to: '01012345678' }] });
  });

  it('해외 번호로는 SMS 한 통(90바이트)을 넘기지 않는다 — 공급자를 부르지 않고 실패로 돌려준다', async () => {
    const res = await cfg(FULL).send({ channel: 'sms', to: '+447911123456', body: 'a'.repeat(91) });
    expect(res).toMatchObject({ configured: true, ok: false, providerId: null });
    expect(res.error).toContain('90바이트');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('목록 밖 나라 번호는 보내지 않는다', async () => {
    const res = await cfg(FULL).send({ channel: 'sms', to: '+84912345678', body: 'x' });
    expect(res).toMatchObject({ configured: true, ok: false, error: '휴대폰 번호 모양이 아닙니다' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SENS 요청에 제한 시간(AbortSignal)을 싣는다', async () => {
    await cfg(FULL).send({ channel: 'sms', to: '01012345678', body: 'x' });
    expect(fetchSpy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('SMTP 연결에 세 단계 제한 시간을 싣는다', async () => {
    const res = await cfg(FULL).send({ channel: 'email', to: 'a@b.co', subject: 's', body: 'x' });
    expect(res).toMatchObject({ ok: true, providerId: 'm-1' });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      connectionTimeout: SEND_TIMEOUT_MS, greetingTimeout: SEND_TIMEOUT_MS, socketTimeout: SEND_TIMEOUT_MS,
    }));
  });

  it('가린 메일 주소는 원장 칸(80자)을 넘지 않는다', () => {
    expect(maskEmail(`ab@${'d'.repeat(120)}.com`).length).toBe(80);
    expect(maskEmail('mom@example.com')).toBe('mo***@example.com');
  });
});

/**
 * 시험 프로세스는 실제 발송 키를 받지 않는다 (2026-09-27 · `test/setup-env.ts`).
 * 대표 Mac 의 `.env.local` 에 SMTP · SENS 키가 있어 발송기를 바꿔 끼우지 않은 시험이 「발송 가능」인 채 돌았다(release 게이트 back 테스트 실패).
 * 같은 모양의 파일을 만들어 dotenv · ConfigModule 이 읽어도 발송기가 설정 없음으로 남는지 본다 — setupFiles 가 빠지면 여기서 먼저 깨진다.
 */
describe('시험 프로세스는 .env.local 의 실제 발송 키를 받지 않는다 (2026-09-27)', () => {
  it('SMTP · SENS 키가 든 env 파일을 dotenv · ConfigModule 이 읽어도 키는 빈 값이고 발송기는 설정 없음이다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'taco-sender-env-'));
    const file = join(dir, '.env.local');
    // 여기서 setup-env 를 import 하지 않는다 — import 만으로 키가 비워져 setupFiles 가 빠져도 이 시험이 초록이 된다
    const leaked: Record<string, string> = {
      SMTP_HOST: 'smtp.example.com', SMTP_USER: 'mailer@example.com', SMTP_PASS: 'p',
      SENS_SERVICE_ID: 'svc', SENS_ACCESS_KEY: 'k', SENS_SECRET_KEY: 's', SENS_FROM: '01000000000',
    };
    writeFileSync(file, Object.entries(leaked).map(([k, v]) => `${k}=${v}`).join('\n'));
    const transportsBefore = jest.mocked(nodemailer.createTransport).mock.calls.length;
    try {
      dotenv.config({ path: file, quiet: true }); // src/data-source.ts · test/db.ts 와 같은 읽기 — 이미 있는 이름은 덮지 않는다
      for (const key of Object.keys(leaked)) expect(process.env[key]).toBe('');

      const mod = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ envFilePath: [file] })],
        providers: [LiveSender],
      }).compile();
      const sender = mod.get(LiveSender);
      expect(sender.ready('email')).toBe(false);
      expect(sender.ready('sms')).toBe(false);
      await expect(sender.send({ channel: 'email', to: 'a@b.co', body: 'x' }))
        .resolves.toMatchObject({ configured: false, ok: false });
      expect(jest.mocked(nodemailer.createTransport).mock.calls.length).toBe(transportsBefore);
      await mod.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
