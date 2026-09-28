/** @file-guide
 * 목적: accounting-billing-w11-followup-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 회계 청구 W11 A' 후속 (리드 → M1).
 *
 * ① 대표 보고 회계 펼칠 줄 — 분납 청구서의 기한 · 지난 날은 **지금 기한**(못 채운 가장 이른 회차의 예정일)이다.
 *    거르는 조각(`invOverdueWhere`)은 이미 지금 기한으로 판정하는데 줄에 적는 날은 `inv.due_on`(분납이면 마지막 회차)이라,
 *    첫 회차로 연체인 청구서가 「−N일 지남」으로 적혔다.
 *
 * ④ 옛 수업료 청구서(N-75 전)의 진단고사 · 상담 줄과 수강 종료 환불 — 지금 계산은 그 회차를 수업료에서 빼므로, 그 회차가 종료일 뒤에
 *    남아 있으면 환불 몫이 **조용히 줄었다**. 저장된 줄을 고쳐 읽지 않고 409 로 멈춘다(사람이 확인). 그 회차가 종료일 전이거나
 *    범위(「이 수업만」)에서 빠지면 전과 같이 처리한다 — 새 방식 청구서(수업료 · 진단고사 + 상담 따로)도 그대로다.
 *
 * 표를 비우지 않는다 — 한 트랜잭션 안에서 만들고 되돌린다(이웃 exec-compare-items-db 와 같은 모양).
 * 수강 종료는 제 트랜잭션을 여는 서비스라, 그 트랜잭션을 이 트랜잭션 안의 SAVEPOINT 로 돌린다 — 409 는 그 SAVEPOINT 만 되돌린다.
 */
import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { BoardService } from '../src/modules/board/board.service';
import { ExecService } from '../src/modules/exec/exec.service';
import { StudentWithdrawService } from '../src/modules/accounting/withdraw.service';
import { mixedDiagIntakeLines } from '../src/modules/accounting/invoice-lines';
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

d('① 대표 보고 회계 펼칠 줄 — 분납이면 지금 기한으로 적는다 (N-79 · W11 A\' 후속)', () => {
  let ds: DataSource;
  let q: QueryRunner;

  /**
   * 기준일은 기간 끝이 아니라 **오늘**이다(H-79 · 2026-09-29 · `lib/exec-areas.execAsOf`) — 2031년을 「그날 보는」 시험이라
   * 그날을 오늘로 넣어 준다. 안 넣으면 실제 오늘(2026)로 재어 2031년 기한은 아직 안 지난 것이 된다.
   */
  const exec = (today: string) => {
    const repo = q.manager.getRepository(Lead);
    const s = new ExecService(repo, new BoardService(repo));
    s.today = () => today;
    return s;
  };
  const moneyItems = async (day: string) =>
    (await exec(day).range(day, day, true)).areas.find((a) => a.key === 'money')!.items;

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => { q = ds.createQueryRunner(); await q.connect(); await q.startTransaction(); });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  /** 분납 청구서 — 합 300,000 · 회차 셋(02-20 · 03-31 · 04-30). `inv.due_on` 은 마지막 회차의 예정일이다(발행이 그렇게 적는다) */
  const splitInvoice = async (paid: number): Promise<number> => {
    const [stu] = (await q.query(`INSERT INTO stu (name) VALUES ('분납 줄 학생') RETURNING id`)) as Array<{ id: string }>;
    const [inv] = (await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, paid_amount, state, due_on)
       VALUES ($1, '2031-02', 'tuition', '2월 수업료 분납', 300000, $2, $3::inv_state_t, '2031-04-30') RETURNING id`,
      [Number(stu.id), paid, paid > 0 ? 'partial' : 'sent'],
    )) as Array<{ id: string }>;
    await q.query(
      `INSERT INTO inv_installment (inv_id, seq, due_on, amount) VALUES
         ($1, 1, '2031-02-20', 100000), ($1, 2, '2031-03-31', 100000), ($1, 3, '2031-04-30', 100000)`,
      [Number(inv.id)],
    );
    return Number(inv.id);
  };

  it('첫 회차로 연체인 분납 청구서는 **그 회차의 예정일**로 「N일 지남」이 양수다 — 마지막 회차 날로 적지 않는다', async () => {
    const id = await splitInvoice(0);
    const line = (await moneyItems('2031-03-11')).find((i) => i.key === `inv-${id}`);
    // 거르는 조각이 이 청구서를 넣는다(지금 기한 02-20 < 03-11) — 줄에 적는 날도 같은 날이어야 한다
    expect(line).toBeDefined();
    expect(line!.sub).toBe('₩300,000 · 기한 02-20 · 19일 지남');
  });

  it('첫 회차를 채웠으면 지금 기한은 **둘째 회차**다 — 그 날이 지나기 전에는 줄이 없고, 지나면 그 날로 센다', async () => {
    const id = await splitInvoice(100000);
    expect((await moneyItems('2031-03-11')).find((i) => i.key === `inv-${id}`)).toBeUndefined();
    const line = (await moneyItems('2031-04-05')).find((i) => i.key === `inv-${id}`);
    expect(line!.sub).toBe('₩200,000 · 기한 03-31 · 5일 지남');
  });

  it('분납이 아닌 청구서는 전과 같다 — 기한은 `due_on` 그대로', async () => {
    const [stu] = (await q.query(`INSERT INTO stu (name) VALUES ('일시납 학생') RETURNING id`)) as Array<{ id: string }>;
    const [inv] = (await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, paid_amount, state, due_on)
       VALUES ($1, '2031-02', 'tuition', '2월 수업료', 250000, 0, 'sent', '2031-03-01') RETURNING id`,
      [Number(stu.id)],
    )) as Array<{ id: string }>;
    const line = (await moneyItems('2031-03-11')).find((i) => i.key === `inv-${Number(inv.id)}`);
    expect(line!.sub).toBe('₩250,000 · 기한 03-01 · 10일 지남');
  });
});

d('④ 옛 수업료 청구서의 진단고사 · 상담 줄과 수강 종료 환불 (N-75 뒤 · W11 A\' 후속)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let stuId = 0;
  let classSer = 0;
  let diagSer = 0;
  const ACTOR = 9293;
  const MONTH = '2031-05';

  /** 수강 종료 서비스 — 제 트랜잭션을 이 트랜잭션 안의 SAVEPOINT 로 연다(409 · 미리보기는 그 SAVEPOINT 만 되돌린다) */
  const withdrawSvc = () => new StudentWithdrawService({
    transaction: <T>(fn: (m: EntityManager) => Promise<T>) => q.manager.transaction(fn),
  } as unknown as DataSource);
  const codeOf = async (p: Promise<unknown>): Promise<{ code: string; message: string } | null> => {
    try { await p; return null; } catch (e) {
      if (e instanceof HttpException) return e.getResponse() as { code: string; message: string };
      throw e;
    }
  };

  const lesson = async (kind: string, sub: string, days: string[], hour: number): Promise<number> => {
    const [se] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, title, mode, start_min, end_min, rrule, from_date)
       VALUES ($1, $2, '후속 수업', 'offline', $3::int, $3::int + 60, 'WEEKLY:MO', '2031-01-01') RETURNING id`,
      [kind, sub, hour * 60],
    )) as Array<{ id: string }>;
    const serId = Number(se.id);
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1, $2)`, [serId, stuId]);
    for (const day of days) {
      await q.query(
        `INSERT INTO ser_occ (ser_id, on_date, canceled, span)
         VALUES ($1, $2::date, false,
                 tstzrange(($2::date + make_time($3, 0, 0)) AT TIME ZONE 'Asia/Seoul',
                           ($2::date + make_time($3 + 1, 0, 0)) AT TIME ZONE 'Asia/Seoul', '[)'))`,
        [serId, day, hour],
      );
    }
    return serId;
  };
  /** 청구서를 **이미 나간 모양 그대로** 넣는다 — 줄은 저장된 것이 정본이다(발행 함수를 지나지 않는다) */
  const storedInvoice = async (
    invType: string, lines: Array<{ sub: string; label: string; n: number; unit: number }>,
  ): Promise<number> => {
    const amount = lines.reduce((s, l) => s + l.n * l.unit, 0);
    const [inv] = (await q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, paid_amount, state, due_on, paid_at)
       VALUES ($1, $2, $3, '5월 청구', $4, $4, 'paid', '2031-05-31', now()) RETURNING id`,
      [stuId, MONTH, invType, amount],
    )) as Array<{ id: string }>;
    const invId = Number(inv.id);
    for (const [i, l] of lines.entries()) {
      await q.query(
        `INSERT INTO inv_line (inv_id, sub_key, label, count, unit_price, amount, seq) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [invId, l.sub, l.label, l.n, l.unit, l.n * l.unit, i],
      );
    }
    await q.query(`INSERT INTO pay (inv_id, student_id, amount, paid_on, method) VALUES ($1, $2, $3, '2031-05-01', 'transfer')`, [invId, stuId, amount]);
    return invId;
  };
  const CLASS_LINE = { sub: 'w11fu-sub', label: '후속 과목', n: 4, unit: 50000 };
  const DIAG_LINE = { sub: 'w11fu-diag', label: '후속 진단', n: 1, unit: 40000 };
  const invOf = async (id: number) =>
    ((await q.query(`SELECT amount, paid_amount, state::text AS state FROM inv WHERE id = $1`, [id])) as Array<{ amount: number; paid_amount: number; state: string }>)[0]!;
  const rosterEnd = async (serId: number) =>
    ((await q.query(`SELECT to_char(to_date, 'YYYY-MM-DD') AS d FROM ser_stu WHERE ser_id = $1 AND student_id = $2`, [serId, stuId])) as Array<{ d: string | null }>)[0]!.d;

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES ($1,'후속 대표','w11fu@t.kr','ceo') ON CONFLICT (id) DO NOTHING`, [ACTOR]);
    // 진단고사는 코드표의 진짜 키다 — 수업료에서 빼는 판정이 그 키를 본다(N-75)
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp) VALUES ('w11fu_class','후속 수업','#333333',4,'lesson'), ('diagx','진단고사','#6F798A',8,'intake')
       ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(`INSERT INTO sub (key,name,color) VALUES ('w11fu-sub','후속 과목','#444444'), ('w11fu-diag','후속 진단','#555555') ON CONFLICT (key) DO NOTHING`);
    await q.query(`DELETE FROM rate WHERE sub_key IN ('w11fu-sub','w11fu-diag')`);
    await q.query(
      `INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES
         ('w11fu_class','w11fu-sub', 50000, '2031-01-01', 1), ('diagx','w11fu-diag', 40000, '2031-01-01', 1)`,
    );
    await q.query(`DELETE FROM month_close WHERE year_month = $1`, [MONTH]);
    const [stu] = (await q.query(`INSERT INTO stu (name, grade) VALUES ('후속 학생','G9') RETURNING id`)) as Array<{ id: string }>;
    stuId = Number(stu.id);
    // 수업 넷(05-05 · 12 · 19 · 26)과 진단고사 하나(05-21)
    classSer = await lesson('w11fu_class', 'w11fu-sub', ['2031-05-05', '2031-05-12', '2031-05-19', '2031-05-26'], 10);
    diagSer = await lesson('diagx', 'w11fu-diag', ['2031-05-21'], 14);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('옛 수업료 청구서에 진단고사 줄이 섞여 있고 그 회차가 종료일 뒤에 남으면 **409 로 멈춘다** — 환불 몫을 조용히 줄이지 않는다', async () => {
    const legacy = await storedInvoice('tuition', [CLASS_LINE, DIAG_LINE]); // 240,000 · 완납
    const dto = { studentId: stuId, endedOn: '2031-05-15' };
    // 미리보기도 같은 말로 멈춘다 — 화면이 「환불 예정」을 틀린 수로 그리지 않는다
    const seen = await codeOf(withdrawSvc().preview(ACTOR, dto, true, true));
    expect(seen?.code).toBe('WITHDRAW_MIXED_INVOICE');
    const hit = await codeOf(withdrawSvc().withdraw(ACTOR, dto, true, true));
    expect(hit?.code).toBe('WITHDRAW_MIXED_INVOICE');
    expect(hit?.message).toContain('2031-05 수업료 청구서');
    expect(hit?.message).toContain('사람이 확인');
    // 아무것도 바뀌지 않았다 — 명단 · 청구서 · 입금 · 감사
    expect(await rosterEnd(classSer)).toBeNull();
    expect(await rosterEnd(diagSer)).toBeNull();
    expect(await invOf(legacy)).toEqual({ amount: 240000, paid_amount: 240000, state: 'paid' });
    const [{ n }] = (await q.query(`SELECT count(*)::int AS n FROM pay WHERE inv_id = $1 AND amount < 0`, [legacy])) as Array<{ n: number }>;
    expect(n).toBe(0);
  });

  it('섞인 진단고사 회차가 종료일 **전**이면 환불 몫이 달라지지 않는다 — 전과 같이 처리한다(남은 수업 하나 · 50,000)', async () => {
    const legacy = await storedInvoice('tuition', [CLASS_LINE, DIAG_LINE]);
    const out = await withdrawSvc().withdraw(ACTOR, { studentId: stuId, endedOn: '2031-05-22' }, true, true);
    expect(out.refundTotal).toBe(50000);
    expect(await invOf(legacy)).toEqual({ amount: 190000, paid_amount: 190000, state: 'paid' });
    // 진단고사 줄은 그대로다 — 이미 한 회차의 값이다
    const [{ n }] = (await q.query(`SELECT count(*)::int AS n FROM inv_line WHERE inv_id = $1 AND sub_key = 'w11fu-diag' AND count > 0`, [legacy])) as Array<{ n: number }>;
    expect(n).toBe(1);
  });

  it('「이 수업만」으로 진단고사를 범위에서 빼면 멈추지 않는다 — 수업 두 회차만 빠지고 진단고사 명단은 그대로다', async () => {
    const legacy = await storedInvoice('tuition', [CLASS_LINE, DIAG_LINE]);
    const out = await withdrawSvc().withdraw(ACTOR, { studentId: stuId, endedOn: '2031-05-15', serIds: [classSer] }, true, true);
    expect(out.refundTotal).toBe(100000);
    expect(await invOf(legacy)).toEqual({ amount: 140000, paid_amount: 140000, state: 'paid' });
    expect(await rosterEnd(classSer)).toBe('2031-05-15');
    expect(await rosterEnd(diagSer)).toBeNull();
  });

  it('새 방식(수업료 · 진단고사 + 상담 따로)은 섞이지 않았다 — 두 청구서가 제 회차만큼 환불한다', async () => {
    const tuition = await storedInvoice('tuition', [CLASS_LINE]);
    const diag = await storedInvoice('diag_intake', [DIAG_LINE]);
    const out = await withdrawSvc().withdraw(ACTOR, { studentId: stuId, endedOn: '2031-05-15' }, true, true);
    expect(out.refundTotal).toBe(140000);
    expect(await invOf(tuition)).toEqual({ amount: 100000, paid_amount: 100000, state: 'paid' });
    expect(await invOf(diag)).toMatchObject({ amount: 0, paid_amount: 0, state: 'void' });
  });

  it('섞인 줄 판정은 한 함수다 — 옛 수업료 청구서의 진단고사 · 상담 양수 줄만 돌려준다(재가격 도구와 같은 판정)', async () => {
    const legacy = await storedInvoice('tuition', [CLASS_LINE, DIAG_LINE]);
    expect(await mixedDiagIntakeLines(q, legacy)).toEqual([{ label: '후속 진단', count: 1, amount: 40000 }]);
    // 과목 없는 회차의 줄은 종류 이름으로 읽는다 · 음수 줄(이월 · 수강 종료)은 청구한 줄이 아니다
    const noSub = await storedInvoice('tuition', [CLASS_LINE]);
    await q.query(
      `INSERT INTO inv_line (inv_id, sub_key, label, count, unit_price, amount, seq) VALUES
         ($1, NULL, '진단고사', 1, 40000, 40000, 5), ($1, NULL, '이월 (4월에서 1회)', -1, 50000, -50000, 6)`,
      [noSub],
    );
    expect(await mixedDiagIntakeLines(q, noSub)).toEqual([{ label: '진단고사', count: 1, amount: 40000 }]);
    // 새 방식 — 수업료에는 섞인 줄이 없고, 진단고사 + 상담 청구서는 그 자체가 제 종류다
    expect(await mixedDiagIntakeLines(q, await storedInvoice('tuition', [CLASS_LINE]))).toEqual([]);
    expect(await mixedDiagIntakeLines(q, await storedInvoice('diag_intake', [DIAG_LINE]))).toEqual([]);
  });
});
