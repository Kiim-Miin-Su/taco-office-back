/**
 * 배포 설정 — **조용히 틀리는 것들**만 모아 못 박는다.
 *
 * 여기 있는 것은 전부 「배포는 성공하고 사람이 나중에 알게 되는」 종류다.
 *   · 쿠키 도메인이 안 맞아 15분 뒤 로그아웃
 *   · 시드가 운영 DB 를 지움 (연결 문자열에 'prod' 가 없어서 옛 안전벨트를 통과했다)
 *
 * DB 가 필요 없다 — 전부 순수 함수다.
 */
import { assertCookieConfig, cookieOptions, clearOptions, REFRESH_COOKIE } from '../src/auth/cookie';
import { describeTarget, assertWritableTarget } from '../src/lib/target';
import { hasPerm } from '../src/common/perm';

/** 환경변수를 건드리는 테스트다 — 끝나면 되돌린다 */
const KEYS = ['NODE_ENV', 'CORS_ORIGIN', 'COOKIE_DOMAIN', 'COOKIE_CROSS_SITE', 'SEED_I_KNOW'] as const;
let saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); });
afterEach(() => {
  KEYS.forEach((k) => {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
});

const setEnv = (e: Partial<Record<(typeof KEYS)[number], string>>) => {
  KEYS.forEach((k) => delete process.env[k]);
  Object.entries(e).forEach(([k, v]) => { process.env[k] = v; });
};

describe('쿠키 설정 — 틀리면 15분 뒤 조용히 로그아웃된다', () => {
  it('개발에서는 도메인 없이 · secure 없이', () => {
    setEnv({ NODE_ENV: 'development' });
    const o = cookieOptions();
    expect(o.domain).toBeUndefined();
    expect(o.secure).toBe(false);
    expect(o.httpOnly).toBe(true);          // JS 가 못 읽는다 — XSS 로 안 털린다
    expect(o.sameSite).toBe('lax');
    expect(assertCookieConfig()).toContain('개발 모드');
  });

  it('운영에서 도메인이 프런트를 덮으면 통과', () => {
    setEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://app.tn.kr', COOKIE_DOMAIN: '.tn.kr' });
    expect(assertCookieConfig()).toContain('.tn.kr');
    const o = cookieOptions();
    expect(o.domain).toBe('.tn.kr');
    expect(o.secure).toBe(true);
  });

  it('점 없는 도메인도 서브도메인을 덮는다', () => {
    setEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://app.tn.kr', COOKIE_DOMAIN: 'tn.kr' });
    expect(() => assertCookieConfig()).not.toThrow();
  });

  it('★ 운영인데 COOKIE_DOMAIN 이 없으면 **부팅을 막는다**', () => {
    setEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://taco-front.vercel.app' });
    expect(() => assertCookieConfig()).toThrow(/COOKIE_DOMAIN/);
    // 왜 막는지가 메시지에 있어야 한다 — 「설정 오류」만 보면 아무도 못 고친다
    expect(() => assertCookieConfig()).toThrow(/15분/);
  });

  it('★ 도메인이 프런트를 못 덮으면 막는다 (브라우저가 쿠키를 버린다)', () => {
    setEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://app.other.kr', COOKIE_DOMAIN: '.tn.kr' });
    expect(() => assertCookieConfig()).toThrow(/덮지 못합니다/);
  });

  it('운영인데 CORS_ORIGIN 이 비면 막는다', () => {
    setEnv({ NODE_ENV: 'production', COOKIE_DOMAIN: '.tn.kr' });
    expect(() => assertCookieConfig()).toThrow(/CORS_ORIGIN/);
  });

  it('주소가 아닌 값을 넣으면 막는다', () => {
    setEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'app.tn.kr', COOKIE_DOMAIN: '.tn.kr' });
    expect(() => assertCookieConfig()).toThrow(/주소가 아닌/);
  });

  it('지우는 옵션은 만든 것과 같아야 한다 — maxAge 만 빠진다', () => {
    setEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://app.tn.kr', COOKIE_DOMAIN: '.tn.kr' });
    const made = cookieOptions();
    const cleared = clearOptions();
    expect(cleared).not.toHaveProperty('maxAge');
    (['domain', 'path', 'sameSite', 'secure', 'httpOnly'] as const)
      .forEach((k) => expect(cleared[k]).toBe(made[k]));
  });

  it('쿠키 이름은 한 곳에서만 나온다', () => {
    expect(REFRESH_COOKIE).toBe('taco_rt');
  });
});

describe('DB 대상 판정 — 옛 안전벨트가 Neon 을 못 잡았다', () => {
  const NEON = 'postgresql://u:p@ep-quiet-frost-a1b2.ap-northeast-2.aws.neon.tech/taco?sslmode=require';
  const LOCAL = 'postgresql://taco:taco@localhost:55432/taco_dev';

  it('로컬은 로컬로 본다', () => {
    expect(describeTarget(LOCAL).kind).toBe('local');
    expect(describeTarget(LOCAL).db).toBe('taco_dev');
  });

  it('★ Neon 주소에는 prod 라는 글자가 없다 — 그래서 옛 검사를 통과했다', () => {
    expect(/prod|production/i.test(NEON)).toBe(false);   // 옛 안전벨트가 통과시킨 이유
    expect(describeTarget(NEON).kind).toBe('managed');    // 새 판정은 잡는다
  });

  it('로컬이면 시드를 허락한다', () => {
    setEnv({});
    expect(() => assertWritableTarget(LOCAL, '시드')).not.toThrow();
  });

  it('★ 원격이면 막는다 — 그리고 어떻게 넘길지 알려 준다', () => {
    setEnv({});
    expect(() => assertWritableTarget(NEON, '시드')).toThrow(/SEED_I_KNOW/);
    expect(() => assertWritableTarget(NEON, '시드')).toThrow(/taco/);
  });

  it('DB 이름을 정확히 적었을 때만 넘어간다', () => {
    setEnv({ SEED_I_KNOW: 'taco' });
    expect(() => assertWritableTarget(NEON, '시드')).not.toThrow();
    setEnv({ SEED_I_KNOW: 'taco_dev' });                 // 다른 이름이면 여전히 막힌다
    expect(() => assertWritableTarget(NEON, '시드')).toThrow();
    setEnv({ SEED_I_KNOW: 'yes' });                      // 「예」로는 안 넘어간다
    expect(() => assertWritableTarget(NEON, '시드')).toThrow();
  });

  it('모르는 호스트는 안전한 쪽으로 — 막는다', () => {
    setEnv({});
    expect(() => assertWritableTarget('postgresql://u:p@db.internal.example/taco', '시드')).toThrow();
  });

  it('DATABASE_URL 이 없으면 그 사실을 말한다', () => {
    setEnv({});
    expect(() => assertWritableTarget(undefined, '시드')).toThrow(/DATABASE_URL/);
  });
});

/**
 * 권한 — **켜 놓았는데 안 열리는** 자리를 못 박는다.
 *
 * 네 컨트롤러가 금액 판정을 `canSeeProfit` 으로 물어보고 있었다. 그 이름에는
 * 사람별 예외 컬럼이 없어서, 관리자가 `STAFF.can_money` 를 켜도 화면은 잠긴 채였다.
 * 오류도 안 나므로 「권한을 줬는데 왜 안 보이지」로만 드러난다.
 */
describe('금액 권한 — 사람별 예외가 실제로 먹히는가', () => {
  it('기본값은 대표만', () => {
    expect(hasPerm('ceo', 'canMoney')).toBe(true);
    expect(hasPerm('manager', 'canMoney')).toBe(false);
    expect(hasPerm('teacher', 'canMoney')).toBe(false);
  });

  it('★ 매니저에게 열어 주면 열린다', () => {
    expect(hasPerm('manager', 'canMoney', { canMoney: true })).toBe(true);
  });

  it('★ 대표에게 닫으면 닫힌다', () => {
    expect(hasPerm('ceo', 'canMoney', { canMoney: false })).toBe(false);
  });

  it('canSeeProfit 은 예외가 없는 **원본**이다 — 그래서 가리는 판정에 쓰면 안 된다', () => {
    // 이 줄이 이 파일의 요점이다. 두 이름이 같은 답을 주는 것처럼 보이지만
    // 예외가 들어오는 순간 갈린다.
    expect(hasPerm('manager', 'canSeeProfit', { canMoney: true })).toBe(false);
    expect(hasPerm('manager', 'canMoney', { canMoney: true })).toBe(true);
  });

  it('예외가 없으면 둘은 같은 답을 준다', () => {
    (['teacher', 'manager', 'admin', 'ceo'] as const).forEach((r) => {
      expect(hasPerm(r, 'canMoney')).toBe(hasPerm(r, 'canSeeProfit'));
    });
  });
});

/**
 * 도메인 없이 먼저 띄우는 임시 경로.
 * 대표님이 도메인을 아직 안 사셨을 때 배포가 아예 막히면 안 되지만,
 * **잘못 들어가는 일도 없어야** 한다 — 그래서 일부러 켜야만 열린다.
 */
describe('도메인 없이 배포 (임시)', () => {
  const VERCEL = { NODE_ENV: 'production', CORS_ORIGIN: 'https://taco-app.vercel.app' };

  it('★ 스위치를 안 켜면 여전히 막는다 — 실수로 들어가지 않게', () => {
    setEnv(VERCEL);
    expect(() => assertCookieConfig()).toThrow(/COOKIE_DOMAIN/);
    // 두 길을 다 알려 준다. 막기만 하면 사람이 무엇을 해야 할지 모른다.
    expect(() => assertCookieConfig()).toThrow(/COOKIE_CROSS_SITE/);
  });

  it('★ 켜면 SameSite=None + Secure 로 열린다', () => {
    setEnv({ ...VERCEL, COOKIE_CROSS_SITE: 'true' });
    const o = cookieOptions();
    expect(o.sameSite).toBe('none');
    expect(o.secure).toBe(true);          // None 은 Secure 없이는 브라우저가 버린다
    expect(o.domain).toBeUndefined();
    expect(assertCookieConfig()).toContain('임시');
  });

  it('도메인이 생기면 Lax 로 돌아온다 — 스위치가 켜져 있어도 도메인이 이긴다', () => {
    setEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://app.tn.kr', COOKIE_DOMAIN: '.tn.kr', COOKIE_CROSS_SITE: 'true' });
    const o = cookieOptions();
    expect(o.sameSite).toBe('lax');
    expect(o.domain).toBe('.tn.kr');
  });

  it('개발에서는 스위치가 켜져 있어도 아무 일도 안 한다', () => {
    setEnv({ NODE_ENV: 'development', COOKIE_CROSS_SITE: 'true' });
    expect(cookieOptions().sameSite).toBe('lax');
    expect(cookieOptions().secure).toBe(false);
  });
});
