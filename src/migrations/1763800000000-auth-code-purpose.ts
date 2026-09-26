/** @file-guide
 * 목적: 1763800000000-auth-code-purpose.ts — AuthCodePurpose1763800000000 (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 인증 코드의 용도 — erd.dbml v4.52 (N-101 비밀번호 찾기 · 대표 결정 2026-09-26).
 *
 * 비밀번호 찾기가 첫 설정과 **같은 원장(auth_code)** 을 쓴다. 용도 칸이 없으면 첫 설정 코드로 비밀번호를 바꾸거나
 * 그 반대가 된다 — 확인이 용도를 함께 보게 한 칸을 더한다.
 *
 * - `auth_code.purpose` — `onboarding` | `password_reset`(`auth_code_purpose_words` CHECK).
 *   **기본값 `onboarding`** — 지금 있는 줄은 전부 첫 설정 코드다(비밀번호 찾기는 이 마이그레이션 뒤에 생긴다). 추정이 아니라 정의다.
 * - 발급 한도(60초 · 한 시간 · 하루)는 용도와 무관하게 계정 · 채널마다 센다 — 색인 `auth_code_staff_channel_idx` 그대로.
 *
 * `down` 은 제약과 칸을 지운다(비밀번호 찾기 코드 줄은 첫 설정 줄과 구별되지 않게 된다 — 남은 코드는 10분 안에 만료된다).
 */
export class AuthCodePurpose1763800000000 implements MigrationInterface {
  name = 'AuthCodePurpose1763800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "auth_code" ADD COLUMN "purpose" varchar(16) NOT NULL DEFAULT 'onboarding'`);
    await q.query(
      `ALTER TABLE "auth_code" ADD CONSTRAINT "auth_code_purpose_words" CHECK ("purpose" IN ('onboarding','password_reset'))`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "auth_code" DROP CONSTRAINT IF EXISTS "auth_code_purpose_words"`);
    await q.query(`ALTER TABLE "auth_code" DROP COLUMN IF EXISTS "purpose"`);
  }
}
