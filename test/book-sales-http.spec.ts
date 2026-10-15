/** @file-guide
 * 목적: BOC-11F 교재 판매 HTTP의 canMoney·DTO·422·멱등·상세·취소·범용 PAY 삭제 차단을 검증한다.
 * 책임/재사용: 실제 AppModule·인증 세션·PostgreSQL을 사용하고 DB 동시성 계산 시나리오는 전용 DB 시험에 맡긴다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11F-BOOK-SALES-FEES-2026-10-09.md · migration 1768700000000
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { addDays, todayKst } from '../src/lib/kst';
import { DEV_URL, markSetupDone } from './db';

const d = DEV_URL && /localhost|127\.0\.0\.1/.test(DEV_URL) ? describe : describe.skip;
jest.setTimeout(90_000);

d('TBO-55 BOC-11F 교재 판매 HTTP 계약', () => {
  let app: INestApplication;
  let ds: DataSource;
  let adminToken = '';
  let teacherToken = '';
  let restrictedToken = '';
  const ADMIN = 998710;
  const TEACHER = 998711;
  const RESTRICTED = 998712;
  const STUDENT = 998713;
  const BOOK = 998714;
  const PASSWORD = 'boc11-book-sales-1234';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    ds.query(sql, params) as Promise<T[]>;

  const cleanup = async () => {
    await ds.transaction(async (m) => {
      for (const table of [
        'payment_evidence_event', 'payment_evidence_request', 'payment_evidence',
        'book_sale_event', 'book_sale_request', 'book_sale', 'pay',
      ]) {
        await m.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      }
      await m.query(`DELETE FROM log WHERE actor_id=ANY($1::bigint[])`, [[ADMIN, TEACHER, RESTRICTED]]);
      await m.query(`DELETE FROM payment_evidence_event WHERE actor_id=ANY($1::bigint[])`, [[ADMIN, TEACHER, RESTRICTED]]);
      await m.query(`DELETE FROM payment_evidence_request WHERE actor_id=ANY($1::bigint[])`, [[ADMIN, TEACHER, RESTRICTED]]);
      await m.query(`DELETE FROM payment_evidence WHERE pay_id IN (
        SELECT pay_id FROM book_sale WHERE created_by=ANY($1::bigint[])
      )`, [[ADMIN, TEACHER, RESTRICTED]]);
      await m.query(`DELETE FROM book_sale_event WHERE actor_id=ANY($1::bigint[])`, [[ADMIN, TEACHER, RESTRICTED]]);
      await m.query(`DELETE FROM book_sale_request WHERE actor_id=ANY($1::bigint[])`, [[ADMIN, TEACHER, RESTRICTED]]);
      await m.query(`DELETE FROM book_sale WHERE created_by=ANY($1::bigint[])`, [[ADMIN, TEACHER, RESTRICTED]]);
      await m.query(`DELETE FROM pay WHERE entered_by=ANY($1::bigint[])`, [[ADMIN, TEACHER, RESTRICTED]]);
      await m.query(`DELETE FROM vers WHERE lib_id=$1`, [BOOK]);
      await m.query(`DELETE FROM lib WHERE id=$1`, [BOOK]);
      await m.query(`DELETE FROM stu WHERE id=$1`, [STUDENT]);
      await m.query(`DELETE FROM noti WHERE to_id=ANY($1::bigint[]) OR from_id=ANY($1::bigint[])`, [[ADMIN, TEACHER, RESTRICTED]]);
      await m.query(`DELETE FROM staff WHERE id=ANY($1::bigint[])`, [[ADMIN, TEACHER, RESTRICTED]]);
      for (const table of [
        'pay', 'book_sale', 'book_sale_request', 'book_sale_event',
        'payment_evidence', 'payment_evidence_request', 'payment_evidence_event',
      ]) {
        await m.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      }
    });
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);
    await cleanup();
    const hash = await bcrypt.hash(PASSWORD, 4);
    await q(`INSERT INTO staff(id,name,email,role,password_hash,active,can_money) VALUES
      ($1,'교재판매관리자','boc11-book-admin@t.kr','admin',$4,true,NULL),
      ($2,'교재판매강사','boc11-book-teacher@t.kr','teacher',$4,true,NULL),
      ($3,'교재판매권한회수','boc11-book-restricted@t.kr','admin',$4,true,false)`, [ADMIN, TEACHER, RESTRICTED, hash]);
    await markSetupDone(q, [ADMIN, TEACHER, RESTRICTED]);
    await q(`INSERT INTO stu(id,name,grade) VALUES($1,'교재판매학생','G10')`, [STUDENT]);
    await q(`INSERT INTO lib(id,code,title,pages) VALUES($1,'BOC11F-HTTP','Writing Basics',120)`, [BOOK]);
    await q(`INSERT INTO vers(lib_id,edition,from_date) VALUES($1,'v2026.10',CURRENT_DATE)`, [BOOK]);
    const login = async (loginId: string) => (await request(app.getHttpServer())
      .post('/auth/login').send({ loginId, password: PASSWORD }).expect(201)).body.accessToken as string;
    adminToken = await login('boc11-book-admin@t.kr');
    teacherToken = await login('boc11-book-teacher@t.kr');
    restrictedToken = await login('boc11-book-restricted@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) await cleanup();
    } finally {
      await app?.close();
    }
  });

  it('canMoney가 없는 강사와 권한 회수 관리자는 목록·상세·쓰기를 받지 못한다', async () => {
    const body = {
      studentId: STUDENT, bookId: BOOK, soldOn: todayKst(), quantity: 1, unitPrice: 25_000,
      paymentMethod: 'cash', requestKey: randomUUID(),
    };
    for (const token of [teacherToken, restrictedToken]) {
      await request(app.getHttpServer()).get('/accounting/book-sales').set(auth(token)).expect(403);
      await request(app.getHttpServer()).get('/accounting/book-sales/1').set(auth(token)).expect(403);
      await request(app.getHttpServer()).post('/accounting/book-sales').set(auth(token)).send(body).expect(403);
      await request(app.getHttpServer()).post('/accounting/book-sales/1/cancel').set(auth(token))
        .send({ expectedVersion: 1, reason: '권한 차단', requestKey: randomUUID() }).expect(403);
    }
  });

  it('DTO 오류는 400, 미래·합계 overflow는 422이고 저장은 0이다', async () => {
    const api = () => request(app.getHttpServer()).post('/accounting/book-sales').set(auth(adminToken));
    const base = {
      studentId: STUDENT, bookId: BOOK, soldOn: todayKst(), quantity: 1, unitPrice: 25_000,
      paymentMethod: 'cash', requestKey: randomUUID(),
    };
    await api().send({ ...base, quantity: 0 }).expect(400);
    await api().send({ ...base, paymentMethod: 'card' }).expect(400);
    await api().send({ ...base, unexpected: true }).expect(400);
    await api().send({ ...base, soldOn: addDays(todayKst(), 1), requestKey: randomUUID() }).expect(422)
      .expect(({ body }) => expect(body.code).toBe('BOOK_SALE_FUTURE'));
    await api().send({ ...base, quantity: 1000, unitPrice: 1_000_000_000, requestKey: randomUUID() }).expect(422)
      .expect(({ body }) => expect(body.code).toBe('BOOK_SALE_TOTAL_INVALID'));
    expect((await q<{ count: number }>(`SELECT count(*)::int AS count FROM book_sale WHERE created_by=$1`, [ADMIN]))[0].count).toBe(0);
  });

  it('생성·exact retry·목록/상세·key 재사용·삭제 차단·stale·취소를 DB 재조회한다', async () => {
    const createKey = randomUUID();
    const createBody = {
      studentId: STUDENT, bookId: BOOK, soldOn: todayKst(), quantity: 2, unitPrice: 25_000,
      paymentMethod: 'transfer', memo: 'HTTP 판매', requestKey: createKey,
    };
    const created = (await request(app.getHttpServer()).post('/accounting/book-sales').set(auth(adminToken))
      .send(createBody).expect(201)).body;
    expect(created).toMatchObject({ replayed: false, item: {
      studentId: STUDENT, bookId: BOOK, totalAmount: 50_000, feeAmount: 0, netAmount: 50_000,
      status: 'completed', version: 1, canCancel: true,
    } });
    const id = created.item.id as number;
    const payId = created.item.payId as number;
    await request(app.getHttpServer()).post('/accounting/book-sales').set(auth(adminToken))
      .send(createBody).expect(201).expect(({ body }) => expect(body).toMatchObject({ replayed: true, item: { id, payId } }));
    await request(app.getHttpServer()).post('/accounting/book-sales').set(auth(adminToken))
      .send({ ...createBody, unitPrice: 26_000 }).expect(409)
      .expect(({ body }) => expect(body.code).toBe('BOOK_SALE_KEY_REUSED'));
    await request(app.getHttpServer()).get('/accounting/book-sales').set(auth(adminToken)).expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ totalCount: 1, totalAmount: 50_000 }));
    await request(app.getHttpServer()).get(`/accounting/book-sales/${id}`).set(auth(adminToken)).expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ id, payId, feePolicy: { value: 0, version: 1 } }));
    await request(app.getHttpServer()).delete(`/accounting/payments/${payId}`).set(auth(adminToken)).expect(409)
      .expect(({ body }) => expect(body.code).toBe('BOOK_SALE_PAYMENT_LOCKED'));

    await request(app.getHttpServer()).post(`/accounting/book-sales/${id}/cancel`).set(auth(adminToken))
      .send({ expectedVersion: 2, reason: '오래된 화면', requestKey: randomUUID() }).expect(409)
      .expect(({ body }) => expect(body.code).toBe('BOOK_SALE_STALE'));
    const cancelKey = randomUUID();
    const canceled = (await request(app.getHttpServer()).post(`/accounting/book-sales/${id}/cancel`).set(auth(adminToken))
      .send({ expectedVersion: 1, reason: '중복 판매 정정', requestKey: cancelKey }).expect(201)).body;
    expect(canceled).toMatchObject({ replayed: false, item: { id, payId, status: 'canceled', version: 2, canCancel: false } });
    await request(app.getHttpServer()).post(`/accounting/book-sales/${id}/cancel`).set(auth(adminToken))
      .send({ expectedVersion: 1, reason: '중복 판매 정정', requestKey: cancelKey }).expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ replayed: true, item: { id, version: 2 } }));

    expect(await q(`SELECT action,result_version FROM book_sale_event WHERE sale_id=$1 ORDER BY result_version`, [id]))
      .toEqual([{ action: 'created', result_version: 1 }, { action: 'canceled', result_version: 2 }]);
    const pays = await q<{ id: string; amount: number; method: string }>(
      `SELECT id,amount,method FROM pay WHERE id=ANY($1::bigint[]) ORDER BY id`, [[payId, canceled.item.correctionPayId]],
    );
    expect(pays.map((row) => ({ amount: row.amount, method: row.method }))).toEqual([
      { amount: 50_000, method: 'transfer' }, { amount: -50_000, method: 'transfer' },
    ]);
  });

  it('발행된 PAY 증빙이 있으면 판매 취소 transaction 전체를 거절한다', async () => {
    const created = (await request(app.getHttpServer()).post('/accounting/book-sales').set(auth(adminToken)).send({
      studentId: STUDENT, bookId: BOOK, soldOn: todayKst(), quantity: 1, unitPrice: 18_000,
      paymentMethod: 'cash', requestKey: randomUUID(),
    }).expect(201)).body;
    const id = created.item.id as number;
    const payId = created.item.payId as number;
    await request(app.getHttpServer()).post(`/accounting/payment-evidence/${payId}/issue`).set(auth(adminToken))
      .send({ expectedVersion: 0, requestKey: randomUUID() }).expect(201);
    await request(app.getHttpServer()).post(`/accounting/book-sales/${id}/cancel`).set(auth(adminToken))
      .send({ expectedVersion: 1, reason: '증빙 발행 뒤 취소', requestKey: randomUUID() }).expect(409)
      .expect(({ body }) => expect(body.code).toBe('BOOK_SALE_EVIDENCE_ISSUED'));
    expect((await q(`SELECT status,row_version,correction_pay_id FROM book_sale WHERE id=$1`, [id]))[0])
      .toEqual({ status: 'completed', row_version: 1, correction_pay_id: null });
    expect((await q<{ count: number }>(`SELECT count(*)::int AS count FROM book_sale_event WHERE sale_id=$1`, [id]))[0].count)
      .toBe(1);
  });
});
