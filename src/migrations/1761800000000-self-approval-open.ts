/** @file-guide
 * 목적: 1761800000000-self-approval-open.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 자기 결재 금지 CHECK **넷을 내린다** — 대표 결정 2026-09-21 「우선은 매니저에게도 모든 권한」.
 *
 * S1(마이그레이션 51)이 새긴 넷이다. **코드만 풀고 CHECK 를 남기면 안 된다** — 화면은 단추를
 * 세우고 서버도 통과시키는데 **DB 가 마지막에 거절한다**. 그것이 S5 가 아홉 자리에서 고친 바로
 * 그 모양이라, 판정과 제약은 언제나 같이 움직인다.
 *
 * **내리는 넷** (S1 이 만든 것):
 *   `rep_no_self_review` · `rpt_no_self_review` · `plan_due_no_self_approve` · `gpa_use_no_self_approve`
 *
 * **남기는 둘** (S1 이 만든 것이 아니다 — 이번 결정의 범위 밖):
 *   `expense_no_self_review`(A-5 · 마이그레이션 1758500000000) ·
 *   `expense_no_self_file_review`(S2 · 마이그레이션 1761600000000).
 *   지출은 처음부터 있던 규칙이고 `lib/approval.SELF_APPROVAL_GUARDED` 도 `expense` 를 남겨 둬
 *   **코드와 표가 여전히 같은 말**을 한다.
 *
 * `gpa_use_approve_pair`(승인 시각과 사람은 짝이다)는 **자기 결재와 무관**하므로 남긴다 —
 * 도장이 반쪽만 찍히는 것을 막는 제약이고 그것은 권한 결정이 아니다.
 *
 * **데이터는 한 줄도 안 건드린다.** 제약을 내리는 것은 앞으로 들어올 행을 허용하는 일이지
 * 지난 행을 바꾸는 일이 아니다 (N-25).
 */
export class SelfApprovalOpen1761800000000 implements MigrationInterface {
  name = 'SelfApprovalOpen1761800000000';

  /** [표, 제약] — `down()` 이 같은 목록으로 되새긴다 */
  private static readonly DROPPED: Array<[string, string, string]> = [
    ['rep', 'rep_no_self_review', 'teacher_id IS NULL OR reviewer_id IS NULL OR teacher_id <> reviewer_id'],
    ['rpt', 'rpt_no_self_review', 'sent_by IS NULL OR reviewed_by IS NULL OR sent_by <> reviewed_by'],
    ['plan', 'plan_due_no_self_approve', 'owner_id IS NULL OR due_approved_by IS NULL OR owner_id <> due_approved_by'],
    ['gpa_use', 'gpa_use_no_self_approve', 'coord_id IS NULL OR approved_by IS NULL OR coord_id <> approved_by'],
  ];

  public async up(q: QueryRunner): Promise<void> {
    for (const [table, name] of SelfApprovalOpen1761800000000.DROPPED) {
      await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`);
    }
  }

  /**
   * 되돌릴 수 있다 — 권한을 다시 좁히는 것은 **정책이 되돌아오는 일**이라 길을 남긴다
   * (낱말을 바꾸는 마이그레이션과 다르다 · 1756700000000 은 되돌리지 않는다).
   *
   * 다만 그 사이에 **자기가 결재한 행이 생겼을 수 있다.** `NOT VALID` 로 새기면 옛 행은
   * 면제되므로 되돌리기 자체는 통과하지만, 그 행들은 남는다 — 몇 건인지 세어서 알린다.
   * 지우거나 고치지 않는다(N-25): 무엇이 맞는지는 사람이 정한다.
   */
  public async down(q: QueryRunner): Promise<void> {
    for (const [table, name, check] of SelfApprovalOpen1761800000000.DROPPED) {
      const [row] = (await q.query(
        `SELECT count(*)::int AS n FROM "${table}" WHERE NOT (${check})`,
      )) as Array<{ n: number }>;
      if (row.n > 0) {
        console.warn(`[self-approval] ${table}: 자기 결재 행 ${row.n}건이 이미 있습니다 — NOT VALID 라 그대로 남습니다.`);
      }
      await q.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${check}) NOT VALID`);
    }
  }
}
