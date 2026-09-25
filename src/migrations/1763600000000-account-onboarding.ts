/** @file-guide
 * 목적: 1763600000000-account-onboarding.ts — AccountOnboarding1763600000000 (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 첫 로그인 강제 변경 · 이메일/휴대폰 인증 — erd.dbml v4.50 (TBO-52 W8 · 대표 지시 2026-09-26).
 *
 * 지시: 「운영 시 초기 비밀번호는 모두 (초기 비밀번호 — 값은 src/lib/account-policy.ts 한 곳) · 첫 로그인 시 아이디(=이메일) 및 비밀번호 강제 변경 ·
 * phone · email 인증 필수 · 바꾸지 않으면 홈에 들어갈 수 없고 자동으로 돌려보낸다」.
 *
 * - `staff.must_change_credentials` — 이 계정은 첫 설정(아이디 · 비밀번호 · 휴대폰 · 이메일 인증)을 끝내야 한다.
 *   **기본 false** — 지금 있는 계정(시드 · 운영)을 이 마이그레이션이 잠그지 않는다. 켜는 것은 셋뿐이다:
 *   관리자가 계정을 만들 때 · 비밀번호를 초기화할 때 · 운영 전환 스크립트가 초기 비밀번호로 되돌릴 때.
 * - `staff.email_verified` — 이메일 인증 완료(휴대폰은 이미 `phone_verified` 가 있다 · TBO-15).
 * - `staff.credentials_changed_at` — 마지막으로 스스로 아이디·비밀번호를 바꾼 시각(감사 · 첫 설정 완료 판정 보조).
 * - 표 `auth_code` — 인증 코드 한 줄. **코드와 받는 곳의 원문은 저장하지 않는다**(HMAC 값 · 가린 받는 곳만) —
 *   원장이 새어도 코드를 되살릴 수 없고, 연락처 원문이 남지 않는다. 시도 수 · 만료 · 쓴 시각을 한 줄이 갖는다.
 *
 * **기존 행 보정 0 (N-25)** — 옛 계정의 이메일이 확인됐는지 아무도 모른다. 새 칸은 기본값(false/NULL)으로 선다.
 * `down` 은 표를 지우고 칸 셋을 지운다.
 */
export class AccountOnboarding1763600000000 implements MigrationInterface {
  name = 'AccountOnboarding1763600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "staff" ADD COLUMN "must_change_credentials" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "staff" ADD COLUMN "email_verified" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "staff" ADD COLUMN "credentials_changed_at" timestamptz`);
    await q.query(`
      CREATE TABLE "auth_code" (
        "id"            bigserial     NOT NULL,
        "staff_id"      bigint        NOT NULL,
        "channel"       varchar(8)    NOT NULL,
        "target_hash"   varchar(64)   NOT NULL,
        "target_masked" varchar(160)  NOT NULL,
        "code_hash"     varchar(64)   NOT NULL,
        "expires_at"    timestamptz   NOT NULL,
        "attempts"      int           NOT NULL DEFAULT 0,
        "consumed_at"   timestamptz,
        "created_at"    timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "auth_code_pk" PRIMARY KEY ("id"),
        CONSTRAINT "auth_code_staff_fk" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE CASCADE,
        CONSTRAINT "auth_code_channel_words" CHECK ("channel" IN ('email','sms')),
        CONSTRAINT "auth_code_attempts_range" CHECK ("attempts" >= 0),
        CONSTRAINT "auth_code_expiry_after_create" CHECK ("expires_at" > "created_at")
      )
    `);
    await q.query(`CREATE INDEX "auth_code_staff_channel_idx" ON "auth_code" ("staff_id", "channel", "created_at" DESC)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "auth_code"`);
    await q.query(`ALTER TABLE "staff" DROP COLUMN IF EXISTS "credentials_changed_at"`);
    await q.query(`ALTER TABLE "staff" DROP COLUMN IF EXISTS "email_verified"`);
    await q.query(`ALTER TABLE "staff" DROP COLUMN IF EXISTS "must_change_credentials"`);
  }
}
