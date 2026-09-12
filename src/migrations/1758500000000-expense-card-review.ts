import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 법인카드 승인과 지출 분류를 **DB가 마지막에 막도록** 한다 (A-D3 · A-D5 채택 · C36-b).
 *
 * 지금까지 `EXPENSE` 에는 제약이 하나도 없었다. 규칙은 `erd.dbml` 주석과 `ACCOUNTING.md` 에만
 * 적혀 있었고, 실제 표는 **무엇이든 받았다** — 승인 금액이 신청 금액보다 커도, 본인이 본인 신청을
 * 승인해도, 분류가 오타여도 조용히 들어간다. 애플리케이션 검사만으로 끝내지 않는다 (D-R43 · 원칙 26).
 *
 * 넷을 건다.
 *   ① 분류 코드표  — 간이 5분류(A-D5) + 임대료. 5분류는 「**카드 사용** 분류」이고
 *                    임대료는 §56 의 부대비용 고정비라 카드 분류에 넣을 자리가 없다.
 *   ② 상태 낱말    — pending | approved | rejected. `1756800000000` 이 옮겨 놓은 낱말을 굳힌다.
 *   ③ 증액 금지    — amount <= requested_amount (A-D3: 증액은 재신청으로).
 *   ④ 자기 승인 금지 — reviewer_id <> requester_id (ACCOUNTING §4.3 A-5).
 *
 * 레거시 `misc` 는 `etc` 로 **낱말만** 옮긴다. 뜻이 같고(둘 다 「기타」),
 * `1756800000000-expense-state-words` 가 같은 일을 한 선례가 있다. 값을 **추정해서 다른 뜻으로
 * 바꾸는 이관이 아니다** — 그것은 금지다.
 */
export class ExpenseCardReview1758500000000 implements MigrationInterface {
  name = 'ExpenseCardReview1758500000000';

  public async up(q: QueryRunner): Promise<void> {
    // ① 낱말 이동 — 뜻은 그대로. 'other' 는 예전 시드가 쓰던 같은 뜻의 낱말이다.
    await q.query(`UPDATE expense SET category = 'etc' WHERE category IN ('misc', 'other')`);

    await q.query(`ALTER TABLE expense ADD CONSTRAINT expense_category_code
      CHECK (category IN ('rent', 'book', 'supply', 'ent', 'fee', 'etc'))`);
    await q.query(`ALTER TABLE expense ADD CONSTRAINT expense_state_words
      CHECK (state IN ('pending', 'approved', 'rejected'))`);
    // A-D3 — 승인 금액이 신청 금액을 넘을 수 없다. 신청이 없는 직접 지출(임대료)은 검사 대상이 아니다.
    await q.query(`ALTER TABLE expense ADD CONSTRAINT expense_amount_le_requested
      CHECK (requested_amount IS NULL OR amount IS NULL OR amount <= requested_amount)`);
    // A-5 — 금액을 제안하는 사람과 확정하는 사람은 항상 다르다 (불변식 I-7)
    await q.query(`ALTER TABLE expense ADD CONSTRAINT expense_no_self_review
      CHECK (reviewer_id IS NULL OR requester_id IS NULL OR reviewer_id <> requester_id)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE expense DROP CONSTRAINT IF EXISTS expense_no_self_review`);
    await q.query(`ALTER TABLE expense DROP CONSTRAINT IF EXISTS expense_amount_le_requested`);
    await q.query(`ALTER TABLE expense DROP CONSTRAINT IF EXISTS expense_state_words`);
    await q.query(`ALTER TABLE expense DROP CONSTRAINT IF EXISTS expense_category_code`);
    // 낱말은 되돌리지 않는다 — 'etc' 와 'misc' 는 같은 뜻이고, 되돌리면 대표 보고가
    // 다시 두 낱말을 세게 된다. 되돌릴 일이 생기면 앞으로 가는 마이그레이션으로 고친다.
  }
}
