/** @file-guide
 * 목적: setup-env.ts — SENDER_ENV_KEYS (test)
 * 책임/재사용: 시험 프로세스가 `.env.local` 의 실제 발송 키(SMTP · SENS)를 받지 않게 jest 가 시험 파일을 부르기 전에 비운다. 발송 규칙은 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 시험은 **발송 키가 없는 환경**을 전제한다(`src/modules/notify/sender.ts` ② — 키가 없으면 보낸 척하지 않는다).
 *
 * 있었던 일(2026-09-27) — 대표 Mac 의 back `.env.local` 에는 실제 메일(SMTP) · 문자(SENS) 키가 있다.
 * `src/data-source.ts` · `test/db.ts` 의 dotenv 와 `ConfigModule` 이 그 파일을 읽어 시험 프로세스에 넣었고,
 * 발송기를 바꿔 끼우지 않은 시험(`screens.spec.ts`)이 「보호자 외부 발송 가능」이 켜진 채 검사돼 릴리스 게이트가 멈췄다.
 * 컨테이너의 `.env.local` 에는 그 키가 없어 초록이었다 — 같은 코드가 기계마다 다른 답을 냈다.
 *
 * 그래서 jest 가 시험 파일마다 import 를 시작하기 **전에**(jest.config.js `setupFiles`) 이 키들을 빈 값으로 잡아 둔다.
 *   · dotenv 는 이미 있는 이름을 덮지 않는다(빈 값도 「있다」) · `ConfigModule` 은 process.env 를 파일 값 위에 얹는다.
 *   · 빈 값이면 `LiveSender` 가 설정 없음으로 본다 — 시험이 실제 공급자로 메일 · 문자를 내보낼 길도 함께 닫힌다.
 * 보내는 흐름을 보는 시험은 지금처럼 `SENDER` 를 `FakeSender` 로 바꿔 끼운다. 이 파일이 막는 것은 **실제 공급자 키**뿐이다.
 */
export const SENDER_ENV_KEYS = [
  'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS',
  'SENS_SERVICE_ID', 'SENS_ACCESS_KEY', 'SENS_SECRET_KEY', 'SENS_FROM',
] as const;

for (const key of SENDER_ENV_KEYS) process.env[key] = '';
