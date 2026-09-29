/** @file-guide
 * 목적: 입금 줄(PAY)과 컨설팅 납부 줄(CONS_PAY)에 요청 키를 새겨 같은 입금 요청이 두 줄이 되지 않게 한다 (안건 N-132).
 * 책임/재사용: 새 행만 채운다 — 옛 행은 NULL(N-25 · 그때 어떤 요청이었는지 아무도 모른다). 부분 유니크가 최후 방어다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 안건 N-132(2026-09-29 권고 채택) — 청구서 행 `FOR UPDATE` + `OVERPAY` 는 **전액** 두 번만 막았다. 남은 금액 안의 같은 부분
 * 입금을 두 번 보내면(재시도 · 더블클릭 · 두 창) 두 줄이 다 들어가 누계가 두 배가 됐다. 리포트 발송(`rsend.request_key`) ·
 * 보호자 발송(`guardian_send.request_key`)과 같은 규약으로 요청 키를 받는다 — 같은 키 · 같은 내용은 앞선 결과로 수렴하고
 * (서버가 권고 잠금 안에서 판정), 표의 부분 유니크는 판정을 우회한 쓰기까지 막는 마지막 자리다.
 *
 * 두 표 모두 옛 행은 NULL 로 둔다 — 부분 유니크(`WHERE request_key IS NOT NULL`)라 옛 행은 몇 줄이든 그대로 선다.
 * down 은 키가 채워진 행이 있으면 멈춘다 — 키를 버리면 이미 받은 요청의 재시도가 다시 한 줄을 만든다.
 */
export class PayRequestKey1765300000000 implements MigrationInterface {
  name = 'PayRequestKey1765300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "pay" ADD COLUMN "request_key" uuid`);
    await q.query(`CREATE UNIQUE INDEX "pay_request_key_once" ON "pay" ("request_key") WHERE "request_key" IS NOT NULL`);
    await q.query(`ALTER TABLE "cons_pay" ADD COLUMN "request_key" uuid`);
    await q.query(`CREATE UNIQUE INDEX "cons_pay_request_key_once" ON "cons_pay" ("request_key") WHERE "request_key" IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM "pay" WHERE "request_key" IS NOT NULL)
         OR EXISTS (SELECT 1 FROM "cons_pay" WHERE "request_key" IS NOT NULL) THEN
        RAISE EXCEPTION 'PayRequestKey down would discard stored payment request keys';
      END IF;
    END $$`);
    await q.query(`DROP INDEX IF EXISTS "cons_pay_request_key_once"`);
    await q.query(`ALTER TABLE "cons_pay" DROP COLUMN "request_key"`);
    await q.query(`DROP INDEX IF EXISTS "pay_request_key_once"`);
    await q.query(`ALTER TABLE "pay" DROP COLUMN "request_key"`);
  }
}
