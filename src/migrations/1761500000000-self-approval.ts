/** @file-guide
 * 목적: 1761500000000-self-approval.ts — 올린 사람은 결재하지 못한다 (REP · RPT · PLAN 기한 · GPA 승인 도장) (migration)
 * 책임/재사용: 스키마 변경만 소유한다. 기존 행을 추정으로 보정하지 않고, 되돌릴 수 있는 down 을 함께 둔다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * **올린 사람은 결재하지 못한다** — 지출에만 있던 규칙을 나머지 결재 갈래로 넓힌다.
 *
 * 선례: `expense_no_self_review  CHECK (reviewer_id <> requester_id)` (migration 1758500000000 · A-5).
 * 2026-09-20 전수 검수에서 **리포트·대표 보고·기획·GPA 넷에는 그 줄이 하나도 없다**는 것이 드러났다.
 * 서비스 쪽 거절은 같은 청크에서 넣었고, 여기서는 **DB 가 마지막으로 한 번 더** 막는다 —
 * 서비스를 우회하는 직접 SQL·다음에 생길 경로가 같은 실수를 반복하지 못하게.
 *
 * **세 칸 모두 `a IS NULL OR b IS NULL OR a <> b`** 다. 모르는 것은 막지 않는다 —
 * `rpt.sent_by` 는 C85-a 에서 생겼고 그 전 행은 NULL 이며(N-25 기존 행 보정 0),
 * 강사 없는 회차의 `rep.teacher_id` 도 NULL 일 수 있다.
 *
 * **`NOT VALID`** 로 새 행만 검사한다. 다만 `NOT VALID` 는 **기존 행만** 봐주고 새 INSERT/UPDATE 는
 * 그대로 검사하며 **시드는 언제나 새 INSERT** 다 (C86-g 가 출하를 멈춘 자리) — 그래서 아래 preflight 가
 * 지금 위반하는 행이 있는지 먼저 세어, 있으면 **고르지 않고 멈춘다.**
 *
 * GPA 는 **승인 도장 칸 자체가 없었다** — 누가 승인했는지 어디에도 안 남았다. 두 칸을 새로 판다.
 */
export class SelfApproval1761500000000 implements MigrationInterface {
  name = 'SelfApproval1761500000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── preflight — 지금 자기 결재인 행이 있으면 사람이 정해야 한다 (추정 보정 금지 · N-25)
    for (const [table, author, reviewer] of [
      ['rep', 'teacher_id', 'reviewer_id'],
      ['rpt', 'sent_by', 'reviewed_by'],
      ['plan', 'owner_id', 'due_approved_by'],
    ] as const) {
      const [{ n }] = (await q.query(
        `SELECT count(*)::text AS n FROM ${table}
          WHERE ${author} IS NOT NULL AND ${reviewer} IS NOT NULL AND ${author} = ${reviewer}`,
      )) as [{ n: string }];
      if (Number(n) > 0) {
        throw new Error(
          `${table}: 올린 사람과 결재한 사람이 같은 행이 ${n}건 있습니다. ` +
          '어느 쪽을 고칠지는 사람이 정합니다 — 이 마이그레이션은 값을 바꾸지 않습니다.',
        );
      }
    }

    // ── REP 리포트 승인 — 쓴 사람(teacher_id)과 결재한 사람(reviewer_id)
    await q.query(`ALTER TABLE rep ADD CONSTRAINT rep_no_self_review
      CHECK (teacher_id IS NULL OR reviewer_id IS NULL OR teacher_id <> reviewer_id) NOT VALID`);

    // ── RPT 대표 보고 결재 — 올린 사람(sent_by)과 결재한 사람(reviewed_by)
    await q.query(`ALTER TABLE rpt ADD CONSTRAINT rpt_no_self_review
      CHECK (sent_by IS NULL OR reviewed_by IS NULL OR sent_by <> reviewed_by) NOT VALID`);

    // ── PLAN 기한 승인 — 담당(owner_id)과 기한을 승인한 사람(due_approved_by)
    //    최종 승인에는 아직 도장 칸이 없다(서비스만 막는다) — 칸을 만드는 것은 S6 기획 청크다
    await q.query(`ALTER TABLE plan ADD CONSTRAINT plan_due_no_self_approve
      CHECK (owner_id IS NULL OR due_approved_by IS NULL OR owner_id <> due_approved_by) NOT VALID`);

    // ── GPA 승인 도장 — 칸 자체가 없었다
    await q.query(`ALTER TABLE gpa_use ADD COLUMN approved_by bigint REFERENCES staff(id) ON DELETE RESTRICT`);
    await q.query(`ALTER TABLE gpa_use ADD COLUMN approved_at timestamptz`);
    // 시각과 사람은 짝이다 (rpt_sign_pair 와 같은 규약)
    await q.query(`ALTER TABLE gpa_use ADD CONSTRAINT gpa_use_approve_pair
      CHECK ((approved_at IS NULL) = (approved_by IS NULL)) NOT VALID`);
    await q.query(`ALTER TABLE gpa_use ADD CONSTRAINT gpa_use_no_self_approve
      CHECK (coord_id IS NULL OR approved_by IS NULL OR coord_id <> approved_by) NOT VALID`);
    await q.query(`CREATE INDEX gpa_use_approved_by_idx ON gpa_use (approved_by)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS gpa_use_approved_by_idx`);
    await q.query(`ALTER TABLE gpa_use DROP CONSTRAINT IF EXISTS gpa_use_no_self_approve`);
    await q.query(`ALTER TABLE gpa_use DROP CONSTRAINT IF EXISTS gpa_use_approve_pair`);
    await q.query(`ALTER TABLE gpa_use DROP COLUMN IF EXISTS approved_at`);
    await q.query(`ALTER TABLE gpa_use DROP COLUMN IF EXISTS approved_by`);
    await q.query(`ALTER TABLE plan DROP CONSTRAINT IF EXISTS plan_due_no_self_approve`);
    await q.query(`ALTER TABLE rpt DROP CONSTRAINT IF EXISTS rpt_no_self_review`);
    await q.query(`ALTER TABLE rep DROP CONSTRAINT IF EXISTS rep_no_self_review`);
  }
}
