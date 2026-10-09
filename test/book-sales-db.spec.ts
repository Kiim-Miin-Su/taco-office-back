/** @file-guide
 * 목적: BOC-11F 교재 판매·수수료의 실제 PostgreSQL transaction, 멱등, 경합, 원 PAY 보존과 지연 제약을 회귀한다.
 * 책임/재사용: BookSalesService를 직접 호출하고 제품 계산·권한 규칙을 테스트 안에 복제하지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11F-BOOK-SALES-FEES-2026-10-09.md · migration 1768700000000
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { todayKst } from '../src/lib/kst';
import { BookSalesService } from '../src/modules/accounting/book-sales.service';
import { assertScratch, blockedBy, TEST_URL } from './db';

const d = TEST_URL && /localhost|127\.0\.0\.1/.test(TEST_URL) ? describe : describe.skip;
jest.setTimeout(60_000);

d('TBO-55 BOC-11F 교재 판매·결제 수수료', () => {
  let ds: DataSource;
  let service: BookSalesService;
  const actor = 998700;
  const student = 998701;
  const book = 998702;
  const bookCode = 'BOC11F-DB';

  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, name: `book-sales-${Date.now()}` } as typeof dataSourceOptions);
    await ds.initialize();
    service = new BookSalesService(ds);
    await ds.query(`INSERT INTO staff(id,name,email,role,active)
      VALUES($1,'교재 판매 대표','book-sales@test.local','ceo',true)`, [actor]);
    await ds.query(`INSERT INTO stu(id,name,grade) VALUES($1,'교재 판매 학생','G10')`, [student]);
    await ds.query(`INSERT INTO lib(id,code,title,pages) VALUES($1,$2,'Writing Basics',120)`, [book, bookCode]);
    await ds.query(`INSERT INTO vers(lib_id,edition,from_date) VALUES($1,'v2026.10',CURRENT_DATE)`, [book]);
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    const q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      // 승인된 로컬 scratch fixture만 정리한다. immutable 제품 trigger는 검증 후 fixture cleanup 동안만 끈다.
      for (const table of ['book_sale_event', 'book_sale_request', 'book_sale', 'pay']) {
        await q.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      }
      await q.query(`DELETE FROM log WHERE actor_id=$1`, [actor]);
      await q.query(`DELETE FROM book_sale_event WHERE actor_id=$1`, [actor]);
      await q.query(`DELETE FROM book_sale_request WHERE actor_id=$1`, [actor]);
      await q.query(`DELETE FROM book_sale WHERE created_by=$1`, [actor]);
      await q.query(`DELETE FROM pay WHERE entered_by=$1`, [actor]);
      await q.query(`DELETE FROM vers WHERE lib_id=$1`, [book]);
      await q.query(`DELETE FROM lib WHERE id=$1`, [book]);
      await q.query(`DELETE FROM stu WHERE id=$1`, [student]);
      await q.query(`DELETE FROM staff WHERE id=$1`, [actor]);
      for (const table of ['pay', 'book_sale', 'book_sale_request', 'book_sale_event']) {
        await q.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      }
      await q.commitTransaction();
    } catch (error) {
      if (q.isTransactionActive) await q.rollbackTransaction();
      throw error;
    } finally {
      await q.release();
      await ds.destroy();
    }
  });

  it('같은 판매 요청은 한 PAY로 수렴하고 다른 payload 재사용과 무권한 조회를 거절한다', async () => {
    await expect(service.ledger(false)).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
    const requestKey = randomUUID();
    const body = {
      studentId: student,
      bookId: book,
      soldOn: todayKst(),
      quantity: 2,
      unitPrice: 25_000,
      paymentMethod: 'transfer' as const,
      memo: '첫 판매',
      requestKey,
    };
    const concurrent = await Promise.all([service.create(actor, true, body), service.create(actor, true, body)]);
    expect(concurrent.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(new Set(concurrent.map((result) => result.item.id)).size).toBe(1);
    const sale = concurrent[0].item;
    expect(sale).toMatchObject({
      studentId: student, bookId: book, quantity: 2, unitPrice: 25_000, totalAmount: 50_000,
      paymentMethod: 'transfer', feeAmount: 0, netAmount: 50_000, status: 'completed', version: 1,
      feePolicy: { calculation: 'fixed', value: 0, version: 1 },
    });
    expect(await service.detail(true, sale.id)).toMatchObject({ id: sale.id, payId: sale.payId, canCancel: true });
    expect(await service.ledger(true)).toMatchObject({ totalCount: 1, totalAmount: 50_000, totalFeeAmount: 0 });
    expect((await ds.query(`SELECT count(*)::int AS count FROM pay WHERE request_key=$1`, [requestKey]))[0].count).toBe(1);
    await expect(service.create(actor, true, { ...body, unitPrice: 26_000 })).rejects.toMatchObject({
      response: { code: 'BOOK_SALE_KEY_REUSED' },
    });
  });

  it('동시 취소는 version으로 하나만 적용하고 원 PAY·불변 이력은 보존한다', async () => {
    const [sale] = await ds.query(`SELECT id,pay_id,row_version,total_amount FROM book_sale
      WHERE created_by=$1 AND status='completed' ORDER BY id LIMIT 1`, [actor]) as Array<{
      id: string; pay_id: string; row_version: number; total_amount: number;
    }>;
    const attempts = [
      { requestKey: randomUUID(), reason: '중복 판매 정정' },
      { requestKey: randomUUID(), reason: '동시 취소 경합' },
    ];
    const results = await Promise.allSettled(attempts.map((attempt) => service.cancel(actor, true, Number(sale.id), {
      expectedVersion: Number(sale.row_version), ...attempt,
    })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ response: { code: 'BOOK_SALE_STALE' } });
    const winnerIndex = results.findIndex((result) => result.status === 'fulfilled');
    const winner = attempts[winnerIndex];
    const replay = await service.cancel(actor, true, Number(sale.id), {
      expectedVersion: 1, reason: winner.reason, requestKey: winner.requestKey,
    });
    expect(replay).toMatchObject({ replayed: true, item: { status: 'canceled', version: 2, canCancel: false } });

    const [current] = await ds.query(`SELECT pay_id,correction_pay_id,total_amount FROM book_sale WHERE id=$1`, [sale.id]) as Array<{
      pay_id: string; correction_pay_id: string; total_amount: number;
    }>;
    expect(Number(current.pay_id)).toBe(Number(sale.pay_id));
    expect(await ds.query(`SELECT amount FROM pay WHERE id IN ($1,$2) ORDER BY id`, [current.pay_id, current.correction_pay_id]))
      .toEqual([{ amount: Number(sale.total_amount) }, { amount: -Number(sale.total_amount) }]);
    expect(await ds.query(`SELECT action,result_version FROM book_sale_event WHERE sale_id=$1 ORDER BY result_version`, [sale.id]))
      .toEqual([{ action: 'created', result_version: 1 }, { action: 'canceled', result_version: 2 }]);
    expect(await service.ledger(true)).toMatchObject({ totalCount: 0, totalAmount: 0, totalFeeAmount: 0, totalNetAmount: 0 });
  });

  it('직접 PAY/정책 변조와 event 없는 판매 쓰기를 DB가 거절한다', async () => {
    const q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const [sale] = await q.query(`SELECT id,pay_id FROM book_sale WHERE created_by=$1 ORDER BY id LIMIT 1`, [actor]) as Array<{
        id: string; pay_id: string;
      }>;
      expect(await blockedBy(q, `UPDATE pay SET amount=amount+1 WHERE id=$1`, [sale.pay_id]))
        .toContain('book sale payments are preserved');
      expect(await blockedBy(q, `DELETE FROM pay WHERE id=$1`, [sale.pay_id]))
        .toContain('book sale payments are preserved');
      expect(await blockedBy(q, `UPDATE book_sale_fee_policy SET value=1 WHERE payment_method='cash'`))
        .toContain('book sale fee policy history is immutable');
      expect(await blockedBy(q, `INSERT INTO book_sale_fee_policy(
          payment_method,calculation,value,policy_version,effective_from)
        VALUES('cash','fixed',10,2,CURRENT_DATE)`)).toContain('book_sale_fee_policy_no_overlap');

      const [pay] = await q.query(`INSERT INTO pay(
          inv_id,student_id,amount,paid_on,method,reason,entered_by,entered_at,confirmed_by,confirmed_at,request_key)
        VALUES(NULL,$1,1000,CURRENT_DATE,'cash','직접 쓰기 probe',$2,now(),$2,now(),$3) RETURNING id`, [
        student, actor, randomUUID(),
      ]) as Array<{ id: string }>;
      const [policy] = await q.query(`SELECT id,policy_version FROM book_sale_fee_policy WHERE payment_method='cash'`);
      await q.query(`SAVEPOINT missing_receipt`);
      let receiptError: unknown;
      try {
        await q.query(`INSERT INTO book_sale(
            student_id,book_id,book_code,book_title,book_edition,book_label,sold_on,quantity,unit_price,total_amount,
            payment_method,fee_policy_id,fee_policy_version,fee_amount,net_amount,pay_id,status,row_version,created_by)
          VALUES($1,$2,$3,'Writing Basics','v2026.10',$4,CURRENT_DATE,1,1000,1000,
            'cash',$5,$6,0,1000,$7,'completed',1,$8)`, [
          student, book, bookCode, `${bookCode} · Writing Basics · v2026.10`, policy.id, policy.policy_version, pay.id, actor,
        ]);
        await q.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      } catch (error) {
        receiptError = error;
      }
      await q.query(`ROLLBACK TO SAVEPOINT missing_receipt`);
      await q.query(`RELEASE SAVEPOINT missing_receipt`);
      expect(receiptError).toMatchObject({ constraint: 'book_sale_receipt_required' });
    } finally {
      if (q.isTransactionActive) await q.rollbackTransaction();
      await q.release();
    }
  });
});
