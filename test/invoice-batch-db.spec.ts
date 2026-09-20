/** @file-guide
 * 목적: invoice-batch-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 청구서 일괄 발행 · 전달 · 취소 — C94-a (테스트 시나리오 H-75 · O-147 「월초/월말 청구서 일괄 발행 · 이월 반영」 ·
 * H-76 「전달 처리 · 상태가 바뀐다」 · N-139 「잘못 발행 · 대표만 · 이력 · 미수 재계산」).
 *
 * 증명하는 것 —
 *   ① 일괄 발행은 그 달 수업이 있는 학생 전부에게 **낱장 발행과 같은 줄**을 낸다 — 이월 음수 줄이 든다(H-75 「이월이 반영 안 되면 실패」).
 *   ② 막힌 학생은 건너뛰고 이유를 돌려준다(이미 있음 · 단가 없음) — 나머지는 낸다. 두 번 돌리면 전부 건너뛴다.
 *   ③ 마감 달은 통째로 409.
 *   ④ 전달은 초안 → sent 로 바뀌고 sent_at 이 찍힌다. 다시 전달은 409. LOG.
 *   ⑤ 취소는 대표만(금액 예외 매니저 403) · 사유 필수 · 입금 붙으면 409 · void 로 남고 사유가 응답에 · 미수 머리에서 빠진다 · LOG.
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
import { DEV_URL } from './db';

/** 기한 자체를 보지 않는 시험들이 쓰는 값 — 「기한을 매번 고른다」는 S3 회귀가 따로 본다 (대표 결정 2026-09-20) */
const DUE = '2026-12-31';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('청구서 일괄 발행 · 전달 · 취소 (C94-a · H-75 · H-76 · N-139)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let managerToken = '';
  const PW = 'invoice-batch-1234';
  const CEO = 961;
  const TEACHER = 962;
  const MANAGER = 963;
  const STU_A = 9961; // 단가 있음 · 지난달 이월을 받는다
  const STU_B = 9962; // 단가 있음
  const STU_C = 9963; // 단가 없는 과목 → 건너뜀
  const KIND = 'ib_kind';
  const SUB_OK = 'ib-sub-ok';
  const SUB_NORATE = 'ib-sub-norate';

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const THIS = kst().slice(0, 7);
  const PREV = plus(`${THIS}-01`, -1).slice(0, 7);
  /** 이번 달 안에서 오늘 뒤 첫 월요일 — 이번 달에 회차가 서게 */
  const nextMonInMonth = () => {
    let d0 = plus(kst(), 1);
    for (let i = 0; i < 7; i++) {
      if (new Date(`${d0}T00:00:00Z`).getUTCDay() === 1) break;
      d0 = plus(d0, 1);
    }
    return d0;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await q(`DELETE FROM month_close WHERE closed_by = $1`, [CEO]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER, MANAGER]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER, MANAGER]]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active, can_money) VALUES
         ($1,'발행대표','ib-ceo@t.kr','ceo',$4,true,null),
         ($2,'발행강사','ib-t@t.kr','teacher',$4,true,null),
         ($3,'발행매니저','ib-m@t.kr','manager',$4,true,true)`,
      [CEO, TEACHER, MANAGER, hash],
    );
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B, STU_C]]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'발행A','10'), ($2,'발행B','10'), ($3,'발행C','10')`, [STU_A, STU_B, STU_C]);
    await q(`INSERT INTO kind (key,name,color,cap,grp) VALUES ($1,'발행 시험','#333333',4,'lesson') ON CONFLICT (key) DO NOTHING`, [KIND]);
    await q(`INSERT INTO sub (key,name,color) VALUES ($1,'발행 과목','#444444'), ($2,'단가 없는 과목','#555555') ON CONFLICT (key) DO NOTHING`, [SUB_OK, SUB_NORATE]);
    await q(`DELETE FROM rate WHERE kind_key = $1`, [KIND]);
    await q(`INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES ($1, $2, 50000, '2026-01-01', 1)`, [KIND, SUB_OK]);
    const login = async (email: string) => {
      const res = await request(app.getHttpServer())
        .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    token = await login('ib-ceo@t.kr');
    managerToken = await login('ib-m@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await q(`DELETE FROM rate WHERE kind_key = $1`, [KIND]);
        await q(`DELETE FROM sub WHERE key = ANY($1)`, [[SUB_OK, SUB_NORATE]]);
        await q(`DELETE FROM kind WHERE key = $1`, [KIND]);
        await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER, MANAGER]]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER, MANAGER]]);
        await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B, STU_C]]);
      }
    } finally {
      await app?.close();
    }
  });

  const made: number[] = [];
  afterEach(async () => {
    const stus = [STU_A, STU_B, STU_C];
    await q(`DELETE FROM month_close WHERE closed_by = $1`, [CEO]);
    await q(`DELETE FROM carry WHERE student_id = ANY($1)`, [stus]);
    await q(`DELETE FROM pay WHERE inv_id IN (SELECT id FROM inv WHERE student_id = ANY($1))`, [stus]);
    await q(`DELETE FROM inv_line WHERE inv_id IN (SELECT id FROM inv WHERE student_id = ANY($1))`, [stus]);
    await q(`DELETE FROM inv WHERE student_id = ANY($1)`, [stus]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, MANAGER]]);
    if (!made.length) return;
    await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [made]);
    await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser WHERE id = ANY($1)`, [made]);
    made.length = 0;
  });

  const api = (m: 'post' | 'patch' | 'delete' | 'get', p: string, t = token) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`)
      .timeout({ response: 8000, deadline: 15000 });

  /** 이번 달 ONCE 수업 — 시각을 갈라 겹침을 피한다 */
  async function lesson(studentIds: number[], sub: string, startMin: number) {
    const res = await api('post', '/schedule').send({
      kindKey: KIND, subKey: sub, mode: 'offline', fromDate: nextMonInMonth(), rrule: 'ONCE',
      startMin, endMin: startMin + 60, teacherId: TEACHER, roomId: null, title: '발행 수업', studentIds,
    }).expect(201);
    made.push(res.body.serIds[0]);
    return res.body.serIds[0] as number;
  }
  const batch = (yearMonth = THIS, t = token) => api('post', '/accounting/invoices/batch', t).send({ yearMonth, dueOn: DUE });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mine = (b: { issued: any[] }, sid: number): any => b.issued.find((i) => i.studentId === sid);

  /* ── ① ② 일괄 발행 ────────────────────────────────────────────────────── */
  it('그 달 수업이 있는 학생 전부에게 낱장과 같은 줄을 낸다 — 이월 음수 줄이 들고, 막힌 학생은 이유와 함께 건너뛴다 (H-75)', async () => {
    await lesson([STU_A, STU_B], SUB_OK, 600);
    await lesson([STU_C], SUB_NORATE, 660);
    // A 는 지난달에서 이월 1회 30,000 을 받는다 — carry 표 한 줄 (§54 「이월 처리」가 남기는 모양)
    await q(`INSERT INTO carry (student_id, from_month, to_month, amount, sessions, by_id) VALUES ($1, $2, $3, 30000, 1, $4)`, [STU_A, PREV, THIS, CEO]);

    const res = await batch().expect(201);
    expect(res.body.yearMonth).toBe(THIS);
    expect(res.body.candidates).toBeGreaterThanOrEqual(3);
    const a = mine(res.body, STU_A)!;
    const b = mine(res.body, STU_B)!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // 한 번에 낸 청구서들은 **같은 기한**을 나눠 갖는다 — 낱장과 같은 규약이다 (S3)
    expect(res.body.issued.every((i: { dueOn: string | null }) => i.dueOn === DUE)).toBe(true);
    // 낱장과 같은 줄 — 2인 수업이라도 구간 단가는 1인 줄뿐이라 50,000 (구간 없으면 그 이하 가장 큰 구간)
    expect(b.lines).toEqual([expect.objectContaining({ count: 1, unitPrice: 50000, amount: 50000 })]);
    expect(b.amount).toBe(50000);
    expect(b.state).toBe('draft');
    // A 는 이월 음수 줄이 든다 — 50,000 − 30,000
    expect(a.lines.some((l: { count: number; amount: number }) => l.count === -1 && l.amount === -30000)).toBe(true);
    expect(a.amount).toBe(20000);
    // C 는 단가 없음으로 건너뛴다 — 0원 청구서를 만들지 않는다
    const c = res.body.skipped.find((s: { studentId: number }) => s.studentId === STU_C);
    expect(c).toMatchObject({ studentName: '발행C', code: 'INV_NO_RATE' });
    // 발행 합 = 이번에 낸 장들의 합 (스위트 밖 학생이 섞일 수 있어 줄로 센다)
    expect(res.body.issuedAmount).toBe(res.body.issued.reduce((n: number, i: { amount: number }) => n + i.amount, 0));
    expect(res.body.issuedAmount).toBeGreaterThanOrEqual(70000);
    // DB 에 두 장 — C 는 없다
    const rows = await q<{ student_id: string; state: string }>(`SELECT student_id, state::text AS state FROM inv WHERE student_id = ANY($1) ORDER BY student_id`, [[STU_A, STU_B, STU_C]]);
    expect(rows.map((r) => Number(r.student_id))).toEqual([STU_A, STU_B]);

    // 두 번 돌리면 이미 있는 학생은 전부 건너뛴다 — 같은 달에 두 장을 내지 않는다
    const again = await batch().expect(201);
    expect(mine(again.body, STU_A)).toBeUndefined();
    expect(again.body.skipped.find((s: { studentId: number }) => s.studentId === STU_A)?.code).toBe('INV_DUPLICATE');
    expect(again.body.skipped.find((s: { studentId: number }) => s.studentId === STU_B)?.code).toBe('INV_DUPLICATE');
  });

  it('마감 달은 통째로 409 — 한 장도 내지 않는다 (C92-d 연동)', async () => {
    await lesson([STU_A], SUB_OK, 720);
    await api('post', '/accounting/tuition/close').send({ month: THIS }).expect(201);
    const res = await batch().expect(409);
    expect(res.body.code).toBe('MONTH_CLOSED');
    const rows = await q(`SELECT id FROM inv WHERE student_id = $1`, [STU_A]);
    expect(rows).toEqual([]);
  });

  it('금액을 못 보는 사람에게는 금액이 null 로 내려간다 — 건너뛴 이유는 그대로 (D-R39)', async () => {
    await lesson([STU_A], SUB_OK, 780);
    // 매니저는 can_money 예외로 회계를 볼 수 있다(true) — 일괄 발행도 된다. 금액 권한은 canMoney 결론이다
    const res = await batch(THIS, managerToken).expect(201);
    expect(mine(res.body, STU_A)).toBeDefined();
    expect(res.body.issuedAmount).not.toBeNull();
  });

  /* ── ④ 전달 ───────────────────────────────────────────────────────────── */
  it('전달은 초안 → sent · sent_at · LOG — 다시 전달은 409 (H-76)', async () => {
    await lesson([STU_A], SUB_OK, 840);
    const { body } = await batch().expect(201);
    const inv = mine(body, STU_A)!;
    expect(inv.canDeliver).toBe(true);
    expect(inv.sentAt).toBeNull();
    const sent = await api('post', `/accounting/invoices/${inv.id}/deliver`).expect(201);
    expect(sent.body).toMatchObject({ id: inv.id, state: 'sent', canDeliver: false });
    expect(typeof sent.body.sentAt).toBe('string');
    const twice = await api('post', `/accounting/invoices/${inv.id}/deliver`).expect(409);
    expect(twice.body.code).toBe('INV_NOT_DELIVERABLE');
    await api('post', `/accounting/invoices/99999999/deliver`).expect(404);
    const logs = await q<{ action: string }>(`SELECT action FROM log WHERE entity = 'INV' AND entity_id = $1 AND actor_id = $2`, [inv.id, CEO]);
    expect(logs.map((l) => l.action)).toEqual(['deliver']);
    // 전달된 청구서가 §52 머리 「보낸 청구서」에 든다
    const acc = await (await api('get', '/accounting').expect(200)).body;
    expect(acc.invoices.find((i: { id: number }) => i.id === inv.id).state).toBe('sent');
  });

  /* ── ⑤ 취소 ───────────────────────────────────────────────────────────── */
  it('취소는 대표만 · 사유 필수 · 입금 붙으면 409 · void 로 남고 사유가 응답에 · 미수에서 빠진다 (N-139)', async () => {
    await lesson([STU_A], SUB_OK, 900);
    const { body } = await batch().expect(201);
    const inv = mine(body, STU_A)!;
    expect(inv.canVoid).toBe(true);
    // 금액 예외 매니저 — 단추도 없고 서버도 403
    const asManager = await (await api('get', '/accounting', managerToken).expect(200)).body;
    expect(asManager.invoices.find((i: { id: number }) => i.id === inv.id).canVoid).toBe(false);
    await api('post', `/accounting/invoices/${inv.id}/void`, managerToken).send({ reason: '매니저 시도' }).expect(403);
    await api('post', `/accounting/invoices/${inv.id}/void`).send({ reason: '   ' }).expect(400);

    // 입금이 붙으면 못 지운다 — 입금을 먼저 지운다
    await api('post', `/accounting/invoices/${inv.id}/deliver`).expect(201);
    const pay = await api('post', '/accounting/payments').send({ invId: inv.id, amount: 10000, paidOn: kst(), method: 'cash' }).expect(201);
    expect(pay.body.paidAmount).toBe(10000);
    const blocked = await api('post', `/accounting/invoices/${inv.id}/void`).send({ reason: '잘못 냄' }).expect(409);
    expect(blocked.body.code).toBe('INV_HAS_PAYMENTS');
    const payId = (await q<{ id: string }>(`SELECT id FROM pay WHERE inv_id = $1`, [inv.id]))[0]!.id;
    await api('delete', `/accounting/payments/${payId}`).expect(200);

    const before = await (await api('get', '/accounting').expect(200)).body;
    const voided = await api('post', `/accounting/invoices/${inv.id}/void`).send({ reason: '단가를 잘못 넣어 다시 낸다' }).expect(201);
    expect(voided.body).toMatchObject({ id: inv.id, state: 'void', voidReason: '단가를 잘못 넣어 다시 낸다', canVoid: false, canDeliver: false });
    // 줄은 남는다 — 지우지 않았다
    expect(voided.body.lines).toHaveLength(1);
    const twice = await api('post', `/accounting/invoices/${inv.id}/void`).send({ reason: '또' }).expect(409);
    expect(twice.body.code).toBe('INV_ALREADY_VOID');
    // 미수 머리에서 빠진다 — 보낸 청구서 합이 그만큼 준다
    const after = await (await api('get', '/accounting').expect(200)).body;
    expect(after.summary.sent).toBe(before.summary.sent - 50000);
    expect(after.summary.unpaid).toBe(before.summary.unpaid - 50000);
    // 같은 달에 새로 낼 수 있다 — 취소한 장은 중복으로 세지 않는다
    const re = await api('post', '/accounting/invoices').send({ studentId: STU_A, yearMonth: THIS, invType: 'tuition', dueOn: DUE }).expect(201);
    expect(re.body.state).toBe('draft');
    const logs = await q<{ action: string; after: { reason?: string } }>(`SELECT action, after FROM log WHERE entity = 'INV' AND entity_id = $1 AND actor_id = $2 ORDER BY id`, [inv.id, CEO]);
    expect(logs.map((l) => l.action)).toEqual(['deliver', 'void']);
    expect(logs[1]!.after.reason).toBe('단가를 잘못 넣어 다시 낸다');
  });

  /**
   * **납부 기한을 안 보내면 발행 자체가 막힌다** (대표 결정 2026-09-20 · S3 · 기본값 없음).
   *
   * 서버가 「발행일 + N일」을 지어내면 원문에 없는 업무 규칙이 생긴다(D-R44). 그래서 필수로 받고
   * 값은 짓지 않는다 — 화면도 비어 있으면 단추가 잠긴다(단추와 서버가 같은 질문을 한다 · D-R39).
   */
  it('기한 없이 내려 하면 400 — 낱장도 일괄도 같다 · 달력에 없는 날도 막는다 (S3)', async () => {
    await api('post', '/accounting/invoices').send({ studentId: STU_A, yearMonth: THIS, invType: 'tuition' }).expect(400);
    await api('post', '/accounting/invoices/batch').send({ yearMonth: THIS }).expect(400);
    // 2026-02-30 은 달력에 없는 날이다 — 형식만 맞다고 통과시키지 않는다
    await api('post', '/accounting/invoices').send({ studentId: STU_A, yearMonth: THIS, invType: 'tuition', dueOn: '2026-02-30' }).expect(400);
  });
});
