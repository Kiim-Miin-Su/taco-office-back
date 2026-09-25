/** @file-guide
 * 목적: accounting-x5-db.spec.ts — 회계 잔여 물결(wave 5) — §53 청구 종류 칩 · §54 넘길 돈 줄 차례 · §57 줄 차례 (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 회계 §53·§54·§57 — 잔여 물결(wave 5 · x5).
 *
 * 증명하는 것 —
 *   ① §53 표 줄이 **청구 종류와 그 이름**을 들고 온다 — 보드 카드(`InvBoardCardDto`)와 같은 낱말 (53-02 · D-R18).
 *   ② §54 **넘길 돈이 있는 줄이 위로** 모이고, 화면이 그 줄을 칠할 수 있게 서버가 `carryPending` 을 준다 —
 *      금액을 못 봐도 판정은 온다(결강 수가 이미 보이므로 새로 드러나는 것이 없다) (54-02).
 *   ③ §57 줄 차례 = 진단고사 + 상담 비용 → 컨설팅비 → MAP + CAT (원문 컷 · 57-01).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Inv } from '../src/entities';
import { AccountingService } from '../src/modules/accounting/accounting.service';
import { INV_TYPE_LABEL } from '../src/modules/accounting/accounting.dto';
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

/** 지난 달 — 「이미 한 수업」이 확실한 날짜를 쓴다 (tuition-db 와 같은 까닭) */
const MONTH = '2026-05';

d('회계 잔여 물결 (x5)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const svc = () => new AccountingService(q.manager.getRepository(Inv));

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    for (const t of ['carry', 'pay', 'inv_line']) await q.query(`DELETE FROM ${t}`);
    await q.query(`DELETE FROM inv`);
    await q.query(`DELETE FROM ser_occ`);
    await q.query(`DELETE FROM ser_stu`);
    await q.query(`DELETE FROM ser`);
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp) VALUES ('x5_kind','x5 수업','#333333',4,'lesson') ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(`INSERT INTO sub (key,name,color) VALUES ('x5-sub','x5 과목','#444444') ON CONFLICT (key) DO NOTHING`);
    await q.query(`DELETE FROM rate WHERE kind_key = 'x5_kind'`);
    await q.query(
      `INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES ('x5_kind','x5-sub', 50000, '2026-01-01', 1)`,
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const student = async (name: string): Promise<number> => {
    const [s] = (await q.query(`INSERT INTO stu (name, grade) VALUES ($1,'G8') RETURNING id`, [name])) as Array<{ id: string }>;
    return Number(s.id);
  };
  /** 월요일 규칙 하나 + 그 달 회차 — `canceled` 인 날은 휴강(이월)이라 넘길 돈이 된다 */
  const lessonFor = async (stuId: number, days: Array<{ on: string; canceled?: boolean }>) => {
    const [se] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, title, mode, start_min, end_min, rrule, from_date)
       VALUES ('x5_kind','x5-sub','x5 수업','offline',540,600,'WEEKLY:MO','2026-01-01') RETURNING id`,
    )) as Array<{ id: string }>;
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1,$2)`, [Number(se.id), stuId]);
    for (const o of days) {
      await q.query(
        `INSERT INTO ser_occ (ser_id, on_date, canceled, span)
         VALUES ($1, $2::date, $3,
                 tstzrange(($2::date + time '09:00') AT TIME ZONE 'Asia/Seoul',
                           ($2::date + time '10:00') AT TIME ZONE 'Asia/Seoul', '[)'))`,
        [Number(se.id), o.on, o.canceled === true],
      );
    }
  };

  /* ── ① §53 청구 종류 ───────────────────────────────────────────── */

  it('§53 표 줄이 청구 종류와 그 이름을 들고 온다 — 보드 카드와 같은 낱말 (53-02)', async () => {
    const sid = await student('종류 학생');
    await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state) VALUES
         ($1,'2026-05','tuition','5월 수업료',100000,'draft'),
         ($1,'2026-05','consulting','컨설팅비',800000,'draft')`,
      [sid],
    );
    const { invoices } = await svc().all(true);
    const mine = invoices.filter((i) => i.studentId === sid);
    expect(mine.map((i) => [i.invType, i.invTypeLabel]).sort()).toEqual([
      ['consulting', INV_TYPE_LABEL.consulting],
      ['tuition', INV_TYPE_LABEL.tuition],
    ]);
    // 금액을 못 봐도 종류는 온다 — 종류는 돈이 아니다
    const hidden = (await svc().all(false)).invoices.find((i) => i.studentId === sid)!;
    expect(hidden.invTypeLabel).toBeTruthy();
    expect(hidden.amount).toBeNull();
  });

  /* ── ② §54 넘길 돈 줄 차례 ──────────────────────────────────────── */

  it('§54 넘길 돈이 있는 줄이 위로 모이고 `carryPending` 이 선다 — 이름순은 그 안에서 그대로 (54-02)', async () => {
    const a = await student('가 학생');   // 이름순 첫째 · 넘길 돈 없음
    const b = await student('나 학생');   // 넘길 돈 없음
    const c = await student('하 학생');   // 이름순 마지막 · 휴강 한 번 = 넘길 돈
    await lessonFor(a, [{ on: '2026-05-04' }, { on: '2026-05-11' }]);
    await lessonFor(b, [{ on: '2026-05-04' }]);
    await lessonFor(c, [{ on: '2026-05-04' }, { on: '2026-05-11', canceled: true }]);

    const v = await svc().tuition(MONTH, true);
    const order = v.items.filter((x) => [a, b, c].includes(x.studentId)).map((x) => x.studentId);
    expect(order).toEqual([c, a, b]);
    const by = Object.fromEntries(v.items.map((x) => [x.studentId, x]));
    expect(by[c]).toMatchObject({ carryPending: true, carryAmount: 50_000 });
    expect(by[a]).toMatchObject({ carryPending: false, carryAmount: 0 });

    // 금액을 못 봐도 차례와 판정은 같다 — 금액만 비운다 (D-R39)
    const hidden = await svc().tuition(MONTH, false);
    expect(hidden.items.filter((x) => [a, b, c].includes(x.studentId)).map((x) => x.studentId)).toEqual([c, a, b]);
    expect(hidden.items.find((x) => x.studentId === c)).toMatchObject({ carryPending: true, carryAmount: null });
  });

  /* ── ③ §57 줄 차례 ────────────────────────────────────────────── */

  it('§57 줄 차례는 원문 컷 그대로 — 진단고사 + 상담 비용 → 컨설팅비 → MAP + CAT (57-01)', async () => {
    const { rows } = await svc().otherIncome(true);
    expect(rows.map((r) => r.key)).toEqual(['diag_intake', 'consulting', 'exam_fee']);
    expect(rows.map((r) => r.label)).toEqual(['진단고사 + 상담 비용', '컨설팅비', 'MAP + CAT']);
  });
});
