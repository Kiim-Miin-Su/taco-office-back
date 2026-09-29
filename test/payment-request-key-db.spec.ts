/** @file-guide
 * 목적: payment-request-key-db.spec.ts — 입금 세 경로(청구서 입금 · 청구서 없는 입금 · 컨설팅 수납)의 멱등 키(N-132) 회귀
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 안건 N-132(2026-09-29 권고 채택) — **같은 부분 입금을 두 번 보내면 둘 다 들어왔다.**
 *
 * 청구서 행 `FOR UPDATE` + `OVERPAY` 는 **전액** 두 번만 막는다(누계가 청구액을 넘으니까). 남은 금액 안의 같은
 * 부분 금액은 두 줄 다 들어가 누계가 두 배가 됐다 — 끊긴 네트워크의 재시도 · 더블클릭 · 두 창.
 * 채택안은 리포트 발송(CR-BE-03) · 보호자 발송과 같은 규약이다:
 *   ① 같은 `requestKey` · 같은 내용 → 앞선 결과를 돌려준다(줄이 늘지 않는다 · 동시에 와도 하나)
 *   ② 같은 키 · 다른 내용 → 409 `PAY_REQUEST_KEY_REUSED`(줄이 늘지 않는다)
 *   ③ 다른 키 → 따로 들어간다(분납 H-78 은 그대로)
 *   ④ 지운 줄의 키로 다시 오면 되살리지 않는다(409 · 지운 기록은 LOG 에 있다)
 *   ⑤ 표가 마지막을 지킨다 — `pay.request_key` · `cons_pay.request_key` 부분 유니크
 *
 * ⚠ 동시성을 보려고 트랜잭션 밖(ds)에서 돈다 — 제 픽스처만 만들고 지운다(전역 DELETE 없음).
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Inv, Lead } from '../src/entities';
import { AccountingService } from '../src/modules/accounting/accounting.service';
import { ConsultingService } from '../src/modules/consulting/consulting.service';
import { todayKst } from '../src/lib/kst';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

const url = TEST_URL ? assertScratch(TEST_URL) : '';

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions,
    url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

const ACTOR = 1321;
const STU = 13211;
const CONS = 13291;

const codeOf = (e: unknown): string | undefined =>
  (e as { response?: { code?: string } })?.response?.code;

d('N-132 입금 멱등 키 — 같은 요청은 한 줄 (청구서 · 청구서 없음 · 컨설팅)', () => {
  let ds: DataSource;
  let invId = 0;

  const acct = () => new AccountingService(ds.getRepository(Inv));
  const cons = () => new ConsultingService(ds.getRepository(Lead));
  const n = async (sql: string, p: unknown[]) => Number(((await ds.query(sql, p)) as Array<{ n: string }>)[0].n);
  const invPays = () => n(`SELECT count(*) AS n FROM pay WHERE inv_id = $1`, [invId]);
  const stuManual = () => n(`SELECT count(*) AS n FROM pay WHERE inv_id IS NULL AND student_id = $1`, [STU]);
  const consPays = () => n(`SELECT count(*) AS n FROM cons_pay WHERE cons_id = $1`, [CONS]);
  const paidAmount = async () =>
    Number(((await ds.query(`SELECT paid_amount FROM inv WHERE id = $1`, [invId])) as Array<{ paid_amount: number }>)[0].paid_amount);

  const cleanup = async () => {
    await ds.query(`DELETE FROM log WHERE actor_id = $1`, [ACTOR]);
    await ds.query(`DELETE FROM noti WHERE to_id = $1 OR from_id = $1`, [ACTOR]);
    await ds.query(`DELETE FROM cons_event WHERE cons_id = $1`, [CONS]);
    await ds.query(`DELETE FROM cons_pay WHERE cons_id = $1`, [CONS]);
    await ds.query(`DELETE FROM cons_stu WHERE cons_id = $1`, [CONS]);
    await ds.query(`DELETE FROM cons WHERE id = $1`, [CONS]);
    await ds.query(`DELETE FROM pay WHERE student_id = $1`, [STU]);
    await ds.query(`DELETE FROM inv WHERE student_id = $1`, [STU]);
    await ds.query(`DELETE FROM stu WHERE id = $1`, [STU]);
  };

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
    await cleanup();
    await ds.query(
      `INSERT INTO staff (id,name,email,role) VALUES ($1,'멱등 수납','idem1321@t.kr','ceo') ON CONFLICT (id) DO NOTHING`,
      [ACTOR],
    );
    await ds.query(`INSERT INTO stu (id, name, grade) VALUES ($1, '멱등 학생', 'G9')`, [STU]);
  });
  beforeEach(async () => {
    await ds.query(`DELETE FROM log WHERE actor_id = $1`, [ACTOR]);
    await ds.query(`DELETE FROM pay WHERE student_id = $1`, [STU]);
    await ds.query(`DELETE FROM inv WHERE student_id = $1`, [STU]);
    const [inv] = (await ds.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state, sent_at)
       VALUES ($1, '2026-09', 'tuition', '멱등 9월 수업료', 300000, 'sent', now()) RETURNING id`,
      [STU],
    )) as Array<{ id: string }>;
    invId = Number(inv.id);
  });
  afterAll(async () => {
    try {
      await cleanup();
      await ds.query(`DELETE FROM staff WHERE id = $1`, [ACTOR]);
    } finally {
      if (ds?.isInitialized) await ds.destroy();
    }
  });

  it('① 같은 키 · 같은 부분 금액을 두 번 보내면 한 줄 · 누계도 한 번 — 둘 다 같은 결과를 받는다', async () => {
    const key = randomUUID();
    const body = { invId, amount: 100000, paidOn: '2026-09-20', method: 'transfer', requestKey: key };
    const first = await acct().addPayment(ACTOR, body, true);
    const again = await acct().addPayment(ACTOR, { ...body }, true);
    expect(await invPays()).toBe(1);
    expect(await paidAmount()).toBe(100000);
    expect(first).toMatchObject({ state: 'partial', paidAmount: 100000 });
    expect(again).toMatchObject({ id: first.id, state: 'partial', paidAmount: 100000 });
  });

  it('① 같은 키가 동시에 와도 한 줄 — 둘째는 첫째가 끝나길 기다렸다가 그 결과를 받는다', async () => {
    const key = randomUUID();
    const body = { invId, amount: 50000, paidOn: '2026-09-20', requestKey: key };
    const results = await Promise.allSettled([
      acct().addPayment(ACTOR, { ...body }, true),
      acct().addPayment(ACTOR, { ...body }, true),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await invPays()).toBe(1);
    expect(await paidAmount()).toBe(50000);
  });

  it('② 같은 키 · 다른 금액은 409 PAY_REQUEST_KEY_REUSED — 줄이 늘지 않는다', async () => {
    const key = randomUUID();
    await acct().addPayment(ACTOR, { invId, amount: 100000, paidOn: '2026-09-20', requestKey: key }, true);
    const err = await acct().addPayment(ACTOR, { invId, amount: 120000, paidOn: '2026-09-20', requestKey: key }, true)
      .then(() => null, (e: unknown) => e);
    expect(codeOf(err)).toBe('PAY_REQUEST_KEY_REUSED');
    expect(await invPays()).toBe(1);
    expect(await paidAmount()).toBe(100000);
  });

  it('③ 다른 키면 같은 부분 금액이라도 따로 들어간다 — 분납(H-78)은 그대로', async () => {
    await acct().addPayment(ACTOR, { invId, amount: 100000, paidOn: '2026-09-20', requestKey: randomUUID() }, true);
    await acct().addPayment(ACTOR, { invId, amount: 100000, paidOn: '2026-09-20', requestKey: randomUUID() }, true);
    expect(await invPays()).toBe(2);
    expect(await paidAmount()).toBe(200000);
  });

  it('④ 지운 줄의 키로 다시 오면 되살리지 않는다 — 409 · 누계는 지운 뒤 그대로', async () => {
    const key = randomUUID();
    await acct().addPayment(ACTOR, { invId, amount: 100000, paidOn: '2026-09-20', requestKey: key }, true);
    const [pay] = (await ds.query(`SELECT id FROM pay WHERE inv_id = $1`, [invId])) as Array<{ id: string }>;
    await acct().removePayment(ACTOR, Number(pay.id));
    const err = await acct().addPayment(ACTOR, { invId, amount: 100000, paidOn: '2026-09-20', requestKey: key }, true)
      .then(() => null, (e: unknown) => e);
    expect(codeOf(err)).toBe('PAY_REQUEST_KEY_REUSED');
    expect(await invPays()).toBe(0);
    const [log] = (await ds.query(
      `SELECT before->>'requestKey' AS k FROM log WHERE entity = 'PAY' AND action = 'delete' AND entity_id = $1`, [Number(pay.id)],
    )) as Array<{ k: string | null }>;
    expect(log.k).toBe(key);
  });

  it('① · ② 청구서 없는 입금도 같다 — 같은 키는 같은 줄 · 다른 사유는 409 · 청구서 입금의 키를 빌려 와도 409', async () => {
    const key = randomUUID();
    const body = { studentId: STU, amount: 35000, paidOn: '2026-09-21', method: 'cash', reason: '교재비', requestKey: key };
    const first = await acct().addManualPayment(ACTOR, body, true);
    const again = await acct().addManualPayment(ACTOR, { ...body, reason: '  교재비  ' }, true);
    expect(again.id).toBe(first.id);
    expect(await stuManual()).toBe(1);
    const logs = await n(`SELECT count(*) AS n FROM log WHERE entity = 'PAY' AND action = 'create' AND entity_id = $1`, [first.id]);
    expect(logs).toBe(1);

    const other = await acct().addManualPayment(ACTOR, { ...body, reason: '조정' }, true).then(() => null, (e: unknown) => e);
    expect(codeOf(other)).toBe('PAY_REQUEST_KEY_REUSED');

    const invKey = randomUUID();
    await acct().addPayment(ACTOR, { invId, amount: 10000, paidOn: '2026-09-21', requestKey: invKey }, true);
    const cross = await acct().addManualPayment(ACTOR, { ...body, requestKey: invKey }, true).then(() => null, (e: unknown) => e);
    expect(codeOf(cross)).toBe('PAY_REQUEST_KEY_REUSED');
    expect(await stuManual()).toBe(1);
  });

  it('⑤ 표가 마지막을 지킨다 — 같은 request_key 두 줄은 들어가지 않는다', async () => {
    const key = randomUUID();
    await ds.query(
      `INSERT INTO pay (inv_id, student_id, amount, paid_on, request_key) VALUES (NULL, $1, 1000, '2026-09-21', $2)`, [STU, key],
    );
    await expect(ds.query(
      `INSERT INTO pay (inv_id, student_id, amount, paid_on, request_key) VALUES (NULL, $1, 1000, '2026-09-21', $2)`, [STU, key],
    )).rejects.toMatchObject({ code: '23505' });
    // 키가 없는 옛 모양의 줄은 몇이든 들어간다 — 옛 행은 NULL 이다
    await ds.query(`INSERT INTO pay (inv_id, student_id, amount, paid_on) VALUES (NULL, $1, 1000, '2026-09-21')`, [STU]);
    await ds.query(`INSERT INTO pay (inv_id, student_id, amount, paid_on) VALUES (NULL, $1, 1000, '2026-09-21')`, [STU]);
    expect(await stuManual()).toBe(3);
  });

  describe('컨설팅 수납(§28 · cons_pay)', () => {
    beforeEach(async () => {
      await ds.query(`DELETE FROM cons_event WHERE cons_id = $1`, [CONS]);
      await ds.query(`DELETE FROM cons_pay WHERE cons_id = $1`, [CONS]);
      await ds.query(`DELETE FROM cons_stu WHERE cons_id = $1`, [CONS]);
      await ds.query(`DELETE FROM cons WHERE id = $1`, [CONS]);
      await ds.query(
        `INSERT INTO cons (id, cons_type, stage, contract_step, amount, sessions, owner_id, share)
         VALUES ($1, 'essay', 'running', 5, 900000, 6, $2, 'all')`, [CONS, ACTOR],
      );
      await ds.query(`INSERT INTO cons_stu (cons_id, student_id) VALUES ($1, $2)`, [CONS, STU]);
    });

    it('① 같은 키 · 같은 금액은 한 줄 — 동시에 와도 · ② 다른 금액은 409 · ⑤ 부분 유니크', async () => {
      const key = randomUUID();
      const body = { amount: 300000, paidOn: todayKst(), memo: '잔금', requestKey: key };
      const results = await Promise.allSettled([
        cons().addPayment(ACTOR, true, true, CONS, { ...body }),
        cons().addPayment(ACTOR, true, true, CONS, { ...body }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await consPays()).toBe(1);

      const err = await cons().addPayment(ACTOR, true, true, CONS, { ...body, amount: 200000 }).then(() => null, (e: unknown) => e);
      expect(codeOf(err)).toBe('PAY_REQUEST_KEY_REUSED');
      expect(await consPays()).toBe(1);

      await cons().addPayment(ACTOR, true, true, CONS, { ...body, requestKey: randomUUID() });
      expect(await consPays()).toBe(2);

      await expect(ds.query(
        `INSERT INTO cons_pay (cons_id, amount, paid_on, by_id, request_key) VALUES ($1, 1, CURRENT_DATE, $2, $3)`, [CONS, ACTOR, key],
      )).rejects.toMatchObject({ code: '23505' });
    });
  });
});
