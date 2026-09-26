/** @file-guide
 * 목적: phone.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 해외 휴대폰 번호 (N-103 · 대표 결정 2026-09-26 「해외 번호도 받기 — 국가번호를 고르고 번호를 적는다」).
 *
 * 저장 모양이 둘이다 — 한국은 지금처럼 숫자만, 해외는 `+국가번호…`. 증명할 것은 넷이다:
 * 한국 번호는 어떻게 적어도 **지금과 같은 모양**이 된다(같은 번호가 두 번호가 되지 않게) · 목록 밖 나라와 모양이 아닌 번호는 받지 않는다 ·
 * 저장 모양에서 SENS 가 받는 국가번호/번호를 한 가지로 되짚는다 · 가림은 나라를 남긴다.
 */
import { KOREA, PHONE_COUNTRIES, maskMobile, normalizeMobile, phoneParts } from '../src/lib/phone';
import { maskPhone, scrubContact, smsDestination } from '../src/modules/notify/sender';

describe('normalizeMobile — 저장 모양', () => {
  it.each([
    ['010-1234-5678', '01012345678'],
    [' 01012345678 ', '01012345678'],
    ['011-234-5678', '0112345678'],
    ['+82 10-1234-5678', '01012345678'],
    ['+82 010 1234 5678', '01012345678'],
    ['+821012345678', '01012345678'],
  ])('한국 번호 %s → %s (지금과 같은 숫자만)', (raw, want) => expect(normalizeMobile(raw)).toBe(want));

  it.each([
    ['+1 (415) 555-0123', '+14155550123'],
    ['+1 415 555 0123', '+14155550123'],
    ['+44 07911 123456', '+447911123456'],
    ['+44 7911 123456', '+447911123456'],
    ['+61 0412 345 678', '+61412345678'],
    ['+852 9123 4567', '+85291234567'],
    ['+886 0912-345-678', '+886912345678'],
    ['+81 90-1234-5678', '+819012345678'],
    ['+86 138 0013 8000', '+8613800138000'],
  ])('해외 번호 %s → %s (맨 앞 0 하나는 뺀다)', (raw, want) => expect(normalizeMobile(raw)).toBe(want));

  it.each([
    ['02-123-4567'], ['1234'], [''], ['010-1234'],
    ['+82 2-123-4567'],
    ['+1 123-456-7890'],
    ['+1 415 555 012'],
    ['+84 912 345 678'],
    ['+971 50 123 4567'],
    ['+44 123'],
    ['+86 1380013800012345'],
    ['+'],
  ])('%s 는 받지 않는다(모양 · 목록 밖 나라 · 너무 짧거나 긺)', (raw) => expect(normalizeMobile(raw)).toBeNull());

  it('저장 모양은 staff.phone(varchar 20)에 들어간다', () => {
    for (const raw of ['+86 138 0013 8000', '+886 0912-345-678', '+852 9123 4567', '010-1234-5678']) {
      expect((normalizeMobile(raw) ?? '').length).toBeLessThanOrEqual(20);
    }
  });
});

describe('나라 목록', () => {
  it('첫 줄이 대한민국이고 국가번호는 서로의 앞자락이 아니다(되짚기가 한 가지로 닫힌다)', () => {
    expect(PHONE_COUNTRIES[0]).toEqual({ code: KOREA, label: '대한민국' });
    const codes = PHONE_COUNTRIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const a of codes) for (const b of codes) if (a !== b) expect(b.startsWith(a)).toBe(false);
    for (const c of PHONE_COUNTRIES) expect(c.code).toMatch(/^[1-9]\d{0,2}$/);
  });

  it('사전 등록이 필요한 나라(베트남 · 사우디 · UAE)는 목록에 없다', () => {
    for (const code of ['84', '966', '971']) expect(PHONE_COUNTRIES.some((c) => c.code === code)).toBe(false);
  });
});

describe('phoneParts · smsDestination — SENS 가 받는 모양', () => {
  it.each([
    ['01012345678', { country: '82', national: '01012345678' }],
    ['+14155550123', { country: '1', national: '4155550123' }],
    ['+447911123456', { country: '44', national: '7911123456' }],
    ['+85291234567', { country: '852', national: '91234567' }],
  ])('%s → %p', (stored, want) => expect(phoneParts(stored)).toEqual(want));

  it('저장 모양이 아니면 null — 보내지 않는다', () => {
    expect(phoneParts('+8201012345678')).toBeNull();
    expect(phoneParts('+84912345678')).toBeNull();
    expect(phoneParts('0212345678')).toBeNull();
  });

  it('한국 번호는 국가번호를 싣지 않고(지금까지와 같은 요청) 해외 번호는 국가번호와 번호를 가른다', () => {
    expect(smsDestination('010-1234-5678')).toEqual({ countryCode: null, to: '01012345678' });
    expect(smsDestination('+14155550123')).toEqual({ countryCode: '1', to: '4155550123' });
    expect(smsDestination('+84912345678')).toBeNull();
    expect(smsDestination('1234')).toBeNull();
  });
});

describe('가림 — 나라는 남긴다', () => {
  it('해외 번호는 +국가번호와 끝 네 자리만 · 한국 번호는 지금 모양 그대로', () => {
    expect(maskMobile('+14155550123')).toBe('+1 ****0123');
    expect(maskPhone('+447911123456')).toBe('+44 ****3456');
    expect(maskMobile('01012345678')).toBeNull();
    expect(maskPhone('01012345678')).toBe('010-****-5678');
  });

  it('공급자 오류 문장이 국가번호를 뗀 번호로 되돌려 실어도 가린다', () => {
    const text = scrubContact('invalid recipient 4155550123 (+14155550123)', 'sms', '+14155550123');
    expect(text).not.toContain('4155550123');
    expect(text).toContain('+1 ****0123');
  });
});
