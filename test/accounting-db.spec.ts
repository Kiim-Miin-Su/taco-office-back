/** @file-guide
 * 목적: accounting-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §53 ⑤ 입금 기록 · §55 들어온 돈 — **분납은 줄을 늘린다** (A-D2 채택 · C36-a).
 *
 * 여기서 증명하는 것은 「화면이 더한 값」이 아니라 **서버가 다시 센 누계**다.
 * 초과·초안·완납 정정의 거절도 전부 서버 한 곳(AccountingService)에서 나온다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Inv } from '../src/entities';
import { AccountingService } from '../src/modules/accounting/accounting.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

const url = TEST_URL ? assertScratch(TEST_URL) : '';

/** 다른 DB 스위트와 같은 방식 — 스크래치 URL 만 갈아 끼우고 Neon 일 때만 ssl 을 켠다 */
function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions,
    url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

d('§53·§55 분납 입금 — 누계·전이·거절은 서버 한 곳 (A-D2 · C36-a)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let invId: number;

  const svc = () => new AccountingService(q.manager.getRepository(Inv));
  const row = async () =>
    (await q.query(`SELECT amount, paid_amount, state, paid_at FROM inv WHERE id = $1`, [invId]))[0] as {
      amount: number; paid_amount: number; state: string; paid_at: Date | null;
    };
  const payCount = async () =>
    Number((await q.query(`SELECT count(*)::int AS n FROM pay WHERE inv_id = $1`, [invId]))[0].n);

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES (61,'수납 담당','pay61@t.kr','ceo') ON CONFLICT (id) DO NOTHING`,
    );
    const [stu] = (await q.query(`INSERT INTO stu (name, grade) VALUES ('분납 학생','G9') RETURNING id`)) as { id: string }[];
    const [inv] = (await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state, sent_at)
       VALUES ($1, '2026-09', 'tuition', '9월 수업료', 500000, 'sent', now()) RETURNING id`,
      [Number(stu.id)],
    )) as { id: string }[];
    invId = Number(inv.id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('두 줄로 나눠 받으면 누계는 줄의 합이고, 채우는 순간 partial → paid 로 넘어간다', async () => {
    const first = await svc().addPayment(61, { invId, amount: 200000, paidOn: '2026-09-10', method: 'transfer' }, true);
    expect(first).toMatchObject({ state: 'partial', paidAmount: 200000, remaining: 300000 });
    expect((await row()).paid_at).toBeNull();

    const second = await svc().addPayment(61, { invId, amount: 300000, paidOn: '2026-09-20', method: 'cash' }, true);
    expect(second).toMatchObject({ state: 'paid', paidAmount: 500000, remaining: 0 });

    expect(await payCount()).toBe(2);
    const after = await row();
    expect(after.paid_amount).toBe(500000);
    expect(after.paid_at).not.toBeNull();
  });

  it('누계가 청구액을 넘는 줄은 OVERPAY 로 거절하고 **행을 남기지 않는다**', async () => {
    await svc().addPayment(61, { invId, amount: 400000, paidOn: '2026-09-10' }, true);
    await expect(svc().addPayment(61, { invId, amount: 200000, paidOn: '2026-09-11' }, true))
      .rejects.toMatchObject({ response: { code: 'OVERPAY' } });
    expect(await payCount()).toBe(1);
    expect((await row()).paid_amount).toBe(400000);
  });

  it('초안·취소 청구서에는 입금이 붙지 않는다 — §53 은 작성 → 안내 → 입금 순서다', async () => {
    await q.query(`UPDATE inv SET state = 'draft' WHERE id = $1`, [invId]);
    await expect(svc().addPayment(61, { invId, amount: 1000, paidOn: '2026-09-10' }, true))
      .rejects.toMatchObject({ response: { code: 'INV_NOT_BILLABLE' } });
    await q.query(`UPDATE inv SET state = 'void' WHERE id = $1`, [invId]);
    await expect(svc().addPayment(61, { invId, amount: 1000, paidOn: '2026-09-10' }, true))
      .rejects.toMatchObject({ response: { code: 'INV_NOT_BILLABLE' } });
    expect(await payCount()).toBe(0);
  });

  it('부분 납부는 줄을 지워 정정할 수 있고, 마지막 줄을 지우면 발행 사실(전달)로 돌아간다', async () => {
    await svc().addPayment(61, { invId, amount: 120000, paidOn: '2026-09-10' }, true);
    const [pay] = (await q.query(`SELECT id FROM pay WHERE inv_id = $1 ORDER BY id DESC LIMIT 1`, [invId])) as { id: string }[];
    await expect(svc().removePayment(Number(pay.id))).resolves.toEqual({ ok: true });
    const after = await row();
    expect(after).toMatchObject({ paid_amount: 0, state: 'sent' });
    expect(await payCount()).toBe(0);
  });

  it('완납된 청구서의 줄은 지울 수 없다 — 되돌리기가 없다 (erd INV Note)', async () => {
    await svc().addPayment(61, { invId, amount: 500000, paidOn: '2026-09-10' }, true);
    const [pay] = (await q.query(`SELECT id FROM pay WHERE inv_id = $1 ORDER BY id DESC LIMIT 1`, [invId])) as { id: string }[];
    await expect(svc().removePayment(Number(pay.id)))
      .rejects.toMatchObject({ response: { code: 'INV_PAID_LOCKED' } });
    expect(await payCount()).toBe(1);
  });

  it('금액 권한이 없으면 잔액도 내려보내지 않는다 — 빼기로 복원되면 가린 뜻이 없다', async () => {
    const out = await svc().addPayment(61, { invId, amount: 100000, paidOn: '2026-09-10' }, false);
    expect(out).toMatchObject({ amount: null, paidAmount: null, remaining: null, state: 'partial' });
  });
});

/* ── 경합 — 같은 청구서에 두 사람이 동시에 입금을 적는다 (D-R43 · 원칙 26) ────────────
   위 블록은 한 커넥션 안의 트랜잭션이라 진짜 동시성이 아니다. 여기서는 전역 매니저로
   두 요청을 동시에 띄워 **하나만 통과**하는지 본다. 스크래치 DB 이므로 끝나고 지운다. */
d('경합 — 같은 청구서 동시 입금은 하나만 남는다 (C36-a)', () => {
  let ds: DataSource;
  let invId = 0;
  let stuId = 0;

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  beforeEach(async () => {
    const [stu] = (await ds.query(`INSERT INTO stu (name) VALUES ('경합 학생') RETURNING id`)) as { id: string }[];
    stuId = Number(stu.id);
    const [inv] = (await ds.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state)
       VALUES ($1, '2026-09', 'tuition', '경합 수업료', 100000, 'unpaid') RETURNING id`,
      [stuId],
    )) as { id: string }[];
    invId = Number(inv.id);
  });
  afterEach(async () => {
    await ds.query(`DELETE FROM pay WHERE inv_id = $1`, [invId]);
    await ds.query(`DELETE FROM inv WHERE id = $1`, [invId]);
    await ds.query(`DELETE FROM stu WHERE id = $1`, [stuId]);
  });

  it('각각 60%를 동시에 적으면 한 줄만 남고 나머지는 OVERPAY 다', async () => {
    const svc = new AccountingService(ds.getRepository(Inv));
    const results = await Promise.allSettled([
      svc.addPayment(61, { invId, amount: 60000, paidOn: '2026-09-10' }, true),
      svc.addPayment(61, { invId, amount: 60000, paidOn: '2026-09-10' }, true),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    (results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]).forEach((r) =>
      expect(r.reason?.response?.code).toBe('OVERPAY'),
    );
    const [{ n }] = (await ds.query(`SELECT count(*)::int AS n FROM pay WHERE inv_id = $1`, [invId])) as { n: number }[];
    expect(n).toBe(1);
    const [{ paid_amount: paid }] = (await ds.query(`SELECT paid_amount FROM inv WHERE id = $1`, [invId])) as { paid_amount: number }[];
    expect(paid).toBe(60000);
  });
});

/* ── §56 법인카드 심사 — 다섯 규칙이 서버 한 곳에 있다 (A-D3 · A-D5 · C36-b) ────────── */
d('§56 법인카드 심사 — 증액은 없다 (A-D3 · C36-b)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let expId: number;

  const svc = () => new AccountingService(q.manager.getRepository(Inv));
  const row = async () =>
    (await q.query(`SELECT state, amount, reason, reviewer_id FROM expense WHERE id = $1`, [expId]))[0] as {
      state: string; amount: number | null; reason: string | null; reviewer_id: string | null;
    };
  /** 기본 신청 — 영수증 있음 · 신청자 62 · 심사자 63 */
  const make = async (over: { receipt?: boolean; requester?: number } = {}) => {
    const [r] = (await q.query(
      `INSERT INTO expense (spend_on, category, merchant, purpose, requested_amount, requester_id, state, receipt_url)
       VALUES ('2026-09-08', 'ent', '카페 서초', '학부모 간담회 다과', 145000, $1, 'pending', $2) RETURNING id`,
      [over.requester ?? 62, over.receipt === false ? null : 'seed://receipt/ent-test'],
    )) as { id: string }[];
    expId = Number(r.id);
  };

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES (62,'신청자','req62@t.kr','manager'),(63,'심사자','rev63@t.kr','ceo')
       ON CONFLICT (id) DO NOTHING`,
    );
    await make();
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('신청 금액 그대로 승인하면 사유 없이 통과하고 심사자·시각이 남는다', async () => {
    const out = await svc().reviewExpense(63, expId, { decision: 'approve', amount: 145000 }, true);
    expect(out).toMatchObject({ state: 'approved', amount: 145000, categoryLabel: '접대비', hasReceipt: true });
    const after = await row();
    expect(after.state).toBe('approved');
    expect(Number(after.reviewer_id)).toBe(63);
  });

  it('증액은 없다 — 신청 금액보다 크면 CARD_AMOUNT_EXCEEDS_REQUEST 로 거절하고 행은 그대로다 (A-D3)', async () => {
    await expect(svc().reviewExpense(63, expId, { decision: 'approve', amount: 145001 }, true))
      .rejects.toMatchObject({ response: { code: 'CARD_AMOUNT_EXCEEDS_REQUEST' } });
    expect((await row()).state).toBe('pending');
  });

  it('감액은 사유가 있어야 한다 — 없으면 AMOUNT_REASON_REQUIRED (A-3)', async () => {
    await expect(svc().reviewExpense(63, expId, { decision: 'approve', amount: 100000 }, true))
      .rejects.toMatchObject({ response: { code: 'AMOUNT_REASON_REQUIRED' } });
    const ok = await svc().reviewExpense(63, expId, { decision: 'approve', amount: 100000, reason: '영수증 금액과 다름' }, true);
    expect(ok).toMatchObject({ state: 'approved', amount: 100000, reason: '영수증 금액과 다름' });
  });

  it('영수증이 없으면 승인 자체가 안 된다 — 반려는 된다 (A-4)', async () => {
    await make({ receipt: false });
    await expect(svc().reviewExpense(63, expId, { decision: 'approve', amount: 145000 }, true))
      .rejects.toMatchObject({ response: { code: 'CARD_RECEIPT_REQUIRED' } });
    const out = await svc().reviewExpense(63, expId, { decision: 'reject', reason: '영수증 첨부 후 재신청' }, true);
    expect(out.state).toBe('rejected');
  });

  it('본인이 올린 신청은 본인이 심사할 수 없다 (A-5)', async () => {
    await make({ requester: 63 });
    await expect(svc().reviewExpense(63, expId, { decision: 'approve', amount: 145000 }, true))
      .rejects.toMatchObject({ response: { code: 'SELF_APPROVAL_FORBIDDEN' } });
    expect((await row()).state).toBe('pending');
  });

  it('이미 심사된 건은 다시 심사하지 않는다', async () => {
    await svc().reviewExpense(63, expId, { decision: 'approve', amount: 145000 }, true);
    await expect(svc().reviewExpense(63, expId, { decision: 'reject', reason: '취소' }, true))
      .rejects.toMatchObject({ response: { code: 'EXPENSE_ALREADY_REVIEWED' } });
  });

  it('반려에는 사유가 필요하다', async () => {
    await expect(svc().reviewExpense(63, expId, { decision: 'reject' }, true))
      .rejects.toMatchObject({ response: { code: 'AMOUNT_REASON_REQUIRED' } });
    expect((await row()).state).toBe('pending');
  });

  it('마지막 방어선은 DB 다 — 서비스를 건너뛴 증액·자기 승인·오타 분류는 CHECK 가 거부한다', async () => {
    /* 제약 위반 하나가 트랜잭션을 끊어 놓으므로 검사마다 savepoint 로 되돌린다.
       안 그러면 두 번째 UPDATE 부터는 25P02(aborted) 라서 **무엇이 막았는지**를 못 본다. */
    const violates = async (sql: string, constraint: string) => {
      await q.query('SAVEPOINT chk');
      await expect(q.query(sql, [expId])).rejects.toMatchObject({ constraint });
      await q.query('ROLLBACK TO SAVEPOINT chk');
    };
    await violates(`UPDATE expense SET amount = 999999 WHERE id = $1`, 'expense_amount_le_requested');
    await violates(`UPDATE expense SET reviewer_id = requester_id WHERE id = $1`, 'expense_no_self_review');
    await violates(`UPDATE expense SET category = 'coffee' WHERE id = $1`, 'expense_category_code');
    await violates(`UPDATE expense SET state = 'submitted' WHERE id = $1`, 'expense_state_words');
    expect((await row()).state).toBe('pending');
  });

  it('금액 권한이 없으면 신청 금액(placeholder)도 내려보내지 않는다', async () => {
    const out = await svc().reviewExpense(63, expId, { decision: 'approve', amount: 145000 }, false);
    expect(out).toMatchObject({ amount: null, requestedAmount: null, state: 'approved', categoryLabel: '접대비' });
  });
});
