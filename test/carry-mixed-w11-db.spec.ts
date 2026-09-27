/** @file-guide
 * 목적: carry-mixed-w11-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * W11 M2 잔여 ③ — 섞인 옛 수업료 청구서의 **이월**은 수강 종료와 같은 판정으로 멈춘다.
 *
 * N-75 전의 수업료 청구서는 진단고사 · 상담 회차도 수업료 줄로 청구했다. 지금 이월 계산(`invoiceLines` · 수업료)은 그 회차를
 * 수업료에서 빼므로, 그 달에 **못 해 준 진단고사 · 상담 회차**가 있으면 받은 돈 일부가 이월에서 **조용히 빠진다**.
 * 저장된 줄을 고쳐 읽지 않고 409 `CARRY_MIXED_INVOICE` 로 멈춘다(사람이 확인) — §54 단추(`carryBlockedReason`)도 같은 문장이다.
 * 섞였어도 못 해 준 그 회차가 없으면 넘길 돈이 같아 멈추지 않는다 · 새 방식 청구서(섞이지 않음)도 그대로다.
 *
 * 표를 비우지 않는다 — 한 트랜잭션 안에서 만들고 되돌린다(accounting-billing-w11-followup 과 같은 모양).
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

const MONTH = '2031-06';
const ACTOR = 9266;

d('섞인 옛 수업료 청구서의 이월 (W11 M2 잔여 ③ · 수강 종료와 같은 판정)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let stuId = 0;
  const svc = () => new AccountingService(q.manager.getRepository(Inv));

  const lesson = async (kind: string, sub: string, days: Array<{ on: string; canceled?: boolean }>, hour: number): Promise<number> => {
    const [se] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, title, mode, start_min, end_min, rrule, from_date)
       VALUES ($1, $2, '이월 섞임', 'offline', $3::int, $3::int + 60, 'WEEKLY:MO', '2031-01-01') RETURNING id`,
      [kind, sub, hour * 60],
    )) as Array<{ id: string }>;
    const serId = Number(se.id);
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1, $2)`, [serId, stuId]);
    for (const day of days) {
      await q.query(
        `INSERT INTO ser_occ (ser_id, on_date, canceled, span)
         VALUES ($1, $2::date, $4,
                 tstzrange(($2::date + make_time($3, 0, 0)) AT TIME ZONE 'Asia/Seoul',
                           ($2::date + make_time($3 + 1, 0, 0)) AT TIME ZONE 'Asia/Seoul', '[)'))`,
        [serId, day.on, hour, day.canceled ?? false],
      );
    }
    return serId;
  };
  /** 완납된 청구서를 **이미 나간 모양 그대로** — 줄은 저장된 것이 정본이다 */
  const paidInvoice = async (lines: Array<{ sub: string; label: string; n: number; unit: number }>): Promise<number> => {
    const amount = lines.reduce((s, l) => s + l.n * l.unit, 0);
    const [inv] = (await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, paid_amount, state, due_on, paid_at)
       VALUES ($1, $2, 'tuition', '6월 수업료', $3, $3, 'paid', '2031-06-30', now()) RETURNING id`,
      [stuId, MONTH, amount],
    )) as Array<{ id: string }>;
    for (const [i, l] of lines.entries()) {
      await q.query(
        `INSERT INTO inv_line (inv_id, sub_key, label, count, unit_price, amount, seq) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [Number(inv.id), l.sub, l.label, l.n, l.unit, l.n * l.unit, i],
      );
    }
    return Number(inv.id);
  };
  const CLASS_LINE = { sub: 'w11cm-sub', label: '섞임 과목', n: 2, unit: 50000 };
  const DIAG_LINE = { sub: 'w11cm-diag', label: '섞임 진단', n: 1, unit: 40000 };
  const rowOf = async () => (await svc().tuition(MONTH, true)).items.find((x) => x.studentId === stuId)!;

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES ($1,'섞임 대표','w11cm@t.kr','ceo') ON CONFLICT (id) DO NOTHING`, [ACTOR]);
    // 진단고사는 코드표의 진짜 키다 — 수업료에서 빼는 판정이 그 키를 본다(N-75)
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp) VALUES ('w11cm_class','섞임 수업','#333333',4,'lesson'), ('diagx','진단고사','#6F798A',8,'intake')
       ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(`INSERT INTO sub (key,name,color) VALUES ('w11cm-sub','섞임 과목','#444444'), ('w11cm-diag','섞임 진단','#555555') ON CONFLICT (key) DO NOTHING`);
    await q.query(`DELETE FROM rate WHERE sub_key IN ('w11cm-sub','w11cm-diag')`);
    await q.query(
      `INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES
         ('w11cm_class','w11cm-sub', 50000, '2031-01-01', 1), ('diagx','w11cm-diag', 40000, '2031-01-01', 1)`,
    );
    await q.query(`DELETE FROM month_close WHERE year_month IN ('2031-06','2031-07')`);
    const [stu] = (await q.query(`INSERT INTO stu (name, grade) VALUES ('섞임 학생','G9') RETURNING id`)) as Array<{ id: string }>;
    stuId = Number(stu.id);
    // 수업 둘(06-02 · 06-09 휴강 — 못 해 준 수업 하나 · 50,000)
    await lesson('w11cm_class', 'w11cm-sub', [{ on: '2031-06-02' }, { on: '2031-06-09', canceled: true }], 10);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('섞인 옛 청구서에 **못 해 준 진단고사 회차**가 있으면 멈춘다 — 단추와 쓰기가 같은 문장 · 줄도 감사도 남지 않는다', async () => {
    await lesson('diagx', 'w11cm-diag', [{ on: '2031-06-18', canceled: true }], 14);
    await paidInvoice([CLASS_LINE, DIAG_LINE]);
    const row = await rowOf();
    expect(row.carryable).toBe(false);
    expect(row.carryBlockedReason).toContain('2031-06 수업료 청구서에 진단고사 · 상담 회차가 함께 청구돼 있습니다');
    await expect(svc().carryTuition(ACTOR, { studentId: stuId, month: MONTH }))
      .rejects.toMatchObject({ status: 409, response: { code: 'CARRY_MIXED_INVOICE', message: row.carryBlockedReason } });
    expect(await q.query(`SELECT id FROM carry WHERE student_id = $1`, [stuId])).toEqual([]);
    expect(await q.query(`SELECT id FROM log WHERE entity = 'CARRY' AND actor_id = $1`, [ACTOR])).toEqual([]);
  });

  it('섞였어도 못 해 준 진단고사 회차가 **없으면** 넘길 돈이 같다 — 전과 같이 넘긴다(50,000 · 1회)', async () => {
    await lesson('diagx', 'w11cm-diag', [{ on: '2031-06-18' }], 14);
    await paidInvoice([CLASS_LINE, DIAG_LINE]);
    const row = await rowOf();
    expect(row).toMatchObject({ carryable: true, carryBlockedReason: null });
    const made = await svc().carryTuition(ACTOR, { studentId: stuId, month: MONTH });
    expect(made).toMatchObject({ amount: 50000, sessions: 1 });
  });

  it('새 방식(섞이지 않은) 수업료 청구서는 진단고사 휴강이 있어도 그대로 넘긴다 — 진단고사는 제 청구서가 따로 센다', async () => {
    await lesson('diagx', 'w11cm-diag', [{ on: '2031-06-18', canceled: true }], 14);
    await paidInvoice([CLASS_LINE]);
    expect(await rowOf()).toMatchObject({ carryable: true, carryBlockedReason: null });
    const made = await svc().carryTuition(ACTOR, { studentId: stuId, month: MONTH });
    expect(made).toMatchObject({ amount: 50000, sessions: 1 });
  });
});

d('W11 M2 migration 되돌리기 — 돈의 근거가 있으면 버리지 않고 멈춘다 (1764900000000)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => { q = ds.createQueryRunner(); await q.connect(); await q.startTransaction(); });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('가산 규칙 · 켜진 비공개 스위치가 있으면 down 이 멈춘다 — 조용히 지우지 않는다', async () => {
    const { PayoutLineBonusPrivacyNote1764900000000: M } = await import('../src/migrations/1764900000000-payout-line-bonus-privacy-note');
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES ($1,'되돌림 대표','w11mig@t.kr','ceo') ON CONFLICT (id) DO NOTHING`, [ACTOR]);
    await q.query(`INSERT INTO payout_bonus_rule (kind, kind_key, amount, from_date, set_by) VALUES ('group_per_student', NULL, 5000, '2031-01-01', $1)`, [ACTOR]);
    await expect(new M().down(q)).rejects.toThrow('가산 규칙');
    await q.query(`DELETE FROM payout_bonus_rule WHERE set_by = $1`, [ACTOR]);
    await q.query(`INSERT INTO acct_privacy (key, private) VALUES ('wage', true) ON CONFLICT (key) DO UPDATE SET private = true`);
    await expect(new M().down(q)).rejects.toThrow('켜져 있는 비공개 스위치');
  });
});
