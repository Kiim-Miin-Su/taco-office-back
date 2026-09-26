/** @file-guide
 * 목적: account-policy.ts — INITIAL_PASSWORD, PASSWORD_RULE_TEXT, passwordIssue, loginIdIssue, normalizeLoginId, normalizeEmail, normalizeMobile (lib)
 * 책임/재사용: 계정의 초기 비밀번호 · 비밀번호 규칙 · 아이디 규칙 · 이메일/휴대폰 정규화를 한 곳에서 소유한다. 계정 만들기 · 비밀번호 초기화 · 첫 설정 · 비밀번호 찾기 · 운영 전환 스크립트가 같이 쓴다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 계정 정책 한 곳 (W8 · W10 · 대표 지시 2026-09-26).
 *
 * **아이디는 형식이 자유다**(W10 · 「매니저가 강사의 아이디를 만들어줄 때든 모든 때의 아이디 형식은 자유 · 폰, 메일 인증만 받으면 됨」).
 * 매니저가 계정을 만들 때 아이디와 임시 비밀번호를 정해 DB 에 넣고, 첫 설정에서 본인이 휴대폰 · 이메일을 코드로 확인하고
 * 새 비밀번호를 정한다. 안전장치는 하나 — **띄어쓰기(보이지 않는 글자 포함) 금지**(답변 2026-09-26). 복사 · 붙여넣기로 섞인
 * 보이지 않는 공백 때문에 「맞게 적었는데 안 들어가지는」 일을 막는다. 대소문자는 같은 아이디로 본다(W8 결정 그대로).
 *
 * 비밀번호 규칙은 하나다 — 매니저가 정하는 임시 비밀번호도, 본인이 정하는 새 비밀번호도 같은 `passwordIssue` 를 지난다.
 *
 * 운영 초기 비밀번호(`INITIAL_PASSWORD`)는 이제 **운영 전환 스크립트(대표 계정)만** 쓴다 — 계정 만들기 · 비밀번호 초기화는
 * 매니저가 적은 임시 비밀번호를 쓴다(W10 · 답변 2026-09-26). 값은 여기 하나이고 운영에서는 서버 환경 변수 `TACO_INITIAL_PASSWORD` 로 덮는다
 * (화면 번들 · 응답 · 기록에는 싣지 않는다). 대표 · 매니저의 초기 계정은 나중에 정한다(대표 지시 2026-09-26).
 */

/** 운영 초기 비밀번호 — 서버 전용 값. 운영 전환 스크립트가 남기는 대표 계정을 이것으로 되돌리고 첫 로그인 때 반드시 바꾸게 한다 */
export const INITIAL_PASSWORD: string = process.env.TACO_INITIAL_PASSWORD?.trim() || 'tnacademy1234!';

export const PASSWORD_MIN = 8;
/** bcrypt 는 72바이트 뒤를 버린다 — 그보다 긴 비밀번호는 뒤가 다른 두 값이 같은 해시가 된다 */
export const PASSWORD_MAX_BYTES = 72;

/** 화면에 그대로 적는 규칙 문장 — 화면이 규칙을 따로 적지 않는다 (D-R18) */
export const PASSWORD_RULE_TEXT =
  `비밀번호는 ${PASSWORD_MIN}자 이상 · 영문과 숫자를 함께 · 초기 비밀번호와 지금 비밀번호는 쓸 수 없습니다`;

/** 매니저가 임시 비밀번호를 정할 때의 문장 — 규칙은 같은 `passwordIssue` 다(문장만 받는 사람에 맞춘다) */
export const TEMP_PASSWORD_RULE_TEXT =
  `임시 비밀번호는 ${PASSWORD_MIN}자 이상 · 영문과 숫자를 함께 — 첫 로그인 때 본인이 휴대폰 · 이메일을 확인하고 새 비밀번호로 바꿉니다`;

export type PasswordIssue = 'TOO_SHORT' | 'TOO_LONG' | 'NEEDS_LETTER_AND_DIGIT' | 'SAME_AS_INITIAL';

/**
 * 새 비밀번호가 규칙에 맞는가 — 맞으면 null. 「지금 비밀번호와 같은가」는 해시 비교가 필요해 부르는 쪽이 따로 본다.
 * 문장은 `PASSWORD_ISSUE_MESSAGE` 한 곳이 만든다.
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

/* ── 아이디 (W10) ───────────────────────────────────────────────────────── */

/** 아이디 길이 — 칸(varchar 120)과 같다. 옛 계정은 이메일이 옮겨 와 있어 그보다 짧게 잡으면 옛 아이디가 규칙 밖이 된다 */
export const LOGIN_ID_MAX = 120;

/** 화면에 그대로 적는 아이디 규칙 문장 (D-R18) */
export const LOGIN_ID_RULE_TEXT =
  `형식 자유 — 한글 · 영문 · 숫자 · 기호 모두 됩니다 · 띄어쓰기 없이 ${LOGIN_ID_MAX}자까지 · 대소문자는 같은 아이디로 봅니다`;

export type LoginIdIssue = 'EMPTY' | 'TOO_LONG' | 'HAS_SPACE';

/**
 * 공백 · 보이지 않는 글자 — 띄어쓰기(`\s` · 전각 공백 포함)와 폭 없는 글자 · 제어 글자(Cf · Cc).
 * `\s` 만으로는 폭 없는 공백(U+200B)을 못 잡는다 — 그것이 바로 「맞게 적었는데 안 들어가지는」 글자다.
 */
const INVISIBLE = /[\s\p{Cc}\p{Cf}]/u;

/** 아이디 정규화 — 앞뒤 공백만 지운다. 적은 모양(대소문자)은 그대로 저장하고 비교만 `lower()` 로 한다 */
export function normalizeLoginId(raw: string): string {
  return raw.trim();
}

/** 아이디가 규칙에 맞는가 — 맞으면 null. 앞뒤 공백은 지운 뒤에 본다 */
export function loginIdIssue(raw: string): LoginIdIssue | null {
  const id = normalizeLoginId(raw);
  if (id.length === 0) return 'EMPTY';
  if ([...id].length > LOGIN_ID_MAX) return 'TOO_LONG';
  if (INVISIBLE.test(id)) return 'HAS_SPACE';
  return null;
}

export const LOGIN_ID_ISSUE_MESSAGE: Record<LoginIdIssue, string> = {
  EMPTY: '아이디를 적어 주세요',
  TOO_LONG: `아이디는 ${LOGIN_ID_MAX}자까지입니다`,
  HAS_SPACE: '아이디에는 띄어쓰기(보이지 않는 공백 포함)를 쓸 수 없습니다',
};

/* ── 이메일 · 휴대폰 ────────────────────────────────────────────────────── */

/** 이메일 정규화 — 앞뒤 공백 없이 소문자. 저장 · 비교 · 유일성 판정이 모두 이 값을 쓴다(W10 부터 연락 · 인증용) */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 휴대폰 번호 정규화 — 한국 휴대폰은 숫자만(010 · 011 · 016~019), 해외 번호는 `+국가번호…` 모양(N-103 · 2026-09-26).
 * 나라 목록 · 저장 모양 · 발송 모양은 `lib/phone` 한 곳이 소유한다 — 여기서는 계정 정책의 이름으로 다시 내보낼 뿐이다.
 */
export { normalizeMobile } from './phone';
