/** @file-guide
 * 목적: invoice-board-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §52 회계 트래킹 보드 — C69 (대표 결정 2026-09-13 · N-28).
 *
 * 「**단일 진실원과 자동 전이에 유리하게**」. 그래서 증명하는 것은 **칸이 한 값으로만 갈린다**는 것이다 —
 *   ① 칸은 `inv.state` 하나로 갈린다. 「50% 냄」도 「연체」도 칸을 바꾸지 않는다.
 *   ② 전이는 자동이다 — 입금을 넣으면 카드가 **저절로** 다음 칸으로 간다.
 *   ③ 칸은 비어도 선다 — 칸은 어휘이지 데이터가 아니다.
 *   ④ 건수·합계는 서버가 센다 (D-R37).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Inv } from '../src/entities';
import { INV_BOARD_COLUMNS, invBoardColumn } from '../src/modules/accounting/accounting.dto';
import { AccountingService } from '../src/modules/accounting/accounting.service';
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

d('§52 회계 트래킹 보드 (C69)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let stuId = 0;
  const svc = () => new AccountingService(q.manager.getRepository(Inv));
  const board = async (canSee = true) => (await svc().invoiceBoard(canSee)).columns;
  const colOf = async (invId: number) =>
    (await board()).find((c) => c.cards.some((x) => x.invId === invId))?.key ?? null;

  const inv = async (state: string, amount = 100_000, paid = 0, dueDays: number | null = null) => {
    const [r] = (await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, paid_amount, state, due_on)
       VALUES ($1, '2026-08', 'tuition', '8월 수업료', $2, $3, $4::inv_state_t,
               CASE WHEN $5::int IS NULL THEN NULL
                    ELSE (now() AT TIME ZONE 'Asia/Seoul')::date + $5::int END)
       RETURNING id`,
      [stuId, amount, paid, state, dueDays],
    )) as Array<{ id: string }>;
    return Number(r.id);
  };

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM pay`);
    await q.query(`DELETE FROM inv_line`);
    await q.query(`DELETE FROM inv`);
    const [stu] = (await q.query(`INSERT INTO stu (name, grade) VALUES ('보드 학생','G9') RETURNING id`)) as Array<{ id: string }>;
    stuId = Number(stu.id);
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES (92,'보드 담당','bd92@t.kr','ceo') ON CONFLICT (id) DO NOTHING`,
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  /* ── ① 한 값으로만 갈린다 ───────────────────────────────────────── */

  it('칸은 **`inv.state` 하나**로 갈린다 — 다섯 상태가 각자 한 칸에만 든다', async () => {
    const ids = {
      draft: await inv('draft'), unpaid: await inv('unpaid'), sent: await inv('sent'),
      partial: await inv('partial', 100_000, 50_000), paid: await inv('paid', 100_000, 100_000),
    };
    expect(await colOf(ids.draft)).toBe('draft');
    expect(await colOf(ids.unpaid)).toBe('draft');   // 「발행했지만 아직 안 보냄」 — ② 는 「보냈습니다」다
    expect(await colOf(ids.sent)).toBe('sent');
    expect(await colOf(ids.paid)).toBe('paid');
    expect(await colOf(ids.partial)).toBe('record');
    // 한 청구서가 두 칸에 동시에 서지 않는다
    const all = (await board()).flatMap((c) => c.cards.map((x) => x.invId));
    expect(new Set(all).size).toBe(all.length);
  });

  it('「50% 냄」은 **칸을 바꾸지 않는다** — 카드에 적히는 값이다 (컷 §52 ④ 의 고은설)', async () => {
    const id = await inv('partial', 2_200_000, 1_100_000);
    const card = (await board()).find((c) => c.key === 'record')!.cards.find((x) => x.invId === id)!;
    expect(card.paidPercent).toBe(50);
    // 같은 비율이어도 완납이면 다른 칸이다 — 비율이 아니라 상태가 칸을 정한다
    expect(await colOf(await inv('paid', 2_200_000, 2_200_000))).toBe('paid');
  });

  it('「연체」도 **칸을 바꾸지 않는다** — 기한이 지나도 상태가 그대로면 그 칸이다 (컷 §52 ④ 의 양찬욱)', async () => {
    const late = await inv('partial', 800_000, 400_000, -7);
    expect(await colOf(late)).toBe('record');
    const card = (await board()).find((c) => c.key === 'record')!.cards.find((x) => x.invId === late)!;
    expect(card.overdueDays).toBe(7);
    expect(card.whenLabel).toBe('7일 지남');
  });

  it('기한이 지났는데 **연체가 아닌 것**은 「D--23」 이 아니라 기한을 적는다', async () => {
    // 완납이라 받을 돈이 없다 — 연체가 아니고, 남은 날도 없다
    const done = await inv('paid', 560_000, 560_000, -23);
    const card = (await board()).find((c) => c.key === 'paid')!.cards.find((x) => x.invId === done)!;
    expect(card.overdueDays).toBe(0);
    expect(card.whenLabel).not.toContain('D--');
    expect(card.whenLabel.startsWith('기한 ')).toBe(true);
  });

  it('연체는 **아직 받을 돈이 있는 건**에만 붙는다 — 초안과 완납은 연체가 아니다', async () => {
    const draft = await inv('draft', 100_000, 0, -5);      // 아직 청구한 것이 아니다
    const done = await inv('paid', 100_000, 100_000, -5);  // 받을 돈이 없다
    const owed = await inv('sent', 100_000, 0, -5);        // 이것만 연체다
    const cards = (await board()).flatMap((c) => c.cards);
    const dayOf = (id: number) => cards.find((x) => x.invId === id)!.overdueDays;
    expect(dayOf(draft)).toBe(0);
    expect(dayOf(done)).toBe(0);
    expect(dayOf(owed)).toBe(5);
  });

  it('취소(void)는 **어느 칸에도 안 든다** — 청구가 아니다', async () => {
    const id = await inv('void');
    expect(await colOf(id)).toBeNull();
    expect(invBoardColumn('void')).toBeNull();
  });

  /* ── ② 전이는 자동이다 ──────────────────────────────────────────── */

  it('입금을 넣으면 카드가 **저절로** 다음 칸으로 간다 — 화면이 옮기지 않는다', async () => {
    const id = await inv('sent', 100_000, 0);
    expect(await colOf(id)).toBe('sent');

    await svc().addPayment(92, { invId: id, amount: 40_000, paidOn: '2026-08-20' }, true);
    expect(await colOf(id)).toBe('record');   // 일부 납부

    await svc().addPayment(92, { invId: id, amount: 60_000, paidOn: '2026-08-21' }, true);
    expect(await colOf(id)).toBe('paid');     // 완납
  });

  /* ── ③ 칸은 어휘다 ─────────────────────────────────────────────── */

  it('청구서가 하나도 없어도 **칸 넷이 선다** — 칸은 어휘이지 데이터가 아니다', async () => {
    const cols = await board();
    expect(cols.map((c) => c.key)).toEqual(INV_BOARD_COLUMNS.map((c) => c.key));
    expect(cols.every((c) => c.count === 0 && c.cards.length === 0)).toBe(true);
    // 이름과 한 줄 설명은 컷의 낱말이다
    expect(cols.map((c) => c.label)).toEqual(['청구서 작성', '청구서 전달', '입금 완료', '입금 기록']);
    expect(cols[1].sub).toBe('보냈습니다 · 입금을 기다립니다');
  });

  /* ── ④ 세는 것도 서버다 ────────────────────────────────────────── */

  it('건수와 합계는 **서버가 센다** — 화면이 카드를 더하지 않는다 (D-R37)', async () => {
    await inv('sent', 4_800_000);
    await inv('sent', 600_000);
    const col = (await board()).find((c) => c.key === 'sent')!;
    expect(col.count).toBe(2);
    expect(col.amount).toBe(5_400_000);
    expect(col.amount).toBe(col.cards.reduce((n, x) => n + (x.amount ?? 0), 0));
  });

  it('금액을 못 보면 **비율도 안 준다** — 비율과 받은 돈이 있으면 청구액이 복원된다 (D-R39)', async () => {
    await inv('partial', 100_000, 50_000);
    const cols = await board(false);
    const card = cols.find((c) => c.key === 'record')!.cards[0];
    expect(card.amount).toBeNull();
    expect(card.paid).toBeNull();
    expect(card.paidPercent).toBeNull();
    expect(cols.find((c) => c.key === 'record')!.amount).toBeNull();
    // 세는 것은 금액과 무관하다
    expect(cols.find((c) => c.key === 'record')!.count).toBe(1);
  });

  it('낱말은 전부 서버가 만든다 — 화면이 코드값을 찍지 않는다 (D-R18)', async () => {
    const id = await inv('partial', 100_000, 50_000, 3);
    const card = (await board()).find((c) => c.key === 'record')!.cards.find((x) => x.invId === id)!;
    expect(card.stateLabel).toBe('일부 납부');
    expect(card.invTypeLabel).toBe('수업료 청구');
    expect(card.whenLabel).toBe('D-3');
  });
});
