/** @file-guide
 * 목적: BOC-11D-01 보호 계좌 CRUD·암호화·권한·키 실패와 강사 지급 snapshot을 실제 PostgreSQL로 검증한다.
 * 책임/재사용: 평문0·masked projection·version/replay/stale·지급 연결을 한 격리 시나리오로 회귀한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11D1-PROTECTED-ACCOUNT-2026-10-09.md · migration 1768400000000
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('BOC-11D-01 보호 계좌·강사 지급 snapshot', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  let adminToken = '';
  let teacherToken = '';
  let restrictedToken = '';
  let payoutId = 0;
  let previousKeyVersion: string | undefined;
  let previousKeyV1: string | undefined;

  const CEO = 9948401;
  const ADMIN = 9948402;
  const TEACHER = 9948403;
  const RESTRICTED = 9948404;
  const STUDENT = 9948405;
  const PASSWORD = 'boc11-account-1234';
  const MONTH = '2001-07';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    ds.query(sql, params) as Promise<T[]>;

  const cleanup = async () => {
    await ds.transaction(async (m) => {
      await m.query(`ALTER TABLE payout_disbursement_event DISABLE TRIGGER payout_disbursement_event_immutable`);
      await m.query(`DELETE FROM payout_disbursement_event WHERE actor_id=ANY($1::bigint[])`, [[CEO, ADMIN]]);
      await m.query(`DELETE FROM payout_disbursement WHERE payout_id IN (
        SELECT id FROM payout WHERE staff_id=$1)`, [TEACHER]);
      await m.query(`DELETE FROM payout_disbursement_request WHERE actor_id=ANY($1::bigint[])`, [[CEO, ADMIN]]);
      await m.query(`ALTER TABLE payout_disbursement_event ENABLE TRIGGER payout_disbursement_event_immutable`);

      await m.query(`ALTER TABLE protected_account DISABLE TRIGGER protected_account_no_delete`);
      await m.query(`ALTER TABLE protected_account_event DISABLE TRIGGER protected_account_event_immutable`);
      await m.query(`ALTER TABLE protected_account_request DISABLE TRIGGER protected_account_request_immutable`);
      await m.query(`DELETE FROM protected_account_event WHERE actor_id=ANY($1::bigint[])`, [[CEO, ADMIN]]);
      await m.query(`DELETE FROM protected_account_request WHERE actor_id=ANY($1::bigint[])`, [[CEO, ADMIN]]);
      await m.query(`DELETE FROM protected_account WHERE target_id=ANY($1::bigint[])`, [[TEACHER, STUDENT]]);
      await m.query(`ALTER TABLE protected_account_request ENABLE TRIGGER protected_account_request_immutable`);
      await m.query(`ALTER TABLE protected_account_event ENABLE TRIGGER protected_account_event_immutable`);
      await m.query(`ALTER TABLE protected_account ENABLE TRIGGER protected_account_no_delete`);
    });
    await q(`DELETE FROM log WHERE actor_id=ANY($1::bigint[]) AND entity IN ('PROTECTED_ACCOUNT','PAYOUT_PAY')`, [[CEO, ADMIN]]);
    await q(`DELETE FROM payout WHERE staff_id=$1`, [TEACHER]);
    await q(`DELETE FROM stu WHERE id=$1`, [STUDENT]);
    await q(`DELETE FROM staff WHERE id=ANY($1::bigint[])`, [[CEO, ADMIN, TEACHER, RESTRICTED]]);
  };

  beforeAll(async () => {
    previousKeyVersion = process.env.TACO_ACCOUNT_ENC_KEY_VERSION;
    previousKeyV1 = process.env.TACO_ACCOUNT_ENC_KEY_V1;
    process.env.TACO_ACCOUNT_ENC_KEY_VERSION = 'v1';
    process.env.TACO_ACCOUNT_ENC_KEY_V1 = 'test-only-protected-account-key-v1';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);
    await cleanup();
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    await q(`INSERT INTO staff(id,name,email,role,password_hash,active,can_money) VALUES
      ($1,'계좌대표','boc11-account-ceo@t.kr','ceo',$5,true,NULL),
      ($2,'계좌관리자','boc11-account-admin@t.kr','admin',$5,true,NULL),
      ($3,'계좌강사','boc11-account-teacher@t.kr','teacher',$5,true,NULL),
      ($4,'권한회수','boc11-account-restricted@t.kr','admin',$5,true,false)`,
    [CEO, ADMIN, TEACHER, RESTRICTED, passwordHash]);
    await q(`INSERT INTO stu(id,name,grade,school) VALUES($1,'환불학생','G10','정합고')`, [STUDENT]);
    const [payout] = await q<{ id: string }>(`INSERT INTO payout(
      staff_id,year_month,hours,gross,late_rep_cut,late_cls_cut,income_tax,local_tax,net,state,confirmed_by,confirmed_at)
      VALUES($1,$2,'5.00',250000,0,0,7500,750,241750,'confirmed',$3,now()) RETURNING id`, [TEACHER, MONTH, CEO]);
    payoutId = Number(payout.id);
    const login = async (loginId: string) => (await request(app.getHttpServer())
      .post('/auth/login').send({ loginId, password: PASSWORD }).expect(201)).body.accessToken as string;
    ceoToken = await login('boc11-account-ceo@t.kr');
    adminToken = await login('boc11-account-admin@t.kr');
    teacherToken = await login('boc11-account-teacher@t.kr');
    restrictedToken = await login('boc11-account-restricted@t.kr');
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

  const write = (
    purpose: 'student_refund' | 'teacher_payout', targetId: number, accountNumber: string,
    expectedVersion = 0, requestKey = randomUUID(), token = adminToken,
  ) => request(app.getHttpServer()).post('/accounting/protected-accounts').set(auth(token)).send({
    purpose, targetId, bank: '정합은행', accountNumber, holder: purpose === 'student_refund' ? '환불학생' : '계좌강사',
    expectedVersion, requestKey,
  });

  it('강사·권한 회수 계정은 직접 API가 403이고 회계 actor는 대상 목록을 읽는다', async () => {
    await request(app.getHttpServer()).get('/accounting/protected-accounts').set(auth(teacherToken)).expect(403);
    await request(app.getHttpServer()).get('/accounting/protected-accounts').set(auth(restrictedToken)).expect(403);
    await write('teacher_payout', TEACHER, '100020003000', 0, randomUUID(), teacherToken).expect(403);
    const ledger = (await request(app.getHttpServer()).get('/accounting/protected-accounts')
      .set(auth(adminToken)).expect(200)).body;
    expect(ledger).toMatchObject({ canRead: true, canWrite: true, canReveal: true, items: [] });
    expect(ledger.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: 'student_refund', targetId: STUDENT, targetName: '환불학생' }),
      expect.objectContaining({ purpose: 'teacher_payout', targetId: TEACHER, targetName: '계좌강사' }),
    ]));
  });

  it('생성·masked reload·same-key·stale·수정이 평문 없이 version으로 수렴한다', async () => {
    const key = randomUUID();
    const made = (await write('student_refund', STUDENT, '1111-2222-3333', 0, key).expect(201)).body;
    expect(made).toMatchObject({ replayed: false, item: {
      purpose: 'student_refund', targetId: STUDENT, state: 'active', version: 1,
      last4: '3333', maskedAccountNumber: '**** 3333',
    } });
    const activeKey = process.env.TACO_ACCOUNT_ENC_KEY_V1;
    try {
      delete process.env.TACO_ACCOUNT_ENC_KEY_V1;
      expect((await write('student_refund', STUDENT, '1111-2222-3333', 0, key).expect(201)).body)
        .toMatchObject({ replayed: true, item: { id: made.item.id, version: 1, last4: '3333' } });
    } finally {
      if (activeKey === undefined) delete process.env.TACO_ACCOUNT_ENC_KEY_V1;
      else process.env.TACO_ACCOUNT_ENC_KEY_V1 = activeKey;
    }
    await write('student_refund', STUDENT, '999988887777', 0).expect(409)
      .expect(({ body }) => expect(body.code).toBe('PROTECTED_ACCOUNT_STALE'));
    const updated = (await write('student_refund', STUDENT, '9999 8888 7777', 1).expect(201)).body.item;
    expect(updated).toMatchObject({ id: made.item.id, version: 2, last4: '7777' });

    const ledgerText = JSON.stringify((await request(app.getHttpServer()).get('/accounting/protected-accounts')
      .set(auth(adminToken)).expect(200)).body);
    expect(ledgerText).not.toContain('111122223333');
    expect(ledgerText).not.toContain('999988887777');
    expect(ledgerText).not.toContain('정합은행');
    const [stored] = await q<{ ciphertext: Buffer; key_version: string; last4: string }>(
      `SELECT ciphertext,key_version,last4 FROM protected_account WHERE id=$1`, [made.item.id],
    );
    expect(stored.key_version).toBe('v1');
    expect(stored.last4).toBe('7777');
    expect(stored.ciphertext.toString('utf8')).not.toContain('999988887777');
  });

  it('사유 있는 원문 확인은 value-less audit만 남기고 키 누락·오키는 fail-closed한다', async () => {
    const [account] = await q<{ id: string; row_version: number }>(
      `SELECT id,row_version FROM protected_account WHERE purpose='student_refund' AND target_id=$1`, [STUDENT],
    );
    const key = randomUUID();
    const revealed = (await request(app.getHttpServer()).post(`/accounting/protected-accounts/${account.id}/reveal`)
      .set(auth(ceoToken)).send({ expectedVersion: account.row_version, reason: '환불 송금 계좌 대조', requestKey: key })
      .expect(201)).body;
    expect(revealed).toMatchObject({ bank: '정합은행', accountNumber: '999988887777', holder: '환불학생', replayed: false });
    expect((await request(app.getHttpServer()).post(`/accounting/protected-accounts/${account.id}/reveal`)
      .set(auth(ceoToken)).send({ expectedVersion: account.row_version, reason: '환불 송금 계좌 대조', requestKey: key })
      .expect(201)).body).toMatchObject({ accountNumber: '999988887777', replayed: true });

    const auditRows = await q<{ body: string }>(`SELECT row_to_json(x)::text AS body FROM (
      SELECT r.action,r.payload_sha256,e.action AS event_action,e.reason,l.before,l.after
      FROM protected_account_request r JOIN protected_account_event e ON e.request_key=r.request_key
      LEFT JOIN log l ON l.entity='PROTECTED_ACCOUNT' AND l.entity_id=r.account_id
      WHERE r.account_id=$1) x`, [Number(account.id)]);
    const auditText = JSON.stringify(auditRows);
    expect(auditText).not.toContain('999988887777');
    expect(auditText).not.toContain('정합은행');
    expect(auditText).not.toContain('환불학생');

    const originalKey = process.env.TACO_ACCOUNT_ENC_KEY_V1;
    try {
      delete process.env.TACO_ACCOUNT_ENC_KEY_V1;
      await request(app.getHttpServer()).post(`/accounting/protected-accounts/${account.id}/reveal`)
        .set(auth(ceoToken)).send({ expectedVersion: account.row_version, reason: '키 누락 회귀 확인', requestKey: randomUUID() })
        .expect(503).expect(({ body }) => expect(body.code).toBe('PROTECTED_ACCOUNT_KEY_UNAVAILABLE'));
      process.env.TACO_ACCOUNT_ENC_KEY_V1 = 'wrong-test-key';
      await request(app.getHttpServer()).post(`/accounting/protected-accounts/${account.id}/reveal`)
        .set(auth(ceoToken)).send({ expectedVersion: account.row_version, reason: '오키 회귀 확인', requestKey: randomUUID() })
        .expect(503).expect(({ body }) => expect(body.code).toBe('PROTECTED_ACCOUNT_DECRYPT_FAILED'));
    } finally {
      if (originalKey === undefined) delete process.env.TACO_ACCOUNT_ENC_KEY_V1;
      else process.env.TACO_ACCOUNT_ENC_KEY_V1 = originalKey;
    }
  });

  it('삭제는 secret을 purge하고 같은 current를 version 증가로 재등록한다', async () => {
    const [account] = await q<{ id: string; row_version: number }>(
      `SELECT id,row_version FROM protected_account WHERE purpose='student_refund' AND target_id=$1`, [STUDENT],
    );
    const deleted = (await request(app.getHttpServer()).post(`/accounting/protected-accounts/${account.id}/delete`)
      .set(auth(adminToken)).send({ expectedVersion: account.row_version, reason: '환불 계좌 변경 요청', requestKey: randomUUID() })
      .expect(201)).body.item;
    expect(deleted).toMatchObject({ id: Number(account.id), state: 'deleted', version: account.row_version + 1, last4: null });
    const [stored] = await q<{ ciphertext: Buffer | null; key_version: string | null; last4: string | null }>(
      `SELECT ciphertext,key_version,last4 FROM protected_account WHERE id=$1`, [Number(account.id)],
    );
    expect(stored).toEqual({ ciphertext: null, key_version: null, last4: null });
    const restored = (await write('student_refund', STUDENT, '444455556666', deleted.version).expect(201)).body.item;
    expect(restored).toMatchObject({ id: Number(account.id), state: 'active', version: deleted.version + 1, last4: '6666' });
  });

  it('강사 지급은 계좌 없음409 뒤 snapshot하고 계좌 변경 뒤 과거 지급 last4를 보존한다', async () => {
    await request(app.getHttpServer()).post(`/accounting/payout-ledger/${payoutId}/pay`).set(auth(ceoToken)).send({
      expectedVersion: 0, paidOn: '2001-08-01', method: 'bank_transfer', requestKey: randomUUID(),
    }).expect(409).expect(({ body }) => expect(body.code).toBe('PAYOUT_ACCOUNT_REQUIRED'));

    const account = (await write('teacher_payout', TEACHER, '123456789012').expect(201)).body.item;
    const paid = (await request(app.getHttpServer()).post(`/accounting/payout-ledger/${payoutId}/pay`)
      .set(auth(ceoToken)).send({ expectedVersion: 0, paidOn: '2001-08-01', method: 'bank_transfer', requestKey: randomUUID() })
      .expect(201)).body;
    expect(paid).toMatchObject({ status: 'paid', version: 1, accountId: account.id, accountVersion: 1, accountLast4: '9012' });

    await write('teacher_payout', TEACHER, '888877776666', 1).expect(201);
    const ledger = (await request(app.getHttpServer()).get('/accounting/payout-ledger').set(auth(ceoToken)).expect(200)).body;
    const paidRow = ledger.months.flatMap((month: { items: unknown[] }) => month.items)
      .find((item: { payoutId?: number }) => item.payoutId === payoutId);
    expect(paidRow).toMatchObject({ status: 'paid', accountVersion: 1, accountLast4: '9012' });

    await request(app.getHttpServer()).post(`/accounting/payout-ledger/${payoutId}/cancel`).set(auth(ceoToken)).send({
      expectedVersion: 1, reason: '이체 취소 후 재처리', requestKey: randomUUID(),
    }).expect(201);
    const repaid = (await request(app.getHttpServer()).post(`/accounting/payout-ledger/${payoutId}/pay`)
      .set(auth(ceoToken)).send({ expectedVersion: 2, paidOn: '2001-08-02', method: 'bank_transfer', requestKey: randomUUID() })
      .expect(201)).body;
    expect(repaid).toMatchObject({ status: 'paid', version: 3, accountVersion: 2, accountLast4: '6666' });
    expect(repaid.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'paid', version: 1, accountLast4: '9012' }),
      expect.objectContaining({ action: 'canceled', version: 2, accountLast4: '9012' }),
      expect.objectContaining({ action: 'paid', version: 3, accountLast4: '6666' }),
    ]));
  });

  it('current 직접 변경·삭제와 request/event 수정은 DB가 거절한다', async () => {
    const [account] = await q<{ id: string }>(
      `SELECT id FROM protected_account WHERE purpose='student_refund' AND target_id=$1`, [STUDENT],
    );
    await expect(q(`UPDATE protected_account SET row_version=row_version+1 WHERE id=$1`, [Number(account.id)]))
      .rejects.toThrow(/PROTECTED_ACCOUNT_RECEIPT_MISSING/);
    await expect(q(`UPDATE protected_account SET last4='0000' WHERE id=$1`, [Number(account.id)]))
      .rejects.toThrow(/PROTECTED_ACCOUNT_VERSION_STEP/);
    await expect(q(`DELETE FROM protected_account WHERE id=$1`, [Number(account.id)]))
      .rejects.toThrow(/current rows are preserved/);
    await expect(q(`UPDATE protected_account_event SET reason='변조' WHERE account_id=$1`, [Number(account.id)]))
      .rejects.toThrow(/audit is immutable/);
    await expect(q(`DELETE FROM protected_account_request WHERE account_id=$1`, [Number(account.id)]))
      .rejects.toThrow(/audit is immutable/);
  });
});
