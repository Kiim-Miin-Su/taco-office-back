/** @file-guide
 * 목적: 1762200000000-lead-diag.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 상담 단계 진단 점수 원장 `LEAD_DIAG` — DQ1 대표 답변(2026-09-25) 「점수만 저장 + 담당자가 선택」 · N-53 · v2 §23 「진단고사 점수 입력」.
 *
 * 왜 새 표인가 — `DIAG` 는 강사가 쓰는 서술형 진단 리포트이고 `student_id NOT NULL` 이라 등록 전 상담 건에는 붙을 자리가 없다(N-53).
 * 두 진단을 한 표에 섞으면 「레벨 요약」 서술과 수치 점수가 같은 칸의 다른 뜻이 된다.
 *
 * - 점수 셋(영어 · 수학 · 인터뷰)은 0 이상 정수만 막는다. **만점·경계는 주어지지 않아 위 끝을 두지 않는다**(`lead_diag_score_nonneg`).
 * - 레벨(`foundation|practice|master`)·교재(`book_id → lib`)는 **담당자가 고른 값**이다. 점수에서 계산하는 열·트리거는 없다.
 * - append-only — 가장 최근 줄이 지금 값이다. 등록되면 `lead.student_id` 를 따라 학생의 것으로 읽는다(값 복사 없음).
 * - 새 표라 옛 행 보정이 없다(0행에서 시작).
 */
export class LeadDiag1762200000000 implements MigrationInterface {
  name = 'LeadDiag1762200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE "lead_diag" (
      "id"         bigserial   PRIMARY KEY,
      "lead_id"    bigint      NOT NULL REFERENCES "lead"("id"),
      "english"    integer,
      "math"       integer,
      "interview"  integer,
      "taken_on"   date,
      "level"      varchar(12),
      "book_id"    bigint      REFERENCES "lib"("id"),
      "note"       text,
      "created_by" bigint      NOT NULL REFERENCES "staff"("id"),
      "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "lead_diag_score_nonneg" CHECK (
        ("english" IS NULL OR "english" >= 0) AND ("math" IS NULL OR "math" >= 0) AND ("interview" IS NULL OR "interview" >= 0)
      ),
      CONSTRAINT "lead_diag_level_words" CHECK ("level" IS NULL OR "level" IN ('foundation','practice','master')),
      CONSTRAINT "lead_diag_not_empty" CHECK (
        "english" IS NOT NULL OR "math" IS NOT NULL OR "interview" IS NOT NULL OR "level" IS NOT NULL OR "book_id" IS NOT NULL
      )
    )`);
    await q.query(`CREATE INDEX "lead_diag_lead" ON "lead_diag" ("lead_id", "id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "lead_diag"`);
  }
}
