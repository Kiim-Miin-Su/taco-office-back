/** @file-guide
 * 목적: 1763700000000-staff-email-lower-unique.ts — StaffEmailLowerUnique1763700000000 (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 로그인 아이디(이메일)는 대소문자를 가리지 않는다 — erd.dbml v4.51 (TBO-52 W8 · 대표 결정 2026-09-26 「아이디 = 이메일」).
 *
 * 로그인은 `lower(email) = 정규화한 입력` 으로 찾는다(AuthService.login). 대소문자만 다른 두 계정이 있으면
 * 어느 쪽인지 말할 수 없어 둘 다 들어가지 못한다 — 판정은 서비스가 닫지만(둘 이상이면 같은 실패 문구),
 * 그런 행이 **생기지 않게** 막는 것은 DB 한 곳이어야 한다. 계정 만들기 · 고치기 · 첫 설정 · 운영 전환이 모두 여기에 걸린다.
 *
 * **기존 행 보정 0 (N-25)** — 대소문자만 다른 이메일이 이미 있으면 이 마이그레이션은 **실패하고 멈춘다**(23505).
 * 어느 계정을 남길지는 사람이 정한다. 기존 `staff_email_key`(대소문자 구분 유일)는 그대로 둔다.
 * `down` 은 이 색인만 지운다.
 */
export class StaffEmailLowerUnique1763700000000 implements MigrationInterface {
  name = 'StaffEmailLowerUnique1763700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE UNIQUE INDEX "staff_email_lower_key" ON "staff" (lower("email"))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "staff_email_lower_key"`);
  }
}
