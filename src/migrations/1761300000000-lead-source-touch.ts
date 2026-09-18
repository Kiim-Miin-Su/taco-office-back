/** @file-guide
 * 목적: 1761300000000-lead-source-touch.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 상담 유입 경로 · 접촉 원장 — C90 (N-44 결정문 그대로 · 테스트 시나리오 A-01 「카카오채널 신규 문의」 · A-03 「상담 예약일에 오지 않음」).
 *
 * `LEAD.source` — 컷 §23 유입 칩 줄의 여섯 갈래(카카오채널 · 전화 · 블로그 · 인스타그램 · 소개 · 워크인). **기존 행은 NULL — 보정 0**(N-25).
 * 옛 상담이 어디서 왔는지는 아무도 모른다. 화면은 「경로 없음」 칩으로 그 사실을 말한다.
 *
 * `LEAD_TOUCH` — 사후 관리 접촉 원장(누가 · 언제 · 어떻게 · 한 줄) append-only. 단계 전이 로그(`LEAD_STAGE_LOG`)에 섞지 않는다 —
 * 두 뜻이 한 표에서 갈린다(N-44). `next_on` 은 「다음은 언제」 — 결정문이 살린다고 한 「사후 관리 임박」 타일과
 * 경고 둘(상담 오늘·지남 · 사후 관리 밀림)은 날짜 없이는 셀 수 없다. 상담 예약(`kind='book'`)의 `next_on` 이 상담 날짜다.
 * 낱말은 `lib/intake-words` 한 곳이고 두 CHECK 가 마지막에 막는다.
 */
export class LeadSourceTouch1761300000000 implements MigrationInterface {
  name = 'LeadSourceTouch1761300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "lead" ADD COLUMN "source" varchar(16)`);
    await q.query(`
      ALTER TABLE "lead"
        ADD CONSTRAINT "lead_source_words"
        CHECK ("source" IS NULL OR "source" IN ('kakao','phone','blog','instagram','referral','walkin'))
    `);
    await q.query(`CREATE TABLE "lead_touch" (
      "id"      bigserial   PRIMARY KEY,
      "lead_id" bigint      NOT NULL REFERENCES "lead"("id"),
      "kind"    varchar(16) NOT NULL,
      "note"    text        NOT NULL,
      "next_on" date,
      "by_id"   bigint      REFERENCES "staff"("id"),
      "at"      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "lead_touch_kind_words" CHECK ("kind" IN ('call','kakao','sms','visit','book','noshow','memo')),
      CONSTRAINT "lead_touch_note_present" CHECK (length(btrim("note")) > 0)
    )`);
    await q.query(`CREATE INDEX "lead_touch_lead" ON "lead_touch" ("lead_id", "id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "lead_touch"`);
    await q.query(`ALTER TABLE "lead" DROP CONSTRAINT IF EXISTS "lead_source_words"`);
    await q.query(`ALTER TABLE "lead" DROP COLUMN IF EXISTS "source"`);
  }
}
