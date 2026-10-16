/** @file-guide
 * 목적: BO-11AD-01 입금 증빙 원장의 발행·일괄 발행·취소·월 마감 경합 계약을 실제 PostgreSQL로 검증한다. (test)
 * 책임/재사용: PAY를 원거래 정본으로 사용하고 발행 snapshot/version/event가 transaction과 함께 보존되는지 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import type { PaymentEvidenceLedgerDto } from '../src/modules/accounting/accounting.dto';
import { DEV_URL, markSetupDone } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('BO-11AD-01 입금 증빙 원장', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  let teacherToken = '';

  // 다른 DB 회귀 fixture와 ID를 공유하면 순서에 따라 cleanup이 서로의 행을 지운다.
  // BO-11AD-01 전용 대역을 사용해 단독/확대 실행 결과를 같게 유지한다.
  const CEO = 9948101;
  const TEACHER = 9948102;
  const STUDENT = 9948111;
  const PASSWORD = 'boc11-evidence-1234';
  const payIds: number[] = [];
  const month = () => '2001-04';
  const today = () => `${month()}-15`;
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    ds.query(sql, params) as Promise<T[]>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await q(`DELETE FROM payment_evidence_event WHERE actor_id = ANY($1::bigint[])`, [[CEO, TEACHER]]);
    await q(`DELETE FROM payment_evidence_request WHERE actor_id = ANY($1::bigint[])`, [[CEO, TEACHER]]);
    await q(`DELETE FROM payment_evidence WHERE pay_id IN (SELECT id FROM pay WHERE student_id=$1)`, [STUDENT]);
    await q(`DELETE FROM pay WHERE student_id=$1`, [STUDENT]);
    await q(`DELETE FROM month_close WHERE year_month=$1`, [month()]);
    await q(`DELETE FROM stu WHERE id=$1`, [STUDENT]);
    await q(`DELETE FROM staff WHERE id = ANY($1::bigint[])`, [[CEO, TEACHER]]);

    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    await q(
      `INSERT INTO staff (id,name,email,role,password_hash,active) VALUES
        ($1,'증빙대표','boc11-evidence-ceo@t.kr','ceo',$3,true),
        ($2,'증빙강사','boc11-evidence-teacher@t.kr','teacher',$3,true)`,
      [CEO, TEACHER, passwordHash],
    );
    await markSetupDone(q, [CEO, TEACHER]);
    await q(`INSERT INTO stu (id,name,grade,created_at) VALUES ($1,'증빙학생','10',current_date)`, [STUDENT]);
    const rows = await q<{ id: string }>(
      `INSERT INTO pay (student_id,amount,paid_on,method,reason,entered_by,entered_at,confirmed_by,confirmed_at)
       VALUES ($1,120000,$2::date,'transfer','수기 입금',$3,now(),$3,now()),
              ($1, 30000,$2::date,'cash','교재비',$3,now(),$3,now()),
              ($1, 10000,$2::date,'cash','동시 발행',$3,now(),$3,now()) RETURNING id`,
      [STUDENT, today(), CEO],
    );
    payIds.push(...rows.map((row) => Number(row.id)).sort((a, b) => a - b));

    const login = async (loginId: string) => (await request(app.getHttpServer())
      .post('/auth/login').send({ loginId, password: PASSWORD }).expect(201)).body.accessToken as string;
    ceoToken = await login('boc11-evidence-ceo@t.kr');
    teacherToken = await login('boc11-evidence-teacher@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await q(`DELETE FROM month_close WHERE year_month=$1`, [month()]);
        await q(`DELETE FROM payment_evidence_event WHERE actor_id = ANY($1::bigint[])`, [[CEO, TEACHER]]);
        await q(`DELETE FROM payment_evidence_request WHERE actor_id = ANY($1::bigint[])`, [[CEO, TEACHER]]);
        await q(`DELETE FROM payment_evidence WHERE pay_id = ANY($1::bigint[])`, [payIds]);
        await q(`DELETE FROM pay WHERE id = ANY($1::bigint[])`, [payIds]);
        await q(`DELETE FROM stu WHERE id=$1`, [STUDENT]);
        await q(`DELETE FROM staff WHERE id = ANY($1::bigint[])`, [[CEO, TEACHER]]);
      }
    } finally {
      await app?.close();
    }
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('대표만 조회하고 개별 발행·stale 거절·취소 뒤 snapshot과 이력을 보존한다', async () => {
    await request(app.getHttpServer()).get(`/accounting/payment-evidence?month=${month()}`)
      .set(auth(teacherToken)).expect(403);
    const initial = (await request(app.getHttpServer()).get(`/accounting/payment-evidence?month=${month()}`)
      .set(auth(ceoToken)).expect(200)).body as PaymentEvidenceLedgerDto;
    expect(initial).toMatchObject({ month: month(), unissuedCount: 3, issuedCount: 0, monthCloseBlockedCount: 3 });

    const issueRequestKey = randomUUID();
    const issued = (await request(app.getHttpServer()).post(`/accounting/payment-evidence/${payIds[0]}/issue`)
      .set(auth(ceoToken)).send({ expectedVersion: 0, requestKey: issueRequestKey }).expect(201)).body;
    expect(issued).toMatchObject({ payId: payIds[0], status: 'issued', version: 1, studentName: '증빙학생', amount: 120000 });
    expect(issued.printRef).toBe('/accounting?tab=receipts');
    expect((await request(app.getHttpServer()).post(`/accounting/payment-evidence/${payIds[0]}/issue`)
      .set(auth(ceoToken)).send({ expectedVersion: 0, requestKey: issueRequestKey }).expect(201)).body)
      .toMatchObject({ status: 'issued', version: 1 });

    await request(app.getHttpServer()).post(`/accounting/payment-evidence/${payIds[0]}/cancel`)
      .set(auth(ceoToken)).send({ expectedVersion: 0, requestKey: randomUUID(), reason: '잘못 발행' }).expect(409);
    const canceled = (await request(app.getHttpServer()).post(`/accounting/payment-evidence/${payIds[0]}/cancel`)
      .set(auth(ceoToken)).send({ expectedVersion: 1, requestKey: randomUUID(), reason: '잘못 발행' }).expect(201)).body;
    expect(canceled).toMatchObject({ status: 'unissued', version: 2, canceledBy: '증빙대표', cancelReason: '잘못 발행' });

    const [stored] = await q<{ snapshot: Record<string, unknown> }>(
      `SELECT snapshot FROM payment_evidence WHERE pay_id=$1`, [payIds[0]],
    );
    expect(stored.snapshot).toMatchObject({ payId: payIds[0], studentName: '증빙학생', amount: 120000 });
    const events = await q<{ action: string }>(
      `SELECT action FROM payment_evidence_event e JOIN payment_evidence d ON d.id=e.payment_evidence_id WHERE d.pay_id=$1 ORDER BY e.result_version`,
      [payIds[0]],
    );
    expect(events.map((row) => row.action)).toEqual(['issued', 'canceled']);
    await request(app.getHttpServer()).post(`/accounting/payment-evidence/${payIds[0]}/issue`)
      .set(auth(ceoToken)).send({ expectedVersion: 0, requestKey: issueRequestKey }).expect(409)
      .expect(({ body }) => expect(body.code).toBe('PAYMENT_EVIDENCE_REPLAY_STALE'));
  });

  it('같은 PAY 동시 발행은 version 0 한 건만 201이고 다른 요청은 stale 409다', async () => {
    const issue = () => request(app.getHttpServer()).post(`/accounting/payment-evidence/${payIds[2]}/issue`)
      .set(auth(ceoToken)).send({ expectedVersion: 0, requestKey: randomUUID() });
    const responses = await Promise.all([issue(), issue()]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body.code).toBe('PAYMENT_EVIDENCE_STALE');
    const [count] = await q<{ count: string }>(
      `SELECT count(*) FROM payment_evidence_event e JOIN payment_evidence d ON d.id=e.payment_evidence_id WHERE d.pay_id=$1`,
      [payIds[2]],
    );
    expect(Number(count.count)).toBe(1);
  });

  it('event receipt 없는 직접 current 변경은 지연 제약이 commit에서 거절한다', async () => {
    await expect(ds.transaction(async (m) => {
      await m.query(
        `UPDATE payment_evidence SET state='issued',row_version=row_version+1,canceled_by=NULL,canceled_at=NULL,cancel_reason=NULL WHERE pay_id=$1`,
        [payIds[0]],
      );
    })).rejects.toThrow(/matching event receipt/);
    const [row] = await q<{ state: string; row_version: number }>(
      `SELECT state,row_version FROM payment_evidence WHERE pay_id=$1`, [payIds[0]],
    );
    expect(row).toMatchObject({ state: 'canceled', row_version: 2 });
  });

  it('일괄 발행은 남은 PAY만 한 번 발행하고 미발행이 있으면 월 마감을 막는다', async () => {
    await request(app.getHttpServer()).post('/accounting/tuition/close')
      .set(auth(ceoToken)).send({ month: month() }).expect(409).expect(({ body }) => {
        expect(body.code).toBe('PAYMENT_EVIDENCE_UNISSUED');
        expect(body.message).toContain('2건');
      });

    const batchRequestKey = randomUUID();
    const batch = (await request(app.getHttpServer()).post('/accounting/payment-evidence/issue-batch')
      .set(auth(ceoToken)).send({ month: month(), requestKey: batchRequestKey }).expect(201)).body;
    expect(batch).toMatchObject({ month: month(), issuedCount: 2, skippedCount: 1 });
    expect((await request(app.getHttpServer()).post('/accounting/payment-evidence/issue-batch')
      .set(auth(ceoToken)).send({ month: month(), requestKey: batchRequestKey }).expect(201)).body)
      .toMatchObject({ month: month(), issuedCount: 2, skippedCount: 1 });

    const ledger = (await request(app.getHttpServer()).get(`/accounting/payment-evidence?month=${month()}`)
      .set(auth(ceoToken)).expect(200)).body as PaymentEvidenceLedgerDto;
    expect(ledger).toMatchObject({ unissuedCount: 0, issuedCount: 3, monthCloseBlockedCount: 0 });
    expect(ledger.items.every((row) => row.status === 'issued')).toBe(true);

    await request(app.getHttpServer()).post('/accounting/tuition/close')
      .set(auth(ceoToken)).send({ month: month() }).expect(201);
    await request(app.getHttpServer()).post(`/accounting/payment-evidence/${payIds[0]}/cancel`)
      .set(auth(ceoToken)).send({ expectedVersion: 3, requestKey: randomUUID(), reason: '마감 뒤 취소' })
      .expect(409).expect(({ body }) => expect(body.code).toBe('MONTH_CLOSED'));
  });
});
