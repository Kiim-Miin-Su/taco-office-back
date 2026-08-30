import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 지출 상태도 **같은 낱말**로 — `pending → approved | rejected`.
 *
 * TBO-29 에서 결재 네 표(CHREQ · REQ · GPAPACK · PLAN)를 한 낱말로 모았는데
 * **EXPENSE 를 빠뜨렸다.** 그리고 그 표는 낱말이 세 벌이었다.
 *
 *     erd.dbml · 컬럼 기본값   submitted | approved | rejected
 *     시드가 넣은 행           confirmed · pending
 *     대표 보고가 세는 조건     WHERE state = 'confirmed'
 *
 * 무슨 일이 일어나는가 — API 나 화면으로 지출을 새로 올리면 기본값 `'submitted'` 를 달고 태어나고,
 * 승인해서 `'approved'` 가 되어도 대표 보고는 `'confirmed'` 만 세므로 **그 지출은 없는 것이 된다.**
 * 임대료 1,400,000원이 손익에서 조용히 빠진다. 오류는 하나도 안 난다.
 *
 * `confirmed` 는 `approved` 와 같은 뜻이었다(둘 다 「장부에 넣는다」). 그래서 뜻을 바꾸지 않고
 * 낱말만 옮긴다.
 */
export class ExpenseStateWords1756800000000 implements MigrationInterface {
  name = 'ExpenseStateWords1756800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE expense SET state = 'approved' WHERE state IN ('confirmed', 'ok')`);
    await q.query(`UPDATE expense SET state = 'pending' WHERE state IN ('submitted', 'open')`);
    await q.query(`UPDATE expense SET state = 'rejected' WHERE state IN ('denied', 'rej')`);
    await q.query(`ALTER TABLE expense ALTER COLUMN state SET DEFAULT 'pending'`);
  }

  public async down(): Promise<void> {
    throw new Error(
      '되돌리지 않습니다 — 지출 낱말을 옛것으로 되돌리면 대표 보고가 지출을 다시 못 셉니다. '
      + '필요하면 새 마이그레이션으로 앞으로 고치세요.',
    );
  }
}
