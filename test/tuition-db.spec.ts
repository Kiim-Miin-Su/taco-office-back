/** @file-guide
 * 목적: tuition-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §54 수업료 계산 — C65.
 *
 * 원문 §54 의 마지막 줄이 이 화면의 정체다 — 「연동: **청구서 생성 시 이 계산 결과를 씁니다**」.
 *
 * 증명하는 것 넷 —
 *   ① **청구서와 같은 금액이 나온다.** 두 곳이 각자 계산하면 미리 본 금액과 청구한 금액이 갈린다 (D-R22).
 *   ② **결강은 금액에서 빠지고 「넘길 돈」으로 따로 선다** — 안 한 수업을 이번 달에 청구하지 않는다.
 *   ③ **「그날만 빠진」 학생도 결강이다** (D-R21) — 회차는 남아 있고 그 사람만 빠진다.
 *   ④ **금액을 못 보면 내역도 안 내려간다** — 줄을 세면 금액이 드러난다 (D-R39).
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

/** 지난 달 — 「이미 한 수업」이 확실한 날짜를 쓴다. 오늘이 언제든 결과가 안 흔들린다 */
const MONTH = '2026-05';
const PAST = ['2026-05-04', '2026-05-11', '2026-05-18'];

d('§54 수업료 계산 (C65)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let stuId = 0;
  let serId = 0;
  const svc = () => new AccountingService(q.manager.getRepository(Inv));

  const occOn = async (sid: number, onDate: string, canceled = false) => {
    const [o] = (await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, canceled, span)
       VALUES ($1, $2::date, $3,
               tstzrange(($2::date + time '09:00') AT TIME ZONE 'Asia/Seoul',
                         ($2::date + time '10:00') AT TIME ZONE 'Asia/Seoul', '[)'))
       RETURNING id`,
      [sid, onDate, canceled],
    )) as Array<{ id: string }>;
    return Number(o.id);
  };
  const occ = (onDate: string, canceled = false) => occOn(serId, onDate, canceled);
  /** **단가가 다른 둘째 과목** — 안분이 틀리는 자리를 만들려면 한 학생에게 값이 둘이어야 한다 */
  const otherSubject = async (unitPrice: number) => {
    await q.query(
      `INSERT INTO sub (key,name,color) VALUES ('tu-sub2','수업료 과목 둘','#555555') ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads)
       VALUES ('tu_test','tu-sub2', $1, '2026-01-01', 1)`, [unitPrice],
    );
    const [se] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, title, mode, start_min, end_min, rrule, from_date)
       VALUES ('tu_test','tu-sub2','둘째 수업','offline',660,720,'WEEKLY:TU','2026-01-01') RETURNING id`,
    )) as Array<{ id: string }>;
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1,$2)`, [Number(se.id), stuId]);
    return Number(se.id);
  };
  /** 회차는 남기고 그 학생만 뺀다 (D-R21) */
  const dropOnce = async (onDate: string) => {
    const [e] = (await q.query(
      `INSERT INTO exc (ser_id, on_date, canceled, reason, by_id, at)
       VALUES ($1, $2::date, false, '개인 사정', 91, now()) RETURNING id`,
      [serId, onDate],
    )) as Array<{ id: string }>;
    await q.query(`INSERT INTO exc_stu_out (exc_id, student_id) VALUES ($1, $2)`, [Number(e.id), stuId]);
  };
  const row = async (canSee = true) => {
    const v = await svc().tuition(MONTH, canSee);
    return { all: v, me: v.items.find((x) => x.studentId === stuId)! };
  };

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM carry`);
    await q.query(`DELETE FROM ser_occ`);
    await q.query(`DELETE FROM ser_stu`);
    await q.query(`DELETE FROM ser`);
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES (91,'수업료 담당','tu91@t.kr','ceo') ON CONFLICT (id) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp) VALUES ('tu_test','수업료 시험','#333333',4,'lesson')
       ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO sub (key,name,color) VALUES ('tu-sub','수업료 과목','#444444') ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(`DELETE FROM rate WHERE kind_key = 'tu_test'`);
    await q.query(`DELETE FROM sub WHERE key = 'tu-sub2'`);
    await q.query(
      `INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads)
       VALUES ('tu_test','tu-sub', 50000, '2026-01-01', 1)`,
    );
    const [stu] = (await q.query(`INSERT INTO stu (name, grade) VALUES ('수업료 학생','G8') RETURNING id`)) as Array<{ id: string }>;
    stuId = Number(stu.id);
    const [ser] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, title, mode, start_min, end_min, rrule, from_date)
       VALUES ('tu_test','tu-sub','수업료 수업','offline',540,600,'WEEKLY:MO','2026-01-01') RETURNING id`,
    )) as Array<{ id: string }>;
    serId = Number(ser.id);
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1,$2)`, [serId, stuId]);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  /* ── ① 청구서와 같은 금액 ─────────────────────────────────────────── */

  it('청구서와 **같은 금액**이 나온다 — 미리 본 값과 청구한 값이 갈리면 안 된다 (D-R22)', async () => {
    for (const day of PAST) await occ(day);
    const { me } = await row();
    const inv = await svc().issueInvoice(91, { studentId: stuId, yearMonth: MONTH, invType: 'tuition' }, true);
    expect(me.doneAmount).toBe(inv.amount);
    expect(me.lines).toEqual(inv.lines);
  });

  it('인원이 늘면 단가가 내려가고 이 화면도 같이 내려간다 — 원문 §54 규칙', async () => {
    await q.query(
      `INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES ('tu_test','tu-sub',30000,'2026-01-01',2)`,
    );
    for (const day of PAST) await occ(day);
    expect((await row()).me.unitPrice).toBe(50_000);

    const [mate] = (await q.query(`INSERT INTO stu (name) VALUES ('짝꿍') RETURNING id`)) as Array<{ id: string }>;
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1,$2)`, [serId, Number(mate.id)]);
    const after = await row();
    expect(after.me.unitPrice).toBe(30_000);
    expect(after.me.doneAmount).toBe(90_000);
  });

  /* ── ② · ③ 결강 ──────────────────────────────────────────────────── */

  it('휴강은 금액에서 빠지고 「넘길 돈」으로 선다 — 안 한 수업을 이번 달에 청구하지 않는다', async () => {
    await occ(PAST[0]);
    await occ(PAST[1]);
    await occ(PAST[2], true); // 휴강
    const { me } = await row();
    expect(me.done).toBe(2);
    expect(me.total).toBe(2);
    expect(me.canceled).toBe(1);
    expect(me.doneAmount).toBe(100_000);
    expect(me.carryAmount).toBe(50_000);
  });

  it('「그날만 빠진」 학생도 결강이다 — 회차는 남아 있다 (D-R21)', async () => {
    await occ(PAST[0]);
    await occ(PAST[1]);
    await dropOnce(PAST[1]);
    const { me } = await row();
    expect(me.done).toBe(1);
    expect(me.canceled).toBe(1);
    expect(me.doneAmount).toBe(50_000);
    expect(me.carryAmount).toBe(50_000);
  });

  it('결강이 없으면 넘길 돈은 0 이다 — null 로 비우지 않는다', async () => {
    await occ(PAST[0]);
    const { me } = await row();
    expect(me.canceled).toBe(0);
    expect(me.carryAmount).toBe(0);
  });

  /* ── 휴강의 처리 — 이월 · 차감 · 보강 이관 (C92 · C-30 ~ C-34) ──────── */

  /** 휴강 회차에 처리를 적는다 — 회차 예외(EXC)가 정본이고 투영(ser_occ)은 취소 여부만 든다 */
  const cancelWith = async (onDate: string, kind: string, treat: string) => {
    await q.query(
      `INSERT INTO exc (ser_id, on_date, canceled, cancel_kind, cancel_treat, by_id, at)
       VALUES ($1, $2::date, true, $3, $4, 91, now())`,
      [serId, onDate, kind, treat],
    );
    await occ(onDate, true);
  };

  it('**차감**은 이번 달 회차로 소진된다 — 금액에 들고 넘길 돈이 생기지 않는다 (C-31)', async () => {
    await occ(PAST[0]);
    await occ(PAST[1]);
    await cancelWith(PAST[2], 'student_absent', 'deduct');
    const { me, all } = await row();
    expect(me.done).toBe(3);
    expect(me.total).toBe(3);
    expect(me.deducted).toBe(1);
    expect(me.canceled).toBe(0);
    expect(me.doneAmount).toBe(150_000);
    expect(me.carryAmount).toBe(0);
    expect(all.deductedCount).toBe(1);
    // 청구서도 같은 값이다 — 차감한 회차가 청구에 든다 (D-R22)
    const inv = await svc().issueInvoice(91, { studentId: stuId, yearMonth: MONTH, invType: 'tuition' }, true);
    expect(inv.amount).toBe(150_000);
  });

  it('**이월**은 처리를 적었어도 옛 휴강과 같다 — 금액에서 빠지고 넘길 돈이 된다 (C-30)', async () => {
    await occ(PAST[0]);
    await cancelWith(PAST[1], 'student_absent', 'carry');
    await occ(PAST[2], true); // 처리를 안 적은 옛 휴강 = 이월 (N-25 · 기존 행 보정 0)
    const { me } = await row();
    expect(me.done).toBe(1);
    expect(me.canceled).toBe(2);
    expect(me.deducted).toBe(0);
    expect(me.doneAmount).toBe(50_000);
    expect(me.carryAmount).toBe(100_000);
  });

  it('**보강 이관**은 원래 회차를 세지 않는다 — 보강 회차가 대신 선다 (C-34 「두 번 세어지면 실패」)', async () => {
    await occ(PAST[0]);
    await cancelWith(PAST[1], 'student_absent', 'makeup');
    const { me } = await row();
    expect(me.done).toBe(1);
    expect(me.deducted).toBe(0);
    expect(me.doneAmount).toBe(50_000);
    // 보강 이관은 이월이 아니다 — 넘길 돈에도 들지 않는다 (보강 회차가 이번·다음 달 어디든 제 자리에서 선다)
    expect(me.canceled).toBe(1);
    expect(me.carryAmount).toBe(0);
  });

  it('학원 사정·공휴일 휴강은 처리와 무관하게 이월이다 — DB 가 차감을 막는다 (C-32)', async () => {
    await expect(cancelWith(PAST[0], 'academy', 'deduct')).rejects.toThrow(/exc_cancel_policy/);
  });

  it('보강 이관 + 보강 회차 = **1회** — 원래 회차는 안 세고 보강 회차가 선다 (C-34 「1 + 1 = 2 가 아니라 1」)', async () => {
    await occ(PAST[0]);
    await cancelWith(PAST[1], 'teacher_absent', 'makeup');
    // 보강 회차 — 같은 과목의 ONCE 규칙, 같은 달
    const [mk] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, title, mode, start_min, end_min, rrule, from_date, to_date)
       VALUES ('tu_test','tu-sub','보강','offline',900,960,'ONCE','2026-05-20','2026-05-20') RETURNING id`,
    )) as Array<{ id: string }>;
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1,$2)`, [Number(mk.id), stuId]);
    await q.query(`UPDATE exc SET makeup_ser_id = $1 WHERE ser_id = $2 AND on_date = $3::date`, [Number(mk.id), serId, PAST[1]]);
    await occOn(Number(mk.id), '2026-05-20');
    const { me } = await row();
    expect(me.done).toBe(2);       // 5/4 원래 + 5/20 보강
    expect(me.total).toBe(2);
    expect(me.canceled).toBe(1);   // 5/11 원래 회차는 결강으로 적히되
    expect(me.carryAmount).toBe(0); // 넘길 돈에는 들지 않는다 — 보강이 대신 섰다
    expect(me.doneAmount).toBe(100_000);
    const inv = await svc().issueInvoice(91, { studentId: stuId, yearMonth: MONTH, invType: 'tuition' }, true);
    expect(inv.amount).toBe(100_000);
  });

  it('보강 링크는 처리가 makeup 일 때만 — 이월 회차에 링크를 붙이면 DB 가 막는다 (exc_makeup_link)', async () => {
    await cancelWith(PAST[0], 'student_absent', 'carry');
    await expect(q.query(`UPDATE exc SET makeup_ser_id = $1 WHERE ser_id = $1 AND on_date = $2::date`, [serId, PAST[0]]))
      .rejects.toThrow(/exc_makeup_link/);
  });

  /* ── 이월분이 다음 달 청구에서 빠진다 (C92-b · C-35) ─────────────────── */

  const carryIn = async (fromMonth: string, amount: number, sessions: number) => {
    await q.query(
      `INSERT INTO carry (student_id, from_month, to_month, amount, sessions, by_id) VALUES ($1, $2, $3, $4, $5, 91)`,
      [stuId, fromMonth, MONTH, amount, sessions],
    );
  };

  it('**이월분이 이 달 청구서에서 빠진다** — 음수 줄 하나 · 회차와 금액이 그대로 (C-35)', async () => {
    for (const day of PAST) await occ(day); // 3회 × 50,000 = 150,000
    await carryIn('2026-04', 100_000, 2);
    const { me, all } = await row();
    expect(me.carriedIn).toBe(100_000);
    expect(me.carriedInSessions).toBe(2);
    expect(all.carriedInCount).toBe(2);
    expect(all.carriedInAmount).toBe(100_000);
    const inv = await svc().issueInvoice(91, { studentId: stuId, yearMonth: MONTH, invType: 'tuition' }, true);
    expect(inv.amount).toBe(50_000);
    const carryLine = inv.lines.find((l) => l.count < 0)!;
    expect(carryLine).toMatchObject({ count: -2, amount: -100_000, unitPrice: 50_000 });
    expect(carryLine.label).toContain('2026-04');
    // 이월 줄을 뺀 나머지는 §54 내역과 같다 (D-R22)
    expect(inv.lines.filter((l) => l.count > 0)).toEqual(me.lines);
  });

  it('이월분이 이 달 수업보다 많으면 청구서를 내지 않는다 — 음수 청구서 대신 409 INV_CARRY_EXCEEDS', async () => {
    await occ(PAST[0]); // 50,000
    await carryIn('2026-04', 120_000, 3);
    await expect(svc().issueInvoice(91, { studentId: stuId, yearMonth: MONTH, invType: 'tuition' }, true))
      .rejects.toMatchObject({ response: { code: 'INV_CARRY_EXCEEDS' } });
    expect(await q.query(`SELECT id FROM inv WHERE student_id = $1 AND year_month = $2`, [stuId, MONTH])).toEqual([]);
  });

  it('이월은 수업료 청구서에만 붙는다 — 다른 종류는 넘어온 돈을 빼지 않는다', async () => {
    await occ(PAST[0]);
    await carryIn('2026-04', 20_000, 1);
    const inv = await svc().issueInvoice(91, { studentId: stuId, yearMonth: MONTH, invType: 'exam_fee' }, true);
    expect(inv.amount).toBe(50_000);
    expect(inv.lines.every((l) => l.count > 0)).toBe(true);
  });

  /* ── 안분을 쓰지 않는다 ──────────────────────────────────────────── */

  /*
   * 여기가 C63 과 같은 자리다. 회귀가 전부 「한 학생 한 단가」 뿐이면
   * **달 총액을 회차 수로 나눈 값**과 **실제로 한 수업의 값**이 우연히 같아져 버그가 안 보인다.
   * 그래서 일부러 **값이 둘인 학생**을 세운다.
   */

  it('「지금까지」는 나눈 값이 아니라 **이미 한 수업의 값**이다 — 값이 둘이면 안분이 틀린다', async () => {
    const NOW = '2026-09'; // 오늘(2026-09-13)을 사이에 둔다
    await occ('2026-09-01'); // 5만 · 했다
    await occ('2026-09-08'); // 5만 · 했다
    const cheap = await otherSubject(30_000);
    await occOn(cheap, '2026-09-21'); // 3만 · 아직
    await occOn(cheap, '2026-09-28'); // 3만 · 아직

    const v = await svc().tuition(NOW, true);
    const me = v.items.find((x) => x.studentId === stuId)!;
    expect(me.done).toBe(2);
    expect(me.total).toBe(4);
    // 비싼 것을 했고 싼 것이 남았다 — 실제로 한 수업의 값은 10만이다
    expect(me.doneAmount).toBe(100_000);
    // 안분이면 (100,000 + 60,000) × 2/4 = 80,000 — 어느 수업의 값도 아니다
    expect(me.doneAmount).not.toBe(80_000);
    // 달 전체는 청구서가 낼 값 그대로다 — 토막을 내도 합이 어긋나지 않는다
    const inv = await svc().issueInvoice(91, { studentId: stuId, yearMonth: NOW, invType: 'tuition' }, true);
    expect(inv.amount).toBe(160_000);
  });

  it('「넘길 돈」도 **결강한 그 수업의 값**이다 — 1회 평균으로 뭉개지 않는다', async () => {
    await occ(PAST[0]);                 // 5만 · 했다
    const cheap = await otherSubject(30_000);
    await occOn(cheap, PAST[1]);        // 3만 · 했다
    await occOn(cheap, PAST[2], true);  // 3만 · 휴강
    const { me } = await row();
    expect(me.doneAmount).toBe(80_000);
    // 1회 평균이면 (50,000+30,000+30,000)/3 ≈ 36,667 — 실제로 빠진 수업은 3만짜리다
    expect(me.carryAmount).toBe(30_000);
  });

  it('「그날만 빠진」 날도 그 수업의 값으로 넘긴다 — 회차는 남아 있다 (D-R21)', async () => {
    await occ(PAST[0]);                 // 5만 · 했다
    const cheap = await otherSubject(30_000);
    await occOn(cheap, PAST[1]);        // 3만 · 그런데 이 학생만 빠진다
    await q.query(
      `INSERT INTO exc (ser_id, on_date, canceled, reason, by_id, at)
       VALUES ($1, $2::date, false, '개인 사정', 91, now())`, [cheap, PAST[1]],
    );
    const [e] = (await q.query(`SELECT id FROM exc WHERE ser_id = $1 ORDER BY id DESC LIMIT 1`, [cheap])) as Array<{ id: string }>;
    await q.query(`INSERT INTO exc_stu_out (exc_id, student_id) VALUES ($1,$2)`, [Number(e.id), stuId]);
    const { me } = await row();
    expect(me.doneAmount).toBe(50_000);
    expect(me.carryAmount).toBe(30_000);
  });

  it('단가가 둘이면 **가짓수를 알린다** — 화면이 대표 단가 하나를 적지 않게', async () => {
    await occ(PAST[0]);
    const { me: one } = await row();
    expect(one.priceCount).toBe(1);
    expect(one.unitPrice).toBe(50_000);

    const cheap = await otherSubject(30_000);
    await occOn(cheap, PAST[1]);
    const { me: two } = await row();
    expect(two.priceCount).toBe(2);
    // 대표 단가는 그대로 내려간다 — 무엇을 적을지는 화면이 정한다
    expect(two.doneAmount).toBe(80_000);
  });

  it('단가표에 없는 과목뿐이면 가짓수가 0 이다 — 0원을 단가라고 적지 않게', async () => {
    await q.query(`DELETE FROM rate WHERE kind_key = 'tu_test'`);
    await occ(PAST[0]);
    const { me } = await row();
    expect(me.priceCount).toBe(0);
    expect(me.doneAmount).toBe(0);
    expect(me.lines).toEqual([]);
  });

  /* ── 세는 것과 나누는 것 ─────────────────────────────────────────── */

  it('퍼센트를 서버가 낸다 — 화면이 다시 나누지 않게', async () => {
    await occ(PAST[0]);
    await occ(PAST[1]);
    await occ('2026-05-25');
    await occ('2026-05-26');
    const { me } = await row();
    expect(me.total).toBe(4);
    expect(me.done).toBe(4);       // 전부 지난 달이라 다 했다
    expect(me.percent).toBe(100);
  });

  it('머리 다섯 칸은 줄의 합이다 — 화면이 더하지 않는다 (D-R37)', async () => {
    await occ(PAST[0]);
    await occ(PAST[1], true);
    const { all } = await row();
    const sum = (k: 'done' | 'total' | 'canceled') => all.items.reduce((n, x) => n + x[k], 0);
    expect(all.doneCount).toBe(sum('done'));
    expect(all.totalCount).toBe(sum('total'));
    expect(all.canceledCount).toBe(sum('canceled'));
    expect(all.doneAmount).toBe(all.items.reduce((n, x) => n + (x.doneAmount ?? 0), 0));
    expect(all.carryAmount).toBe(all.items.reduce((n, x) => n + (x.carryAmount ?? 0), 0));
  });

  it('그 달에 수업이 없는 학생은 줄을 만들지 않는다 — 빈 줄을 세우지 않는다', async () => {
    await occ('2026-06-01'); // 다른 달
    const { all } = await row();
    expect(all.items.some((x) => x.studentId === stuId)).toBe(false);
  });

  it('달의 날 수를 서버가 센다 — 「N일 지남 · N일 남음」', async () => {
    await occ(PAST[0]);
    const { all } = await row();
    // 지난 달이므로 통째로 지났다
    expect(all.daysPast).toBe(31);
    expect(all.daysLeft).toBe(0);
    expect(all.month).toBe(MONTH);
  });

  /* ── 이월 처리 (N-39 · 대표 결정 2026-09-13) ─────────────────────── */

  /*
   * 「**이월 처리는 수업이 결제 됐으나 정해진 시수가 채워지지 않은 경우**」.
   * 그래서 증명하는 것은 **받아 놓고 못 해 준 수업만 넘어간다**는 것이다.
   */
  const payInvoice = async (state: 'paid' | 'sent') => {
    const inv = await svc().issueInvoice(91, { studentId: stuId, yearMonth: MONTH, invType: 'tuition' }, true);
    await q.query(`UPDATE inv SET state = $2::inv_state_t, paid_amount = CASE WHEN $2 = 'paid' THEN amount ELSE 0 END WHERE id = $1`,
      [inv.id, state]);
    return inv.id;
  };

  it('**돈을 안 받았으면 이월할 수 없다** — 안 청구된 것이지 넘길 것이 아니다', async () => {
    await occ(PAST[0]);
    await occ(PAST[1], true);           // 휴강 — 못 해 준 수업이 있다
    await payInvoice('sent');            // 그런데 아직 안 받았다
    expect((await row()).me.carryable).toBe(false);
    await expect(svc().carryTuition(91, { studentId: stuId, month: MONTH }))
      .rejects.toMatchObject({ response: { code: 'CARRY_NOT_PAID' } });
  });

  it('**못 해 준 수업이 없으면** 이월할 수 없다 — 완납이어도', async () => {
    await occ(PAST[0]);
    await payInvoice('paid');
    expect((await row()).me.carryable).toBe(false);
    await expect(svc().carryTuition(91, { studentId: stuId, month: MONTH }))
      .rejects.toMatchObject({ response: { code: 'CARRY_NOTHING' } });
  });

  it('받아 놓고 못 해 준 수업은 **다음 달로 넘어간다** — 줄이 남는다', async () => {
    await occ(PAST[0]);
    await occ(PAST[1], true);           // 휴강 1회 · 5만
    await payInvoice('paid');
    expect((await row()).me.carryable).toBe(true);

    const made = await svc().carryTuition(91, { studentId: stuId, month: MONTH });
    expect(made.fromMonth).toBe('2026-05');
    expect(made.toMonth).toBe('2026-06');  // 바로 다음 달
    expect(made.amount).toBe(50_000);
    expect(made.sessions).toBe(1);
  });

  it('**한 달은 한 번만** 넘긴다 — 두 번 누르면 같은 돈이 두 번 넘어간다', async () => {
    await occ(PAST[0]);
    await occ(PAST[1], true);
    await payInvoice('paid');
    await svc().carryTuition(91, { studentId: stuId, month: MONTH });

    const { me } = await row();
    expect(me.carryable).toBe(false);      // 단추가 더는 서지 않는다
    expect(me.carriedAt).not.toBeNull();
    await expect(svc().carryTuition(91, { studentId: stuId, month: MONTH }))
      .rejects.toMatchObject({ response: { code: 'CARRY_DUPLICATE' } });
  });

  it('**다음 달이 그 돈을 받는다** — 저장하지 않으면 넘어왔는지 아무도 모른다', async () => {
    await occ(PAST[0]);
    await occ(PAST[1], true);
    await payInvoice('paid');
    await svc().carryTuition(91, { studentId: stuId, month: MONTH });

    // 6월에도 수업이 있어야 줄이 선다
    await occ('2026-06-01');
    const june = await svc().tuition('2026-06', true);
    expect(june.items.find((x) => x.studentId === stuId)!.carriedIn).toBe(50_000);
    // 5월 화면에서는 「넘어온 돈」이 아니라 「넘길 돈」이다
    expect((await row()).me.carriedIn).toBe(0);
  });

  it('금액을 못 보면 넘어온 돈도 안 준다 — 단추 여부는 금액이 아니라 판정이다', async () => {
    await occ(PAST[0]);
    await occ(PAST[1], true);
    await payInvoice('paid');
    const { me } = await row(false);
    expect(me.carriedIn).toBeNull();
    expect(me.carryable).toBe(true);
  });

  /* ── ④ 금액 권한 ─────────────────────────────────────────────────── */

  it('금액을 못 보면 내역도 안 내려간다 — 줄을 세면 금액이 드러난다 (D-R39)', async () => {
    await occ(PAST[0]);
    const { all, me } = await row(false);
    expect(all.canSeeAmounts).toBe(false);
    expect(all.doneAmount).toBeNull();
    expect(me.unitPrice).toBeNull();
    expect(me.doneAmount).toBeNull();
    expect(me.lines).toEqual([]);
    // 세는 것은 금액과 무관하다 — 회차는 그대로 내려간다
    expect(me.done).toBe(1);
    expect(me.percent).toBe(100);
  });
});
