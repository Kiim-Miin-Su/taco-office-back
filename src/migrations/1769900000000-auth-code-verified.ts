/** @file-guide
 * 목적: 1769900000000-auth-code-verified.ts — AuthCodeVerified1769900000000 (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 첫 설정 채널별 인증 (사용자 지시 2026-10-19 「이메일 인증하기와 휴대폰 번호 인증하기 버튼이 있어야 함」) — erd.dbml AUTH_CODE.
 *
 * - `auth_code.verified_at timestamptz NULL` — 첫 설정 코드를 「인증하기」로 맞게 적은 시각. 그 코드는 닫지 않고(consumed_at NULL)
 *   이번 차례의 확인 증거로 남았다가 「설정 마치기」가 새 비밀번호와 함께 닫는다.
 *   STAFF.email_verified · phone_verified 로 대신하지 않는 이유: 관리자 초기화로 다시 잠긴 계정은 두 칸이 이미 true 다 —
 *   칸만 보면 초기 비밀번호를 아는 사람이 이메일 · 휴대폰을 다시 증명하지 않고 새 비밀번호를 정할 수 있다.
 * - `auth_code_verified_onboarding` — 이 칸은 첫 설정 코드에만 쓴다(비밀번호 찾기 · 연락처 변경은 확인과 동시에 닫는다).
 * - `auth_code_verified_after_create` — 보낸 뒤에만 인증된다(`auth_code_expiry_after_create` 와 같은 모양).
 *
 * **기존 행 보정 0** — 새 칸은 NULL 로 선다(옛 줄은 「인증하기」를 거치지 않았다 · 추정하지 않는다).
 * `down` 은 데이터를 지우지 않는다 — 인증된 줄이 하나라도 남아 있으면 세어서 멈춘다.
 */
export class AuthCodeVerified1769900000000 implements MigrationInterface {
  name = 'AuthCodeVerified1769900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "auth_code" ADD COLUMN "verified_at" timestamptz`);
    await q.query(
      `ALTER TABLE "auth_code" ADD CONSTRAINT "auth_code_verified_onboarding"
         CHECK ("verified_at" IS NULL OR "purpose" = 'onboarding')`,
    );
    await q.query(
      `ALTER TABLE "auth_code" ADD CONSTRAINT "auth_code_verified_after_create"
         CHECK ("verified_at" IS NULL OR "verified_at" >= "created_at")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    const [{ n }] = await q.query(
      `SELECT count(*)::int AS n FROM auth_code WHERE verified_at IS NOT NULL`,
    ) as Array<{ n: number }>;
    if (n > 0) {
      throw new Error(`되돌리면 인증된 첫 설정 코드 ${n}건의 확인 기록을 잃습니다 — 지우지 않고 멈춥니다`);
    }
    await q.query(`ALTER TABLE "auth_code" DROP CONSTRAINT "auth_code_verified_after_create"`);
    await q.query(`ALTER TABLE "auth_code" DROP CONSTRAINT "auth_code_verified_onboarding"`);
    await q.query(`ALTER TABLE "auth_code" DROP COLUMN "verified_at"`);
  }
}
