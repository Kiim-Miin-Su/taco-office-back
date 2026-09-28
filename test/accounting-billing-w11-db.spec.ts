/** @file-guide
 * 목적: accounting-billing-w11-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 회계 청구 W11 — 결정 채택 N-75 · N-79 · N-28 ② · 7-3 ① · N-73 (스크래치 DB · 트랜잭션을 되돌린다).
 *
 * 증명하는 것 —
 *   ① **N-75** 진단고사 · 상담 회차는 제 종류로만 청구된다 — 수업료 줄에서 빠지고, 두 청구서의 합이 회차 전부의 값이다(이중 청구 0).
 *      §54 수업료 계산도 같은 집합이다 · 응시료는 사람이 줄을 적는다 · 컨설팅비는 발행 창에서 막힌다(같은 문장).
 *   ② **N-79** 분납 일정 — 합 = 청구액(409) · 같은 날 두 회차(400) · 기한 = 마지막 회차 · 연체는 누적 입금이 못 채운
 *      가장 이른 회차의 예정일로 판정한다(§69 배지 조각 · 청구서 줄 · §55 미수 조각이 같은 답) · 지연 제약 트리거가 커밋 때 합을 본다.
 *   ③ 미리 세기(`draftInvoice`)는 발행과 같은 금액이다 — 이미 낸 종류면 같은 문장으로 막혔다고 말한다.
 *   ④ **7-3 ①** 이월은 받는 달이 마감이면 409 — 단추(`carryBlockedReason`)와 쓰기가 같은 문장.
 *   ⑤ **N-73** 발행 · 이월은 같은 트랜잭션에 감사 한 줄 — 409 로 되돌린 쓰기에는 0줄.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Inv } from '../src/entities';
import { invDueSql, invOverdueWhere } from '../src/lib/exec-areas';
import { monthClosedMessage } from '../src/lib/month-close';
import { AccountingService } from '../src/modules/accounting/accounting.service';
import { invTypeIssueBlockedReason } from '../src/modules/accounting/accounting.dto';
import { invoiceLines } from '../src/modules/accounting/invoice-lines';
import { assertScratch, blockedBy, TEST_URL } from './db';

const DUE = '2026-12-31';
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

/** 지난 달 — 오늘이 언제든 「이미 한 수업」이 흔들리지 않는다 */
const MONTH = '2026-05';
const NEXT = '2026-06';
const ACTOR = 92;

d('회계 청구 W11 — 진단고사 · 상담 분리 · 분납 일정 · 받는 달 마감 · 감사 (N-75 · N-79 · 7-3 ① · N-73)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let stuId = 0;
  const svc = () => new AccountingService(q.manager.getRepository(Inv));

  /** (종류 · 과목) 규칙 하나 + 명단 + 회차 — 날짜마다. canceled 면 휴강 회차 */
  const lesson = async (kindKey: string, subKey: string, dates: Array<{ on: string; canceled?: boolean }>) => {
    const [se] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, title, mode, start_min, end_min, rrule, from_date)
       VALUES ($1, $2, 'W11 청구', 'offline', 540, 600, 'WEEKLY:MO', '2026-01-01') RETURNING id`,
      [kindKey, subKey],
    )) as Array<{ id: string }>;
    const serId = Number(se.id);
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1, $2)`, [serId, stuId]);
    for (const [i, day] of dates.entries()) {
      // 회차마다 시각을 한 시간씩 비켜 둔다 — 같은 날 두 규칙이 겹쳐도 EXCLUDE 에 걸리지 않게
      await q.query(
        `INSERT INTO ser_occ (ser_id, on_date, canceled, span)
         VALUES ($1, $2::date, $3,
                 tstzrange(($2::date + make_time($4, 0, 0)) AT TIME ZONE 'Asia/Seoul',
                           ($2::date + make_time($4 + 1, 0, 0)) AT TIME ZONE 'Asia/Seoul', '[)'))`,
        [serId, day.on, day.canceled ?? false, 9 + (serId % 6) + i % 2],
      );
    }
    return serId;
  };
  const issue = (invType: string, extra: Record<string, unknown> = {}, yearMonth = MONTH) =>
    svc().issueInvoice(ACTOR, { studentId: stuId, yearMonth, invType, dueOn: DUE, ...extra } as never, true);
  const invRows = async () =>
    (await q.query(`SELECT id, inv_type FROM inv WHERE student_id = $1 ORDER BY id`, [stuId])) as Array<{ id: string; inv_type: string }>;
  const logRows = async (entity: string, entityId: number) =>
    (await q.query(`SELECT action, after FROM log WHERE entity = $1 AND entity_id = $2 ORDER BY id`, [entity, entityId])) as Array<{
      action: string; after: Record<string, unknown>;
    }>;

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM carry`);
    await q.query(`DELETE FROM ser_occ`);
    await q.query(`DELETE FROM ser_stu`);
    await q.query(`DELETE FROM ser`);
    await q.query(`DELETE FROM month_close WHERE year_month IN ($1, $2)`, [MONTH, NEXT]);
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES ($1,'청구 담당','w11b92@t.kr','ceo') ON CONFLICT (id) DO NOTHING`, [ACTOR]);
    // 코드표의 진짜 키를 쓴다 — 수업료에서 빼는 판정이 그 키를 본다(N-75)
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp) VALUES
         ('w11_class','W11 수업','#333333',4,'lesson'),
         ('diagx','진단고사','#6F798A',8,'intake'),
         ('consult','상담','#52969C',3,'intake')
       ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO sub (key,name,color) VALUES ('w11-sub','W11 과목','#444444'),
         ('w11-diag','W11 진단','#555555'), ('w11-intake','W11 입학 상담','#666666')
       ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(`DELETE FROM rate WHERE sub_key IN ('w11-sub','w11-diag','w11-intake')`);
    await q.query(
      `INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES
         ('w11_class','w11-sub', 50000, '2026-01-01', 1),
         ('diagx','w11-diag', 40000, '2026-01-01', 1),
         ('consult','w11-intake', 30000, '2026-01-01', 1)`,
    );
    const [stu] = (await q.query(`INSERT INTO stu (name, grade) VALUES ('청구 학생','G9') RETURNING id`)) as Array<{ id: string }>;
    stuId = Number(stu.id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  /* ── ① N-75 진단고사 · 상담은 제 종류로만 ─────────────────────────── */

  it('진단고사 · 상담 회차는 **제 종류로만** 청구된다 — 수업료에서 빠지고 두 장의 합이 회차 전부의 값이다 (이중 청구 0)', async () => {
    await lesson('w11_class', 'w11-sub', [{ on: '2026-05-04' }, { on: '2026-05-11' }, { on: '2026-05-18' }]);
    await lesson('diagx', 'w11-diag', [{ on: '2026-05-06' }]);
    await lesson('consult', 'w11-intake', [{ on: '2026-05-13' }]);

    const tuition = await issue('tuition');
    expect(tuition.amount).toBe(150_000);
    expect(tuition.lines.map((l) => l.subKey)).toEqual(['w11-sub']);
    const diag = await issue('diag_intake');
    expect(diag.amount).toBe(70_000); // 40,000 + 30,000
    expect(diag.lines.map((l) => l.subKey).sort()).toEqual(['w11-diag', 'w11-intake']);
    expect(diag.title).toBe('2026년 5월 진단고사 + 상담 비용');
    // 회차 다섯의 값 = 두 청구서의 합 — 같은 회차가 두 번 든 줄이 없다
    expect((tuition.amount ?? 0) + (diag.amount ?? 0)).toBe(3 * 50_000 + 40_000 + 30_000);

    // §54 수업료 계산도 같은 집합이다 — 진단고사 · 상담 회차를 세지 않는다 (청구 줄과 같은 판정 · D-R22)
    const row = (await svc().tuition(MONTH, true)).items.find((x) => x.studentId === stuId)!;
    expect(row.total).toBe(3);
    expect(row.lines).toEqual(tuition.lines);
    // 재가격 도구가 부르는 기본 계산도 수업료 줄이다
    expect((await invoiceLines(q, stuId, MONTH)).map((l) => l.sub_key)).toEqual(['w11-sub']);
  });

  it('진단고사 · 상담 회차가 없으면 그 종류는 낼 것이 없다 — 수업료 회차를 대신 세지 않는다', async () => {
    await lesson('w11_class', 'w11-sub', [{ on: '2026-05-04' }]);
    await expect(issue('diag_intake')).rejects.toMatchObject({
      status: 409, response: { code: 'INV_NO_LESSONS', message: expect.stringContaining('진단고사 · 입학 상담 회차가 없습니다') },
    });
    expect(await invRows()).toEqual([]);
  });

  it('컨설팅비는 발행 창에서 막힌다 — 「청구서로 전환」 한 길이다 · 문장은 /meta 와 같은 함수', async () => {
    await lesson('w11_class', 'w11-sub', [{ on: '2026-05-04' }]);
    await expect(issue('consulting')).rejects.toMatchObject({
      status: 409, response: { code: 'INV_TYPE_NOT_SUPPORTED', message: invTypeIssueBlockedReason('consulting') },
    });
    expect(invTypeIssueBlockedReason('consulting')).toContain('청구서로 전환');
    expect(await invRows()).toEqual([]);
  });

  it('응시료는 **사람이 줄을 적는다** — 줄 없으면 400 · 서버가 세는 종류에 줄을 보내면 400 · 적은 그대로 낸다', async () => {
    await lesson('w11_class', 'w11-sub', [{ on: '2026-05-04' }]);
    await expect(issue('exam_fee')).rejects.toMatchObject({ status: 400, response: { code: 'INV_LINES_REQUIRED' } });
    await expect(issue('tuition', { lines: [{ label: '멋대로', amount: 1 }] }))
      .rejects.toMatchObject({ status: 400, response: { code: 'INV_LINES_NOT_ALLOWED' } });
    await expect(issue('exam_fee', { lines: [{ label: '   ', amount: 1000 }] }))
      .rejects.toMatchObject({ status: 400, response: { code: 'INV_LINE_LABEL_REQUIRED' } });
    expect(await invRows()).toEqual([]);

    const fee = await issue('exam_fee', { lines: [{ label: '  MAP 응시료 ', amount: 120_000 }, { label: 'CAT 응시료', amount: 80_000 }] });
    expect(fee.amount).toBe(200_000);
    expect(fee.lines).toEqual([
      { subKey: null, label: 'MAP 응시료', count: 1, unitPrice: 120_000, amount: 120_000 },
      { subKey: null, label: 'CAT 응시료', count: 1, unitPrice: 80_000, amount: 80_000 },
    ]);
    // 같은 달 수업료와는 다른 종류라 같이 선다 — 수업 회차가 응시료에 들지 않는다
    const tuition = await issue('tuition');
    expect(tuition.amount).toBe(50_000);
  });

  /* ── ② N-79 분납 일정 ────────────────────────────────────────────── */

  it('분납 합이 청구액과 다르면 409 — 청구서도 일정도 남지 않는다 · 같은 날 두 회차 400 · 기한이 마지막 회차와 다르면 400', async () => {
    await lesson('w11_class', 'w11-sub', [{ on: '2026-05-04' }, { on: '2026-05-11' }]); // 100,000
    await expect(issue('tuition', { dueOn: undefined, installments: [{ dueOn: '2026-05-20', amount: 50_000 }, { dueOn: '2026-06-20', amount: 40_000 }] }))
      .rejects.toMatchObject({ status: 409, response: { code: 'INV_INSTALLMENT_SUM', message: expect.stringContaining('100,000원') } });
    await expect(issue('tuition', { dueOn: undefined, installments: [{ dueOn: '2026-05-20', amount: 50_000 }, { dueOn: '2026-05-20', amount: 50_000 }] }))
      .rejects.toMatchObject({ status: 400, response: { code: 'INV_INSTALLMENT_DATES' } });
    await expect(issue('tuition', { dueOn: '2026-12-31', installments: [{ dueOn: '2026-05-20', amount: 50_000 }, { dueOn: '2026-06-20', amount: 50_000 }] }))
      .rejects.toMatchObject({ status: 400, response: { code: 'INV_INSTALLMENT_DUE' } });
    expect(await invRows()).toEqual([]);
    expect(await q.query(`SELECT 1 FROM inv_installment i JOIN inv v ON v.id = i.inv_id WHERE v.student_id = $1`, [stuId])).toEqual([]);
  });

  it('분납 일정은 **예정일 순으로 회차를 매기고** 기한은 마지막 회차의 예정일이다', async () => {
    await lesson('w11_class', 'w11-sub', [{ on: '2026-05-04' }, { on: '2026-05-11' }, { on: '2026-05-18' }]); // 150,000
    const inv = await issue('tuition', {
      dueOn: undefined,
      installments: [{ dueOn: '2026-07-20', amount: 50_000 }, { dueOn: '2026-05-20', amount: 60_000 }, { dueOn: '2026-06-20', amount: 40_000 }],
    });
    expect(inv.dueOn).toBe('2026-07-20');
    expect(inv.installments).toEqual([
      { seq: 1, dueOn: '2026-05-20', amount: 60_000, covered: false },
      { seq: 2, dueOn: '2026-06-20', amount: 40_000, covered: false },
      { seq: 3, dueOn: '2026-07-20', amount: 50_000, covered: false },
    ]);
    expect(inv.nextDueOn).toBe('2026-05-20');
    expect(inv.nextInstallmentSeq).toBe(1);
    // 금액 권한이 없으면 회차 금액도 가린다 — 합에서 청구액이 복원되면 가린 뜻이 없다
    const masked = (await svc().all(false)).invoices.find((i) => i.id === inv.id)!;
    expect(masked.installments.map((x) => x.amount)).toEqual([null, null, null]);
  });

  it('「전달」은 학부모 안내(PNOTI 보낼 것)를 만든다 — 청구서 줄이 그 안내를 들고 오고, 두 번째 전달은 409 · 안내는 하나 (H-76 「학부모 안내가 생성된다」)', async () => {
    await lesson('w11_class', 'w11-sub', [{ on: '2026-05-04' }, { on: '2026-05-11' }]); // 100,000
    const inv = await issue('tuition');
    expect(inv.notice).toBeNull();                        // 초안에는 아직 안내가 없다
    const sent = await svc().deliverInvoice(ACTOR, inv.id, true);
    expect(sent.state).toBe('sent');
    expect(sent.notice).toEqual({ id: expect.any(Number), body: expect.stringContaining('청구 학생'), sentAt: null });
    expect(sent.notice!.body).toContain('100,000원');
    expect(sent.notice!.body).toContain(DUE);
    const rows = (await q.query(
      `SELECT id, audience::text AS audience, student_id::text AS student_id, ser_id, body, sent_at FROM pnoti WHERE student_id = $1`, [stuId],
    )) as Array<{ id: string; audience: string; student_id: string; ser_id: string | null; body: string; sent_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: String(sent.notice!.id), audience: 'parent', student_id: String(stuId), ser_id: null, sent_at: null });
    expect(rows[0].body).toBe(sent.notice!.body);
    // 목록 줄도 같은 안내를 들고 온다 — 화면이 pnoti 를 따로 찾지 않는다
    const listed = (await svc().all(true)).invoices.find((i) => i.id === inv.id)!;
    expect(listed.notice).toEqual(sent.notice);
    // 이력에 안내 번호가 남는다
    const logs = await logRows('INV', inv.id);
    expect(logs.find((l) => l.action === 'deliver')?.after).toMatchObject({ state: 'sent', noticeId: sent.notice!.id });
    // 두 번째 전달은 거절 — 안내가 둘이 되지 않는다
    await expect(svc().deliverInvoice(ACTOR, inv.id, true)).rejects.toMatchObject({ response: { code: 'INV_NOT_DELIVERABLE' } });
    expect(((await q.query(`SELECT count(*)::int AS n FROM pnoti WHERE student_id = $1`, [stuId])) as Array<{ n: number }>)[0].n).toBe(1);
  });

  it('연체는 **누적 입금이 못 채운 가장 이른 회차**로 판정한다 — 줄 · §69 배지 조각 · 지금 기한이 같은 답', async () => {
    await lesson('w11_class', 'w11-sub', [{ on: '2026-05-04' }, { on: '2026-05-11' }, { on: '2026-05-18' }]); // 150,000
    const inv = await issue('tuition', {
      dueOn: undefined,
      installments: [{ dueOn: '2026-05-20', amount: 100_000 }, { dueOn: '2099-12-31', amount: 50_000 }],
    });
    await svc().deliverInvoice(ACTOR, inv.id, true);
    const today = '2026-09-26';
    const overdueOf = async () => Number(((await q.query(
      `SELECT count(*)::int AS n FROM inv WHERE inv.id = $1 AND ${invOverdueWhere('', '$2')}`, [inv.id, today],
    )) as Array<{ n: number }>)[0]!.n);
    const dueOf = async () => ((await q.query(
      `SELECT to_char(${invDueSql('i')}, 'YYYY-MM-DD') AS due FROM inv i WHERE i.id = $1`, [inv.id],
    )) as Array<{ due: string | null }>)[0]!.due;

    // 1회차(5월)가 안 채워졌다 — 마지막 기한(2099)이 멀어도 연체다
    expect(await dueOf()).toBe('2026-05-20');
    expect(await overdueOf()).toBe(1);
    const before = (await svc().all(true)).invoices.find((i) => i.id === inv.id)!;
    expect(before.overdueDays).toBeGreaterThan(0);
    expect(before.nextInstallmentSeq).toBe(1);

    // 1회차 몫을 받으면 지금 기한은 2회차 — 연체가 아니다
    const paid = await svc().addPayment(ACTOR, { invId: inv.id, amount: 100_000, paidOn: '2026-05-20', method: 'transfer' }, true);
    expect(paid.state).toBe('partial');
    expect(paid.installments.map((x) => x.covered)).toEqual([true, false]);
    expect(paid.nextDueOn).toBe('2099-12-31');
    expect(paid.nextInstallmentSeq).toBe(2);
    expect(paid.overdueDays).toBe(0);
    expect(await dueOf()).toBe('2099-12-31');
    expect(await overdueOf()).toBe(0);

    // 다 받으면 볼 기한이 없다
    const done = await svc().addPayment(ACTOR, { invId: inv.id, amount: 50_000, paidOn: '2026-06-01', method: 'transfer' }, true);
    expect(done.state).toBe('paid');
    expect(done.nextDueOn).toBeNull();
    expect(await dueOf()).toBeNull();
  });

  it('일정이 없는 청구서는 **지금처럼 기한 하나**다 — 옛 청구서 판정이 그대로 (보정 0 · N-25)', async () => {
    await lesson('w11_class', 'w11-sub', [{ on: '2026-05-04' }]);
    const inv = await issue('tuition', { dueOn: '2026-05-31' });
    expect(inv.installments).toEqual([]);
    expect(inv.nextDueOn).toBe('2026-05-31');
    expect(inv.nextInstallmentSeq).toBeNull();
    const [row] = (await q.query(
      `SELECT to_char(${invDueSql('i')}, 'YYYY-MM-DD') AS due FROM inv i WHERE i.id = $1`, [inv.id],
    )) as Array<{ due: string }>;
    expect(row!.due).toBe('2026-05-31');
  });

  it('§55 미수는 **못 채운 회차마다 한 줄**이다 — 「N회차」 · 그 회차의 못 받은 몫 · 합 = 남은 돈', async () => {
    await lesson('w11_class', 'w11-sub', [{ on: '2026-05-04' }, { on: '2026-05-11' }, { on: '2026-05-18' }, { on: '2026-05-25' }, { on: '2026-05-26' }]); // 250,000
    const inv = await issue('tuition', {
      dueOn: undefined,
      installments: [{ dueOn: '2026-05-20', amount: 100_000 }, { dueOn: '2026-06-20', amount: 100_000 }, { dueOn: '2026-07-20', amount: 50_000 }],
    });
    await svc().deliverInvoice(ACTOR, inv.id, true);
    await svc().addPayment(ACTOR, { invId: inv.id, amount: 150_000, paidOn: '2026-05-20', method: 'cash' }, true);

    const flow = await svc().cashflow(true, {}, '2026-06-10');
    const mine = flow.open.filter((o) => o.invId === inv.id);
    expect(mine.map((o) => [o.seq, o.partLabel, o.amount, o.dueOn])).toEqual([
      [2, '2회차', 50_000, '2026-06-20'],
      [3, '3회차', 50_000, '2026-07-20'],
    ]);
    expect(mine.reduce((n, o) => n + (o.amount ?? 0), 0)).toBe(100_000);
    expect(mine[0]!.whenLabel).toBe('D-10');

    // 기간 달력의 「예정」도 같은 조각이다 — 6월에는 2회차 몫 하나만 선다
    const june = await svc().cashflow(true, { from: '2026-06-01', to: '2026-06-30' }, '2026-06-10');
    expect(june.days.find((x) => x.date === '2026-06-20')).toMatchObject({ expectedAmount: 50_000, expectedCount: 1 });
    expect(june.days.find((x) => x.date === '2026-07-20')).toBeUndefined();
  });

  it('합 = 청구액은 **표가 마지막으로 본다** — 어긋난 채 커밋하려 하면 지연 제약이 막는다 (청구액만 바꿔도)', async () => {
    const [inv] = (await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state, created_by)
       VALUES ($1, $2, 'tuition', '트리거 시험', 300, 'draft', $3) RETURNING id`,
      [stuId, MONTH, ACTOR],
    )) as Array<{ id: string }>;
    await q.query(`INSERT INTO inv_installment (inv_id, seq, due_on, amount) VALUES ($1, 1, '2026-05-10', 100), ($1, 2, '2026-05-20', 200)`, [inv!.id]);
    // 맞으면 지나간다
    await q.query(`SET CONSTRAINTS inv_installment_sum_check, inv_installment_sum_on_inv IMMEDIATE`);
    await q.query(`SET CONSTRAINTS inv_installment_sum_check, inv_installment_sum_on_inv DEFERRED`);
    // 청구액만 바꾸면 막힌다
    await q.query(`UPDATE inv SET amount = 250 WHERE id = $1`, [inv!.id]);
    const msg = await blockedBy(q, `SET CONSTRAINTS inv_installment_sum_on_inv IMMEDIATE`);
    expect(msg).toContain('installment total');
  });

  it('회차 금액은 0 보다 크고 같은 청구서에서 회차 번호 · 예정일이 한 번씩만 — 표가 막는다', async () => {
    const [inv] = (await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state, created_by)
       VALUES ($1, $2, 'tuition', '제약 시험', 100, 'draft', $3) RETURNING id`,
      [stuId, MONTH, ACTOR],
    )) as Array<{ id: string }>;
    expect(await blockedBy(q, `INSERT INTO inv_installment (inv_id, seq, due_on, amount) VALUES ($1, 1, '2026-05-10', 0)`, [inv!.id]))
      .toContain('inv_installment_amount_positive');
    expect(await blockedBy(q, `INSERT INTO inv_installment (inv_id, seq, due_on, amount) VALUES ($1, 0, '2026-05-10', 10)`, [inv!.id]))
      .toContain('inv_installment_seq_positive');
    await q.query(`INSERT INTO inv_installment (inv_id, seq, due_on, amount) VALUES ($1, 1, '2026-05-10', 50)`, [inv!.id]);
    expect(await blockedBy(q, `INSERT INTO inv_installment (inv_id, seq, due_on, amount) VALUES ($1, 1, '2026-05-11', 50)`, [inv!.id]))
      .toContain('inv_installment_seq_uniq');
    expect(await blockedBy(q, `INSERT INTO inv_installment (inv_id, seq, due_on, amount) VALUES ($1, 2, '2026-05-10', 50)`, [inv!.id]))
      .toContain('inv_installment_due_uniq');
  });

  /* ── ③ 미리 세기 = 발행 ───────────────────────────────────────────── */

  it('미리 세기는 **발행과 같은 금액**이다 — 쓰지 않고, 이미 낸 종류면 같은 문장으로 막혔다고 말한다', async () => {
    await lesson('w11_class', 'w11-sub', [{ on: '2026-05-04' }, { on: '2026-05-11' }]);
    await q.query(`INSERT INTO carry (student_id, from_month, to_month, amount, sessions, by_id) VALUES ($1, '2026-04', $2, 30000, 1, $3)`, [stuId, MONTH, ACTOR]);
    const draft = await svc().draftInvoice({ studentId: stuId, yearMonth: MONTH, invType: 'tuition' }, true);
    expect(draft).toMatchObject({ amount: 70_000, canIssue: true, blockedCode: null, issueBlockedReason: null, title: '2026년 5월 수업료 청구' });
    expect(draft.lines.map((l) => l.amount)).toEqual([100_000, -30_000]);
    expect(await invRows()).toEqual([]); // 쓰기 0

    const inv = await issue('tuition');
    expect(inv.amount).toBe(draft.amount);
    expect(inv.lines).toEqual(draft.lines);
    const again = await svc().draftInvoice({ studentId: stuId, yearMonth: MONTH, invType: 'tuition' }, true);
    expect(again).toMatchObject({ canIssue: false, blockedCode: 'INV_DUPLICATE', amount: null });
    await expect(issue('tuition')).rejects.toMatchObject({ response: { code: 'INV_DUPLICATE', message: again.issueBlockedReason } });
    // 금액을 못 보면 금액 · 줄 금액을 가린다
    const blind = await svc().draftInvoice({ studentId: stuId, yearMonth: MONTH, invType: 'diag_intake' }, false);
    expect(blind).toMatchObject({ amount: null, canIssue: false, blockedCode: 'INV_NO_LESSONS' });
  });

  /* ── ④ 7-3 ① 받는 달 마감 · ⑤ 감사 ───────────────────────────────── */

  /** 5월 완납 청구서 + 휴강 1회 — 넘길 것이 있는 상태 */
  const paidWithDrop = async () => {
    await lesson('w11_class', 'w11-sub', [{ on: '2026-05-04' }, { on: '2026-05-11', canceled: true }]);
    const inv = await issue('tuition');
    await q.query(`UPDATE inv SET state = 'paid', paid_amount = amount WHERE id = $1`, [inv.id]);
    return inv.id;
  };

  it('**받는 달이 마감이면** 이월할 수 없다 — 단추와 쓰기가 같은 문장 · 줄도 감사도 남지 않는다 (7-3 ①)', async () => {
    await paidWithDrop();
    await q.query(`INSERT INTO month_close (year_month, closed_by) VALUES ($1, $2)`, [NEXT, ACTOR]);

    const row = (await svc().tuition(MONTH, true)).items.find((x) => x.studentId === stuId)!;
    expect(row.carryable).toBe(false);
    expect(row.carryBlockedReason).toBe(monthClosedMessage(NEXT));
    await expect(svc().carryTuition(ACTOR, { studentId: stuId, month: MONTH }))
      .rejects.toMatchObject({ status: 409, response: { code: 'MONTH_CLOSED', message: monthClosedMessage(NEXT) } });
    expect(await q.query(`SELECT id FROM carry WHERE student_id = $1`, [stuId])).toEqual([]);
    expect(await q.query(`SELECT id FROM log WHERE entity = 'CARRY' AND actor_id = $1`, [ACTOR])).toEqual([]);

    // 마감을 풀면 넘어간다 — 감사 한 줄(누가 · 얼마를 · 어디로)
    await q.query(`UPDATE month_close SET reopened_at = now(), reopened_by = $2, reopen_reason = '시험' WHERE year_month = $1`, [NEXT, ACTOR]);
    const made = await svc().carryTuition(ACTOR, { studentId: stuId, month: MONTH });
    const logs = await logRows('CARRY', made.id);
    expect(logs.map((l) => l.action)).toEqual(['create']);
    expect(logs[0]!.after).toMatchObject({ studentId: stuId, fromMonth: MONTH, toMonth: NEXT, amount: 50_000, sessions: 1 });
  });

  it('발행은 **같은 트랜잭션에 감사 한 줄** — 409 로 되돌린 발행에는 줄이 없다 (N-73)', async () => {
    await lesson('w11_class', 'w11-sub', [{ on: '2026-05-04' }]);
    const inv = await issue('tuition');
    const logs = await logRows('INV', inv.id);
    expect(logs.map((l) => l.action)).toEqual(['issue']);
    expect(logs[0]!.after).toMatchObject({ studentId: stuId, yearMonth: MONTH, invType: 'tuition', amount: 50_000, dueOn: DUE, installments: 0 });

    const before = Number(((await q.query(`SELECT count(*)::int AS n FROM log WHERE entity = 'INV' AND actor_id = $1`, [ACTOR])) as Array<{ n: number }>)[0]!.n);
    await expect(issue('tuition')).rejects.toMatchObject({ response: { code: 'INV_DUPLICATE' } });
    await expect(issue('consulting')).rejects.toMatchObject({ response: { code: 'INV_TYPE_NOT_SUPPORTED' } });
    const after = Number(((await q.query(`SELECT count(*)::int AS n FROM log WHERE entity = 'INV' AND actor_id = $1`, [ACTOR])) as Array<{ n: number }>)[0]!.n);
    expect(after).toBe(before);
  });

  /* ── N-28 ② 청구 대상 = 일괄 발행 후보 ─────────────────────────────── */

  it('일괄 발행은 (학생 · 종류) 마다 낸다 — 진단고사 · 상담 회차가 있으면 그 청구서도 · 건너뛴 줄에 종류가 적힌다', async () => {
    await lesson('w11_class', 'w11-sub', [{ on: '2026-05-04' }]);
    await lesson('diagx', 'w11-diag', [{ on: '2026-05-06' }]);
    const res = await svc().issueBatch(ACTOR, { yearMonth: MONTH, dueOn: DUE }, true);
    const mine = res.issued.filter((i) => i.studentId === stuId);
    expect(mine.map((i) => [i.invType, i.amount])).toEqual([['tuition', 50_000], ['diag_intake', 40_000]]);
    const again = await svc().issueBatch(ACTOR, { yearMonth: MONTH, dueOn: DUE }, true);
    expect(again.skipped.filter((s) => s.studentId === stuId).map((s) => [s.invType, s.invTypeLabel, s.code])).toEqual([
      ['tuition', '수업료 청구', 'INV_DUPLICATE'],
      ['diag_intake', '진단고사 + 상담 비용', 'INV_DUPLICATE'],
    ]);
  });
});
