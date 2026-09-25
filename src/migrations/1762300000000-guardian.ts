/** @file-guide
 * 목적: 1762300000000-guardian.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 학생의 **보호자**와 보호자별 **발송 원장** — DQ3 대표 답변 (2026-09-25 · N-42).
 *
 * 「복수 보호자 + 선택 발송, 단 현재 쓰는 이메일과 Naver SENS 만」.
 * 지금까지 PNOTI 의 학부모 줄은 만들어지기만 하고 나가지 못했다 — STU 에 수신처 칸이 없었다.
 * 수신처를 STU 칸 두 개로 붙이지 않고 표로 둔 까닭은 답변이 「여러 명」이기 때문이다.
 *
 * - `guardian` — 학생 한 명에 N명. **지우지 않는다**(`active=false`) — 원장이 가리킨다.
 *   연락처는 최소 하나(CHECK) · 받는 채널은 그 연락처가 있어야 켠다(CHECK) · 대표 보호자는 학생당 하나(부분 유니크).
 * - `guardian_send` — 보호자×채널 **시도 한 번에 한 줄**. 받는 곳은 **가린 값만** 적는다(원문을 원장에 두지 않는다).
 *   설정이 없어 시도조차 못 한 것도 `not_configured` 로 남긴다 — 조용히 성공으로 적지 않는다.
 *   `(request_key, guardian_id, channel)` 유니크가 재시도·더블클릭의 두 번째 발송을 막는다.
 *
 * 채널 낱말(email·sms)은 `notify/sender.SEND_CHANNELS` 와 같다 — 채널을 더하는 날 CHECK 도 함께 넓힌다.
 * 기존 행 0 (새 표) · 옛 데이터 보정 없음.
 */
export class Guardian1762300000000 implements MigrationInterface {
  name = 'Guardian1762300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "guardian" (
        "id"            bigserial PRIMARY KEY,
        "student_id"    bigint      NOT NULL REFERENCES "stu"("id"),
        "name"          varchar(40) NOT NULL,
        "relation"      varchar(20),
        "email"         varchar(254),
        "phone"         varchar(11),
        "receive_email" boolean     NOT NULL DEFAULT true,
        "receive_sms"   boolean     NOT NULL DEFAULT false,
        "is_primary"    boolean     NOT NULL DEFAULT false,
        "active"        boolean     NOT NULL DEFAULT true,
        "created_by"    bigint      NOT NULL REFERENCES "staff"("id"),
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "guardian_name_present" CHECK (length(btrim("name")) > 0),
        CONSTRAINT "guardian_contact_present" CHECK ("email" IS NOT NULL OR "phone" IS NOT NULL),
        CONSTRAINT "guardian_email_shape" CHECK ("email" IS NULL OR "email" ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]{2,}$'),
        CONSTRAINT "guardian_phone_digits" CHECK ("phone" IS NULL OR "phone" ~ '^0[0-9]{9,10}$'),
        CONSTRAINT "guardian_email_channel" CHECK (NOT "receive_email" OR "email" IS NOT NULL),
        CONSTRAINT "guardian_sms_channel" CHECK (NOT "receive_sms" OR "phone" IS NOT NULL),
        CONSTRAINT "guardian_primary_active" CHECK ("active" OR NOT "is_primary")
      )
    `);
    await q.query(`CREATE INDEX "guardian_student_idx" ON "guardian" ("student_id")`);
    await q.query(`CREATE UNIQUE INDEX "guardian_one_primary" ON "guardian" ("student_id") WHERE "is_primary"`);

    await q.query(`
      CREATE TABLE "guardian_send" (
        "id"          bigserial PRIMARY KEY,
        "request_key" uuid        NOT NULL,
        "pnoti_id"    bigint      REFERENCES "pnoti"("id"),
        "student_id"  bigint      NOT NULL REFERENCES "stu"("id"),
        "guardian_id" bigint      NOT NULL REFERENCES "guardian"("id"),
        "channel"     varchar(10) NOT NULL,
        "to_masked"   varchar(80) NOT NULL,
        "status"      varchar(16) NOT NULL,
        "provider_id" varchar(200),
        "error"       text,
        "sent_by"     bigint      NOT NULL REFERENCES "staff"("id"),
        "sent_at"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "guardian_send_channel" CHECK ("channel" IN ('email','sms')),
        CONSTRAINT "guardian_send_status" CHECK ("status" IN ('sent','failed','not_configured')),
        CONSTRAINT "guardian_send_once" UNIQUE ("request_key", "guardian_id", "channel")
      )
    `);
    await q.query(`CREATE INDEX "guardian_send_student_idx" ON "guardian_send" ("student_id", "sent_at")`);
    await q.query(`CREATE INDEX "guardian_send_pnoti_idx" ON "guardian_send" ("pnoti_id") WHERE "pnoti_id" IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // 원장이 보호자를 가리키므로 원장부터 내린다. 두 표 모두 이 마이그레이션이 만든 것이라 다른 표는 건드리지 않는다.
    await q.query(`DROP TABLE IF EXISTS "guardian_send"`);
    await q.query(`DROP TABLE IF EXISTS "guardian"`);
  }
}
