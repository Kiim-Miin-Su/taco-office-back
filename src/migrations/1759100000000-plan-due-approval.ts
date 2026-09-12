/** @file-guide
 * 목적: 1759100000000-plan-due-approval.ts — PlanDueApproval1759100000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §65 기획 보고서 — **기한을 먼저 승인해야 최종 승인이 열린다** (C56).
 *
 * 원문이 두 곳에서 같은 말을 한다. 슬라이드 61: 「대표는 기한을 먼저 승인해야 최종 승인이
 * 열립니다」. 슬라이드 65: 같은 문장. 컷의 바닥 단추도 「**기한부터 승인하세요**」다.
 *
 * 그런데 `PLAN` 에는 `due_on` 한 칸뿐이라 **제안한 기한과 승인된 기한이 구분되지 않는다.**
 * 그 상태로 「기한 승인」을 만들면 누른 흔적이 아무 데도 안 남고, 다음 사람은 이 기한이
 * 대표를 지나온 것인지 알 수 없다.
 *
 * 그래서 **승인한 순간의 사실**을 적는다 — 누가, 언제. `due_approved_at` 이 비어 있으면
 * `due_on` 은 **아직 제안**이고(원문 컷의 「기한 제안 · 대표 확인을 기다립니다」 띠), 차 있으면
 * 승인된 기한이다. 상태를 따로 저장하지 않는다 — 두 칸에서 파생한다 (D-R39).
 *
 * 기존 행은 **건드리지 않는다.** 지금 있는 `due_on` 이 대표를 지나온 것인지 알 방법이 없다.
 * 전부 「아직 제안」으로 읽히는 쪽이 안전하다 — 승인 도장을 없는 자리에 찍지 않는다.
 */
export class PlanDueApproval1759100000000 implements MigrationInterface {
  name = 'PlanDueApproval1759100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE plan ADD COLUMN IF NOT EXISTS due_approved_at timestamptz`);
    await q.query(
      `COMMENT ON COLUMN plan.due_approved_at IS '대표가 기한을 승인한 순간 — 비어 있으면 due_on 은 아직 제안이다 (원문 §61·§65)'`,
    );
    await q.query(`ALTER TABLE plan ADD COLUMN IF NOT EXISTS due_approved_by bigint`);
    await q.query(
      `COMMENT ON COLUMN plan.due_approved_by IS '기한을 승인한 사람 — 누가 눌렀는지가 사실이다'`,
    );
    // 둘은 함께 있거나 함께 없다. 한쪽만 남으면 「승인은 됐는데 누가 했는지 모른다」가 된다.
    await q.query(
      `ALTER TABLE plan ADD CONSTRAINT plan_due_approval_pair
         CHECK ((due_approved_at IS NULL) = (due_approved_by IS NULL)) NOT VALID`,
    );
    // 승인할 기한이 없는데 승인 도장만 있을 수는 없다
    await q.query(
      `ALTER TABLE plan ADD CONSTRAINT plan_due_approval_needs_due
         CHECK (due_approved_at IS NULL OR due_on IS NOT NULL) NOT VALID`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE plan DROP CONSTRAINT IF EXISTS plan_due_approval_needs_due`);
    await q.query(`ALTER TABLE plan DROP CONSTRAINT IF EXISTS plan_due_approval_pair`);
    await q.query(`ALTER TABLE plan DROP COLUMN IF EXISTS due_approved_by`);
    await q.query(`ALTER TABLE plan DROP COLUMN IF EXISTS due_approved_at`);
  }
}
