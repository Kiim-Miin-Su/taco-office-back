/** @file-guide
 * 목적: 1769700000000-auth-self-onboarding.ts — AuthSelfOnboarding1769700000000 (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AUTH-SELF-01 마이페이지 · AUTH-INIT-02 필수 초기설정 — erd.dbml STAFF/AUTH_CODE (사용자 결정 2026-10-16).
 *
 * - `staff.english_name varchar(40) NULL` — 본인이 마이페이지에서 적는 영어 이름. 비우면 NULL(빈 글자는 CHECK 가 막는다).
 *   길이는 이름(`name` varchar(40))과 같은 규칙이고 임의 영문 정규식은 두지 않는다. 기존 행은 NULL 로 선다(추정 이관 없음).
 * - `auth_code_purpose_words` 에 `contact_change` 추가 — 본인 연락처 변경 코드가 첫 설정 · 비밀번호 찾기 코드와 섞이지 않게
 *   같은 원장(해시 · 만료 · 한도)을 쓰되 용도를 가른다.
 *
 * **기존 행 보정 0 · 위반은 세어서 멈춘다.**
 *  ① AUTH-INIT-02 판정(AuthService.credentialSetupRequired = 잠금 · 두 인증)은 「두 인증 + 잠금 해제」를 완료 증거로 쓴다.
 *     이 migration 이전의 초기 발급 코드는 CEO 를 개명할 때 공통 초기 비밀번호로 덮으면서 잠금을 끄고(must=false) 인증 칸은
 *     그대로 뒀다. 그 개명 뒤에 첫 설정 기록이 없는데 「완료처럼 보이는」 계정은 판정이 비밀번호 교체를 증명하지 못하므로
 *     **세어서 멈춘다** — 어느 쪽으로 볼지는 운영 전환 절차에서 사람이 정한다(잠금을 켜는 것이 안전한 쪽이다).
 *  ② purpose 에 목록 밖 값이 있으면 세어서 멈춘다(기존 CHECK 가 막아 왔으므로 0 이어야 한다).
 *
 * `down` 은 데이터를 지우지 않는다 — 영어 이름이 하나라도 적혀 있거나 `contact_change` 코드 줄이 남아 있으면 세어서 멈춘다.
 */
export class AuthSelfOnboarding1769700000000 implements MigrationInterface {
  name = 'AuthSelfOnboarding1769700000000';

  public async up(q: QueryRunner): Promise<void> {
    const [unprovable] = await q.query(
      `SELECT count(*)::int AS n FROM staff s
        WHERE NOT s.must_change_credentials AND s.email_verified AND s.phone_verified
          AND EXISTS (
            SELECT 1 FROM log p
             WHERE p.entity = 'STAFF' AND p.action = 'account_provision' AND p.entity_id = s.id
               AND NOT EXISTS (
                 SELECT 1 FROM log o
                  WHERE o.entity = 'STAFF' AND o.action = 'onboarding' AND o.entity_id = s.id AND o.at > p.at))`,
    ) as Array<{ n: number }>;
    if (unprovable.n > 0) {
      throw new Error(
        `AUTH-INIT-02: 초기 발급(account_provision) 뒤 첫 설정 기록이 없는데 두 인증·잠금 해제 상태인 계정 ${unprovable.n}건 — `
        + '비밀번호 교체를 증명할 수 없어 멈춥니다. 운영 전환 절차에서 대상을 확인해 첫 설정 잠금을 켠 뒤 다시 실행하세요(자동 보정하지 않습니다).',
      );
    }
    const [purposes] = await q.query(
      `SELECT count(*)::int AS n FROM auth_code WHERE purpose NOT IN ('onboarding','password_reset','contact_change')`,
    ) as Array<{ n: number }>;
    if (purposes.n > 0) {
      throw new Error(`auth_code.purpose 에 목록 밖 값 ${purposes.n}건 — 보정하지 않고 멈춥니다`);
    }

    await q.query(`ALTER TABLE "staff" ADD COLUMN "english_name" varchar(40)`);
    await q.query(
      `ALTER TABLE "staff" ADD CONSTRAINT "staff_english_name_present" CHECK ("english_name" IS NULL OR btrim("english_name") <> '')`,
    );
    await q.query(`ALTER TABLE "auth_code" DROP CONSTRAINT "auth_code_purpose_words"`);
    await q.query(
      `ALTER TABLE "auth_code" ADD CONSTRAINT "auth_code_purpose_words"
         CHECK ("purpose" IN ('onboarding','password_reset','contact_change'))`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    const [{ names, codes }] = await q.query(
      `SELECT (SELECT count(*)::int FROM staff WHERE english_name IS NOT NULL) AS names,
              (SELECT count(*)::int FROM auth_code WHERE purpose = 'contact_change') AS codes`,
    ) as Array<{ names: number; codes: number }>;
    if (names > 0 || codes > 0) {
      throw new Error(
        `되돌리면 영어 이름 ${names}건 · 연락처 변경 코드 ${codes}건을 잃습니다 — 지우지 않고 멈춥니다`,
      );
    }
    await q.query(`ALTER TABLE "auth_code" DROP CONSTRAINT "auth_code_purpose_words"`);
    await q.query(
      `ALTER TABLE "auth_code" ADD CONSTRAINT "auth_code_purpose_words" CHECK ("purpose" IN ('onboarding','password_reset'))`,
    );
    await q.query(`ALTER TABLE "staff" DROP CONSTRAINT "staff_english_name_present"`);
    await q.query(`ALTER TABLE "staff" DROP COLUMN "english_name"`);
  }
}
