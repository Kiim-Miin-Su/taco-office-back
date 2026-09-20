/** @file-guide
 * 목적: withdraw-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 수강 종료 · 중도 환불 — C94-c (테스트 시나리오 H-80 「중도 환불 · 잔여 회차 × 회당 단가 · 환불 기록이 장부에 · 수강 종료 · 이후 일정 정리」 ·
 * N-135 「이력이 끊기면 실패」 · N-136 「학생이 갑자기 그만둠 · 그룹 단가가 안 바뀌면 실패」).
 *
 * 증명하는 것 —
 *   ① 환불액 = 종료일 뒤 남은 회차 × 그 회차의 단가(청구서와 같은 함수) — 청구서에서 음수 줄로 빠지고, 받은 돈이 넘치면 PAY 음수 줄로 돌려준다.
 *   ② 명단 행은 남고 to_date 만 적힌다 — 종료일 전 회차는 그대로(이력), 뒤 회차는 시간표·§54·명단에서 빠진다. 같은 규칙에 다시 넣을 수 없다.
 *   ③ 그룹 수업의 남은 학생 단가가 **종료일 뒤부터** 다시 잡힌다(N-136) — 같은 달 청구 줄이 45,000×2 + 60,000×3 으로 갈린다.
 *   ④ 미리보기는 실제와 같은 수를 주고 아무것도 쓰지 않는다 · 두 번은 409 · 마감 달 409 · 금액 권한 없는 매니저 403 · ENR 종료일 · LOG 2줄.
 *
 * ⚠ 이 파일은 **표를 비우지 않는다.** 스위트 전용 번호대로 만들고 스스로 치운다.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { invoiceLines } from '../src/modules/accounting/invoice-lines';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('수강 종료 · 중도 환불 (C94-c · H-80 · N-135 · N-136)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let managerToken = '';
  let moneyMgrToken = '';
  const PW = 'withdraw-1234';
  const CEO = 981;
  const TEACHER = 982;
  const MANAGER = 983; // 금액 예외 없는 매니저 — 회계 403
  const MONEY_MGR = 984; // **금액 예외로 회계에 들어온 매니저** — 장부를 접는 것은 여전히 대표만이다 (S2)
  const STU_A = 9981; // 그만두는 학생
  const STU_B = 9982; // 남는 학생 — 단가가 다시 잡힌다
  const KIND = 'wd_kind';
  const SUB = 'wd-sub';
  const SOLO = 60000;
  const DUO = 45000;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const THIS = kst().slice(0, 7);
  /** 다음 달 1일부터 닷새 — 오늘이 언제든 전부 「앞으로의 회차」이고 한 달(청구서 하나) 안에 든다 */
  const NEXT_FIRST = `${plus(`${THIS}-01`, 32).slice(0, 7)}-01`;
  const NEXT = NEXT_FIRST.slice(0, 7);
  const DAYS = [0, 1, 2, 3, 4].map((n) => plus(NEXT_FIRST, n));

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await q(`DELETE FROM month_close WHERE closed_by = $1`, [CEO]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER, MANAGER, MONEY_MGR]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER, MANAGER, MONEY_MGR]]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active, can_money) VALUES
         ($1,'종료대표','wd-ceo@t.kr','ceo',$4,true,null),
         ($2,'종료강사','wd-t@t.kr','teacher',$4,true,null),
         ($3,'종료매니저','wd-m@t.kr','manager',$4,true,null),
         ($5,'종료금액매니저','wd-mm@t.kr','manager',$4,true,true)`,
      [CEO, TEACHER, MANAGER, hash, MONEY_MGR],
    );
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B]]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'종료A','10'), ($2,'종료B','10')`, [STU_A, STU_B]);
    await q(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'종료 시험','#333333',4,'lesson',true) ON CONFLICT (key) DO NOTHING`, [KIND]);
    await q(`INSERT INTO sub (key,name,color) VALUES ($1,'종료 과목','#444444') ON CONFLICT (key) DO NOTHING`, [SUB]);
    await q(`DELETE FROM rate WHERE kind_key = $1`, [KIND]);
    // 구간 단가 — 1인 60,000 · 2인 45,000 (D-R10 「인원이 늘면 1인 단가가 내려간다」)
    await q(`INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES ($1, $2, $3, '2026-01-01', 1), ($1, $2, $4, '2026-01-01', 2)`, [KIND, SUB, SOLO, DUO]);
    const login = async (email: string) => {
      const res = await request(app.getHttpServer())
        .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    token = await login('wd-ceo@t.kr');
    managerToken = await login('wd-m@t.kr');
    moneyMgrToken = await login('wd-mm@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await q(`DELETE FROM rate WHERE kind_key = $1`, [KIND]);
        await q(`DELETE FROM sub WHERE key = $1`, [SUB]);
        await q(`DELETE FROM kind WHERE key = $1`, [KIND]);
        await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER, MANAGER, MONEY_MGR]]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER, MANAGER, MONEY_MGR]]);
        await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B]]);
      }
    } finally {
      await app?.close();
    }
  });

  const made: number[] = [];
  afterEach(async () => {
    const stus = [STU_A, STU_B];
    await q(`DELETE FROM month_close WHERE closed_by = $1`, [CEO]);
    await q(`DELETE FROM enr WHERE student_id = ANY($1)`, [stus]);
    await q(`DELETE FROM carry WHERE student_id = ANY($1)`, [stus]);
    await q(`DELETE FROM pay WHERE student_id = ANY($1) OR inv_id IN (SELECT id FROM inv WHERE student_id = ANY($1))`, [stus]);
    await q(`DELETE FROM inv_line WHERE inv_id IN (SELECT id FROM inv WHERE student_id = ANY($1))`, [stus]);
    await q(`DELETE FROM inv WHERE student_id = ANY($1)`, [stus]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, MANAGER]]);
    if (!made.length) return;
    await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [made]);
    await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id = ANY($1))`, [made]);
    await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser WHERE id = ANY($1)`, [made]);
    made.length = 0;
  });

  const api = (m: 'post' | 'patch' | 'delete' | 'get', p: string, t = token) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`)
      .timeout({ response: 8000, deadline: 15000 });

  /** 다음 달 닷새 ONCE 60분 — 같은 두 학생의 그룹 수업 */
  async function fiveLessons(students = [STU_A, STU_B], startMin = 600) {
    const ids: number[] = [];
    for (const day of DAYS) {
      const res = await api('post', '/schedule').send({
        kindKey: KIND, subKey: SUB, mode: 'offline', fromDate: day, rrule: 'ONCE',
        startMin, endMin: startMin + 60, teacherId: TEACHER, roomId: null, title: '종료 수업', studentIds: students,
      }).expect(201);
      ids.push(res.body.serIds[0]);
    }
    made.push(...ids);
    return ids;
  }
  /** 다음 달 청구서를 내고 전달하고 전액 받는다 */
  async function paidInvoice(studentId: number) {
    const inv = (await api('post', '/accounting/invoices').send({ studentId, yearMonth: NEXT, invType: 'tuition' }).expect(201)).body;
    await api('post', `/accounting/invoices/${inv.id}/deliver`).expect(201);
    await api('post', '/accounting/payments').send({ invId: inv.id, amount: inv.amount, paidOn: kst(), method: 'cash' }).expect(201);
    return inv as { id: number; amount: number; lines: Array<{ count: number; unitPrice: number; amount: number }> };
  }
  const withdraw = (body: Record<string, unknown>, t = token) => api('post', '/accounting/withdrawals', t).send(body);
  const preview = (body: Record<string, unknown>, t = token) => api('post', '/accounting/withdrawals/preview', t).send(body);
  const lineOf = (m: { query: (sql: string, p?: unknown[]) => Promise<unknown> }) => m;

  /* ── ① ② ③ 중도 환불 ────────────────────────────────────────────────── */
  it('종료일 뒤 남은 회차 × 단가만큼 청구서에서 빠지고 넘친 돈은 환불 줄로 — 명단은 남고, 그룹의 남은 학생 단가가 종료일 뒤부터 다시 잡힌다 (H-80 · N-136)', async () => {
    const ids = await fiveLessons();
    await q(`INSERT INTO enr (student_id, kind_key, sub_key, sessions, started_on) VALUES ($1, $2, $3, 5, $4)`, [STU_A, KIND, SUB, DAYS[0]]);
    const invA = await paidInvoice(STU_A);
    const invB = await paidInvoice(STU_B);
    // 2인 구간으로 청구됐다 — 45,000 × 5
    expect(invA.amount).toBe(DUO * 5);
    expect(invB.amount).toBe(DUO * 5);

    // 둘째 날까지 다니고 그만둔다 — 남은 회차 3
    const endedOn = DAYS[1];
    const pre = await preview({ studentId: STU_A, endedOn, reason: '이사' }).expect(201);
    expect(pre.body).toMatchObject({ studentId: STU_A, studentName: '종료A', endedOn, preview: true, remainingCount: 3, refundTotal: DUO * 3, enrollmentsEnded: 1 });
    expect(pre.body.invoices).toEqual([expect.objectContaining({ id: invA.id, amountBefore: DUO * 5, amountAfter: DUO * 2, paidAmount: DUO * 2, refund: DUO * 3, removedCount: 3, voided: false, state: 'paid' })]);
    // 미리보기는 아무것도 쓰지 않는다
    expect(await q(`SELECT 1 FROM ser_stu WHERE student_id = $1 AND to_date IS NOT NULL`, [STU_A])).toEqual([]);
    expect(await q(`SELECT 1 FROM pay WHERE amount < 0 AND student_id = $1`, [STU_A])).toEqual([]);
    expect(await q(`SELECT 1 FROM enr WHERE student_id = $1 AND ended_on IS NOT NULL`, [STU_A])).toEqual([]);
    expect(await q(`SELECT 1 FROM log WHERE actor_id = $1 AND action = 'withdraw'`, [CEO])).toEqual([]);

    const res = await withdraw({ studentId: STU_A, endedOn, reason: '이사' }).expect(201);
    expect(res.body).toMatchObject({ preview: false, remainingCount: 3, refundTotal: DUO * 3, enrollmentsEnded: 1, reason: '이사' });
    // 종료일에 이미 끝난 규칙(ONCE 1·2일차)은 건드리지 않는다 — 그 뒤에도 유효한 셋만 종료일이 적힌다
    expect(res.body.series.map((s: { serId: number; remainingCount: number }) => [s.serId, s.remainingCount])).toEqual([[ids[2], 1], [ids[3], 1], [ids[4], 1]]);

    // 장부 — 청구서 줄(음수) · 금액 · 상태 · 환불 PAY 줄
    const [inv] = await q<{ amount: number; paid_amount: number; state: string }>(`SELECT amount, paid_amount, state::text AS state FROM inv WHERE id = $1`, [invA.id]);
    expect(inv).toMatchObject({ amount: DUO * 2, paid_amount: DUO * 2, state: 'paid' });
    const lines = await q<{ label: string; count: number; amount: number }>(`SELECT label, count, amount FROM inv_line WHERE inv_id = $1 ORDER BY seq`, [invA.id]);
    expect(lines.at(-1)).toMatchObject({ label: '수강 종료 · 종료 과목', count: -3, amount: -(DUO * 3) });
    const pays = await q<{ amount: number; reason: string }>(`SELECT amount, reason FROM pay WHERE inv_id = $1 ORDER BY id`, [invA.id]);
    expect(pays.map((p) => Number(p.amount))).toEqual([DUO * 5, -(DUO * 3)]);
    expect(pays[1]!.reason).toContain('수강 종료 환불 · 잔여 3회');
    // 회계 목록에 환불 줄이 음수로 선다 · §52 머리는 새 금액으로
    const acc = (await api('get', '/accounting').expect(200)).body;
    expect(acc.invoices.find((i: { id: number }) => i.id === invA.id)).toMatchObject({ amount: DUO * 2, paidAmount: DUO * 2, state: 'paid' });
    expect(acc.payments.some((p: { amount: number; studentName: string }) => p.amount === -(DUO * 3) && p.studentName === '종료A')).toBe(true);

    // 명단 — 행은 남고 to_date 만 (이력) · ENR 종료일
    const rows = await q<{ ser_id: string; to_date: string | null }>(`SELECT ser_id, to_char(to_date,'YYYY-MM-DD') AS to_date FROM ser_stu WHERE student_id = $1 ORDER BY ser_id`, [STU_A]);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.to_date)).toEqual([null, null, endedOn, endedOn, endedOn]);
    expect((await q<{ ended_on: string }>(`SELECT to_char(ended_on,'YYYY-MM-DD') AS ended_on FROM enr WHERE student_id = $1`, [STU_A]))[0]!.ended_on).toBe(endedOn);

    // 시간표 — 종료일까지는 있고 그 뒤는 없다 (이후 일정이 정리된다)
    const occ = (await api('get', `/schedule/occurrences?from=${DAYS[0]}&to=${DAYS[4]}&studentId=${STU_A}`).expect(200)).body.items;
    expect(occ.map((o: { serId: number }) => o.serId).sort()).toEqual([ids[0], ids[1]].sort());
    const all = (await api('get', `/schedule/occurrences?from=${DAYS[0]}&to=${DAYS[4]}`).expect(200)).body.items;
    const namesOn = (serId: number) => all.find((o: { serId: number }) => o.serId === serId).students.map((s: { name: string }) => s.name);
    expect(namesOn(ids[1])).toEqual(['종료A', '종료B']);
    expect(namesOn(ids[2])).toEqual(['종료B']);
    // §79 카드 — 종료 뒤 회차에는 「종료」로 남고 인원·단가에서 빠진다 (그룹 단가 1인 60,000)
    const tracking = (await api('get', `/schedule/tracking?serId=${ids[3]}&onDate=${DAYS[3]}`).expect(200)).body;
    expect(tracking.students.find((s: { id: number }) => s.id === STU_A)).toMatchObject({ ended: true, endedOn });
    expect(tracking).toMatchObject({ count: 1, unitPrice: SOLO });
    const before = (await api('get', `/schedule/tracking?serId=${ids[1]}&onDate=${DAYS[1]}`).expect(200)).body;
    expect(before.students.find((s: { id: number }) => s.id === STU_A)).toMatchObject({ ended: false });
    expect(before).toMatchObject({ count: 2, unitPrice: DUO });
    // 같은 규칙에 다시 넣을 수 없다 — 새 규칙으로 등록한다
    const again = await api('patch', `/schedule/${ids[3]}/roster`).send({ op: 'add', onDate: DAYS[3], studentId: STU_A }).expect(400);
    expect(again.body.code).toBe('BAD_ROSTER_OP');

    // N-136 — 남은 학생 B 의 단가가 종료일 뒤부터 다시 잡힌다: 45,000 × 2 + 60,000 × 3 (청구서와 같은 함수)
    const bLines = await invoiceLines(lineOf(ds.manager), STU_B, NEXT);
    expect(bLines.map((l) => [l.n, Number(l.unit_price)]).sort((a, b) => a[1]! - b[1]!)).toEqual([[2, DUO], [3, SOLO]]);
    // 이미 낸 B 의 청구서는 안 바뀐다(INSERT 뿐) — 다시 내면 새 단가다
    await api('post', `/accounting/invoices/${invB.id}/void`).send({ reason: '단가 재계산' }).expect(409); // 입금이 있어 취소 불가 — 장부는 그대로
    const tuitionB = (await api('get', `/accounting/tuition?month=${NEXT}`).expect(200)).body.items.find((r: { studentId: number }) => r.studentId === STU_B);
    expect(tuitionB.total).toBe(5);
    expect(tuitionB.priceCount).toBeGreaterThanOrEqual(2);
    // A 는 그 달 회차가 둘 남는다 — §54 도 같은 셈
    const tuitionA = (await api('get', `/accounting/tuition?month=${NEXT}`).expect(200)).body.items.find((r: { studentId: number }) => r.studentId === STU_A);
    expect(tuitionA.total).toBe(2);

    // 이력 — LOG 두 줄(STU withdraw · INV withdraw)
    const logs = await q<{ entity: string; action: string; after: Record<string, unknown> }>(`SELECT entity, action, after FROM log WHERE actor_id = $1 AND action = 'withdraw' ORDER BY id`, [CEO]);
    expect(logs.map((l) => l.entity)).toEqual(['INV', 'STU']);
    expect(logs[0]!.after).toMatchObject({ refund: DUO * 3, removed: 3, endedOn });
    expect(logs[1]!.after).toMatchObject({ endedOn, remainingCount: 3, refundTotal: DUO * 3, reason: '이사', enrollmentsEnded: 1 });

    // 두 번은 409 — 종료할 수강이 없다
    const twice = await withdraw({ studentId: STU_A, endedOn }).expect(409);
    expect(twice.body.code).toBe('WITHDRAW_NOTHING');
  });

  it('잔여 회차뿐인 청구서는 0 원이 되어 void 로 접히고 전액 환불된다 · 규칙 하나만 종료할 수 있다', async () => {
    const ids = await fiveLessons();
    const solo = await fiveLessons([STU_A], 720); // A 혼자 듣는 규칙 — 남겨 둔다
    const invA = await paidInvoice(STU_A);
    expect(invA.amount).toBe(DUO * 5 + SOLO * 5);
    // 그룹 규칙만 종료 — 시작 전에(종료일 = 지난달 마지막 날)
    const endedOn = plus(NEXT_FIRST, -1);
    const res = await withdraw({ studentId: STU_A, endedOn, serIds: ids }).expect(201);
    expect(res.body).toMatchObject({ remainingCount: 5, refundTotal: DUO * 5 });
    expect(res.body.invoices).toEqual([expect.objectContaining({ id: invA.id, amountAfter: SOLO * 5, refund: DUO * 5, voided: false, state: 'paid' })]);
    // 혼자 듣는 규칙은 그대로다
    expect(await q(`SELECT 1 FROM ser_stu WHERE student_id = $1 AND ser_id = ANY($2) AND to_date IS NULL`, [STU_A, solo])).toHaveLength(5);
    // 남은 규칙까지 종료하면 청구서는 0 원 — void 로 접히고 전액 환불
    const rest = await withdraw({ studentId: STU_A, endedOn }).expect(201);
    expect(rest.body.invoices).toEqual([expect.objectContaining({ id: invA.id, amountAfter: 0, refund: SOLO * 5, voided: true, state: 'void' })]);
    const [inv] = await q<{ amount: number; paid_amount: number; state: string; reason: string | null }>(
      `SELECT amount, paid_amount, state::text AS state, detail->'void'->>'reason' AS reason FROM inv WHERE id = $1`, [invA.id],
    );
    expect(inv).toMatchObject({ amount: 0, paid_amount: 0, state: 'void' });
    expect(inv.reason).toContain('수강 종료');
    const paid = await q<{ s: number }>(`SELECT COALESCE(sum(amount),0)::int AS s FROM pay WHERE inv_id = $1`, [invA.id]);
    expect(Number(paid[0]!.s)).toBe(0);
    // 잘못된 규칙 id 가 섞이면 400 · 없는 학생 404
    await withdraw({ studentId: STU_B, endedOn, serIds: [solo[0]] }).expect(400);
    await withdraw({ studentId: 99999999, endedOn }).expect(404);
  });

  /**
   * 같은 일에 문이 둘 있었는데 **한쪽만 잠겨 있었다** (S2 · 2026-09-20 전수 검수).
   *
   * 전용 경로 `POST /invoices/{id}/void` 는 `canMoney` **위에** `canCeoVoidInvoice` 를 걸어 두었다 —
   * 「회계 탭에 금액 예외로 들어온 매니저가 장부를 지울 수 있으면 안 된다」. 그런데 수강 종료는
   * `canMoney` 만으로 같은 상태(`void` + `detail.void`)에 닿고 있었다.
   */
  it('청구서가 통째로 비는 종료는 대표만 한다 — 금액 예외 매니저는 미리보기에서 막히고 이유가 온다 (S2)', async () => {
    await fiveLessons([STU_A]);
    const invA = await paidInvoice(STU_A);
    expect(invA.amount).toBe(SOLO * 5);
    const endedOn = plus(NEXT_FIRST, -1);

    // 미리보기는 던지지 않는다 — 화면이 「왜 못 누르는지」를 먼저 말해야 한다
    const pv = await preview({ studentId: STU_A, endedOn }, moneyMgrToken).expect(201);
    expect(pv.body.canConfirm).toBe(false);
    expect(pv.body.confirmBlockedReason).toContain('대표만');
    expect(pv.body.invoices).toEqual([expect.objectContaining({ id: invA.id, voided: true, needsCeoVoid: true })]);

    // 눌러도 서버가 거절한다 — 단추와 서버가 같은 질문을 한다
    const blocked = await withdraw({ studentId: STU_A, endedOn }, moneyMgrToken).expect(409);
    expect(blocked.body.code).toBe('WITHDRAW_NEEDS_CEO_VOID');
    const [untouched] = await q<{ state: string }>(`SELECT state::text AS state FROM inv WHERE id = $1`, [invA.id]);
    expect(untouched.state).toBe('paid'); // 아무것도 남지 않았다
    expect(await q(`SELECT 1 FROM ser_stu WHERE student_id = $1 AND to_date IS NOT NULL`, [STU_A])).toHaveLength(0);

    // 대표는 그대로 된다
    const done = await withdraw({ studentId: STU_A, endedOn }).expect(201);
    expect(done.body).toMatchObject({ canConfirm: true, confirmBlockedReason: null });
    expect(done.body.invoices).toEqual([expect.objectContaining({ id: invA.id, voided: true, needsCeoVoid: false, state: 'void' })]);
  });

  it('청구서가 남는 종료는 금액 예외 매니저도 한다 — 막는 것은 취소 하나뿐이다 (S2)', async () => {
    const ids = await fiveLessons([STU_A, STU_B]);
    const invA = await paidInvoice(STU_A);
    // 첫날 뒤로 종료 — 1회는 청구에 남는다(0 원이 되지 않는다)
    // 첫날 ONCE 는 종료일에 이미 끝나 있어 대상이 아니다(WITHDRAW_BAD_SERIES) — 나머지 넷만 고른다
    const res = await withdraw({ studentId: STU_A, endedOn: DAYS[0], serIds: ids.slice(1) }, moneyMgrToken).expect(201);
    expect(res.body).toMatchObject({ canConfirm: true, confirmBlockedReason: null });
    expect(res.body.invoices).toEqual([expect.objectContaining({ id: invA.id, voided: false, needsCeoVoid: false })]);
  });

  it('마감 달의 종료일은 409 MONTH_CLOSED · 금액 권한 없는 매니저는 403 · 청구서가 없으면 환불 없이 명단만 정리된다', async () => {
    const ids = await fiveLessons();
    await api('post', '/accounting/tuition/close').send({ month: THIS }).expect(201);
    const closed = await withdraw({ studentId: STU_A, endedOn: kst() }).expect(409);
    expect(closed.body.code).toBe('MONTH_CLOSED');
    await withdraw({ studentId: STU_A, endedOn: DAYS[0] }, managerToken).expect(403);
    // 청구서 없음 — 환불 0 · 명단만
    const res = await withdraw({ studentId: STU_A, endedOn: DAYS[0] }).expect(201);
    expect(res.body).toMatchObject({ remainingCount: 4, refundTotal: 0, invoices: [], enrollmentsEnded: 0 });
    // 1일차 ONCE 는 종료일에 이미 끝나 있어 그대로, 나머지 넷에 종료일
    expect(await q(`SELECT 1 FROM ser_stu WHERE student_id = $1 AND ser_id = ANY($2) AND to_date = $3::date`, [STU_A, ids, DAYS[0]])).toHaveLength(4);
    // 이제 내는 청구서는 종료일까지의 회차만 — 1회 × 2인 단가 (B 도 그날은 둘이었다)
    const inv = (await api('post', '/accounting/invoices').send({ studentId: STU_A, yearMonth: NEXT, invType: 'tuition' }).expect(201)).body;
    expect(inv.lines).toEqual([expect.objectContaining({ count: 1, unitPrice: DUO })]);
  });
});
