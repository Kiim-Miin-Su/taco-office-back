/** @file-guide
 * 목적: accounting-billing-w11-http.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 회계 청구 W11 — HTTP 계약 (N-75 · N-79 · N-28 ② · 개발 DB · 스위트 전용 번호대로 만들고 스스로 치운다).
 *
 * 증명하는 것 —
 *   ① `GET /meta` 청구 종류 — 진단고사 + 상담 · 응시료가 열리고 컨설팅비는 「청구서로 전환」 문장으로 잠긴다 · 응시료만 사람이 줄을 적는다.
 *   ② `GET /accounting/invoices/draft` — 입력 검증(400) · 강사 403 · 발행과 같은 금액.
 *   ③ `POST /accounting/invoices` — 분납 일정(2~12회차 · 기한 칸 없이도) · 응시료 줄 · 입력 검증(400).
 *   ④ `GET /accounting/board` — §53 다섯 칸: ① 「아직 안 씀」이 청구 대상을 예상 금액과 함께 내리고, 발행 → 전달 → 입금으로
 *      카드가 저절로 칸을 옮긴다(다음 칸 단추가 부르는 쓰기 그대로).
 *   ⑤ 수강 종료 환불이 분납 일정의 **끝 회차부터** 줄인다 — 커밋 때 지연 제약(합 = 청구액)을 지난다.
 *   ⑥ 다 채운 분납 카드는 「기한 없음」이 아니라 기한(마지막 회차 예정일)을 적는다.
 */
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('회계 청구 W11 — HTTP 계약 (N-75 · N-79 · N-28 ②)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let teacherToken = '';
  const PW = 'w11-billing-1234';
  const CEO = 9282;
  const TEACHER = 9283;
  const STU_A = 99281;
  const STU_B = 99282;
  const KIND = 'w11h_kind';
  const SUB = 'w11h-sub';

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const THIS = kst().slice(0, 7);
  const NEXT = plus(`${THIS}-28`, 7).slice(0, 7);
  /** 그 달 안의 월요일들 — 회차가 그 달에 서게 */
  const mondaysOf = (ym: string) => {
    const out: string[] = [];
    for (let day = `${ym}-01`; day.startsWith(ym); day = plus(day, 1)) {
      if (new Date(`${day}T00:00:00Z`).getUTCDay() === 1) out.push(day);
    }
    return out;
  };
  const DUE = `${NEXT}-28`;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER]]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'청구대표','w11h-ceo@t.kr','ceo',$3,true),
         ($2,'청구강사','w11h-t@t.kr','teacher',$3,true)`,
      [CEO, TEACHER, hash],
    );
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B]]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'청구A','10'), ($2,'청구B','10')`, [STU_A, STU_B]);
    await q(`INSERT INTO kind (key,name,color,cap,grp) VALUES ($1,'청구 시험','#333333',4,'lesson') ON CONFLICT (key) DO NOTHING`, [KIND]);
    await q(`INSERT INTO sub (key,name,color) VALUES ($1,'청구 과목','#444444') ON CONFLICT (key) DO NOTHING`, [SUB]);
    await q(`DELETE FROM rate WHERE kind_key = $1`, [KIND]);
    await q(`INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES ($1, $2, 50000, '2026-01-01', 1)`, [KIND, SUB]);
    const login = async (loginId: string) => {
      const res = await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ loginId, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    token = await login('w11h-ceo@t.kr');
    teacherToken = await login('w11h-t@t.kr');
  });

  const made: number[] = [];
  const cleanup = async () => {
    const stus = [STU_A, STU_B];
    const invIds = (await q<{ id: string }>(`SELECT id FROM inv WHERE student_id = ANY($1)`, [stus])).map((r) => Number(r.id));
    await q(`DELETE FROM log WHERE entity = 'INV' AND entity_id = ANY($1::bigint[])`, [invIds]);
    await q(`DELETE FROM log WHERE actor_id = $1`, [CEO]);
    await q(`DELETE FROM pay WHERE student_id = ANY($1)`, [stus]);
    await q(`DELETE FROM inv_line WHERE inv_id = ANY($1::bigint[])`, [invIds]);
    await q(`DELETE FROM inv WHERE id = ANY($1::bigint[])`, [invIds]);
    // 「전달」이 만든 학부모 안내(PNOTI · stu FK · H-76)는 학생을 지우기 전에 치운다
    await q(`DELETE FROM pnoti WHERE student_id = ANY($1)`, [stus]);
    await q(`DELETE FROM enr WHERE student_id = ANY($1)`, [stus]);
    if (!made.length) return;
    await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [made]);
    await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser WHERE id = ANY($1)`, [made]);
    made.length = 0;
  };
  afterEach(cleanup);
  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await cleanup();
        await q(`DELETE FROM rate WHERE kind_key = $1`, [KIND]);
        await q(`DELETE FROM sub WHERE key = $1`, [SUB]);
        await q(`DELETE FROM kind WHERE key = $1`, [KIND]);
        await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER]]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER]]);
        await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B]]);
      }
    } finally {
      await app?.close();
    }
  });

  const api = (m: 'post' | 'get', p: string, t = token) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`).timeout({ response: 8000, deadline: 15000 });

  /** 그 날짜의 ONCE 수업 — 시각을 갈라 겹침을 피한다 */
  async function lesson(studentIds: number[], on: string, startMin: number, kindKey = KIND, subKey: string | null = SUB) {
    const res = await api('post', '/schedule').send({
      kindKey, subKey, mode: 'offline', fromDate: on, rrule: 'ONCE',
      startMin, endMin: startMin + 60, teacherId: TEACHER, roomId: null, title: 'W11 청구 수업', studentIds,
    }).expect(201);
    made.push(res.body.serIds[0]);
    return res.body.serIds[0] as number;
  }

  it('① /meta 청구 종류 — 진단고사 + 상담 · 응시료는 열리고 컨설팅비는 「청구서로 전환」으로 잠긴다 · 줄을 사람이 적는 종류는 응시료뿐', async () => {
    const meta = (await api('get', '/meta').expect(200)).body as { invTypes: Array<{ key: string; issuable: boolean; issueBlockedReason: string | null; manualLines: boolean }> };
    const by = Object.fromEntries(meta.invTypes.map((t) => [t.key, t]));
    expect(by.tuition).toMatchObject({ issuable: true, issueBlockedReason: null, manualLines: false });
    expect(by.diag_intake).toMatchObject({ issuable: true, issueBlockedReason: null, manualLines: false });
    expect(by.exam_fee).toMatchObject({ issuable: true, issueBlockedReason: null, manualLines: true });
    expect(by.consulting!.issuable).toBe(false);
    expect(by.consulting!.issueBlockedReason).toContain('청구서로 전환');
  });

  it('② 미리 세기 — 입력 검증 400 · 강사 403 · 발행과 같은 금액', async () => {
    const [mon] = mondaysOf(NEXT);
    await lesson([STU_A], mon!, 600);
    await api('get', `/accounting/invoices/draft?studentId=abc&yearMonth=${NEXT}&invType=tuition`).expect(400);
    await api('get', `/accounting/invoices/draft?studentId=${STU_A}&yearMonth=2026-13&invType=tuition`).expect(400);
    await api('get', `/accounting/invoices/draft?studentId=${STU_A}&yearMonth=${NEXT}&invType=exam_fee`).expect(400);
    await api('get', `/accounting/invoices/draft?studentId=${STU_A}&yearMonth=${NEXT}&invType=tuition`, teacherToken).expect(403);
    const draft = (await api('get', `/accounting/invoices/draft?studentId=${STU_A}&yearMonth=${NEXT}&invType=tuition`).expect(200)).body;
    expect(draft).toMatchObject({ studentId: STU_A, amount: 50_000, canIssue: true, blockedCode: null });
    const inv = (await api('post', '/accounting/invoices').send({ studentId: STU_A, yearMonth: NEXT, invType: 'tuition', dueOn: DUE }).expect(201)).body;
    expect(inv.amount).toBe(draft.amount);
  });

  it('③ 분납 일정 · 응시료 줄 — 기한 칸 없이도 분납으로 낸다 · 1회차뿐이면 400 · 기한도 분납도 없으면 400', async () => {
    const [m1, m2] = mondaysOf(NEXT);
    await lesson([STU_A], m1!, 600);
    await lesson([STU_A], m2!, 600);
    const base = { studentId: STU_A, yearMonth: NEXT, invType: 'tuition' };
    await api('post', '/accounting/invoices').send(base).expect(400);
    await api('post', '/accounting/invoices').send({ ...base, installments: [{ dueOn: DUE, amount: 100_000 }] }).expect(400);
    await api('post', '/accounting/invoices').send({ ...base, installments: [{ dueOn: '2026-02-30', amount: 50_000 }, { dueOn: DUE, amount: 50_000 }] }).expect(400);
    const inv = (await api('post', '/accounting/invoices').send({
      ...base, installments: [{ dueOn: DUE, amount: 70_000 }, { dueOn: `${NEXT}-10`, amount: 30_000 }],
    }).expect(201)).body;
    expect(inv).toMatchObject({ amount: 100_000, dueOn: DUE, nextDueOn: `${NEXT}-10`, nextInstallmentSeq: 1 });
    expect(inv.installments.map((x: { seq: number; amount: number }) => [x.seq, x.amount])).toEqual([[1, 30_000], [2, 70_000]]);

    // 응시료 — 줄은 사람이 적는다. 금액 0 · 줄 없음은 400
    const fee = { studentId: STU_B, yearMonth: NEXT, invType: 'exam_fee', dueOn: DUE };
    await api('post', '/accounting/invoices').send({ ...fee, lines: [{ label: 'MAP 응시료', amount: 0 }] }).expect(400);
    await api('post', '/accounting/invoices').send({ ...fee, lines: [] }).expect(400);
    const made2 = (await api('post', '/accounting/invoices').send({ ...fee, lines: [{ label: 'MAP 응시료', amount: 95_000 }] }).expect(201)).body;
    expect(made2).toMatchObject({ amount: 95_000, invType: 'exam_fee', invTypeLabel: 'MAP + CAT 응시료' });
    // 컨설팅비는 발행 창에서 막힌다
    const cons = await api('post', '/accounting/invoices').send({ studentId: STU_B, yearMonth: NEXT, invType: 'consulting', dueOn: DUE }).expect(409);
    expect(cons.body.code).toBe('INV_TYPE_NOT_SUPPORTED');
  });

  it('④ §53 다섯 칸 — ① 이 청구 대상을 예상 금액과 내리고, 발행 → 전달 → 입금으로 카드가 저절로 칸을 옮긴다', async () => {
    const mondays = mondaysOf(THIS);
    const today = kst();
    const on = mondays.find((x) => x > today) ?? mondays[mondays.length - 1]!;
    await lesson([STU_A], on, 1260);
    const board = async () => (await api('get', '/accounting/board').expect(200)).body;
    const b0 = await board();
    expect(b0.candidateMonth).toBe(THIS);
    expect(b0.stages.map((s: { key: string }) => s.key)).toEqual(['todo', 'draft', 'sent', 'paid', 'record']);
    expect(b0.stages.map((s: { label: string }) => s.label)).toEqual(['아직 안 씀', '청구서 작성', '학부모 안내', '입금 완료', '입금 기록']);
    expect(b0.stages.map((s: { next: string | null }) => s.next)).toEqual(['issue', 'deliver', 'pay', null, null]);
    const cand = b0.stages[0].candidates.find((c: { studentId: number }) => c.studentId === STU_A);
    expect(cand).toMatchObject({ yearMonth: THIS, invType: 'tuition', amount: 50_000, canIssue: true, issueBlockedReason: null });
    // §52 네 칸은 그대로다
    expect(b0.columns.map((c: { key: string }) => c.key)).toEqual(['draft', 'sent', 'paid', 'record']);

    const inv = (await api('post', '/accounting/invoices').send({ studentId: STU_A, yearMonth: THIS, invType: 'tuition', dueOn: DUE }).expect(201)).body;
    const where = async () => {
      const b = await board();
      return b.stages.find((s: { cards: Array<{ invId: number }>; candidates: Array<{ studentId: number }> }) =>
        s.cards.some((c) => c.invId === inv.id))?.key ?? null;
    };
    const b1 = await board();
    expect(b1.stages[0].candidates.some((c: { studentId: number }) => c.studentId === STU_A)).toBe(false);
    expect(await where()).toBe('draft');
    await api('post', `/accounting/invoices/${inv.id}/deliver`).expect(201);
    expect(await where()).toBe('sent');
    await api('post', '/accounting/payments').send({ requestKey: randomUUID(), invId: inv.id, amount: 20_000, paidOn: today, method: 'cash' }).expect(201);
    expect(await where()).toBe('record');
    await api('post', '/accounting/payments').send({ requestKey: randomUUID(), invId: inv.id, amount: 30_000, paidOn: today, method: 'cash' }).expect(201);
    expect(await where()).toBe('paid');
  });

  it('⑥ 다 채운 분납(완납) 카드는 「기한 없음」이 아니라 기한(= 마지막 회차 예정일)을 적는다 — 연체는 아니다', async () => {
    const [m1] = mondaysOf(NEXT);
    await lesson([STU_B], m1!, 720);
    const inv = (await api('post', '/accounting/invoices').send({
      studentId: STU_B, yearMonth: NEXT, invType: 'tuition',
      installments: [{ dueOn: `${NEXT}-05`, amount: 20_000 }, { dueOn: `${NEXT}-25`, amount: 30_000 }],
    }).expect(201)).body;
    await api('post', `/accounting/invoices/${inv.id}/deliver`).expect(201);
    await api('post', '/accounting/payments').send({ requestKey: randomUUID(), invId: inv.id, amount: 50_000, paidOn: kst(), method: 'cash' }).expect(201);
    const b = (await api('get', '/accounting/board').expect(200)).body;
    const paid = b.stages.find((s: { key: string }) => s.key === 'paid');
    const card = paid.cards.find((c: { invId: number }) => c.invId === inv.id);
    expect(card).toMatchObject({ dueOn: `${NEXT}-25`, overdueDays: 0 });
    expect(card.whenLabel).not.toBe('기한 없음');
  });

  it('⑤ 수강 종료 환불은 분납 일정을 **끝 회차부터** 줄인다 — 합 = 새 청구액이라 커밋이 지나간다', async () => {
    const [m1, m2] = mondaysOf(NEXT);
    await lesson([STU_B], m1!, 660);
    await lesson([STU_B], m2!, 660);
    const inv = (await api('post', '/accounting/invoices').send({
      studentId: STU_B, yearMonth: NEXT, invType: 'tuition',
      installments: [{ dueOn: `${NEXT}-05`, amount: 30_000 }, { dueOn: `${NEXT}-25`, amount: 70_000 }],
    }).expect(201)).body;
    const res = (await api('post', '/accounting/withdrawals').send({ studentId: STU_B, endedOn: m1!, reason: '시험' }).expect(201)).body;
    expect(res.invoices.find((i: { id: number }) => i.id === inv.id)).toMatchObject({ amountBefore: 100_000, amountAfter: 50_000 });
    const rows = await q<{ seq: number; amount: number }>(`SELECT seq, amount FROM inv_installment WHERE inv_id = $1 ORDER BY seq`, [inv.id]);
    expect(rows.map((r) => [Number(r.seq), Number(r.amount)])).toEqual([[1, 30_000], [2, 20_000]]);
    const acc = (await api('get', '/accounting').expect(200)).body;
    const after = acc.invoices.find((i: { id: number }) => i.id === inv.id);
    expect(after.installments.map((x: { amount: number }) => x.amount)).toEqual([30_000, 20_000]);
  });
});
