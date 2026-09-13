/** @file-guide
 * 목적: other-income-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §57 그 밖의 수입 — C66.
 *
 * 증명하는 것 넷 —
 *   ① **줄 셋은 데이터가 0건이어도 선다** — 종류는 어휘이지 데이터가 아니다.
 *   ② **초안은 건수에서 빠지고 「청구 안 함」으로 센다** — §52 머리의 「보낸 청구서」와 같은 어휘다.
 *   ③ **수업료는 이 화면에 없다** — 「수업료가 아닌 돈」이 컷의 부제다.
 *   ④ **금액을 못 보면 금액만 가려지고 건수는 산다** — 세는 것은 금액과 무관하다 (D-R39).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Inv } from '../src/entities';
import { INV_TYPES_OTHER, INV_TYPE_ROW, INV_TYPE_SUB } from '../src/modules/accounting/accounting.dto';
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

d('§57 그 밖의 수입 (C66)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let stuId = 0;
  const svc = () => new AccountingService(q.manager.getRepository(Inv));
  const rows = async (canSee = true) => (await svc().otherIncome(canSee)).rows;
  const row = async (key: string, canSee = true) => (await rows(canSee)).find((r) => r.key === key)!;

  const inv = async (invType: string, amount: number, paid: number, state: string) => {
    const [r] = (await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, paid_amount, state)
       VALUES ($1, '2026-08', $2, $3, $4, $5, $6::inv_state_t) RETURNING id`,
      [stuId, invType, `${invType} 표본`, amount, paid, state],
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
    const [stu] = (await q.query(`INSERT INTO stu (name) VALUES ('그밖 학생') RETURNING id`)) as Array<{ id: string }>;
    stuId = Number(stu.id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  /* ── ① 어휘가 줄을 세운다 ────────────────────────────────────────── */

  it('청구서가 하나도 없어도 **줄 셋이 선다** — 종류는 어휘이지 데이터가 아니다', async () => {
    const all = await rows();
    expect(all.map((r) => r.key)).toEqual([...INV_TYPES_OTHER]);
    expect(all.every((r) => r.count === 0 && r.amount === 0 && r.items.length === 0)).toBe(true);
  });

  it('줄 제목과 부제는 **§57 컷의 낱말**이다 — 화면이 짓지 않는다 (D-R18)', async () => {
    for (const r of await rows()) {
      expect(r.label).toBe(INV_TYPE_ROW[r.key]);
      expect(r.sub).toBe(INV_TYPE_SUB[r.key]);
    }
    // 컷의 줄 제목은 §53 카드의 칩(「컨설팅비 청구」)과 다른 낱말이다
    expect((await row('consulting')).label).toBe('컨설팅비');
    expect((await row('exam_fee')).label).toBe('MAP + CAT');
  });

  /* ── ② 「청구 안 함」 ─────────────────────────────────────────────── */

  it('초안은 **건수에서 빠지고 「청구 안 함」으로 센다** — §52 머리와 같은 어휘', async () => {
    await inv('diag_intake', 150_000, 0, 'sent');
    await inv('diag_intake', 60_000, 60_000, 'paid');
    await inv('diag_intake', 90_000, 0, 'draft');
    await inv('diag_intake', 30_000, 0, 'draft');
    const r = await row('diag_intake');
    expect(r.count).toBe(2);
    expect(r.unbilled).toBe(2);
    // 금액에도 초안은 안 든다 — 「보낸 청구서」가 초안을 빼는 것과 같다
    expect(r.amount).toBe(210_000);
    expect(r.paid).toBe(60_000);
  });

  it('취소(void)는 **어디에도 안 든다** — 건수에도 「청구 안 함」에도 줄에도', async () => {
    await inv('consulting', 800_000, 0, 'void');
    await inv('consulting', 200_000, 0, 'sent');
    const r = await row('consulting');
    expect(r.count).toBe(1);
    expect(r.unbilled).toBe(0);
    expect(r.amount).toBe(200_000);
    expect(r.items).toHaveLength(1);
  });

  it('합계는 **줄의 합**이다 — 두 곳에서 더하지 않는다 (D-R37)', async () => {
    await inv('exam_fee', 30_000, 30_000, 'paid');
    await inv('exam_fee', 90_000, 45_000, 'partial');
    await inv('exam_fee', 60_000, 0, 'draft');
    const r = await row('exam_fee');
    const billed = r.items.filter((x) => !x.unbilled);
    expect(r.amount).toBe(billed.reduce((n, x) => n + (x.amount ?? 0), 0));
    expect(r.paid).toBe(billed.reduce((n, x) => n + (x.paid ?? 0), 0));
    expect(r.count).toBe(billed.length);
  });

  /* ── ③ 수업료는 없다 ────────────────────────────────────────────── */

  it('수업료는 이 화면에 **없다** — 컷의 부제가 「수업료가 아닌 돈」이다', async () => {
    await inv('tuition', 1_170_000, 0, 'sent');
    const all = await rows();
    expect(all.some((r) => r.key === 'tuition')).toBe(false);
    expect(all.every((r) => r.count === 0)).toBe(true);
  });

  /* ── ④ 낱말과 금액 권한 ─────────────────────────────────────────── */

  it('상태 낱말도 서버가 짓는다 — 화면이 코드값을 찍지 않는다 (D-R18)', async () => {
    await inv('consulting', 100_000, 50_000, 'partial');
    await inv('consulting', 100_000, 0, 'draft');
    const items = (await row('consulting')).items;
    expect(items.map((x) => x.stateLabel).sort()).toEqual(['일부 납부', '작성 중']);
    expect(items.filter((x) => x.unbilled)).toHaveLength(1);
  });

  it('금액을 못 보면 **금액만 가려지고 건수는 산다** (D-R39)', async () => {
    await inv('consulting', 800_000, 800_000, 'paid');
    await inv('consulting', 100_000, 0, 'draft');
    const v = await svc().otherIncome(false);
    const r = v.rows.find((x) => x.key === 'consulting')!;
    expect(v.canSeeAmounts).toBe(false);
    expect(r.amount).toBeNull();
    expect(r.paid).toBeNull();
    expect(r.items[0].amount).toBeNull();
    // 세는 것은 금액과 무관하다 — 0 으로 뭉개지 않는다
    expect(r.count).toBe(1);
    expect(r.unbilled).toBe(1);
    expect(r.items).toHaveLength(2);
  });
});
