/** @file-guide
 * 목적: BOC-11D-02 학생 실제 환불의 source/account snapshot·멱등·취소·재지급·조정 차단을 PostgreSQL로 검증한다.
 * 책임/재사용: 승인 조정의 환불 증가분부터 지급 current/request/event와 직접쓰기 방어까지 한 격리 시나리오로 회귀한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11D2-STUDENT-REFUND-DISBURSEMENT-2026-10-09.md · migration 1768500000000
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DEV_URL, markSetupDone } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('BOC-11D-02 학생 실제 환불 지급 원장', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  let adminToken = '';
  let teacherToken = '';
  let restrictedToken = '';
  let adjustmentId = 0;
  let accountId = 0;
  let previousKeyVersion: string | undefined;
  let previousKeyV1: string | undefined;

  const CEO = 9948501;
  const ADMIN = 9948502;
  const TEACHER = 9948503;
  const RESTRICTED = 9948504;
  const STUDENT = 9948505;
  const INVOICE = 9948506;
  const PASSWORD = 'boc11-refund-1234';
  const MONTH = '2001-09';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    ds.query(sql, params) as Promise<T[]>;

  const cleanup = async () => {
    await ds.transaction(async (m) => {
      await m.query(`ALTER TABLE student_refund_disbursement_event DISABLE TRIGGER student_refund_disbursement_event_immutable`);
      await m.query(`ALTER TABLE student_refund_disbursement_request DISABLE TRIGGER student_refund_disbursement_request_immutable`);
      await m.query(`ALTER TABLE student_refund_disbursement DISABLE TRIGGER student_refund_disbursement_row_guard`);
      await m.query(`DELETE FROM student_refund_disbursement_event WHERE actor_id=ANY($1::bigint[])`, [[CEO, ADMIN]]);
      await m.query(`DELETE FROM student_refund_disbursement_request WHERE actor_id=ANY($1::bigint[])`, [[CEO, ADMIN]]);
      await m.query(`DELETE FROM student_refund_disbursement WHERE invoice_adjustment_id IN (
        SELECT id FROM invoice_adjustment WHERE student_id=$1)`, [STUDENT]);
      await m.query(`ALTER TABLE student_refund_disbursement ENABLE TRIGGER student_refund_disbursement_row_guard`);
      await m.query(`ALTER TABLE student_refund_disbursement_request ENABLE TRIGGER student_refund_disbursement_request_immutable`);
      await m.query(`ALTER TABLE student_refund_disbursement_event ENABLE TRIGGER student_refund_disbursement_event_immutable`);

      await m.query(`ALTER TABLE protected_account DISABLE TRIGGER protected_account_no_delete`);
      await m.query(`ALTER TABLE protected_account_event DISABLE TRIGGER protected_account_event_immutable`);
      await m.query(`ALTER TABLE protected_account_request DISABLE TRIGGER protected_account_request_immutable`);
      await m.query(`DELETE FROM protected_account_event WHERE actor_id=ANY($1::bigint[])`, [[CEO, ADMIN]]);
      await m.query(`DELETE FROM protected_account_request WHERE actor_id=ANY($1::bigint[])`, [[CEO, ADMIN]]);
      await m.query(`DELETE FROM protected_account WHERE purpose='student_refund' AND target_id=$1`, [STUDENT]);
      await m.query(`ALTER TABLE protected_account_request ENABLE TRIGGER protected_account_request_immutable`);
      await m.query(`ALTER TABLE protected_account_event ENABLE TRIGGER protected_account_event_immutable`);
      await m.query(`ALTER TABLE protected_account ENABLE TRIGGER protected_account_no_delete`);

      await m.query(`ALTER TABLE invoice_adjustment_event DISABLE TRIGGER invoice_adjustment_event_immutable`);
      await m.query(`ALTER TABLE invoice_adjustment DISABLE TRIGGER invoice_adjustment_row_guard`);
      await m.query(`ALTER TABLE invoice_adjustment_base DISABLE TRIGGER invoice_adjustment_base_immutable`);
      await m.query(`DELETE FROM invoice_adjustment_event WHERE actor_id=ANY($1::bigint[])`, [[CEO, ADMIN]]);
      await m.query(`DELETE FROM invoice_adjustment WHERE student_id=$1`, [STUDENT]);
      await m.query(`DELETE FROM invoice_adjustment_base WHERE inv_id=$1`, [INVOICE]);
      await m.query(`ALTER TABLE invoice_adjustment_base ENABLE TRIGGER invoice_adjustment_base_immutable`);
      await m.query(`ALTER TABLE invoice_adjustment ENABLE TRIGGER invoice_adjustment_row_guard`);
      await m.query(`ALTER TABLE invoice_adjustment_event ENABLE TRIGGER invoice_adjustment_event_immutable`);
    });
    await q(`DELETE FROM noti WHERE from_id=ANY($1::bigint[]) OR to_id=ANY($1::bigint[])`, [[CEO, ADMIN]]);
    await q(`DELETE FROM log WHERE actor_id=ANY($1::bigint[])`, [[CEO, ADMIN]]);
    await q(`DELETE FROM inv WHERE id=$1`, [INVOICE]);
    await q(`DELETE FROM stu WHERE id=$1`, [STUDENT]);
    await q(`DELETE FROM staff WHERE id=ANY($1::bigint[])`, [[CEO, ADMIN, TEACHER, RESTRICTED]]);
  };

  beforeAll(async () => {
    previousKeyVersion = process.env.TACO_ACCOUNT_ENC_KEY_VERSION;
    previousKeyV1 = process.env.TACO_ACCOUNT_ENC_KEY_V1;
    process.env.TACO_ACCOUNT_ENC_KEY_VERSION = 'v1';
    process.env.TACO_ACCOUNT_ENC_KEY_V1 = 'test-only-student-refund-key-v1';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);
    await cleanup();
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    await q(`INSERT INTO staff(id,name,email,role,password_hash,active,can_money) VALUES
      ($1,'환불대표','boc11-refund-ceo@t.kr','ceo',$5,true,NULL),
      ($2,'환불관리자','boc11-refund-admin@t.kr','admin',$5,true,NULL),
      ($3,'환불강사','boc11-refund-teacher@t.kr','teacher',$5,true,NULL),
      ($4,'환불권한회수','boc11-refund-restricted@t.kr','admin',$5,true,false)`,
    [CEO, ADMIN, TEACHER, RESTRICTED, passwordHash]);
    await markSetupDone(q, [CEO, ADMIN, TEACHER, RESTRICTED]);
    await q(`INSERT INTO stu(id,name,grade,school) VALUES($1,'실제환불학생','G10','정합고')`, [STUDENT]);
    await q(`INSERT INTO inv(id,student_id,year_month,inv_type,title,amount,paid_amount,state,issued_on,due_on,sent_at,paid_at,created_by)
      VALUES($1,$2,$3,'tuition','환불 원천 청구',100000,100000,'paid',$4,$4,now(),now(),$5)`, [
      INVOICE, STUDENT, MONTH, `${MONTH}-01`, ADMIN,
    ]);
    const login = async (loginId: string) => (await request(app.getHttpServer())
      .post('/auth/login').send({ loginId, password: PASSWORD }).expect(201)).body.accessToken as string;
    ceoToken = await login('boc11-refund-ceo@t.kr');
    adminToken = await login('boc11-refund-admin@t.kr');
    teacherToken = await login('boc11-refund-teacher@t.kr');
    restrictedToken = await login('boc11-refund-restricted@t.kr');

    const made = (await request(app.getHttpServer()).post('/accounting/adjustments').set(auth(adminToken)).send({
      effectiveOn: `${MONTH}-07`, kind: 'refund', studentId: STUDENT, reason: '중도 종료 실제 환불',
      amount: 25000, requestKey: randomUUID(),
    }).expect(201)).body.item;
    adjustmentId = made.id;
    await request(app.getHttpServer()).post(`/accounting/adjustments/${adjustmentId}/approve`).set(auth(ceoToken))
      .send({ expectedVersion: 1, requestKey: randomUUID() }).expect(201);
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) await cleanup();
    } finally {
      await app?.close();
      if (previousKeyVersion === undefined) delete process.env.TACO_ACCOUNT_ENC_KEY_VERSION;
      else process.env.TACO_ACCOUNT_ENC_KEY_VERSION = previousKeyVersion;
      if (previousKeyV1 === undefined) delete process.env.TACO_ACCOUNT_ENC_KEY_V1;
      else process.env.TACO_ACCOUNT_ENC_KEY_V1 = previousKeyV1;
    }
  });

  const pay = (expectedVersion: number, requestKey = randomUUID(), paidOn = '2001-09-08') =>
    request(app.getHttpServer()).post(`/accounting/student-refunds/${adjustmentId}/pay`).set(auth(ceoToken)).send({
      expectedVersion, paidOn, method: 'bank_transfer', requestKey,
    });
  const cancel = (expectedVersion: number, requestKey = randomUUID(), reason = '이체 오류로 지급 취소') =>
    request(app.getHttpServer()).post(`/accounting/student-refunds/${adjustmentId}/cancel`).set(auth(ceoToken)).send({
      expectedVersion, reason, requestKey,
    });
  const writeAccount = (number: string, expectedVersion = 0) =>
    request(app.getHttpServer()).post('/accounting/protected-accounts').set(auth(adminToken)).send({
      purpose: 'student_refund', targetId: STUDENT, bank: '정합은행', accountNumber: number,
      holder: '실제환불학생', expectedVersion, requestKey: randomUUID(),
    });

  it('권한 없는 계정은 직접 API 403이고 승인 조정의 환불 증가분만 미지급 후보로 읽는다', async () => {
    await request(app.getHttpServer()).get(`/accounting/student-refunds?month=${MONTH}`).set(auth(teacherToken)).expect(403);
    await request(app.getHttpServer()).get(`/accounting/student-refunds?month=${MONTH}`).set(auth(restrictedToken)).expect(403);
    await pay(0, randomUUID()).set(auth(teacherToken)).expect(403);
    const ledger = (await request(app.getHttpServer()).get(`/accounting/student-refunds?month=${MONTH}`)
      .set(auth(adminToken)).expect(200)).body;
    expect(ledger).toMatchObject({
      month: MONTH, totalCount: 1, totalAmount: 25000, paidCount: 0, paidAmount: 0, unpaidAmount: 25000,
      canWrite: true,
    });
    expect(ledger.items[0]).toMatchObject({
      adjustmentId, invoiceId: INVOICE, studentId: STUDENT, amount: 25000, sourceAdjustmentVersion: 2,
      status: 'unpaid', version: 0, accountReady: false, canPay: false, canCancel: false,
    });
    await pay(0).expect(409).expect(({ body }) => expect(body.code).toBe('STUDENT_REFUND_ACCOUNT_REQUIRED'));
  });

  it('지급은 source/account snapshot과 value-less 계좌 정보를 보존하고 exact retry만 수렴한다', async () => {
    const account = (await writeAccount('1111-2222-3333').expect(201)).body.item;
    accountId = account.id;
    const key = randomUUID();
    const paid = (await pay(0, key).expect(201)).body;
    expect(paid).toMatchObject({
      adjustmentId, amount: 25000, sourceAdjustmentVersion: 2, status: 'paid', version: 1,
      accountId, accountVersion: 1, accountLast4: '3333', paidOn: '2001-09-08', canCancel: true,
    });
    expect((await pay(0, key).expect(201)).body).toMatchObject({ status: 'paid', version: 1, accountLast4: '3333' });
    await pay(0, key, '2001-09-09').expect(409)
      .expect(({ body }) => expect(body.code).toBe('STUDENT_REFUND_KEY_REUSED'));
    await pay(0).expect(409).expect(({ body }) => expect(body.code).toBe('STUDENT_REFUND_STALE'));

    const audit = JSON.stringify(await q(`SELECT r.payload_sha256,e.account_last4,l.before,l.after
      FROM student_refund_disbursement_request r
      JOIN student_refund_disbursement_event e ON e.request_key=r.request_key
      LEFT JOIN log l ON l.entity='STUDENT_REFUND' AND l.entity_id=e.student_refund_disbursement_id
      WHERE r.invoice_adjustment_id=$1`, [adjustmentId]));
    expect(audit).not.toContain('111122223333');
    expect(audit).not.toContain('정합은행');
  });

  it('지급 완료 조정 취소를 막고, 지급 취소·계좌 변경·재지급은 과거 snapshot을 보존한다', async () => {
    await request(app.getHttpServer()).post(`/accounting/adjustments/${adjustmentId}/cancel`).set(auth(ceoToken))
      .send({ expectedVersion: 2, reason: '조정 반영 취소', requestKey: randomUUID() })
      .expect(409).expect(({ body }) => expect(body.code).toBe('STUDENT_REFUND_CANCEL_REQUIRED'));

    await cancel(2).expect(409).expect(({ body }) => expect(body.code).toBe('STUDENT_REFUND_STALE'));
    const canceled = (await cancel(1).expect(201)).body;
    expect(canceled).toMatchObject({ status: 'canceled', version: 2, accountVersion: 1, accountLast4: '3333' });
    await writeAccount('9999 8888 7777', 1).expect(201);
    const repaid = (await pay(2, randomUUID(), '2001-09-09').expect(201)).body;
    expect(repaid).toMatchObject({ status: 'paid', version: 3, accountId, accountVersion: 2, accountLast4: '7777' });
    expect(repaid.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'paid', version: 1, accountVersion: 1, accountLast4: '3333' }),
      expect.objectContaining({ action: 'canceled', version: 2, accountVersion: 1, accountLast4: '3333' }),
      expect.objectContaining({ action: 'paid', version: 3, accountVersion: 2, accountLast4: '7777' }),
    ]));
  });

  it('환불 취소 뒤 조정 취소·복원·재지급하며 직접 current/event 변조는 DB가 거절한다', async () => {
    await cancel(3, randomUUID(), '조정 재검토를 위한 지급 취소').expect(201);
    const sourceCanceled = (await request(app.getHttpServer()).post(`/accounting/adjustments/${adjustmentId}/cancel`)
      .set(auth(ceoToken)).send({ expectedVersion: 2, reason: '조정 근거 재검토', requestKey: randomUUID() }).expect(201)).body.item;
    expect(sourceCanceled).toMatchObject({ state: 'canceled', version: 3, invoiceAmount: 100000, refundDue: 0 });
    const hidden = (await request(app.getHttpServer()).get(`/accounting/student-refunds?month=${MONTH}`)
      .set(auth(ceoToken)).expect(200)).body;
    expect(hidden.items).toEqual([]);

    const restored = (await request(app.getHttpServer()).post(`/accounting/adjustments/${adjustmentId}/undo`)
      .set(auth(ceoToken)).send({ expectedVersion: 3, reason: '환불 근거 재확인', requestKey: randomUUID() }).expect(201)).body.item;
    expect(restored).toMatchObject({ state: 'approved', version: 4, invoiceAmount: 75000, refundDue: 25000 });
    const repaid = (await pay(4, randomUUID(), '2001-09-10').expect(201)).body;
    expect(repaid).toMatchObject({ status: 'paid', version: 5, sourceAdjustmentVersion: 4, accountVersion: 2, accountLast4: '7777' });

    const [current] = await q<{ id: string }>(`SELECT id FROM student_refund_disbursement WHERE invoice_adjustment_id=$1`, [adjustmentId]);
    await expect(q(`UPDATE student_refund_disbursement SET row_version=row_version+1 WHERE id=$1`, [Number(current.id)]))
      .rejects.toThrow(/matching event receipt/);
    await expect(q(`DELETE FROM student_refund_disbursement WHERE id=$1`, [Number(current.id)]))
      .rejects.toThrow(/current rows are preserved/);
    await expect(q(`UPDATE student_refund_disbursement_event SET amount=amount+1 WHERE student_refund_disbursement_id=$1`, [Number(current.id)]))
      .rejects.toThrow(/audit history is immutable/);
    await expect(q(`UPDATE invoice_adjustment SET state='canceled',row_version=row_version+1 WHERE id=$1`, [adjustmentId]))
      .rejects.toThrow(/STUDENT_REFUND_CANCEL_REQUIRED/);
  });
});
