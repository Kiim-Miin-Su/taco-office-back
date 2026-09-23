/** @file-guide
 * 목적: 51의 자기 결재 제약·GPA 승인 도장을 추가하고, 기존 이력을 보존해 54의 현재 정책까지 전환한다 (migration).
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
 * 위 금지는 당시 정책이다. **2026-09-21 P1 결정으로 54가 이 네 CHECK를 제거한다.**
 * 51 이전 DB의 정상 자기 결재 이력 때문에 54에 도달하지 못하면 최신 정책과 모순이다.
 * 따라서 기존 행은 집계만 알리고 보존한다. NOT VALID는 기존 행을 검사하지 않지만
 * 새 INSERT/UPDATE는 검사하므로, 운영 전환은 54까지 같은 transaction에서 마친 뒤 앱을 연다.
 *
 * GPA 는 **승인 도장 칸 자체가 없었다** — 누가 승인했는지 어디에도 안 남았다. 두 칸을 새로 판다.
 */
export class SelfApproval1761500000000 implements MigrationInterface {
  name = 'SelfApproval1761500000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── 기존 행은 보존한다. 54가 허용할 자기 결재를 삭제/타인으로 치환해 통과시키지 않는다.
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
        console.warn(
          `[self-approval upgrade] ${table}: 기존 자기 결재 ${n}건을 그대로 보존합니다. ` +
          'NOT VALID 제약을 거쳐 54의 현행 정책까지 같은 트랜잭션에서 적용하세요.',
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
