/** @file-guide
 * 목적: 1764200000000-inv-installment.ts — InvInstallment1764200000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 청구서 **분납 일정** — `inv_installment` (N-79 채택 · W11 · 원문 §55 「고은성 2회차 ₩413,300 D-10 · 3회차 D-40」).
 *
 * - 선택 입력이다. 일정이 없는 청구서는 지금처럼 `inv.due_on` 하나로 기한을 본다 — **옛 청구서 보정 0**(N-25).
 * - 한 줄 = 회차(seq) · 예정일 · 금액. 같은 청구서 안에서 회차 번호와 예정일은 한 번씩만(유니크 둘).
 * - **회차 금액의 합 = 청구액**(`inv.amount`) — 발행 경로(`issueOne`)가 먼저 막고, 이 표의 **지연 제약 트리거**가
 *   커밋 때 마지막으로 본다(여러 줄에 걸친 합이라 CHECK 로는 못 건다). 일정이 없는 청구서는 보지 않는다.
 *   청구액을 바꾸는 쓰기(수강 종료 환불)는 같은 트랜잭션에서 일정의 끝 회차부터 줄인다.
 * - 청구서를 지우면 일정도 함께 지워진다(ON DELETE CASCADE) — 일정은 청구서의 일부다.
 * - 연체 판정은 「누적 입금이 못 채운 가장 이른 회차의 예정일」 — 판정 조각은 `lib/exec-areas` 한 곳이다.
 *
 * `down` 은 표를 지운다 — 사람이 적은 분납 일정이 사라지므로, 행이 있으면 **세어서 멈춘다**(데이터를 조용히 버리지 않는다).
 */
export class InvInstallment1764200000000 implements MigrationInterface {
  name = 'InvInstallment1764200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "inv_installment" (
        "id"     bigserial PRIMARY KEY,
        "inv_id" bigint   NOT NULL,
        "seq"    smallint NOT NULL,
        "due_on" date     NOT NULL,
        "amount" integer  NOT NULL,
        CONSTRAINT "inv_installment_inv_fk" FOREIGN KEY ("inv_id") REFERENCES "inv"("id") ON DELETE CASCADE,
        CONSTRAINT "inv_installment_seq_positive" CHECK ("seq" >= 1),
        CONSTRAINT "inv_installment_amount_positive" CHECK ("amount" > 0),
        CONSTRAINT "inv_installment_seq_uniq" UNIQUE ("inv_id", "seq"),
        CONSTRAINT "inv_installment_due_uniq" UNIQUE ("inv_id", "due_on")
      )
    `);

    /*
     * 합 = 청구액 — 커밋 때 본다(INITIALLY DEFERRED). 한 트랜잭션 안에서 청구서를 먼저 넣고 회차를 줄줄이 넣거나,
     * 청구액을 줄인 뒤 회차를 맞추는 동안에는 잠깐 어긋나도 된다. 끝에 어긋나 있으면 커밋이 실패한다.
     * 청구서가 없어졌으면(CASCADE) 볼 것이 없다.
     */
    await q.query(`
      CREATE FUNCTION "inv_installment_sum_guard"() RETURNS trigger AS $$
      DECLARE
        target bigint;
        billed integer;
        planned bigint;
      BEGIN
        IF TG_TABLE_NAME = 'inv' THEN target := NEW.id;
        ELSIF TG_OP = 'DELETE' THEN target := OLD.inv_id;
        ELSE target := NEW.inv_id;
        END IF;
        SELECT amount INTO billed FROM inv WHERE id = target;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT sum(amount) INTO planned FROM inv_installment WHERE inv_id = target;
        IF planned IS NOT NULL AND planned <> billed THEN
          RAISE EXCEPTION 'installment total % differs from invoice amount % (inv %)', planned, billed, target
            USING ERRCODE = '23514', CONSTRAINT = 'inv_installment_sum';
        END IF;
        RETURN NULL;
      END;
    $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE CONSTRAINT TRIGGER "inv_installment_sum_check"
        AFTER INSERT OR UPDATE OR DELETE ON "inv_installment"
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION "inv_installment_sum_guard"()`);
    await q.query(`
      CREATE CONSTRAINT TRIGGER "inv_installment_sum_on_inv"
        AFTER UPDATE OF "amount" ON "inv"
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION "inv_installment_sum_guard"()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    const [row] = (await q.query(`SELECT count(*)::int AS n FROM "inv_installment"`)) as Array<{ n: number }>;
    if (Number(row?.n ?? 0) > 0) {
      throw new Error(
        `inv_installment 에 분납 일정 ${row.n}줄이 있습니다 — 되돌리면 사람이 적은 일정이 사라집니다. 옮겨 둔 뒤 다시 되돌리세요.`,
      );
    }
    await q.query(`DROP TRIGGER IF EXISTS "inv_installment_sum_on_inv" ON "inv"`);
    await q.query(`DROP TABLE IF EXISTS "inv_installment"`);
    await q.query(`DROP FUNCTION IF EXISTS "inv_installment_sum_guard"()`);
  }
}
