/** @file-guide
 * 목적: 1759300000000-consulting-payments.ts — ConsultingPayments1759300000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §28 컨설팅 회계 — **납부 기록**과 **청구서 연결** (C58).
 *
 * 원문 슬라이드 28 의 데이터 줄이 「`CONS.amt`, **`CONS.pay[]`**」이고 연동 줄이
 * 「INV 에 **csid** 로 연결됩니다」다. 우리 표에는 `cons.amount` 만 있고 **받은 돈을 적을
 * 자리가 없었다** — 그래서 §28 의 세 칸(계약 금액 · 받은 돈 · 남은 돈)을 만들 수 없었다.
 *
 * **`pay` 표를 빌려 쓰지 않는다.** `pay` 는 `inv_id` 에 매달린 **청구서 입금**이다.
 * 컨설팅 납부는 청구서를 거치지 않고도 들어온다(원문 §30 의 계약 5단계에서 「수납」이
 * 서명본 다음이고, 청구서 생성은 그 **뒤의 선택지**다 — 「수납 시 청구서(INV) 생성 **가능**」).
 * 둘을 한 표에 섞으면 「청구서 없는 입금」이 `inv_id` 없는 유령 행이 된다.
 *
 * `inv.cs_id` 는 **연결이지 소유가 아니다.** 청구서로 전환해도 납부 기록은 `cons_pay` 에
 * 그대로 남는다 — 원문 §28 의 「납부 기록」 칸이 청구서 발행 뒤에도 사라지면 안 된다.
 */
export class ConsultingPayments1759300000000 implements MigrationInterface {
  name = 'ConsultingPayments1759300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS cons_pay (
      id bigserial NOT NULL,
      cons_id bigint NOT NULL,
      amount integer NOT NULL,
      paid_on date NOT NULL,
      memo varchar(80),
      by_id bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT cons_pay_cons_fk FOREIGN KEY (cons_id) REFERENCES cons(id),
      CONSTRAINT cons_pay_by_fk FOREIGN KEY (by_id) REFERENCES staff(id),
      -- 0 원 납부는 기록이 아니라 실수다. 음수는 환불이라 다른 일이고, 원문에 없다.
      CONSTRAINT cons_pay_amount_positive CHECK (amount > 0)
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS cons_pay_cons_id_paid_on_idx ON cons_pay (cons_id, paid_on)`);
    await q.query(
      `COMMENT ON TABLE cons_pay IS '§28 컨설팅 납부 기록 — 원문 CONS.pay[]. 청구서 입금(pay)과 다른 표다'`,
    );

    await q.query(`ALTER TABLE inv ADD COLUMN IF NOT EXISTS cs_id bigint`);
    await q.query(
      `COMMENT ON COLUMN inv.cs_id IS '어느 컨설팅에서 전환된 청구서인가 — 원문 §28 「INV 에 csid 로 연결」. 연결이지 소유가 아니다'`,
    );
    await q.query(
      `ALTER TABLE inv ADD CONSTRAINT inv_cs_fk FOREIGN KEY (cs_id) REFERENCES cons(id) NOT VALID`,
    );
    // 한 컨설팅에서 살아 있는 청구서는 하나다. 취소(void)한 것은 다시 만들 수 있다.
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS inv_cs_id_live_uniq ON inv (cs_id) WHERE cs_id IS NOT NULL AND state <> 'void'`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS inv_cs_id_live_uniq`);
    await q.query(`ALTER TABLE inv DROP CONSTRAINT IF EXISTS inv_cs_fk`);
    await q.query(`ALTER TABLE inv DROP COLUMN IF EXISTS cs_id`);
    await q.query(`DROP TABLE IF EXISTS cons_pay`);
  }
}
