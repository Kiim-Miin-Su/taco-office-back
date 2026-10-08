/** @file-guide
 * 목적: BO-11AD-03 실제 강사료 지급 원장의 개별·일괄 지급, 취소·재지급, 멱등·경합·DB 제약을 실제 PostgreSQL로 검증한다. (test)
 * 책임/재사용: payout/payout_line 확정 snapshot은 바꾸지 않고 payout_disbursement current/event/request만 검증한다.
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
import type { PayoutDisbursementLedgerDto } from '../src/modules/accounting/accounting.dto';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('BO-11AD-03 실제 강사료 지급 원장', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  let teacherToken = '';
  const payoutIds: number[] = [];

  const CEO = 9948201;
  const TEACHER = 9948202;
  const TEACHER_2 = 9948203;
  const TEACHER_3 = 9948204;
  const PASSWORD = 'boc11-payout-1234';
  const MONTH = '2001-05';
  const PREVIOUS = '2001-04';
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    ds.query(sql, params) as Promise<T[]>;

  const cleanup = async () => {
    await ds.transaction(async (m) => {
      // 불변 event trigger는 제품 방어다. fixture 범위만 한 transaction에서 비우고 즉시 복원한다.
      await m.query(`ALTER TABLE payout_disbursement_event DISABLE TRIGGER payout_disbursement_event_immutable`);
      await m.query(`DELETE FROM payout_disbursement_event WHERE actor_id=$1`, [CEO]);
      await m.query(`DELETE FROM payout_disbursement WHERE payout_id IN (
        SELECT id FROM payout WHERE staff_id=ANY($1::bigint[]))`, [[TEACHER, TEACHER_2, TEACHER_3]]);
      await m.query(`DELETE FROM payout_disbursement_request WHERE actor_id=$1`, [CEO]);
      await m.query(`ALTER TABLE payout_disbursement_event ENABLE TRIGGER payout_disbursement_event_immutable`);
    });
    await q(`DELETE FROM log WHERE actor_id=$1 AND entity='PAYOUT_PAY'`, [CEO]);
    await q(`DELETE FROM payout WHERE staff_id=ANY($1::bigint[])`, [[TEACHER, TEACHER_2, TEACHER_3]]);
    await q(`DELETE FROM staff WHERE id=ANY($1::bigint[])`, [[CEO, TEACHER, TEACHER_2, TEACHER_3]]);
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
        ($1,'지급대표','boc11-payout-ceo@t.kr','ceo',$5,true),
        ($2,'지급강사A','boc11-payout-teacher@t.kr','teacher',$5,true),
        ($3,'지급강사B','boc11-payout-teacher2@t.kr','teacher',$5,true),
        ($4,'지급강사C','boc11-payout-teacher3@t.kr','teacher',$5,true)`,
      [CEO, TEACHER, TEACHER_2, TEACHER_3, passwordHash],
    );
    const rows = await q<{ id: string }>(
      `INSERT INTO payout(
        staff_id,year_month,hours,gross,late_rep_cut,late_cls_cut,income_tax,local_tax,net,state,confirmed_by,confirmed_at)
       VALUES
        ($1,$4,'8.00',400000,5000,0,11850,1185,381965,'confirmed',$5,now()),
        ($2,$4,'6.50',325000,0,2500,9675,967,311858,'confirmed',$5,now()),
        ($3,$4,'4.00',200000,0,0,6000,600,193400,'confirmed',$5,now()),
        ($1,$6,'3.00',150000,0,0,4500,450,145050,'confirmed',$5,now())
       RETURNING id`,
      [TEACHER, TEACHER_2, TEACHER_3, MONTH, CEO, PREVIOUS],
    );
    payoutIds.push(...rows.map((row) => Number(row.id)));
    await q(
      `INSERT INTO payout(staff_id,year_month,hours,gross,late_rep_cut,late_cls_cut,income_tax,local_tax,net,state)
       VALUES ($1,'2001-03','1.00',50000,0,0,1500,150,48350,'draft')`, [TEACHER_3],
    );

    const login = async (loginId: string) => (await request(app.getHttpServer())
      .post('/auth/login').send({ loginId, password: PASSWORD }).expect(201)).body.accessToken as string;
    ceoToken = await login('boc11-payout-ceo@t.kr');
    teacherToken = await login('boc11-payout-teacher@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) await cleanup();
    } finally {
      await app?.close();
    }
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const pay = (payoutId: number, expectedVersion: number, requestKey = randomUUID(), paidOn = '2001-06-10') =>
    request(app.getHttpServer()).post(`/accounting/payout-ledger/${payoutId}/pay`).set(auth(ceoToken))
      .send({ expectedVersion, requestKey, paidOn, method: 'bank_transfer' });

  it('최근 두 달의 확정 정산만 반환하고 강사 직접 조회를 막는다', async () => {
    await request(app.getHttpServer()).get('/accounting/payout-ledger').set(auth(teacherToken)).expect(403);
    const ledger = (await request(app.getHttpServer()).get('/accounting/payout-ledger')
      .set(auth(ceoToken)).expect(200)).body as PayoutDisbursementLedgerDto;
    expect(ledger.months.map((row) => row.month)).toEqual([MONTH, PREVIOUS]);
    expect(ledger.months[0]).toMatchObject({ totalCount: 3, paidCount: 0, totalAmount: 887223, paidAmount: 0, unpaidAmount: 887223 });
    expect(ledger.months[0]?.items[0]).toMatchObject({ status: 'unpaid', version: 0, method: null, canPay: true, canCancel: false });
  });

  it('개별 지급·멱등 재시도·stale 취소·취소·재지급이 snapshot과 event를 보존한다', async () => {
    const key = randomUUID();
    const paid = (await pay(payoutIds[0]!, 0, key).expect(201)).body;
    expect(paid).toMatchObject({ payoutId: payoutIds[0], status: 'paid', version: 1, paidOn: '2001-06-10', paidBy: '지급대표', method: 'bank_transfer' });
    expect(paid).toMatchObject({ hours: '8.00', gross: 400000, deduction: 5000, withholding: 13035, net: 381965 });
    expect((await pay(payoutIds[0]!, 0, key).expect(201)).body).toMatchObject({ status: 'paid', version: 1 });

    await request(app.getHttpServer()).post(`/accounting/payout-ledger/${payoutIds[0]}/cancel`)
      .set(auth(ceoToken)).send({ expectedVersion: 0, requestKey: randomUUID(), reason: '이체 오류' })
      .expect(409).expect(({ body }) => expect(body.code).toBe('PAYOUT_DISBURSEMENT_STALE'));
    const canceled = (await request(app.getHttpServer()).post(`/accounting/payout-ledger/${payoutIds[0]}/cancel`)
      .set(auth(ceoToken)).send({ expectedVersion: 1, requestKey: randomUUID(), reason: '이체 오류' }).expect(201)).body;
    expect(canceled).toMatchObject({ status: 'unpaid', version: 2, canceledBy: '지급대표', cancelReason: '이체 오류', canPay: true });
    await pay(payoutIds[0]!, 0, key).expect(409).expect(({ body }) => {
      expect(body.code).toBe('PAYOUT_DISBURSEMENT_REPLAY_STALE');
    });
    expect((await pay(payoutIds[0]!, 2, randomUUID(), '2001-06-11').expect(201)).body)
      .toMatchObject({ status: 'paid', version: 3, paidOn: '2001-06-11', cancelReason: null });

    const [snapshot] = await q<{ snapshot: Record<string, unknown> }>(
      `SELECT snapshot FROM payout_disbursement WHERE payout_id=$1`, [payoutIds[0]],
    );
    expect(snapshot.snapshot).toMatchObject({ payoutId: payoutIds[0], staffName: '지급강사A', net: 381965 });
    const events = await q<{ action: string }>(
      `SELECT action FROM payout_disbursement_event e JOIN payout_disbursement d ON d.id=e.payout_disbursement_id
        WHERE d.payout_id=$1 ORDER BY result_version`, [payoutIds[0]],
    );
    expect(events.map((row) => row.action)).toEqual(['paid', 'canceled', 'paid']);
  });

  it('같은 정산의 동시 지급은 version 0 한 건만 성공한다', async () => {
    const calls = [pay(payoutIds[1]!, 0), pay(payoutIds[1]!, 0)];
    const responses = await Promise.all(calls);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body.code).toBe('PAYOUT_DISBURSEMENT_STALE');
    const [count] = await q<{ count: string }>(
      `SELECT count(*) FROM payout_disbursement_event e JOIN payout_disbursement d ON d.id=e.payout_disbursement_id
        WHERE d.payout_id=$1`, [payoutIds[1]],
    );
    expect(Number(count.count)).toBe(1);
  });

  it('일괄 지급은 미지급 확정 정산만 처리하고 동일 요청·후속 취소 경합을 구분한다', async () => {
    const key = randomUUID();
    const batch = (await request(app.getHttpServer()).post('/accounting/payout-ledger/pay-batch').set(auth(ceoToken))
      .send({ month: MONTH, paidOn: '2001-06-12', method: 'bank_transfer', requestKey: key }).expect(201)).body;
    expect(batch).toMatchObject({ month: MONTH, paidCount: 1, skippedCount: 2 });
    expect(batch.items[0]).toMatchObject({ payoutId: payoutIds[2], status: 'paid', version: 1 });
    expect((await request(app.getHttpServer()).post('/accounting/payout-ledger/pay-batch').set(auth(ceoToken))
      .send({ month: MONTH, paidOn: '2001-06-12', method: 'bank_transfer', requestKey: key }).expect(201)).body)
      .toMatchObject({ paidCount: 1, skippedCount: 2 });

    await request(app.getHttpServer()).post(`/accounting/payout-ledger/${payoutIds[2]}/cancel`).set(auth(ceoToken))
      .send({ expectedVersion: 1, requestKey: randomUUID(), reason: '일괄 이체 취소' }).expect(201);
    await request(app.getHttpServer()).post('/accounting/payout-ledger/pay-batch').set(auth(ceoToken))
      .send({ month: MONTH, paidOn: '2001-06-12', method: 'bank_transfer', requestKey: key })
      .expect(409).expect(({ body }) => expect(body.code).toBe('PAYOUT_DISBURSEMENT_REPLAY_STALE'));
  });

  it('미래 지급일과 미확정 정산을 거절한다', async () => {
    await pay(payoutIds[3]!, 0, randomUUID(), '2999-01-01').expect(400)
      .expect(({ body }) => expect(body.code).toBe('PAYOUT_PAYMENT_FUTURE'));
    const [draft] = await q<{ id: string }>(`SELECT id FROM payout WHERE staff_id=$1 AND year_month='2001-03'`, [TEACHER_3]);
    await pay(Number(draft.id), 0).expect(409).expect(({ body }) => expect(body.code).toBe('PAYOUT_NOT_CONFIRMED'));
  });

  it('event receipt 없는 직접 current 변경과 event 수정은 DB가 거절한다', async () => {
    await expect(ds.transaction(async (m) => {
      await m.query(
        `UPDATE payout_disbursement SET state='canceled',row_version=row_version+1,canceled_by=$2,canceled_at=now(),cancel_reason='직접 변경'
          WHERE payout_id=$1`, [payoutIds[0], CEO],
      );
    })).rejects.toThrow(/matching event receipt/);
    await expect(q(`UPDATE payout_disbursement_event SET reason='변조' WHERE payout_disbursement_id=(
      SELECT id FROM payout_disbursement WHERE payout_id=$1)`, [payoutIds[0]])).rejects.toThrow(/event history is immutable/);
    const [row] = await q<{ state: string; row_version: number }>(
      `SELECT state,row_version FROM payout_disbursement WHERE payout_id=$1`, [payoutIds[0]],
    );
    expect(row).toMatchObject({ state: 'paid', row_version: 3 });
  });
});
