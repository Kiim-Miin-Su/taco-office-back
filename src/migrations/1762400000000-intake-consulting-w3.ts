/** @file-guide
 * 목적: 1762400000000-intake-consulting-w3.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 1:1 대조 wave 3 · 상담(§23·§24)·컨설팅(§31)이 **담을 칸이 없어서** 못 그리던 셋 — 전부 NULL 허용 칸 추가다.
 *
 * - `lead.grade` (23-10) — 원본 §23 카드 이름 옆 학년 칩(G8 · G5 …). 학생(`stu.grade`)과 같은 폭·같은 자유 글이다.
 *   표기 규약(G·학년)을 여기서 정하지 않는다 — 적은 그대로 둔다(27-02 는 따로).
 * - `lead.reason_kind` (24-05) — 원본 §24 실패 사유 분류 다섯(연락 두절 · 타 학원 등록 · 일정 안 맞음 · 비용 · 시기 안 맞음).
 *   자유 글 `reason` 은 설명 칸으로 그대로 남는다. **옛 실패 건은 NULL**(분류 안 됨) — 사유 글에서 분류를 추정하지 않는다(N-25).
 * - `cons_sess.result` · `cons_sess.next_until` (31-08) — 원본 §31 회차 본문의 「결과」(인용 상자)와 「다음까지」(호박 줄).
 *   슬라이드 31 연동 「'다음까지' 항목 → TODO 자동 생성 · 담당자에게 NOTI」는 서비스(`writeSession`)가 같은 트랜잭션에서 한다.
 *
 * 둘째 묶음(같은 물결 · 같은 파일) — 원본 §23 카드가 **담을 곳이 없어** 못 그리던 둘:
 * - `lead_plan` (23-16 · 24-07) — 배치안 초안 줄(과목 · 주 N회 · 강사). 「+ 등록 확정」 창이 이 줄로 채워지고 §24 「당시 배치안」도 같은 줄을 읽는다.
 *   **단가는 적지 않는다** — 단가표(RATE)가 정본이라 두 곳이면 갈린다(D-R22). 적은 날(`created_at`)의 단가표를 읽기 때 붙인다.
 * - `lead.recheck_on` (23-16) — 보류 「재확인 날짜」. 비어 있으면 보류에 들어온 날 + 2일(슬라이드 23 「D+2에 수락 여부 확인」)이고,
 *   「연장 +2일」이 그 날짜에서 이틀을 더해 적는다. 단계가 바뀌면 비운다(다음 보류에 옛 날짜가 남지 않게).
 * - `lead_appt` (23-15) — 2차 상담 · 진단고사 일정(날짜 · 시각 · 강의실/온라인). 한 건에 종류마다 한 줄.
 *   「스케줄에 N건 만들기」가 시간표 회차(SER)를 만들고 `ser_id` 로 잇는다 — **「미생성」은 그 연결이 없는 것**이다.
 *   시간표에서 회차를 지우면 연결만 풀린다(ON DELETE SET NULL · 회의 `mtrec.ser_id` 와 같은 길).
 *
 * 새 칸·새 표라 옛 행 보정이 없다. CHECK 는 NULL 을 통과시키므로 기존 행에 걸리지 않는다(NOT VALID 불필요).
 * 이 파일은 같은 물결 안에서 한 번 늘었다 — 앞 판을 이미 돌린 DB 는 `migration:revert` 뒤 다시 `migration:run` 한다(IF NOT EXISTS 라 두 번 돌아도 안전).
 */
export class IntakeConsultingW31762400000000 implements MigrationInterface {
  name = 'IntakeConsultingW31762400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "grade" varchar(10)`);
    await q.query(`ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "reason_kind" varchar(16)`);
    await q.query(`ALTER TABLE "lead" ADD CONSTRAINT "lead_reason_kind_words" CHECK (
      "reason_kind" IS NULL OR "reason_kind" IN ('unreachable','other_academy','schedule','cost','timing')
    )`);
    await q.query(`ALTER TABLE "cons_sess" ADD COLUMN IF NOT EXISTS "result" text`);
    await q.query(`ALTER TABLE "cons_sess" ADD COLUMN IF NOT EXISTS "next_until" text`);

    await q.query(`ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "recheck_on" date`);
    await q.query(`CREATE TABLE IF NOT EXISTS "lead_plan" (
      "id"         bigserial   PRIMARY KEY,
      "lead_id"    bigint      NOT NULL REFERENCES "lead"("id"),
      "seq"        smallint    NOT NULL,
      "kind_key"   varchar(16) NOT NULL REFERENCES "kind"("key"),
      "sub_key"    varchar(20) REFERENCES "sub"("key"),
      "per_week"   smallint    NOT NULL,
      "teacher_id" bigint      REFERENCES "staff"("id"),
      "created_by" bigint      NOT NULL REFERENCES "staff"("id"),
      "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "lead_plan_seq_range" CHECK ("seq" BETWEEN 1 AND 8),
      CONSTRAINT "lead_plan_per_week_range" CHECK ("per_week" BETWEEN 1 AND 7),
      CONSTRAINT "lead_plan_lead_seq" UNIQUE ("lead_id", "seq")
    )`);
    await q.query(`CREATE TABLE IF NOT EXISTS "lead_appt" (
      "id"         bigserial   PRIMARY KEY,
      "lead_id"    bigint      NOT NULL REFERENCES "lead"("id"),
      "kind"       varchar(8)  NOT NULL,
      "on_date"    date        NOT NULL,
      "start_min"  smallint    NOT NULL,
      "end_min"    smallint    NOT NULL,
      "mode"       varchar(8)  NOT NULL DEFAULT 'offline',
      "room_id"    bigint      REFERENCES "room"("id"),
      "ser_id"     bigint      REFERENCES "ser"("id") ON DELETE SET NULL,
      "created_by" bigint      NOT NULL REFERENCES "staff"("id"),
      "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "lead_appt_kind_words" CHECK ("kind" IN ('diag','second')),
      CONSTRAINT "lead_appt_mode_words" CHECK ("mode" IN ('offline','online')),
      CONSTRAINT "lead_appt_time_range" CHECK ("start_min" >= 0 AND "end_min" <= 1440 AND "end_min" > "start_min"),
      CONSTRAINT "lead_appt_online_no_room" CHECK ("mode" = 'offline' OR "room_id" IS NULL),
      CONSTRAINT "lead_appt_lead_kind" UNIQUE ("lead_id", "kind")
    )`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "lead_appt"`);
    await q.query(`DROP TABLE IF EXISTS "lead_plan"`);
    await q.query(`ALTER TABLE "lead" DROP COLUMN IF EXISTS "recheck_on"`);
    await q.query(`ALTER TABLE "cons_sess" DROP COLUMN IF EXISTS "next_until"`);
    await q.query(`ALTER TABLE "cons_sess" DROP COLUMN IF EXISTS "result"`);
    await q.query(`ALTER TABLE "lead" DROP CONSTRAINT IF EXISTS "lead_reason_kind_words"`);
    await q.query(`ALTER TABLE "lead" DROP COLUMN IF EXISTS "reason_kind"`);
    await q.query(`ALTER TABLE "lead" DROP COLUMN IF EXISTS "grade"`);
  }
}
