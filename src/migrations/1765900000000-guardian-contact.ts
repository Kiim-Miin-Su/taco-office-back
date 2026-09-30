/** @file-guide
 * 목적: ST1-b3a 기존 보호자 수신처를 단방향 guardian_contact 행으로 보존하는 additive migration.
 * 책임/재사용: 구형 guardian 칼럼·CHECK·default를 그대로 두고, 이미 저장된 주소와 동의를 추정 없이 복사한다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/contracts/db/student-registration-target.dbml
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class GuardianContact1765900000000 implements MigrationInterface {
  name = 'GuardianContact1765900000000';

  public async up(q: QueryRunner): Promise<void> {
    // 연락처가 보호자만 가리킨다. 역방향 FK를 두지 않아 GoLive의 FK 삭제 순서에 순환이 없다.
    await q.query(`CREATE TABLE guardian_contact (
      id bigserial PRIMARY KEY,
      guardian_id bigint NOT NULL REFERENCES guardian(id),
      kind varchar(5) NOT NULL,
      value varchar(254) NOT NULL,
      label varchar(80),
      active boolean NOT NULL DEFAULT true,
      is_delivery_selected boolean NOT NULL DEFAULT false,
      origin varchar(11) NOT NULL DEFAULT 'user',
      created_by bigint REFERENCES staff(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT guardian_contact_kind CHECK (kind IN ('phone','kakao','email','other')),
      CONSTRAINT guardian_contact_value CHECK (value = btrim(value) AND length(value) > 0),
      CONSTRAINT guardian_contact_label CHECK (
        (kind = 'other' AND label IS NOT NULL AND length(btrim(label)) > 0)
        OR (kind <> 'other' AND label IS NULL)
      ),
      CONSTRAINT guardian_contact_origin CHECK (
        (origin = 'user' AND created_by IS NOT NULL)
        OR (origin = 'legacy_copy' AND created_by IS NULL)
      ),
      CONSTRAINT guardian_contact_selected CHECK (
        NOT is_delivery_selected OR (active AND kind IN ('email','phone'))
      ),
      CONSTRAINT guardian_contact_email_shape CHECK (
        kind <> 'email' OR value ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]{2,}$'
      ),
      CONSTRAINT guardian_contact_phone_shape CHECK (
        kind <> 'phone' OR value ~ '^0[0-9]{9,10}$' OR value ~ '^\\+[1-9][0-9]{7,14}$'
      )
    )`);
    await q.query(`CREATE INDEX guardian_contact_owner_active ON guardian_contact(guardian_id, active)`);
    await q.query(`CREATE UNIQUE INDEX guardian_contact_one_selected_kind
      ON guardian_contact(guardian_id, kind) WHERE is_delivery_selected`);

    // 받기 동의가 꺼진 주소도 기존에 고른 주소다. 원문은 가공하지 않고 복사하며 작성자는 추정하지 않는다.
    await q.query(`INSERT INTO guardian_contact(guardian_id,kind,value,is_delivery_selected,origin)
      SELECT id,'email',email,true,'legacy_copy' FROM guardian WHERE email IS NOT NULL
      UNION ALL
      SELECT id,'phone',phone,true,'legacy_copy' FROM guardian WHERE phone IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // 새 입력뿐 아니라 선택 해제된 옛 주소도 이력이다. scalar로 완전히 되돌릴 수 있을 때만 내린다.
    const [row] = await q.query(`SELECT count(*)::int AS n FROM guardian_contact c JOIN guardian g ON g.id = c.guardian_id
      WHERE c.origin <> 'legacy_copy' OR NOT c.active OR NOT c.is_delivery_selected
        OR (c.kind = 'email' AND c.value IS DISTINCT FROM g.email)
        OR (c.kind = 'phone' AND c.value IS DISTINCT FROM g.phone)
        OR c.kind NOT IN ('email','phone')`) as Array<{ n: number }>;
    if (row.n > 0) throw new Error('guardian_contact has unrepresented rows; down migration would lose data');
    // 구버전 writer가 migration 뒤 만든 보호자는 child가 없을 수 있다. 모든 현재 scalar에도 정확한 복사 행이 필요하다.
    const [missing] = await q.query(`SELECT count(*)::int AS n FROM guardian g
      WHERE (g.email IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM guardian_contact c WHERE c.guardian_id = g.id AND c.kind = 'email'
          AND c.value = g.email AND c.active AND c.is_delivery_selected AND c.origin = 'legacy_copy'))
        OR (g.phone IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM guardian_contact c WHERE c.guardian_id = g.id AND c.kind = 'phone'
          AND c.value = g.phone AND c.active AND c.is_delivery_selected AND c.origin = 'legacy_copy'))`) as Array<{ n: number }>;
    if (missing.n > 0) throw new Error('guardian_contact is missing legacy scalar rows; down migration would lose data');
    await q.query(`DROP TABLE guardian_contact`);
  }
}
