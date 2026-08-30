/**
 * 리프레시 쿠키의 **유일한 자리**.
 *
 * 왜 파일 하나를 따로 두는가 — 이 설정이 틀리면 **아무것도 안 터진다.**
 * 로그인은 되고, 화면도 뜨고, 15분 뒤 액세스 토큰이 만료되는 순간
 * 재발급 요청에 쿠키가 안 실려서 조용히 로그아웃된다. 로그에도 남지 않는다.
 *
 * 프런트와 백엔드가 **다른 사이트**면 `SameSite=Lax` 쿠키는 안 실린다.
 * `*.vercel.app` 은 공개 접미사 목록(PSL)에 있어서 `a.vercel.app` 과 `b.vercel.app` 도 남남이다.
 * 그래서 커스텀 도메인 하나 아래로 모으고(`app.tn.kr` · `api.tn.kr`)
 * 쿠키에 `Domain=.tn.kr` 를 준다 — 그러면 둘은 **같은 사이트**가 되고 Lax 로 충분하다.
 * 서드파티 쿠키 차단과도 무관해진다 (SameSite=None 이 위험한 이유가 그것이다).
 */
import type { CookieOptions } from 'express';

export const REFRESH_COOKIE = 'taco_rt';

/** 로컬은 도메인을 주지 않는다 — localhost 에 Domain 을 주면 브라우저가 버린다 */
const domain = () => process.env.COOKIE_DOMAIN?.trim() || undefined;

/**
 * 도메인 없이 `*.vercel.app` 두 개로 먼저 띄우는 **임시** 경로.
 *
 * 이때는 `SameSite=None; Secure` 여야 쿠키가 실린다. 지금은 동작하지만
 * **브라우저가 서드파티 쿠키를 막기 시작하면 그날로 멈춘다** — 그래서 기본값이 아니라
 * 사람이 켜야 하는 스위치로 둔다. 켜 두면 부팅 로그가 매번 경고한다.
 * 도메인을 사면 `COOKIE_DOMAIN` 만 넣고 이 스위치를 끄면 된다. 코드는 안 바뀐다.
 */
const crossSite = () => process.env.COOKIE_CROSS_SITE === 'true';

export function cookieOptions(): CookieOptions {
  const prod = process.env.NODE_ENV === 'production';
  // 도메인이 있으면 같은 사이트가 되므로 Lax 로 충분하다 — 그게 더 안전하고 더 오래 간다.
  const none = prod && !domain() && crossSite();
  return {
    httpOnly: true,                                    // JS 가 못 읽는다 — XSS 한 번에 안 털린다
    secure: prod,                                      // SameSite=None 은 Secure 가 없으면 브라우저가 버린다
    sameSite: none ? 'none' : 'lax',
    domain: domain(),
    path: '/',
    maxAge: 14 * 24 * 60 * 60 * 1000,                  // JWT_REFRESH_EXPIRES 와 같은 뜻
  };
}

/** 지울 때는 만든 것과 **같은 domain · path** 여야 지워진다 */
export function clearOptions(): CookieOptions {
  const rest = { ...cookieOptions() };
  delete rest.maxAge;
  return rest;
}

/** `https://app.tn.kr` → `app.tn.kr` · 나쁜 값이면 null */
const hostOf = (origin: string): string | null => {
  try { return new URL(origin.trim()).hostname; } catch { return null; }
};

/** `.tn.kr` 도 `tn.kr` 도 `app.tn.kr` 을 덮는다 */
const covers = (cookieDomain: string, host: string): boolean => {
  const d = cookieDomain.replace(/^\./, '');
  return host === d || host.endsWith(`.${d}`);
};

/**
 * 부팅 시 검사. **반쯤 뜬 서버가 가장 고치기 어렵다** (`app.module.ts` 의 Joi 와 같은 이유).
 * 여기서 막지 않으면 배포는 성공하고 사람이 15분 뒤에 로그아웃되는 것으로 알게 된다.
 *
 * @returns 사람이 읽을 설명. 문제가 있으면 던진다.
 */
export function assertCookieConfig(): string {
  const prod = process.env.NODE_ENV === 'production';
  const origins = (process.env.CORS_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const cd = domain();

  if (!prod) return `개발 모드 — 쿠키 도메인 없음 · secure=false (허용 출처 ${origins.length || '기본값'})`;

  if (origins.length === 0) {
    throw new Error('CORS_ORIGIN 이 비어 있습니다 — 운영에서는 프런트 주소를 반드시 지정하세요.');
  }

  const hosts = origins.map((o) => ({ o, h: hostOf(o) }));
  const bad = hosts.filter((x) => x.h === null).map((x) => x.o);
  if (bad.length) throw new Error(`CORS_ORIGIN 에 주소가 아닌 값이 있습니다: ${bad.join(' · ')}`);

  const local = hosts.every((x) => x.h === 'localhost' || x.h === '127.0.0.1');
  if (local) return '운영 모드지만 허용 출처가 로컬입니다 — 쿠키 도메인 없이 둡니다.';

  if (!cd) {
    // 도메인을 아직 안 샀을 때의 임시 경로. **일부러 켜야만** 여기로 온다.
    if (crossSite()) {
      return (
        '⚠ 임시 설정 — COOKIE_DOMAIN 없이 SameSite=None 으로 돕니다.\n'
        + '   지금은 동작하지만 브라우저가 서드파티 쿠키를 막으면 그날로 로그인 유지가 끊깁니다.\n'
        + `   도메인을 사시면 app.<도메인> · api.<도메인> 으로 옮기고 COOKIE_DOMAIN=".<도메인>" 을 넣은 뒤\n`
        + '   COOKIE_CROSS_SITE 를 지우세요. 코드는 바뀌지 않습니다.'
      );
    }
    throw new Error(
      'COOKIE_DOMAIN 이 없습니다.\n'
      + `  프런트(${origins.join(' · ')})와 이 API 가 다른 사이트면 SameSite=Lax 쿠키가 실리지 않아\n`
      + '  **로그인은 되지만 15분 뒤 재발급이 조용히 실패**합니다.\n'
      + '  고르는 길은 둘입니다.\n'
      + '    ① (권장) 둘을 한 도메인 아래로 — app.tn.kr · api.tn.kr · COOKIE_DOMAIN=".tn.kr"\n'
      + '    ② (임시) 도메인 없이 먼저 띄우기 — COOKIE_CROSS_SITE="true"\n'
      + '       서드파티 쿠키가 막히면 멈추므로 도메인이 생기면 ①로 옮기세요.',
    );
  }

  const uncovered = hosts.filter((x) => x.h && !covers(cd, x.h)).map((x) => x.h);
  if (uncovered.length) {
    throw new Error(
      `COOKIE_DOMAIN="${cd}" 이 프런트 주소를 덮지 못합니다: ${uncovered.join(' · ')}\n`
      + '  덮지 못하면 브라우저가 쿠키를 버립니다 — 오류 없이 로그아웃만 됩니다.',
    );
  }

  return `운영 모드 — 쿠키 도메인 ${cd} · 허용 출처 ${origins.join(' · ')}`;
}
