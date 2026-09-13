/** @file-guide
 * 목적: pay-category-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §55 「들어온 돈」의 **분류 여섯** — C71 (대표 결정 2026-09-13 · N-37 ③).
 *
 * 「**Entity, DTO 의 정합성과 단일 진실원 해결**」. 그래서 증명하는 것은 **새 칸이 없다**는 것이다 —
 *   ① 여섯이 전부 `pay.inv_id` 와 `inv.inv_type` 과 줄의 종류에서 **읽혀 나온다**.
 *   ② 청구서가 없는 입금은 **「기타」**다 — 여섯 중 청구 종류로 설명되지 않는 유일한 하나.
 *   ③ 수업료 중 **GPA 수업에서 나온 것**이 「GPA 관리비」다.
 *   ④ 분류는 어휘라 **건수가 0이어도 칩이 선다.**
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Inv } from '../src/entities';
import { PAY_CATEGORIES, payCategory } from '../src/modules/accounting/accounting.dto';
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

d('§55 입금 분류 여섯 (C71)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let stuId = 0;
  const svc = () => new AccountingService(q.manager.getRepository(Inv));
  const all = async (canSee = true) => svc().all(canSee);
  const chip = async (key: string) => (await all()).payCategories.find((c) => c.key === key)!;

  /** 청구서 한 장 + 그 청구서로 들어온 입금 한 줄 */
  const paid = async (invType: string, subKey: string | null, amount = 100_000) => {
    const [inv] = (await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, paid_amount, state)
       VALUES ($1, '2026-08', $2, '표본', $3, $3, 'paid') RETURNING id`,
      [stuId, invType, amount],
    )) as Array<{ id: string }>;
    if (subKey) {
      await q.query(
        `INSERT INTO inv_line (inv_id, sub_key, label, count, unit_price, amount, seq)
         VALUES ($1, $2, '줄', 1, $3, $3, 0)`,
        [Number(inv.id), subKey, amount],
      );
    }
    await q.query(
      `INSERT INTO pay (inv_id, student_id, amount, paid_on) VALUES ($1, $2, $3, '2026-08-20')`,
      [Number(inv.id), stuId, amount],
    );
    return Number(inv.id);
  };

  /** 청구서 없이 들어온 돈 — 「매니저가 직접 넣은 건」 (A-D1) */
  const loosePay = async (amount = 30_000) => {
    await q.query(
      `INSERT INTO pay (inv_id, student_id, amount, paid_on) VALUES (NULL, $1, $2, '2026-08-21')`,
      [stuId, amount],
    );
  };

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM pay`);
    await q.query(`DELETE FROM inv_line`);
    await q.query(`DELETE FROM inv`);
    const [stu] = (await q.query(`INSERT INTO stu (name) VALUES ('분류 학생') RETURNING id`)) as Array<{ id: string }>;
    stuId = Number(stu.id);
    // GPA 수업 과목과 보통 수업 과목
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp) VALUES ('gpa','GPA','#111111',4,'lesson')
       ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO sub (key,name,color) VALUES ('pc-gpa','GPA 관리','#222222') ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp) VALUES ('pc_les','보통 수업','#333333',4,'lesson')
       ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO sub (key,name,color) VALUES ('pc-les','보통 과목','#444444') ON CONFLICT (key) DO NOTHING`,
    );
    // 과목이 어느 종류에 속하는지는 **단가표가 안다** — `sub` 에는 종류 칸이 없다
    await q.query(`DELETE FROM rate WHERE sub_key IN ('pc-gpa','pc-les')`);
    await q.query(
      `INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads)
       VALUES ('gpa','pc-gpa', 120000, '2026-01-01', 1), ('pc_les','pc-les', 80000, '2026-01-01', 1)`,
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  /* ── ① 여섯은 읽어서 만든다 ─────────────────────────────────────── */

  it('분류는 **저장된 칸이 아니라 읽은 값**이다 — `pay` 에 분류 칸이 없다', async () => {
    const [col] = (await q.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'pay' AND column_name IN ('category','kind','class')`,
    )) as Array<{ n: number }>;
    expect(col.n).toBe(0);
  });

  it('청구 종류 넷이 그대로 분류 넷이 된다', async () => {
    await paid('tuition', 'pc-les');
    await paid('consulting', null);
    await paid('diag_intake', null);
    await paid('exam_fee', null);
    const v = await all();
    const byCat = (k: string) => v.payments.filter((p) => p.category === k).length;
    expect(byCat('tuition')).toBe(1);
    expect(byCat('consulting')).toBe(1);
    expect(byCat('diag_intake')).toBe(1);
    expect(byCat('exam_fee')).toBe(1);
  });

  /* ── ② 기타 ─────────────────────────────────────────────────────── */

  it('**청구서 없이 들어온 돈은 「기타」**다 — 여섯 중 청구 종류로 설명되지 않는 하나', async () => {
    await loosePay();
    const v = await all();
    expect(v.payments[0].category).toBe('etc');
    expect(v.payments[0].categoryLabel).toBe('기타');
    expect((await chip('etc')).count).toBe(1);
  });

  /* ── ③ GPA 관리비 ───────────────────────────────────────────────── */

  it('수업료 중 **GPA 수업에서 나온 것**이 「GPA 관리비」다 — 청구 종류는 그대로 tuition 이다', async () => {
    await paid('tuition', 'pc-gpa', 120_000);
    await paid('tuition', 'pc-les', 80_000);
    const v = await all();
    expect(v.payments.map((p) => p.category).sort()).toEqual(['gpa', 'tuition']);
    expect((await chip('gpa')).amount).toBe(120_000);
    expect((await chip('tuition')).amount).toBe(80_000);
    // 청구 종류는 여전히 넷이다 — 분류는 다른 축이다
    const [{ n }] = (await q.query(`SELECT count(DISTINCT inv_type)::int AS n FROM inv`)) as Array<{ n: number }>;
    expect(n).toBe(1);
  });

  it('판정은 **한 함수뿐**이다 — 화면도 칩도 같은 답을 쓴다 (D-R39)', () => {
    expect(payCategory(null, false)).toBe('etc');
    expect(payCategory('tuition', true)).toBe('gpa');
    expect(payCategory('tuition', false)).toBe('tuition');
    expect(payCategory('consulting', false)).toBe('consulting');
    // 모르는 종류는 감추지 않고 「기타」로 — 새 종류가 생긴 것을 알아야 한다
    expect(payCategory('unknown_type', false)).toBe('etc');
  });

  /* ── ④ 어휘다 ───────────────────────────────────────────────────── */

  it('입금이 하나도 없어도 **칩 여섯이 선다** — 분류는 어휘이지 데이터가 아니다', async () => {
    const v = await all();
    expect(v.payCategories.map((c) => c.key)).toEqual(PAY_CATEGORIES.map((c) => c.key));
    expect(v.payCategories.map((c) => c.label)).toEqual([
      '수업료', 'GPA 관리비', '컨설팅비', '진단고사 · 상담', '시험 응시료', '기타',
    ]);
    expect(v.payCategories.every((c) => c.count === 0)).toBe(true);
  });

  it('칩의 건수 합은 입금 줄 수와 같다 — 어느 줄도 분류를 못 받지 않는다', async () => {
    await paid('tuition', 'pc-gpa');
    await paid('consulting', null);
    await loosePay();
    const v = await all();
    expect(v.payCategories.reduce((n, c) => n + c.count, 0)).toBe(v.payments.length);
  });

  /*
   * 이 읽기는 **한 과목이 한 종류에 속한다**는 것에 기댄다. 두 종류에 걸린 과목이 생기면
   * 「GPA 관리비인가」가 흔들린다 — 그날 여기가 빨개져야 한다.
   */
  it('한 과목이 **두 종류에 걸치지 않는다** — 걸치면 GPA 판정이 흔들린다', async () => {
    const rows = (await q.query(
      `SELECT sub_key FROM rate WHERE sub_key IS NOT NULL
        GROUP BY sub_key HAVING count(DISTINCT kind_key) > 1`,
    )) as Array<{ sub_key: string }>;
    expect(rows.map((r) => r.sub_key)).toEqual([]);
  });

  it('금액을 못 보면 칩의 금액도 안 준다 — 건수는 산다 (D-R39)', async () => {
    await paid('consulting', null);
    const v = await all(false);
    const c = v.payCategories.find((x) => x.key === 'consulting')!;
    expect(c.amount).toBeNull();
    expect(c.count).toBe(1);
  });
});
