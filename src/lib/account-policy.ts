/** @file-guide
 * 목적: account-policy.ts — INITIAL_PASSWORD, PASSWORD_RULE_TEXT, passwordIssue, normalizeLoginEmail, normalizeMobile (lib)
 * 책임/재사용: 계정의 초기 비밀번호 · 비밀번호 규칙 · 아이디(이메일)/휴대폰 정규화를 한 곳에서 소유한다. 계정 만들기 · 비밀번호 초기화 · 첫 설정 · 운영 전환 스크립트가 같이 쓴다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 계정 정책 한 곳 (W8 · 대표 지시 2026-09-26).
 *
 * 「운영 시 초기 비밀번호는 모두 (아래 값) 로 설정하고 모두 첫 로그인 시 아이디 및 비밀번호 강제 변경,
 *  phone · email 인증 필수」 — 초기 비밀번호가 **여러 곳에 적히면** 한 곳만 바뀌어 계정마다 다른 값이 된다.
 * 그래서 값은 여기 하나이고, 운영에서 바꾸려면 서버 환경 변수 `TACO_INITIAL_PASSWORD` 로 덮는다
 * (화면 번들에는 절대 싣지 않는다 — 넘겨줄 때는 서버 응답이 그 계정에 한해 알려 준다).
 *
 * 아이디는 **이메일**이다(대표 결정 2026-09-26). 저장 · 비교는 소문자 · 앞뒤 공백 없이 한다 —
 * 대소문자만 다른 두 계정이 생기면 로그인이 어느 쪽인지 말할 수 없다.
 */

/** 운영 초기 비밀번호 — 서버 전용 값. 새 계정 · 비밀번호 초기화 · 운영 전환이 이것으로 만들고 첫 로그인 때 반드시 바꾸게 한다 */
export const INITIAL_PASSWORD: string = process.env.TACO_INITIAL_PASSWORD?.trim() || 'tnacademy1234!';

export const PASSWORD_MIN = 8;
/** bcrypt 는 72바이트 뒤를 버린다 — 그보다 긴 비밀번호는 뒤가 다른 두 값이 같은 해시가 된다 */
export const PASSWORD_MAX_BYTES = 72;

/** 화면에 그대로 적는 규칙 문장 — 화면이 규칙을 따로 적지 않는다 (D-R18) */
export const PASSWORD_RULE_TEXT =
  `비밀번호는 ${PASSWORD_MIN}자 이상 · 영문과 숫자를 함께 · 초기 비밀번호와 지금 비밀번호는 쓸 수 없습니다`;

export type PasswordIssue = 'TOO_SHORT' | 'TOO_LONG' | 'NEEDS_LETTER_AND_DIGIT' | 'SAME_AS_INITIAL';

/**
 * 새 비밀번호가 규칙에 맞는가 — 맞으면 null. 「지금 비밀번호와 같은가」는 해시 비교가 필요해 부르는 쪽이 따로 본다.
 * 문장은 `passwordIssueMessage` 한 곳이 만든다.
 */
export function passwordIssue(pw: string): PasswordIssue | null {
  if (pw.length < PASSWORD_MIN) return 'TOO_SHORT';
  if (Buffer.byteLength(pw, 'utf8') > PASSWORD_MAX_BYTES) return 'TOO_LONG';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'NEEDS_LETTER_AND_DIGIT';
  if (pw === INITIAL_PASSWORD) return 'SAME_AS_INITIAL';
  return null;
}

export const PASSWORD_ISSUE_MESSAGE: Record<PasswordIssue, string> = {
  TOO_SHORT: `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다`,
  TOO_LONG: '비밀번호가 너무 깁니다 — 72바이트 이하로 적어 주세요',
  NEEDS_LETTER_AND_DIGIT: '비밀번호에 영문과 숫자를 함께 넣어 주세요',
  SAME_AS_INITIAL: '초기 비밀번호는 쓸 수 없습니다 — 새 비밀번호를 정해 주세요',
};

/** 아이디(이메일) 정규화 — 앞뒤 공백 없이 소문자. 저장 · 비교 · 유일성 판정이 모두 이 값을 쓴다 */
export function normalizeLoginEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 휴대폰 번호 정규화 — 숫자만 남기고 한국 휴대폰(010 · 011 · 016~019, 10~11자리)만 받는다. 아니면 null.
 * SENS 는 숫자만 받는다 — 하이픈 있는 값과 없는 값이 따로 저장되면 같은 번호가 두 번호가 된다.
 */
export function normalizeMobile(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return /^01[016789]\d{7,8}$/.test(digits) ? digits : null;
}
