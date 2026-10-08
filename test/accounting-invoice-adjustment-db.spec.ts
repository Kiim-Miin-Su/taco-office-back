/** @file-guide
 * 목적: BO-11BD-01 청구 조정의 신청·대표 승인·반려·반영 취소·되돌리기와 청구액/월마감 불변식을 PostgreSQL로 검증한다. (test)
 * 책임/재사용: 기존 INV·월마감·권한을 재사용하고 current/event/base 원장의 transaction·멱등·stale·직접쓰기 방어를 검증한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11BD01-INVOICE-ADJUSTMENT-APPROVAL-2026-10-09.md · migration 1768200000000
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import type { InvoiceAdjustmentLedgerDto } from '../src/modules/accounting/accounting.dto';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('BO-11BD-01 청구 조정 승인 원장', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  let adminToken = '';
  let teacherToken = '';
  let invoiceId = 0;
  let plainInvoiceId = 0;

  const CEO = 9948201;
  const ADMIN = 9948202;
  const TEACHER = 9948203;
  const STUDENT = 9948211;
  const PLAIN_STUDENT = 9948212;
  const MONTH = '2001-07';
  const PASSWORD = 'boc11-adjustment-1234';
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    ds.query(sql, params) as Promise<T[]>;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const cleanup = async () => {
    await ds.transaction(async (m) => {
      // 불변 원장은 제품 방어다. 합성 fixture 범위만 trigger를 잠시 끄고 같은 transaction에서 제거한다.
      await m.query(`ALTER TABLE invoice_adjustment_event DISABLE TRIGGER invoice_adjustment_event_immutable`);
      await m.query(`ALTER TABLE invoice_adjustment DISABLE TRIGGER invoice_adjustment_row_guard`);
      await m.query(`ALTER TABLE invoice_adjustment_base DISABLE TRIGGER invoice_adjustment_base_immutable`);
      await m.query(`DELETE FROM invoice_adjustment_event WHERE actor_id = ANY($1::bigint[])`, [[CEO, ADMIN, TEACHER]]);
      await m.query(`DELETE FROM invoice_adjustment WHERE student_id=$1`, [STUDENT]);
      await m.query(`DELETE FROM invoice_adjustment_base WHERE inv_id IN (SELECT id FROM inv WHERE student_id=$1)`, [STUDENT]);
      await m.query(`ALTER TABLE invoice_adjustment_base ENABLE TRIGGER invoice_adjustment_base_immutable`);
      await m.query(`ALTER TABLE invoice_adjustment ENABLE TRIGGER invoice_adjustment_row_guard`);
      await m.query(`ALTER TABLE invoice_adjustment_event ENABLE TRIGGER invoice_adjustment_event_immutable`);
    });
    await q(`DELETE FROM noti WHERE to_id = ANY($1::bigint[]) OR from_id = ANY($1::bigint[])`, [[CEO, ADMIN, TEACHER]]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1::bigint[]) AND entity='INV_ADJUSTMENT'`, [[CEO, ADMIN, TEACHER]]);
    await q(`DELETE FROM month_close WHERE year_month=$1`, [MONTH]);
    await q(`DELETE FROM inv WHERE student_id = ANY($1::bigint[])`, [[STUDENT, PLAIN_STUDENT]]);
    await q(`DELETE FROM stu WHERE id = ANY($1::bigint[])`, [[STUDENT, PLAIN_STUDENT]]);
    await q(`DELETE FROM staff WHERE id = ANY($1::bigint[])`, [[CEO, ADMIN, TEACHER]]);
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await cleanup();

    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    await q(
      `INSERT INTO staff(id,name,email,role,password_hash,active) VALUES
        ($1,'조정대표','boc11-adjustment-ceo@t.kr','ceo',$4,true),
        ($2,'조정관리자','boc11-adjustment-admin@t.kr','admin',$4,true),
        ($3,'조정강사','boc11-adjustment-teacher@t.kr','teacher',$4,true)`,
      [CEO, ADMIN, TEACHER, passwordHash],
    );
    await q(`INSERT INTO stu(id,name,grade,created_at) VALUES
      ($1,'조정학생','10',current_date),($2,'일반청구학생','10',current_date)`, [STUDENT, PLAIN_STUDENT]);
    const [invoice] = await q<{ id: string }>(`INSERT INTO inv
      (student_id,year_month,inv_type,title,amount,state,issued_on,due_on,sent_at,created_by,paid_amount,paid_at)
      VALUES($1,$2,'tuition','조정 검증 청구',250000,'paid',$3::date,$4::date,now(),$5,250000,now()) RETURNING id`,
    [STUDENT, MONTH, `${MONTH}-01`, `${MONTH}-10`, ADMIN]);
    invoiceId = Number(invoice.id);
    const [plainInvoice] = await q<{ id: string }>(`INSERT INTO inv
      (student_id,year_month,inv_type,title,amount,state,issued_on,due_on,sent_at,created_by,paid_amount,paid_at)
      VALUES($1,$2,'tuition','일반 초과수납 방어',100000,'paid',$3::date,$4::date,now(),$5,100000,now()) RETURNING id`,
    [PLAIN_STUDENT, MONTH, `${MONTH}-01`, `${MONTH}-10`, ADMIN]);
    plainInvoiceId = Number(plainInvoice.id);

    const login = async (loginId: string) => (await request(app.getHttpServer())
      .post('/auth/login').send({ loginId, password: PASSWORD }).expect(201)).body.accessToken as string;
    ceoToken = await login('boc11-adjustment-ceo@t.kr');
    adminToken = await login('boc11-adjustment-admin@t.kr');
    teacherToken = await login('boc11-adjustment-teacher@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await cleanup();
      }
    } finally {
      await app?.close();
    }
  });

  const createAdjustment = (amount: number, requestKey = randomUUID(), kind = 'refund') =>
    request(app.getHttpServer()).post('/accounting/adjustments').set(auth(adminToken)).send({
      effectiveOn: `${MONTH}-15`, kind, studentId: STUDENT, reason: '승인 원장 회귀 검증', amount, requestKey,
    });
  const transition = (id: number, action: string, expectedVersion: number, reason?: string, token = ceoToken) =>
    request(app.getHttpServer()).post(`/accounting/adjustments/${id}/${action}`).set(auth(token)).send({
      expectedVersion, requestKey: randomUUID(), ...(reason ? { reason } : {}),
    });

  it('회계 역할만 조회·신청하고 승인 전 청구 금액을 바꾸지 않으며 same-key 재시도는 수렴한다', async () => {
    await request(app.getHttpServer()).get(`/accounting/adjustments?month=${MONTH}`).set(auth(teacherToken)).expect(403);
    await createAdjustment(10000, randomUUID()).set(auth(teacherToken)).expect(403);

    const requestKey = randomUUID();
    const made = (await createAdjustment(50000, requestKey).expect(201)).body;
    expect(made).toMatchObject({ replayed: false, item: {
      invoiceId, studentId: STUDENT, yearMonth: MONTH, kind: 'refund', amount: 50000,
      state: 'pending', version: 1, invoiceAmount: 250000, refundDue: 0,
    } });
    expect((await createAdjustment(50000, requestKey).expect(201)).body)
      .toMatchObject({ replayed: true, item: { id: made.item.id, state: 'pending', version: 1 } });
    const [invoice] = await q<{ amount: number }>(`SELECT amount FROM inv WHERE id=$1`, [invoiceId]);
    expect(Number(invoice.amount)).toBe(250000);
  });

  it('승인→반영 취소→되돌리기가 청구액을 보상하고 immutable event를 남긴다', async () => {
    const ledger = (await request(app.getHttpServer()).get(`/accounting/adjustments?month=${MONTH}`)
      .set(auth(adminToken)).expect(200)).body as InvoiceAdjustmentLedgerDto;
    const item = ledger.items.find((row) => row.amount === 50000)!;

    const approved = (await transition(item.id, 'approve', 1).expect(201)).body.item;
    expect(approved).toMatchObject({ state: 'approved', version: 2, invoiceAmount: 200000, refundDue: 50000, canCancel: true });
    await transition(item.id, 'reject', 1, '늦은 반려').expect(409)
      .expect(({ body }) => expect(body.code).toBe('INVOICE_ADJUSTMENT_STALE'));

    const canceled = (await transition(item.id, 'cancel', 2, '환불 계좌 재확인').expect(201)).body.item;
    expect(canceled).toMatchObject({ state: 'canceled', version: 3, invoiceAmount: 250000, refundDue: 0, canUndo: true });
    const restored = (await transition(item.id, 'undo', 3, '계좌 확인 완료').expect(201)).body.item;
    expect(restored).toMatchObject({ state: 'approved', version: 4, invoiceAmount: 200000, refundDue: 50000 });

    const events = await q<{ action: string; result_version: number }>(
      `SELECT action,result_version FROM invoice_adjustment_event WHERE invoice_adjustment_id=$1 ORDER BY result_version`, [item.id],
    );
    expect(events).toEqual([
      { action: 'created', result_version: 1 }, { action: 'approved', result_version: 2 },
      { action: 'canceled', result_version: 3 }, { action: 'restored', result_version: 4 },
    ]);
  });

  it('반려·되돌리기는 청구액을 건드리지 않고 승인 시 0원 아래 조정을 거절한다', async () => {
    const rejectedTarget = (await createAdjustment(10000).expect(201)).body.item;
    const rejected = (await transition(rejectedTarget.id, 'reject', 1, '근거 부족').expect(201)).body.item;
    expect(rejected).toMatchObject({ state: 'rejected', version: 2, invoiceAmount: 200000 });
    const pending = (await transition(rejectedTarget.id, 'undo', 2, '근거 보완').expect(201)).body.item;
    expect(pending).toMatchObject({ state: 'pending', version: 3, invoiceAmount: 200000 });
    await transition(rejectedTarget.id, 'reject', 3, '마감 전 정리').expect(201);

    const tooLarge = (await createAdjustment(300000).expect(201)).body.item;
    await transition(tooLarge.id, 'approve', 1).expect(409)
      .expect(({ body }) => expect(body.code).toBe('INVOICE_ADJUSTMENT_EXCEEDS_INVOICE'));
    await transition(tooLarge.id, 'reject', 1, '금액 초과').expect(201);
  });

  it('pending 조정은 월 마감을 막고 마감 뒤 신규 조정을 막는다', async () => {
    const pending = (await createAdjustment(5000, randomUUID(), 'sibling_discount').expect(201)).body.item;
    await request(app.getHttpServer()).post('/accounting/tuition/close').set(auth(ceoToken)).send({ month: MONTH })
      .expect(409).expect(({ body }) => expect(body.code).toBe('INVOICE_ADJUSTMENT_PENDING'));
    await transition(pending.id, 'reject', 1, '월 마감 전 반려').expect(201);
    await request(app.getHttpServer()).post('/accounting/tuition/close').set(auth(ceoToken)).send({ month: MONTH }).expect(201);
    await createAdjustment(5000).expect(409).expect(({ body }) => expect(body.code).toBe('MONTH_CLOSED'));
    await request(app.getHttpServer()).post('/accounting/tuition/reopen').set(auth(ceoToken))
      .send({ month: MONTH, reason: '테스트 정리' }).expect(201);
  });

  it('event 없는 INV/current 직접 변경과 event 수정은 DB가 거절한다', async () => {
    await expect(ds.transaction(async (m) => {
      await m.query(`UPDATE inv SET paid_amount=amount+1 WHERE id=$1`, [plainInvoiceId]);
    })).rejects.toThrow(/only up to its original amount/);
    await expect(ds.transaction(async (m) => {
      await m.query(`UPDATE inv SET paid_amount=250001 WHERE id=$1`, [invoiceId]);
    })).rejects.toThrow(/only up to its original amount/);
    await expect(ds.transaction(async (m) => {
      await m.query(`UPDATE inv SET amount=amount+1 WHERE id=$1`, [invoiceId]);
    })).rejects.toThrow(/approved adjustments/);
    await expect(q(`UPDATE invoice_adjustment_event SET reason='변조' WHERE actor_id=$1`, [CEO]))
      .rejects.toThrow(/event history is immutable/);
    const [invoice] = await q<{ amount: number }>(`SELECT amount FROM inv WHERE id=$1`, [invoiceId]);
    expect(Number(invoice.amount)).toBe(200000);
  });
});
