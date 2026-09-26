/** @file-guide
 * 목적: phone.ts — PHONE_COUNTRIES, KOREA, normalizeMobile, phoneParts, maskMobile (lib)
 * 책임/재사용: 구성원 휴대폰 번호의 나라 · 저장 모양 · 발송 모양 · 가림을 한 곳에서 소유한다. 첫 설정 · 비밀번호 찾기 · 구성원 만들기/수정 · 문자 발송이 같이 쓴다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 해외 휴대폰 번호 (N-103 · 대표 결정 2026-09-26 「해외 번호도 받기 — 국가번호를 고르고 번호를 적는다 · SENS 국제 문자」).
 *
 * **저장 모양은 둘이다.**
 *   · 한국 번호는 지금처럼 숫자만(`01012345678`) — 이미 저장된 번호와 보호자 번호(`guardian_phone_digits`)가 이 모양이다.
 *     `+82 10-1234-5678` 로 적어도 같은 모양으로 저장한다(같은 번호가 두 번호가 되지 않게).
 *   · 해외 번호는 `+국가번호` 와 국내 번호(맨 앞 0 을 뺀 것)를 붙인 E.164 모양(`+14155550123`).
 * 국가번호는 서로의 앞자락이 되지 않으므로(ITU E.164) 저장된 `+…` 에서 나라를 되짚는 일이 한 가지로 닫힌다.
 *
 * 나라 목록은 SENS 국제 문자 발송국 중에서 **사전 등록 없이** 보낼 수 있는 나라만 둔다(NAVER Cloud SENS 정책 안내 ·
 * 베트남 · 사우디 · UAE 는 발신 번호 사전 등록이 필요해 뺐다). 화면의 국가번호 고르기도 이 목록을 서버에서 받는다(D-R18).
 * 나라를 더하는 날 고칠 곳은 이 배열 하나다.
 */
export interface PhoneCountry {
  /** 국가번호 — `+` 없이 숫자만 */
  code: string;
  label: string;
}

export const KOREA = '82';

export const PHONE_COUNTRIES: readonly PhoneCountry[] = [
  { code: KOREA, label: '대한민국' },
  { code: '1', label: '미국 · 캐나다' },
  { code: '44', label: '영국' },
  { code: '61', label: '호주' },
  { code: '64', label: '뉴질랜드' },
  { code: '65', label: '싱가포르' },
  { code: '852', label: '홍콩' },
  { code: '63', label: '필리핀' },
  { code: '81', label: '일본' },
  { code: '86', label: '중국' },
  { code: '886', label: '대만' },
  { code: '60', label: '말레이시아' },
  { code: '66', label: '태국' },
  { code: '62', label: '인도네시아' },
  { code: '91', label: '인도' },
  { code: '49', label: '독일' },
  { code: '33', label: '프랑스' },
];

/** 한국 휴대폰 — 010 · 011 · 016~019, 10~11자리 (SENS 는 숫자만 받는다) */
const KOREAN_MOBILE = /^01[016789]\d{7,8}$/;
/** 북미(+1)는 지역번호 · 국번이 2~9 로 시작하는 10자리 */
const NANP = /^[2-9]\d{2}[2-9]\d{6}$/;
/** 그 밖의 나라 — 맨 앞 0(국내 접두)을 뺀 국내 번호 6~12자리 · 국가번호와 합쳐 15자리 이하(E.164) */
const NATIONAL = /^[1-9]\d{5,11}$/;

/** 숫자만 — `+` 는 호출하는 쪽이 따로 본다 */
const digitsOf = (raw: string) => raw.replace(/\D/g, '');

/** `+` 로 시작하는 숫자열의 나라 — 국가번호는 서로의 앞자락이 아니므로 맞는 것은 많아야 하나다 */
function countryOf(digits: string): PhoneCountry | null {
  return PHONE_COUNTRIES.find((c) => digits.startsWith(c.code)) ?? null;
}

/**
 * 적은 번호를 저장 모양으로 — 모양이 아니면 null.
 *   · `+` 가 없으면 한국 번호로 읽는다(지금까지와 같다).
 *   · `+82 …` 는 한국 번호 모양(숫자만 · 0 으로 시작)으로 바꿔 저장한다.
 *   · 그 밖의 `+국가번호 …` 는 목록에 있는 나라만 받고, 국내 번호 맨 앞의 0 하나는 뺀다(`+44 07911 …` → `+447911…`).
 */
export function normalizeMobile(raw: string): string | null {
  const text = raw.trim();
  if (!text.startsWith('+')) {
    const digits = digitsOf(text);
    return KOREAN_MOBILE.test(digits) ? digits : null;
  }
  const digits = digitsOf(text);
  const country = countryOf(digits);
  if (!country) return null;
  const rest = digits.slice(country.code.length);
  if (country.code === KOREA) {
    const domestic = rest.startsWith('0') ? rest : `0${rest}`;
    return KOREAN_MOBILE.test(domestic) ? domestic : null;
  }
  const national = rest.startsWith('0') ? rest.slice(1) : rest;
  const ok = country.code === '1' ? NANP.test(national) : NATIONAL.test(national);
  if (!ok || country.code.length + national.length > 15) return null;
  return `+${country.code}${national}`;
}

/**
 * 저장 모양 → 보낼 나라와 번호. 한국은 `{ country: '82', national: '010…' }`(SENS 기본 국가) ·
 * 해외는 `{ country: '1', national: '4155550123' }`(SENS 는 국가번호를 따로 받고 받는 번호는 숫자만이다).
 * 저장 모양이 아니면 null — 보내지 않는다.
 */
export function phoneParts(stored: string): { country: string; national: string } | null {
  const text = stored.trim();
  if (!text.startsWith('+')) {
    return KOREAN_MOBILE.test(text) ? { country: KOREA, national: text } : null;
  }
  const digits = digitsOf(text);
  const country = countryOf(digits);
  if (!country || country.code === KOREA) return null;
  const national = digits.slice(country.code.length);
  return national ? { country: country.code, national } : null;
}

/** 해외 번호 가림 — `+1 ****0123`. 나라는 남긴다(어디로 갔는지는 알아야 한다). 한국 번호는 부르는 쪽(maskPhone)이 따로 가린다 */
export function maskMobile(stored: string): string | null {
  const parts = stored.trim().startsWith('+') ? phoneParts(stored) : null;
  return parts ? `+${parts.country} ****${parts.national.slice(-4)}` : null;
}
