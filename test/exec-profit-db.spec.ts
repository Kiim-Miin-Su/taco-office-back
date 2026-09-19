/** @file-guide
 * 목적: exec-profit-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §71 손익 — 「매출(입금) − **강사료** − 지출 = 이익」 (원본 §71 컷 · 테스트 시나리오 H-86).
 *
 * 강사료 칸이 없어 **이익이 인건비만큼 부풀어** 있었다. 여기서 못 박는 것은 넷이다:
 * ① 식이 실제로 셋을 뺀다 ② **확정된 정산만** 센다(지출과 같은 규약) ③ 기간에 **온전히 들어오는 달**만
 * 센다 ④ 이익률은 **수입**으로 나누고 수입이 0 이면 없다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { BoardService } from '../src/modules/board/board.service';
import { ExecService } from '../src/modules/exec/exec.service';
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

d('§71 손익 — 매출 − 강사료 − 지출 (H-86)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let svc: ExecService;
  let staffId = 0;

  const stat = (rows: Array<{ key: string; value?: number | null }>, key: string) =>
    rows.find((s) => s.key === key)?.value ?? null;
  const aug = () => svc.range('2026-08-01', '2026-08-31', true);

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM pay`);
    await q.query(`DELETE FROM expense`);
    await q.query(`DELETE FROM payout`);
    const made = await q.query(
      `INSERT INTO staff (name, role, email, active, tz)
       VALUES ('손익강사','teacher','profit-qa@tnacademy.kr',true,'Asia/Seoul') RETURNING id`,
    ) as Array<{ id: string }>;
    staffId = Number(made[0].id);
    svc = new ExecService(q.manager.getRepository(Lead), new BoardService(q.manager.getRepository(Lead)));
    // 서비스가 이 트랜잭션의 러너를 쓰도록 바꿔 끼운다 — 다른 DB 스위트와 같은 방식이다
    (svc as unknown as { lead: { manager: unknown } }).lead = q.manager.getRepository(Lead);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    await q?.release();
  });
  afterAll(async () => { await ds?.destroy(); });

  const payout = (yearMonth: string, gross: number, lateCut: number, confirmed: boolean) => q.query(
    `INSERT INTO payout (staff_id, year_month, hours, gross, late_rep_cut, late_cls_cut, income_tax, local_tax, net, state, confirmed_by, confirmed_at)
     VALUES ($1,$2,10,$3,$4,0,0,0,$5,$6,$7,$8)`,
    [staffId, yearMonth, gross, lateCut, gross - lateCut, confirmed ? 'approved' : 'draft',
      confirmed ? 1 : null, confirmed ? '2026-09-01T00:00:00Z' : null],
  );
  const expense = (on: string, amount: number) => q.query(
    `INSERT INTO expense (spend_on, category, merchant, purpose, requested_amount, amount, state, requester_id)
     VALUES ($1,'supply','QA','QA 지출',$2,$2,'approved',1)`, [on, amount],
  );

  it('이익은 매출에서 강사료와 지출을 **둘 다** 뺀다 — 이익률은 매출로 나눈다', async () => {
    await q.query(`INSERT INTO pay (inv_id, amount, paid_on, method) VALUES (NULL, 1000000, '2026-08-10', 'transfer')`);
    await payout('2026-08', 400000, 0, true);
    await expense('2026-08-12', 100000);
    const s = (await aug()).stats;
    expect(stat(s, 'revenue')).toBe(1000000);
    expect(stat(s, 'payout')).toBe(400000);
    expect(stat(s, 'expense')).toBe(100000);
    expect(stat(s, 'profit')).toBe(500000);
    expect(stat(s, 'margin')).toBe(50);
  });

  it('지각 차감은 학원이 안 내보낸 돈이라 강사료에서 빠진다 — 원천징수는 빼지 않는다', async () => {
    await payout('2026-08', 500000, 30000, true);
    const s = (await aug()).stats;
    expect(stat(s, 'payout')).toBe(470000);
  });

  it('**작성 중인 정산은 나간 돈이 아니다** — 지출과 같은 규약이다', async () => {
    await payout('2026-08', 900000, 0, false);
    const s = (await aug()).stats;
    expect(stat(s, 'payout')).toBe(0);
  });

  it('기간에 **온전히 들어오는 달**만 센다 — 반 달을 반으로 쪼개 얹지 않는다', async () => {
    await payout('2026-08', 800000, 0, true);
    const half = (await svc.range('2026-08-01', '2026-08-15', true)).stats;
    expect(stat(half, 'payout')).toBe(0);
    const whole = (await aug()).stats;
    expect(stat(whole, 'payout')).toBe(800000);
  });

  it('매출이 0 이면 이익률은 없다 — 0% 라 적으면 본전으로 읽힌다', async () => {
    await expense('2026-08-12', 100000);
    const s = (await aug()).stats;
    expect(stat(s, 'profit')).toBe(-100000);
    expect(stat(s, 'margin')).toBeNull();
  });

  it('금액을 못 보는 사람에게는 강사료도 이익률도 null 이다 (D-R39)', async () => {
    await payout('2026-08', 800000, 0, true);
    const s = (await svc.range('2026-08-01', '2026-08-31', false)).stats;
    expect(stat(s, 'payout')).toBeNull();
    expect(stat(s, 'profit')).toBeNull();
    expect(stat(s, 'margin')).toBeNull();
  });
});
