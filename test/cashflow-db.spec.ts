/** @file-guide
 * 목적: cashflow-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §55 들어온 돈 — 기간 · 입금 달력 · 분류별 · 미수 전체 (w5 · g5 55-01 · 55-02 · 55-03 · 55-05).
 *
 * **원본 컷의 수를 그대로 다시 만든다** — 2026년 8월 · 오늘 08-21:
 *   「11건 · ₩5,287,300 청구 · ₩3,964,000 입금 · ₩1,323,300 예정」
 *   분류별: 수업료 1,053,300 0% · GPA 1,560,000 100% · 컨설팅 1,900,000 100% · 진단·상담 300,000 50% ·
 *           시험 응시료 210,000 43% · 기타 264,000 100%
 *   달력: 1일 840,000 · 2일 720,000 · 5일 1,100,000 · 6일 264,000 · 10일 90,000 · 12일 150,000 · 14일 800,000 ·
 *         22일 150,000(1) · 28일 120,000(1) · 31일 1,053,300(2)
 *   미수 전체(기간과 무관): 양찬욱 21일 연체 · 서지호 D-1 · 김태린 D-7 · … D-10
 * 이 수가 맞으면 「청구 = 입금 + 예정 · 예정 = 기한이 그 기간인 남은 돈」이라는 읽기가 컷과 같다는 증거다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Inv } from '../src/entities';
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

const TODAY = '2026-08-21';
const AUG = { from: '2026-08-01', to: '2026-08-31' };

d('§55 들어온 돈 — 기간 · 달력 · 분류별 · 미수 전체 (w5)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const svc = () => new AccountingService(q.manager.getRepository(Inv));

  const stu = async (name: string): Promise<number> => {
    const [r] = (await q.query(`INSERT INTO stu (name) VALUES ($1) RETURNING id`, [name])) as Array<{ id: string }>;
    return Number(r.id);
  };
  /** 청구서 한 장 — 상태는 받은 돈이 정한다(원장 규칙 그대로: 0 → sent · 일부 → partial · 전부 → paid) */
  const inv = async (studentId: number, invType: string, amount: number, paid: number, dueOn: string | null, gpa = false) => {
    const state = paid === 0 ? 'sent' : paid < amount ? 'partial' : 'paid';
    const [r] = (await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, paid_amount, state, due_on)
       VALUES ($1,'2026-08',$2,'표본',$3,$4,$5,$6::date) RETURNING id`,
      [studentId, invType, amount, paid, state, dueOn],
    )) as Array<{ id: string }>;
    if (gpa) {
      await q.query(
        `INSERT INTO inv_line (inv_id, sub_key, label, count, unit_price, amount, seq) VALUES ($1,'cf-gpa','GPA',1,$2,$2,0)`,
        [Number(r.id), amount],
      );
    }
    return Number(r.id);
  };
  const pay = (invId: number | null, studentId: number, amount: number, on: string) => q.query(
    `INSERT INTO pay (inv_id, student_id, amount, paid_on) VALUES ($1,$2,$3,$4::date)`, [invId, studentId, amount, on],
  );

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    for (const t of ['pay', 'inv_line', 'carry', 'inv']) await q.query(`DELETE FROM ${t}`);
    await q.query(`INSERT INTO kind (key,name,color,cap,grp) VALUES ('gpa','GPA','#111111',4,'lesson') ON CONFLICT (key) DO NOTHING`);
    await q.query(`INSERT INTO sub (key,name,color) VALUES ('cf-gpa','GPA 관리','#222222') ON CONFLICT (key) DO NOTHING`);
    await q.query(`DELETE FROM rate WHERE sub_key = 'cf-gpa'`);
    await q.query(`INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES ('gpa','cf-gpa',100000,'2026-01-01',1)`);

    // ── 원본 §55 컷의 8월 ──
    const a = await stu('강라율'); const b = await stu('이하린'); const c = await stu('고은성');
    const e = await stu('서지호'); const f = await stu('김태린'); const g = await stu('Laura Park'); const h = await stu('양찬욱');
    // GPA 관리비 2 — 1일 840,000 · 2일 720,000 (수업료 청구서인데 줄이 GPA 수업에서 왔다)
    await pay(await inv(a, 'tuition', 840_000, 840_000, '2026-08-05', true), a, 840_000, '2026-08-01');
    await pay(await inv(b, 'tuition', 720_000, 720_000, '2026-08-05', true), b, 720_000, '2026-08-02');
    // 컨설팅비 2 — 5일 1,100,000 · 14일 800,000
    await pay(await inv(c, 'consulting', 1_100_000, 1_100_000, null), c, 1_100_000, '2026-08-05');
    await pay(await inv(a, 'consulting', 800_000, 800_000, null), a, 800_000, '2026-08-14');
    // 기타 1 — 청구서 없이 들어온 돈 6일 264,000 (A-D1)
    await pay(null, b, 264_000, '2026-08-06');
    // 시험 응시료 2 — 10일 90,000 들어옴 · 남은 120,000 은 28일 기한(김태린 D-7)
    await pay(await inv(f, 'exam_fee', 210_000, 90_000, '2026-08-28'), f, 90_000, '2026-08-10');
    // 진단고사 · 상담 2 — 12일 150,000 들어옴 · 남은 150,000 은 22일 기한(서지호 D-1)
    await pay(await inv(e, 'diag_intake', 300_000, 150_000, '2026-08-22'), e, 150_000, '2026-08-12');
    // 수업료 2 — 31일 기한 두 장(고은성 413,300 · Laura Park 640,000), 아직 한 푼도 안 들어옴
    await inv(c, 'tuition', 413_300, 0, '2026-08-31');
    await inv(g, 'tuition', 640_000, 0, '2026-08-31');
    // 기간 밖 — 7월 31일 기한 양찬욱 1,170,000 (8월 요약에는 없고 미수 전체에만 선다)
    await inv(h, 'tuition', 1_170_000, 0, '2026-07-31');
    // 다 받은 청구서의 기한은 예정이 아니다 · 초안은 청구가 아니다
    await inv(g, 'tuition', 50_000, 50_000, '2026-08-20');
    await q.query(`INSERT INTO inv (student_id, year_month, inv_type, title, amount, paid_amount, state, due_on)
                   VALUES ($1,'2026-08','tuition','초안',99000,0,'draft','2026-08-25')`, [g]);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('원본 머리 「11건 · 5,287,300 청구 · 3,964,000 입금 · 1,323,300 예정」 — 청구 = 입금 + 예정 (55-01)', async () => {
    const v = await svc().cashflow(true, AUG, TODAY);
    expect(v).toMatchObject({
      from: AUG.from, to: AUG.to, label: '2026년 8월', dayCount: 31, category: null, today: TODAY,
      count: 11, billed: 5_287_300, paid: 3_964_000, expected: 1_323_300,
    });
  });

  it('입금 달력 — 날마다 합계와 **기한 칸의 숫자 배지**가 원본과 같다 (55-02)', async () => {
    const v = await svc().cashflow(true, AUG, TODAY);
    expect(v.days.map((x) => [x.date.slice(8), x.amount, x.expectedCount])).toEqual([
      ['01', 840_000, 0], ['02', 720_000, 0], ['05', 1_100_000, 0], ['06', 264_000, 0], ['10', 90_000, 0],
      ['12', 150_000, 0], ['14', 800_000, 0], ['22', 150_000, 1], ['28', 120_000, 1], ['31', 1_053_300, 2],
    ]);
    // 칸의 합이 머리의 청구다 — 두 곳이 따로 세지 않는다
    expect(v.days.reduce((n, x) => n + (x.amount ?? 0), 0)).toBe(v.billed);
  });

  it('분류별 — 여섯 칩의 건수·청구·받은 비율이 원본과 같다 (55-03 · 55-05)', async () => {
    const v = await svc().cashflow(true, AUG, TODAY);
    expect(v.categories.map((c) => [c.label, c.count, c.billed, c.rate])).toEqual([
      ['수업료', 2, 1_053_300, 0], ['GPA 관리비', 2, 1_560_000, 100], ['컨설팅비', 2, 1_900_000, 100],
      ['진단고사 · 상담', 2, 300_000, 50], ['시험 응시료', 2, 210_000, 43], ['기타', 1, 264_000, 100],
    ]);
  });

  it('분류 칩으로 좁히면 요약·달력만 좁혀지고 칩 건수는 그대로다 (55-05)', async () => {
    const v = await svc().cashflow(true, { ...AUG, category: 'exam_fee' }, TODAY);
    expect(v).toMatchObject({ category: 'exam_fee', count: 2, billed: 210_000, paid: 90_000, expected: 120_000 });
    expect(v.days.map((x) => x.date)).toEqual(['2026-08-10', '2026-08-28']);
    expect(v.categories.find((c) => c.key === 'tuition')!.count).toBe(2);
  });

  it('미수 전체는 기간과 무관하다 — 기한 이른 순 · 「21일 연체」·「D-1」·「D-7」 · 연체 분홍/7일 안 노랑', async () => {
    const v = await svc().cashflow(true, { from: '2026-09-01', to: '2026-09-30' }, TODAY);
    expect(v.count).toBe(0);
    expect(v.open.map((o) => [o.studentName, o.partLabel, o.amount, o.whenLabel, o.tone])).toEqual([
      ['양찬욱', '전액', 1_170_000, '21일 연체', 'danger'],
      ['서지호', '잔액', 150_000, 'D-1', 'warning'],
      ['김태린', '잔액', 120_000, 'D-7', 'warning'],
      ['고은성', '전액', 413_300, 'D-10', null],
      ['Laura Park', '전액', 640_000, 'D-10', null],
    ]);
  });

  it('금액 권한이 없으면 금액은 전부 null 이고 건수만 선다 — 서버가 안 내려보낸다 (D-R39)', async () => {
    const v = await svc().cashflow(false, AUG, TODAY);
    expect(v).toMatchObject({ canSeeAmounts: false, count: 11, billed: null, paid: null, expected: null });
    expect(v.days.every((x) => x.amount === null && x.paidAmount === null && x.expectedAmount === null)).toBe(true);
    expect(v.categories.every((c) => c.billed === null && c.paid === null && c.rate === null)).toBe(true);
    expect(v.open.every((o) => o.amount === null)).toBe(true);
  });

  it('기간 낱말은 서버가 만든다 · 끝이 시작보다 앞서면 409 BAD_RANGE', async () => {
    expect((await svc().cashflow(true, {}, TODAY)).label).toBe('전체');
    expect((await svc().cashflow(true, { from: TODAY, to: TODAY }, TODAY)).label).toBe('8월 21일');
    expect((await svc().cashflow(true, { from: '2026-08-17', to: '2026-08-23' }, TODAY)).label).toBe('08-17 ~ 08-23');
    // 전체면 기간 밖이 없다 — 8월 전부 + 7월 31일 기한(예정)까지
    expect((await svc().cashflow(true, {}, TODAY)).expected).toBe(1_323_300 + 1_170_000);
    await expect(svc().cashflow(true, { from: '2026-08-31', to: '2026-08-01' }, TODAY)).rejects.toMatchObject({ status: 409 });
  });
});
