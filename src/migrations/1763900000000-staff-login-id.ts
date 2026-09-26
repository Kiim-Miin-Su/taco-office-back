/** @file-guide
 * 목적: 1763900000000-staff-login-id.ts — StaffLoginId1763900000000 (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 로그인 아이디를 이메일에서 떼어 낸다 — erd.dbml v4.53 (TBO-52 W10 · 대표 지시 2026-09-26).
 *
 * 지시: 「매니저가 강사의 아이디를 만들어줄 때든 모든 때의 아이디 형식은 자유 · 폰, 메일 인증만 받으면 됨 ·
 * 매니저가 아이디 비번 만들면 db 에 저장 → 초기 설정 시 주요 인증 및 비번 재설정」. 답변: 이메일은 만들 때 **선택** ·
 * 아이디는 **띄어쓰기만 금지**(대소문자는 같은 아이디).
 *
 * - `staff.login_id` — 로그인 아이디. 형식 자유 · 1~120자 · 띄어쓰기 없음 · `lower(login_id)` 유일(대소문자 무시).
 *   **기존 행은 지금 이메일을 그대로 아이디로 옮긴다** — 추정이 아니라 W8 결정(「이메일 = 아이디」)이 이미 정한 값이다.
 *   그래서 지금 있는 계정은 전과 같은 글로 로그인한다. `lower(email)` 이 이미 유일하므로 옮긴 값도 유일하다.
 * - `staff.email` — 이제 연락 · 인증용이다. **비워 둘 수 있다**(매니저가 몰라도 만들 수 있고 첫 설정 때 본인이 적고 코드로 확인한다).
 *   두 유일 제약(`staff_email_key` · `staff_email_lower_key`)은 그대로 — NULL 은 여럿이어도 된다.
 * - 트리거 `staff_login_id_default` — INSERT 에서 아이디를 안 주면 이메일을 아이디로 쓴다. **배포 순서 호환**이다:
 *   마이그레이션은 back 배포 **전에** 돌고(push 는 DB 를 바꾸지 않는다), 그동안 떠 있는 옛 서버는 `login_id` 없이
 *   계정을 만든다 — 트리거가 없으면 옛 「+ 구성원」이 NOT NULL 로 죽는다(`exc_override_flags_compat` 와 같은 자리).
 *   새 서버는 늘 아이디를 적어 넣으므로 이 트리거를 타지 않는다. 아이디도 이메일도 없으면 NOT NULL 이 막는다.
 * - CHECK `staff_login_id_shape` — 비어 있지 않고 공백 글자가 없다(`NOT VALID` · 기존 행은 검사하지 않는다 — 보정 0 · N-25).
 *   보이지 않는 글자(폭 없는 공백 등)까지 막는 판정은 서버 한 곳(`lib/account-policy.loginIdIssue`)이고, 이 CHECK 는 마지막 방어다.
 *
 * `down` 은 이메일이 빈 계정이 있으면 **멈춘다**(지어낸 주소를 채우지 않는다) — 사람이 먼저 채우거나 지워야 한다.
 */
export class StaffLoginId1763900000000 implements MigrationInterface {
  name = 'StaffLoginId1763900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "staff" ADD COLUMN "login_id" varchar(120)`);
    await q.query(`UPDATE "staff" SET "login_id" = "email"`);
    await q.query(`ALTER TABLE "staff" ALTER COLUMN "login_id" SET NOT NULL`);
    await q.query(`CREATE UNIQUE INDEX "staff_login_id_lower_key" ON "staff" (lower("login_id"))`);
    await q.query(`
      ALTER TABLE "staff" ADD CONSTRAINT "staff_login_id_shape"
        CHECK (char_length("login_id") BETWEEN 1 AND 120 AND "login_id" !~ '[[:space:]]') NOT VALID
    `);
    await q.query(`ALTER TABLE "staff" ALTER COLUMN "email" DROP NOT NULL`);
    await q.query(`
      CREATE FUNCTION staff_login_id_default() RETURNS trigger AS $$
      BEGIN
        IF NEW.login_id IS NULL THEN NEW.login_id := NEW.email; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await q.query(`
      CREATE TRIGGER staff_login_id_default_trigger
      BEFORE INSERT ON "staff"
      FOR EACH ROW EXECUTE FUNCTION staff_login_id_default()
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    const [row] = await q.query(`SELECT count(*)::int AS n FROM "staff" WHERE "email" IS NULL`);
    if (Number(row?.n ?? 0) > 0) {
      throw new Error(`이메일이 빈 계정이 ${row.n}개 있어 되돌릴 수 없습니다 — 이메일을 채우거나 계정을 정리한 뒤 다시 도세요(주소를 지어내지 않는다)`);
    }
    await q.query(`DROP TRIGGER IF EXISTS staff_login_id_default_trigger ON "staff"`);
    await q.query(`DROP FUNCTION IF EXISTS staff_login_id_default()`);
    await q.query(`ALTER TABLE "staff" ALTER COLUMN "email" SET NOT NULL`);
    await q.query(`ALTER TABLE "staff" DROP CONSTRAINT IF EXISTS "staff_login_id_shape"`);
    await q.query(`DROP INDEX IF EXISTS "staff_login_id_lower_key"`);
    await q.query(`ALTER TABLE "staff" DROP COLUMN IF EXISTS "login_id"`);
  }
}
