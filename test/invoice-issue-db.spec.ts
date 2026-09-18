/** @file-guide
 * 목적: invoice-issue-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §53 「+ 새 청구서 발행」 — **횟수는 서버가 센다** (C50 · D-R37).
 *
 * 원문 명세가 「INV_LINE 의 횟수는 `occ()` 가 센다 · 프론트가 세면 예외(EXC)를 빠뜨린다」고 적었다.
 * 그래서 여기서 증명하는 것은 「몇 줄이 생겼는가」가 아니라 **무엇을 빼고 세었는가**다 —
 * 취소된 회차와 「그날만 빠진」 학생을 정말로 빼는지.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Inv } from '../src/entities';
import { AccountingService } from '../src/modules/accounting/accounting.service';
import { rosterPricing } from '../src/lib/rules';
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

d('§53 청구서 발행 — 줄은 서버가 만든다 (C50)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let stuId: number;
  let serId: number;

  const svc = () => new AccountingService(q.manager.getRepository(Inv));

  /** 회차 하나를 그 날짜 09:00~10:00 KST 로 만든다 */
  const occ = async (onDate: string, canceled = false) => {
    const [o] = (await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, canceled, span)
       VALUES ($1, $2::date, $3,
               tstzrange(($2::date + time '09:00') AT TIME ZONE 'Asia/Seoul',
                         ($2::date + time '10:00') AT TIME ZONE 'Asia/Seoul', '[)'))
       RETURNING id`,
      [serId, onDate, canceled],
    )) as Array<{ id: string }>;
    return Number(o.id);
  };

  /** 그날만 빠진 학생 — 회차를 지우지 않고 그 사람만 뺀다 (D-R21) */
  const dropOnce = async (onDate: string) => {
    const [e] = (await q.query(
      `INSERT INTO exc (ser_id, on_date, canceled, reason, by_id, at)
       VALUES ($1, $2::date, false, '개인 사정', 71, now()) RETURNING id`,
      [serId, onDate],
    )) as Array<{ id: string }>;
    await q.query(`INSERT INTO exc_stu_out (exc_id, student_id) VALUES ($1, $2)`, [Number(e.id), stuId]);
  };

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES (71,'청구 담당','inv71@t.kr','ceo') ON CONFLICT (id) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp) VALUES ('inv_test','청구 시험','#111111',4,'lesson')
       ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO sub (key,name,color,active,sort) VALUES ('inv-sub','청구 과목','#222222',true,900)
       ON CONFLICT (key) DO NOTHING`,
    );
    const [stu] = (await q.query(`INSERT INTO stu (name, grade) VALUES ('청구 학생','G8') RETURNING id`)) as Array<{ id: string }>;
    stuId = Number(stu.id);
    const [ser] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, title, mode, start_min, end_min, rrule, from_date)
       VALUES ('inv_test','inv-sub','청구 수업','offline',540,600,'WEEKLY:MO','2026-08-01') RETURNING id`,
    )) as Array<{ id: string }>;
    serId = Number(ser.id);
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1,$2)`, [serId, stuId]);
    await q.query(
      `INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads)
       VALUES ('inv_test','inv-sub', 50000, '2026-01-01', 1)`,
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const issue = () => svc().issueInvoice(71, { studentId: stuId, yearMonth: '2026-08', invType: 'tuition' }, true);

  it('취소된 회차는 세지 않는다 — 화면이 세면 이 한 건이 청구서에 남는다', async () => {
    await occ('2026-08-03');
    await occ('2026-08-10');
    await occ('2026-08-17', true);   // 휴강
    const inv = await issue();
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]).toMatchObject({ label: '청구 과목', count: 2, unitPrice: 50000, amount: 100000 });
    expect(inv.amount).toBe(100000);
  });

  it('그날만 빠진 학생은 그 회차에서 빠진다 — 회차는 남아 있다', async () => {
    await occ('2026-08-03');
    await occ('2026-08-10');
    await dropOnce('2026-08-10');
    const inv = await issue();
    expect(inv.lines[0].count).toBe(1);
    expect(inv.amount).toBe(50000);
    // 회차 자체는 지워지지 않았다
    const n = Number((await q.query(`SELECT count(*)::int AS n FROM ser_occ WHERE ser_id = $1`, [serId]))[0].n);
    expect(n).toBe(2);
  });

  it('달은 KST 로 가른다 — 8월 31일 23시 수업은 UTC 로는 9월이다', async () => {
    await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, canceled, span)
       VALUES ($1,'2026-08-31'::date,false,
               tstzrange((date '2026-08-31' + time '23:00') AT TIME ZONE 'Asia/Seoul',
                         (date '2026-09-01' + time '00:00') AT TIME ZONE 'Asia/Seoul','[)'))`,
      [serId],
    );
    const inv = await issue();
    expect(inv.lines[0].count).toBe(1);   // 8월분으로 잡힌다
  });

  it('그 달에 수업이 없으면 빈 청구서를 만들지 않고 거절한다', async () => {
    await expect(issue()).rejects.toMatchObject({
      response: { code: 'INV_NO_LESSONS' },
    });
    const n = Number((await q.query(`SELECT count(*)::int AS n FROM inv WHERE student_id = $1`, [stuId]))[0].n);
    expect(n).toBe(0);
  });

  it('단가표에 없는 과목이면 0원으로 내지 않고 거절한다 — 0원 청구서는 조용히 틀린 청구서다', async () => {
    await q.query(`DELETE FROM rate WHERE kind_key = 'inv_test'`);
    await occ('2026-08-03');
    await expect(issue()).rejects.toMatchObject({ response: { code: 'INV_NO_RATE' } });
  });

  it('같은 학생·달·종류를 두 번 내지 않는다 — 두 장이면 「보낸 청구서」 합계가 두 번 더해진다', async () => {
    await occ('2026-08-03');
    await issue();
    await expect(issue()).rejects.toMatchObject({ response: { code: 'INV_DUPLICATE' } });
    // 취소한 것은 셈에서 빠지므로 다시 낼 수 있다 (원문: 되돌리기 없음 · 취소하고 새로 만든다)
    await q.query(`UPDATE inv SET state = 'void' WHERE student_id = $1`, [stuId]);
    const again = await issue();
    expect(again.state).toBe('draft');
  });

  it('발행은 INSERT 뿐이다 — 되돌리기가 없으므로 기존 줄을 고치지 않는다', async () => {
    await occ('2026-08-03');
    const inv = await issue();
    const lines = (await q.query(
      `SELECT count, unit_price, amount, seq FROM inv_line WHERE inv_id = $1 ORDER BY seq`, [inv.id],
    )) as Array<{ count: number; unit_price: number; amount: number; seq: number }>;
    expect(lines).toHaveLength(1);
    // 소계는 저장 시점 스냅샷이다 — 단가가 나중에 바뀌어도 이 청구서는 안 바뀐다
    expect(lines[0].amount).toBe(lines[0].count * lines[0].unit_price);
    await q.query(`UPDATE rate SET unit_price = 99999 WHERE kind_key = 'inv_test'`);
    const after = (await q.query(`SELECT amount FROM inv_line WHERE inv_id = $1`, [inv.id])) as Array<{ amount: number }>;
    expect(after[0].amount).toBe(50000);
  });

  it('과목 단가가 없으면 프로그램 단가로 떨어진다 — 과목별 단가가 있으면 그쪽이 이긴다', async () => {
    // 프로그램 전체 단가 (sub_key NULL) — 둘째 과목은 이걸로 계산된다
    await q.query(
      `INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads)
       VALUES ('inv_test', NULL, 30000, '2026-01-01', 1)`,
    );
    await q.query(
      `INSERT INTO sub (key,name,color,active,sort) VALUES ('inv-sub2','둘째 과목','#333333',true,901)
       ON CONFLICT (key) DO NOTHING`,
    );
    const [s2] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, title, mode, start_min, end_min, rrule, from_date)
       VALUES ('inv_test','inv-sub2','둘째 수업','offline',540,600,'WEEKLY:TU','2026-08-01') RETURNING id`,
    )) as Array<{ id: string }>;
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1,$2)`, [Number(s2.id), stuId]);
    await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, canceled, span)
       VALUES ($1,'2026-08-04'::date,false,
               tstzrange((date '2026-08-04' + time '09:00') AT TIME ZONE 'Asia/Seoul',
                         (date '2026-08-04' + time '10:00') AT TIME ZONE 'Asia/Seoul','[)'))`,
      [Number(s2.id)],
    );
    await occ('2026-08-03');
    const inv = await issue();
    const byLabel = Object.fromEntries(inv.lines.map((l) => [l.label, l.unitPrice]));
    expect(byLabel['청구 과목']).toBe(50000);   // 과목별 단가가 이긴다
    expect(byLabel['둘째 과목']).toBe(30000);   // 프로그램 단가로 떨어진다
  });

  it('과목이 여럿이면 줄이 여럿이고 합계는 줄의 합이다', async () => {
    await q.query(
      `INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads)
       VALUES ('inv_test', NULL, 30000, '2026-01-01', 1)`,
    );
    await q.query(
      `INSERT INTO sub (key,name,color,active,sort) VALUES ('inv-sub2','둘째 과목','#333333',true,901)
       ON CONFLICT (key) DO NOTHING`,
    );
    const [s2] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, title, mode, start_min, end_min, rrule, from_date)
       VALUES ('inv_test','inv-sub2','둘째 수업','offline',540,600,'WEEKLY:TU','2026-08-01') RETURNING id`,
    )) as Array<{ id: string }>;
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1,$2)`, [Number(s2.id), stuId]);
    await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, canceled, span)
       VALUES ($1,'2026-08-04'::date,false,
               tstzrange((date '2026-08-04' + time '09:00') AT TIME ZONE 'Asia/Seoul',
                         (date '2026-08-04' + time '10:00') AT TIME ZONE 'Asia/Seoul','[)'))`,
      [Number(s2.id)],
    );
    await occ('2026-08-03');
    const inv = await issue();
    expect(inv.lines).toHaveLength(2);
    expect(inv.amount).toBe(inv.lines.reduce((n, l) => n + l.amount, 0));
  });

  /* ══ 인원 구간과 학생 예외 (C63) ═══════════════════════════════════════
   * 원문 §54 — 「데이터 RATE(단가), **STURATE(학생별 예외)**」 ·
   * 「규칙 **그룹 수업은 인원이 늘면 1인 단가가 내려가고 총액은 올라갑니다**」 ·
   * 「연동 **청구서 생성 시 이 계산 결과를 씁니다**」.
   *
   * 이 자리가 그 셋을 하나도 안 보고 있었다. 아래 회귀가 없어서 눈에 안 띄었다 —
   * 시드 고정 데이터의 구간이 전부 1인이라 **틀린 채로 다 초록**이었다.
   * ═══════════════════════════════════════════════════════════════════ */

  /** 이 수업에 사람을 더 넣는다 — 구간을 움직이는 유일한 입력이다 */
  const addClassmate = async (name: string) => {
    const [s] = (await q.query(`INSERT INTO stu (name) VALUES ($1) RETURNING id`, [name])) as Array<{ id: string }>;
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1,$2)`, [serId, Number(s.id)]);
    return Number(s.id);
  };
  const tier = (heads: number, unitPrice: number) =>
    q.query(
      `INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES ('inv_test','inv-sub',$1,'2026-01-01',$2)`,
      [unitPrice, heads],
    );

  it('인원이 늘면 1인 단가가 내려간다 — 원문 §54 의 규칙 줄 그대로', async () => {
    await tier(2, 30000);
    await tier(3, 22000);
    await occ('2026-08-03');

    // 혼자일 때는 1인 구간
    expect((await issue()).lines[0]).toMatchObject({ count: 1, unitPrice: 50000 });
  });

  it('둘이면 2인 구간, 셋이면 3인 구간 — 인원 이하의 **가장 큰** 구간을 고른다', async () => {
    await tier(2, 30000);
    await tier(3, 22000);
    await occ('2026-08-03');
    await addClassmate('짝꿍 하나');
    const two = await issue();
    expect(two.lines[0]).toMatchObject({ unitPrice: 30000, amount: 30000 });

    await q.query(`UPDATE inv SET state = 'void' WHERE id = $1`, [two.id]);
    await addClassmate('짝꿍 둘');
    expect((await issue()).lines[0]).toMatchObject({ unitPrice: 22000 });
  });

  it('명단 화면과 청구서가 **같은 단가**를 쓴다 — 같은 수업에 값이 둘이면 안 된다 (D-R22)', async () => {
    await tier(2, 30000);
    await tier(3, 22000);
    await occ('2026-08-03');
    await addClassmate('짝꿍 하나');
    await addClassmate('짝꿍 둘');

    // 명단 화면이 쓰는 함수 — 제품 규칙을 시험 안에 복제하지 않고 그대로 부른다
    const roster = rosterPricing(
      [{ heads: 1, unitPrice: 50000 }, { heads: 2, unitPrice: 30000 }, { heads: 3, unitPrice: 22000 }],
      [null, null, null],
    );
    expect((await issue()).lines[0].unitPrice).toBe(roster!.unitPrice);
  });

  it('구간이 여럿이어도 고르는 값이 **정해져 있다** — 같은 입력에 같은 답이 나온다', async () => {
    await tier(2, 30000);
    await tier(3, 22000);
    await tier(4, 18000);
    await occ('2026-08-03');
    await addClassmate('짝꿍 하나');
    const seen = new Set<number>();
    for (let i = 0; i < 5; i += 1) {
      const inv = await issue();
      seen.add(inv.lines[0].unitPrice!);
      await q.query(`UPDATE inv SET state = 'void' WHERE id = $1`, [inv.id]);
    }
    expect([...seen]).toEqual([30000]);
  });

  it('학생 예외(STURATE)가 구간 단가를 이긴다 — 원문이 「학생별 예외」라 부르는 것이다', async () => {
    await tier(2, 30000);
    await occ('2026-08-03');
    await addClassmate('짝꿍 하나');
    await q.query(
      `INSERT INTO sturate (student_id, kind_key, unit_price, from_date, reason) VALUES ($1,'inv_test',12000,'2026-01-01','형제 할인')`,
      [stuId],
    );
    expect((await issue()).lines[0]).toMatchObject({ unitPrice: 12000, amount: 12000 });
  });

  it('예외는 **그날에 유효한 것**만 이긴다 — 나중에 생긴 예외가 지난 수업을 바꾸지 않는다', async () => {
    await occ('2026-08-03');
    await q.query(
      `INSERT INTO sturate (student_id, kind_key, unit_price, from_date, reason) VALUES ($1,'inv_test',12000,'2026-09-01','형제 할인')`,
      [stuId],
    );
    expect((await issue()).lines[0]).toMatchObject({ unitPrice: 50000 });
  });

  it('같은 과목이라도 단가가 다르면 줄이 갈린다 — 「몇 번에 얼마」가 한 줄에서 읽혀야 한다', async () => {
    await occ('2026-08-03');
    await occ('2026-08-10');
    // 8월 5일부터 단가가 오른다
    await q.query(
      `INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES ('inv_test','inv-sub',70000,'2026-08-05',1)`,
    );
    const inv = await issue();
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines.map((l) => l.unitPrice).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([50000, 70000]);
    expect(inv.amount).toBe(120000);
  });
});
