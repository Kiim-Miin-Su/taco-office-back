/** @file-guide
 * 목적: consulting-accounting-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §28 컨설팅 회계 — C58.
 *
 * 증명하는 것 다섯 —
 *   ① **남은 돈과 머리 세 칸을 서버가 만든다** (D-R37). 화면이 계약 − 받음을 다시 하지 않는다.
 *   ② **「수납만 공개여도 금액은 보인다」** — 원문 §28 규칙. 새 판정이 아니라 csCanAmount 그대로다.
 *   ③ **금액이 가려지면 납부 기록 줄도 안 내려간다** — 줄을 세면 금액이 드러난다.
 *   ④ **청구서는 남은 돈으로 낸다** — 계약 전액으로 내면 받은 돈이 미수금에 한 번 더 얹힌다.
 *   ⑤ **한 컨설팅에 살아 있는 청구서는 하나다** — 두 번 눌러도 하나.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { ConsultingService } from '../src/modules/consulting/consulting.service';
import { todayKst } from '../src/lib/kst';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions, url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

const day = (n: number): string => {
  const t = new Date(`${todayKst()}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

const OWNER = 61;   // 건의 담당자
const OTHER = 62;   // 남 — 권한만으로는 지정 공개 건을 못 본다
const STU_A = 71;
const STU_B = 72;

/** 계약 5단계 · 진행 · 전체 공개 · 900,000 원 — 원문 컷의 표본과 같은 모양 */
const OPEN = 91;
/** 수납만 공개 — §28 규칙 ②가 걸리는 자리 */
const PAY_ONLY = 92;
/** 계약 1단계 — 아직 수납 전이라 전환할 수 없다 */
const EARLY = 93;
/** 지정 공개 — OTHER 에게는 목록에서조차 없다 */
const PICKED = 94;
/** 학생 둘 — 청구서를 누구 앞으로 낼지 원문에 없다 */
const TWO_STU = 95;

d('§28 컨설팅 회계 (C58)', () => {
  let ds: DataSource;
  let q: QueryRunner;

  const svc = () => new ConsultingService(q.manager.getRepository(Lead));
  /** 대표 시점 — 금액 보임 · 비공개도 보임 */
  const asBoss = () => svc().accounting(OWNER, true, true);

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM inv WHERE cs_id IS NOT NULL`);
    await q.query(`DELETE FROM cons_pay`);
    await q.query(`DELETE FROM cons_stu`);
    await q.query(`DELETE FROM cons_pick`);
    await q.query(`DELETE FROM cons_item`);
    await q.query(`DELETE FROM cons_sess`);
    await q.query(`DELETE FROM cons`);
    await q.query(
      `INSERT INTO staff (id,name,email,role,title) VALUES
         (${OWNER},'담당','cs-own@t.kr','manager','매니저'),
         (${OTHER},'남','cs-oth@t.kr','manager','매니저')
       ON CONFLICT (id) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO stu (id,name) VALUES (${STU_A},'민제인'),(${STU_B},'고은성')
       ON CONFLICT (id) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO cons (id, cons_type, stage, contract_step, amount, sessions, owner_id, share) VALUES
         (${OPEN},    'essay',      'running',  5, 900000, 6, ${OWNER}, 'all'),
         (${PAY_ONLY},'admissions', 'running',  5, 800000, 8, ${OWNER}, 'money_only'),
         (${EARLY},   'roadmap',    'contract', 1, 500000, 4, ${OWNER}, 'all'),
         (${PICKED},  'essay',      'running',  5, 300000, 3, ${OWNER}, 'picked'),
         (${TWO_STU}, 'admissions', 'running',  5, 700000, 5, ${OWNER}, 'all')`,
    );
    await q.query(
      `INSERT INTO cons_stu (cons_id, student_id) VALUES
         (${OPEN},${STU_A}), (${PAY_ONLY},${STU_B}), (${EARLY},${STU_A}),
         (${PICKED},${STU_A}), (${TWO_STU},${STU_A}), (${TWO_STU},${STU_B})`,
    );
    await q.query(
      `INSERT INTO cons_pay (cons_id, amount, paid_on, memo, by_id) VALUES
         (${PAY_ONLY}, 400000, $1::date, '계약금', ${OWNER})`,
      [day(-3)],
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const row = async (id: number) => {
    const { items } = await asBoss();
    return items.find((x) => x.id === id)!;
  };

  /* ── ① 뺄셈은 서버가 한다 ─────────────────────────────────────────── */

  it('남은 돈을 서버가 뺀다 — 화면이 계약 − 받음을 다시 하지 않는다 (D-R37)', async () => {
    const paid = await row(PAY_ONLY);
    expect(paid.amount).toBe(800000);
    expect(paid.paid).toBe(400000);
    expect(paid.due).toBe(400000);

    const none = await row(OPEN);
    expect(none.paid).toBe(0);
    expect(none.due).toBe(900000);
  });

  it('머리 세 칸도 서버가 만든다 — 줄의 합과 갈리지 않는다', async () => {
    const v = await asBoss();
    const sum = (k: 'amount' | 'paid' | 'due') =>
      v.items.reduce((n, x) => n + (x[k] ?? 0), 0);
    expect(v.totalAmount).toBe(sum('amount'));
    expect(v.totalPaid).toBe(sum('paid'));
    expect(v.totalDue).toBe(sum('due'));
    expect(v.totalDue).toBe(v.totalAmount! - v.totalPaid!);
  });

  it('단계 이름을 서버가 만든다 — 코드값이 화면으로 새지 않는다 (D-R18)', async () => {
    expect((await row(OPEN)).stageLabel).toBe('진행');
    expect((await row(EARLY)).stageLabel).toBe('계약');
  });

  /* ── ② · ③ 공개 범위 두 층 ────────────────────────────────────────── */

  it("「수납만 공개(vis='pay')여도 이 화면의 금액은 보입니다」 — 원문 §28 규칙", async () => {
    // 담당자도 아니고 지정도 아닌 사람이, 금액 권한만으로 본다
    const { items } = await svc().accounting(OTHER, true, false);
    const hit = items.find((x) => x.id === PAY_ONLY)!;
    expect(hit.amount).toBe(800000);
    expect(hit.paid).toBe(400000);
    expect(hit.due).toBe(400000);
  });

  it('금액 권한이 없으면 금액도 납부 기록도 안 내려간다 — 줄을 세면 금액이 드러난다', async () => {
    const { items, canSeeAmounts, totalDue } = await svc().accounting(OWNER, false, false);
    const hit = items.find((x) => x.id === PAY_ONLY)!;
    expect(canSeeAmounts).toBe(false);
    expect(totalDue).toBeNull();
    expect(hit.amount).toBeNull();
    expect(hit.due).toBeNull();
    expect(hit.payments).toEqual([]);
    expect(hit.canInvoice).toBe(false);
  });

  it('지정 공개 건은 지정받지 않은 사람의 표에 줄조차 없다 — 존재를 누출하지 않는다', async () => {
    const { items } = await svc().accounting(OTHER, true, false);
    expect(items.some((x) => x.id === PICKED)).toBe(false);
    // 지정해 주면 그때 보인다
    await q.query(`INSERT INTO cons_pick (cons_id, staff_id) VALUES (${PICKED}, ${OTHER})`);
    const after = await svc().accounting(OTHER, true, false);
    expect(after.items.some((x) => x.id === PICKED)).toBe(true);
  });

  /* ── 납부 넣기 ────────────────────────────────────────────────────── */

  it('납부를 넣으면 받음이 늘고 남음이 줄어든다 — 받은 합은 저장하지 않는다', async () => {
    const after = await svc().addPayment(OWNER, true, true, OPEN, { amount: 300000, paidOn: day(-1) });
    expect(after.paid).toBe(300000);
    expect(after.due).toBe(600000);
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0]).toMatchObject({ amount: 300000, paidOn: day(-1), byName: '담당' });

    // 원장만 남는다 — cons 에 받은 합을 적는 칸은 없다
    const [{ n }] = (await q.query(
      `SELECT count(*)::int AS n FROM cons_pay WHERE cons_id = ${OPEN}`,
    )) as Array<{ n: number }>;
    expect(n).toBe(1);
  });

  it('납부일이 오늘보다 뒤면 막는다 — 아직 안 받은 돈이다', async () => {
    await expect(svc().addPayment(OWNER, true, true, OPEN, { amount: 1, paidOn: day(1) }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('종료된 건에는 납부를 더하지 못한다', async () => {
    await q.query(`UPDATE cons SET stage = 'done' WHERE id = ${OPEN}`);
    await expect(svc().addPayment(OWNER, true, true, OPEN, { amount: 1000, paidOn: day(0) }))
      .rejects.toMatchObject({ response: { code: 'CONS_PAY_LOCKED' } });
  });

  it('금액이 공개 범위 밖이면 납부를 못 넣는다 — 보이지 않는 건은 404 로 끝낸다', async () => {
    await expect(svc().addPayment(OWNER, false, false, OPEN, { amount: 1000, paidOn: day(0) }))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc().addPayment(OTHER, true, false, PICKED, { amount: 1000, paidOn: day(0) }))
      .rejects.toMatchObject({ status: 404 });
  });

  /* ── ④ · ⑤ 청구서로 전환 ─────────────────────────────────────────── */

  it('청구서는 **남은 돈**으로 낸다 — 받은 돈이 미수금에 한 번 더 얹히지 않는다', async () => {
    const after = await svc().toInvoice(OWNER, true, true, PAY_ONLY);
    expect(after.invId).not.toBeNull();
    const [inv] = (await q.query(
      `SELECT amount, inv_type, state, cs_id, student_id FROM inv WHERE id = $1`, [after.invId],
    )) as Array<Record<string, unknown>>;
    expect(Number(inv.amount)).toBe(400000);          // 800,000 − 400,000
    expect(inv.inv_type).toBe('consulting');
    expect(inv.state).toBe('draft');
    expect(Number(inv.cs_id)).toBe(PAY_ONLY);
    expect(Number(inv.student_id)).toBe(STU_B);
  });

  it('전환해도 납부 기록은 그대로 남는다 — cs_id 는 연결이지 소유가 아니다', async () => {
    const after = await svc().toInvoice(OWNER, true, true, PAY_ONLY);
    expect(after.payments).toHaveLength(1);
    expect(after.paid).toBe(400000);
    expect(after.due).toBe(400000);
  });

  it('두 번 눌러도 청구서는 하나다', async () => {
    await svc().toInvoice(OWNER, true, true, PAY_ONLY);
    await expect(svc().toInvoice(OWNER, true, true, PAY_ONLY))
      .rejects.toMatchObject({ response: { code: 'CONS_INV_EXISTS' } });
    const [{ n }] = (await q.query(
      `SELECT count(*)::int AS n FROM inv WHERE cs_id = ${PAY_ONLY}`,
    )) as Array<{ n: number }>;
    expect(n).toBe(1);
  });

  it('전환한 건은 「청구서로 전환」이 더는 눌리지 않는다', async () => {
    expect((await row(PAY_ONLY)).canInvoice).toBe(true);
    await svc().toInvoice(OWNER, true, true, PAY_ONLY);
    expect((await row(PAY_ONLY)).canInvoice).toBe(false);
  });

  it('계약 5단계(수납) 전에는 전환하지 않는다 — 원문 「수납 시 청구서 생성 가능」', async () => {
    expect((await row(EARLY)).canInvoice).toBe(false);
    await expect(svc().toInvoice(OWNER, true, true, EARLY))
      .rejects.toMatchObject({ response: { code: 'CONS_INV_NOT_PAID_STEP' } });
  });

  it('남은 돈이 없으면 낼 청구서도 없다 — 0 원 청구서를 만들지 않는다', async () => {
    await svc().addPayment(OWNER, true, true, OPEN, { amount: 900000, paidOn: day(0) });
    expect((await row(OPEN)).due).toBe(0);
    expect((await row(OPEN)).canInvoice).toBe(false);
    await expect(svc().toInvoice(OWNER, true, true, OPEN))
      .rejects.toMatchObject({ response: { code: 'CONS_INV_NOTHING_DUE' } });
  });

  it('학생이 둘이면 전환하지 않는다 — 누구 앞으로 낼지는 원문에 없다 (N-33)', async () => {
    await expect(svc().toInvoice(OWNER, true, true, TWO_STU))
      .rejects.toMatchObject({ response: { code: 'CONS_INV_STUDENT_AMBIGUOUS' } });
  });

  it('취소한 청구서는 다시 전환할 수 있다 — void 는 살아 있는 청구서가 아니다', async () => {
    const first = await svc().toInvoice(OWNER, true, true, PAY_ONLY);
    await q.query(`UPDATE inv SET state = 'void' WHERE id = $1`, [first.invId]);
    expect((await row(PAY_ONLY)).canInvoice).toBe(true);
    const again = await svc().toInvoice(OWNER, true, true, PAY_ONLY);
    expect(again.invId).not.toBe(first.invId);
  });
});
