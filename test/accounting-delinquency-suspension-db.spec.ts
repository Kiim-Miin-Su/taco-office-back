/** @file-guide
 * 목적: BOC-11C 연체 후보·기준·독촉·정지·해제와 schedule/DB 직접쓰기 방어를 PostgreSQL로 검증한다.
 * 책임/재사용: 실제 HTTP→service→migration 원장을 사용하고 외부 발송은 수행하지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11C-DELINQUENCY-SUSPENSION-2026-10-09.md
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('BOC-11C 연체 수강 정지·해제', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  let adminToken = '';
  let teacherToken = '';
  let existingSerId = 0;
  let emptySerId = 0;
  let invoiceId = 0;

  const CEO = 9948301;
  const ADMIN = 9948302;
  const TEACHER = 9948303;
  const STUDENT = 9948311;
  const STUDENT2 = 9948312;
  const PASSWORD = 'boc11-delinquency-1234';
  const FROM = '2099-04-06';
  const DUE = '2026-09-19';
  const MONTH = '2026-09';
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    ds.query(sql, params) as Promise<T[]>;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const cleanup = async () => {
    await q(`DELETE FROM noti WHERE to_id=ANY($1::bigint[]) OR from_id=ANY($1::bigint[])`, [[CEO, ADMIN, TEACHER]]);
    await q(`DELETE FROM log WHERE actor_id=ANY($1::bigint[])`, [[CEO, ADMIN, TEACHER]]);
    const series = await q<{ id: string }>(`SELECT id FROM ser WHERE title LIKE 'BOC11C 회귀%'`);
    const ids = series.map((row) => Number(row.id));
    if (ids.length) {
      await q(`DELETE FROM ser_occ WHERE ser_id=ANY($1::bigint[])`, [ids]);
      await q(`DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id=ANY($1::bigint[]))`, [ids]);
      await q(`DELETE FROM exc WHERE ser_id=ANY($1::bigint[])`, [ids]);
      await q(`DELETE FROM ser_stu WHERE ser_id=ANY($1::bigint[])`, [ids]);
      await q(`DELETE FROM ser WHERE id=ANY($1::bigint[])`, [ids]);
    }
    await ds.transaction(async (m) => {
      await m.query(`ALTER TABLE delinquency_suspension_event DISABLE TRIGGER delinquency_suspension_event_immutable`);
      await m.query(`ALTER TABLE delinquency_suspension DISABLE TRIGGER delinquency_current_no_delete`);
      await m.query(`ALTER TABLE delinquency_suspension DISABLE TRIGGER delinquency_current_receipt`);
      await m.query(`ALTER TABLE delinquency_policy_event DISABLE TRIGGER delinquency_policy_event_immutable`);
      await m.query(`ALTER TABLE delinquency_policy DISABLE TRIGGER delinquency_policy_receipt`);
      await m.query(`DELETE FROM delinquency_suspension_event WHERE student_id=ANY($1::bigint[])`, [[STUDENT, STUDENT2]]);
      await m.query(`DELETE FROM delinquency_suspension WHERE student_id=ANY($1::bigint[])`, [[STUDENT, STUDENT2]]);
      await m.query(`DELETE FROM delinquency_policy_event WHERE actor_id=ANY($1::bigint[])`, [[CEO, ADMIN, TEACHER]]);
      await m.query(`UPDATE delinquency_policy SET threshold_days=14,row_version=1,updated_by=NULL,updated_at=now() WHERE id=1`);
      await m.query(`ALTER TABLE delinquency_policy ENABLE TRIGGER delinquency_policy_receipt`);
      await m.query(`ALTER TABLE delinquency_policy_event ENABLE TRIGGER delinquency_policy_event_immutable`);
      await m.query(`ALTER TABLE delinquency_suspension ENABLE TRIGGER delinquency_current_receipt`);
      await m.query(`ALTER TABLE delinquency_suspension ENABLE TRIGGER delinquency_current_no_delete`);
      await m.query(`ALTER TABLE delinquency_suspension_event ENABLE TRIGGER delinquency_suspension_event_immutable`);
    });
    await q(`DELETE FROM guardian WHERE student_id=ANY($1::bigint[])`, [[STUDENT, STUDENT2]]);
    await q(`DELETE FROM inv WHERE student_id=ANY($1::bigint[])`, [[STUDENT, STUDENT2]]);
    await q(`DELETE FROM stu WHERE id=ANY($1::bigint[])`, [[STUDENT, STUDENT2]]);
    await q(`DELETE FROM staff WHERE id=ANY($1::bigint[])`, [[CEO, ADMIN, TEACHER]]);
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
    await q(`INSERT INTO staff(id,name,email,role,password_hash,active) VALUES
      ($1,'연체대표','boc11c-ceo@t.kr','ceo',$4,true),
      ($2,'연체관리자','boc11c-admin@t.kr','admin',$4,true),
      ($3,'연체강사','boc11c-teacher@t.kr','teacher',$4,true)`, [CEO, ADMIN, TEACHER, hash]);
    await q(`INSERT INTO stu(id,name,grade,created_at) VALUES
      ($1,'연체학생','10',current_date),($2,'연체학생2','9',current_date)`, [STUDENT, STUDENT2]);
    await q(`INSERT INTO guardian(student_id,name,phone,receive_email,receive_sms,is_primary,is_payer,created_by)
      VALUES($1,'납부보호자','01012345678',false,true,true,true,$2)`, [STUDENT, ADMIN]);
    const [invoice] = await q<{ id: string }>(`INSERT INTO inv
      (student_id,year_month,inv_type,title,amount,state,issued_on,due_on,sent_at,created_by,paid_amount)
      VALUES($1,$2,'tuition','연체 정지 회귀 청구',100000,'unpaid',$3::date,$4::date,now(),$5,0) RETURNING id`,
    [STUDENT, MONTH, `${MONTH}-01`, DUE, ADMIN]);
    invoiceId = Number(invoice.id);
    await q(`INSERT INTO inv
      (student_id,year_month,inv_type,title,amount,state,issued_on,due_on,sent_at,created_by,paid_amount)
      VALUES($1,$2,'tuition','연체 정지 회귀 청구2',50000,'unpaid',$3::date,$4::date,now(),$5,0)`,
    [STUDENT2, MONTH, `${MONTH}-01`, DUE, ADMIN]);

    const login = async (loginId: string) => (await request(app.getHttpServer())
      .post('/auth/login').send({ loginId, password: PASSWORD }).expect(201)).body.accessToken as string;
    ceoToken = await login('boc11c-ceo@t.kr');
    adminToken = await login('boc11c-admin@t.kr');
    teacherToken = await login('boc11c-teacher@t.kr');

    const create = async (title: string, studentIds: number[]) => (await request(app.getHttpServer()).post('/schedule')
      .set(auth(adminToken)).send({
        kindKey: 'class', subKey: null, mode: 'online', title, fromDate: FROM, toDate: null,
        rrule: 'WEEKLY:MO', startMin: 600, endMin: 660, teacherId: TEACHER, roomId: null, studentIds,
      }).expect(201)).body.serIds[0] as number;
    existingSerId = await create('BOC11C 회귀 기존', [STUDENT]);
    emptySerId = await create('BOC11C 회귀 빈수업', []);
  });

  afterAll(async () => {
    try { if (ds?.isInitialized) await cleanup(); } finally { await app?.close(); }
  });

  const action = (name: string, expectedVersion: number, reason?: string, requestKey = randomUUID()) =>
    request(app.getHttpServer()).post(`/accounting/delinquency-suspensions/${STUDENT}/${name}`)
      .set(auth(adminToken)).send({ expectedVersion, requestKey, ...(reason ? { reason } : {}) });

  it('14일 이상 후보·aging·마스킹 연락처를 서버가 계산하고 강사를 차단한다', async () => {
    await request(app.getHttpServer()).get('/accounting/delinquency-suspensions').set(auth(teacherToken)).expect(403);
    const body = (await request(app.getHttpServer()).get('/accounting/delinquency-suspensions')
      .set(auth(adminToken)).expect(200)).body;
    expect(body.policy).toMatchObject({ thresholdDays: 14, version: 1, canChange: true });
    expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({
      studentId: STUDENT, state: 'candidate', version: 0, outstanding: 100000,
      overdueInvoiceCount: 1, contact: '납부보호자 010-****-5678', affectedSeriesCount: 1,
    })]));
    const recent = body.aging.find((row: { key: string }) => row.key === '1_30');
    // 원장은 전사 합계라 seed의 다른 연체도 포함한다. 이 fixture 두 명의 기여가 빠지지 않았는지만 하한으로 검증한다.
    expect(recent.outstanding).toBeGreaterThanOrEqual(150000);
    expect(recent.studentCount).toBeGreaterThanOrEqual(2);
  });

  it('기준 변경은 version/requestKey로 수렴하고 후보를 즉시 재판정한다', async () => {
    const key = randomUUID();
    const payload = { thresholdDays: 30, expectedVersion: 1, requestKey: key };
    await request(app.getHttpServer()).post('/accounting/delinquency-suspensions/policy').set(auth(ceoToken))
      .send(payload).expect(201).expect(({ body }) => expect(body).toMatchObject({ thresholdDays: 30, version: 2 }));
    await request(app.getHttpServer()).post('/accounting/delinquency-suspensions/policy').set(auth(ceoToken))
      .send(payload).expect(201).expect(({ body }) => expect(body).toMatchObject({ thresholdDays: 30, version: 2 }));
    await request(app.getHttpServer()).get('/accounting/delinquency-suspensions').set(auth(adminToken))
      .expect(200).expect(({ body }) => expect(body.items).toEqual([]));
    await request(app.getHttpServer()).post('/accounting/delinquency-suspensions/policy').set(auth(ceoToken))
      .send({ thresholdDays: 14, expectedVersion: 2, requestKey: randomUUID() }).expect(201);
  });

  it('일괄 독촉은 한 transaction에서 학생별 멱등키로 전부 기록하고 재시도한다', async () => {
    const items = [STUDENT, STUDENT2].map((studentId) => ({ studentId, expectedVersion: 0, requestKey: randomUUID() }));
    const first = await request(app.getHttpServer()).post('/accounting/delinquency-suspensions/remind-batch')
      .set(auth(adminToken)).send({ items }).expect(201);
    expect(first.body).toMatchObject({ remindedCount: 2, replayedCount: 0 });
    const replay = await request(app.getHttpServer()).post('/accounting/delinquency-suspensions/remind-batch')
      .set(auth(adminToken)).send({ items }).expect(201);
    expect(replay.body).toMatchObject({ remindedCount: 2, replayedCount: 2 });
    expect(await q(`SELECT student_id,count(*)::int AS count FROM delinquency_suspension_event
      WHERE student_id=ANY($1::bigint[]) AND action='reminded' GROUP BY student_id ORDER BY student_id`, [[STUDENT, STUDENT2]]))
      .toEqual([{ student_id: String(STUDENT), count: 1 }, { student_id: String(STUDENT2), count: 1 }]);
  });

  it('독촉 이력은 외부 발송을 가장하지 않고 same-key 재시도 뒤 한 줄만 남긴다', async () => {
    const [before] = await q<{ count: number }>(`SELECT count(*)::int AS count FROM delinquency_suspension_event
      WHERE student_id=$1 AND action='reminded'`, [STUDENT]);
    const key = randomUUID();
    await action('remind', 0, undefined, key).expect(201).expect(({ body }) => expect(body.replayed).toBe(false));
    await action('remind', 0, undefined, key).expect(201).expect(({ body }) => expect(body.replayed).toBe(true));
    expect(await q(`SELECT action,count(*)::int AS count FROM delinquency_suspension_event
      WHERE student_id=$1 GROUP BY action`, [STUDENT])).toContainEqual({ action: 'reminded', count: before.count + 1 });
  });

  it('정지 후 새 생성·이동·명단 추가·직접 SQL을 막고 기존 일정은 보존한다', async () => {
    const suspended = (await action('suspend', 0, '연체 기준 충족').expect(201)).body.item;
    expect(suspended).toMatchObject({ state: 'suspended', version: 1, canRelease: false });

    await request(app.getHttpServer()).post('/schedule').set(auth(adminToken)).send({
      kindKey: 'class', subKey: null, mode: 'online', title: 'BOC11C 회귀 차단', fromDate: '2099-04-07',
      rrule: 'ONCE', startMin: 700, endMin: 760, teacherId: TEACHER, roomId: null, studentIds: [STUDENT],
    }).expect(409).expect(({ body }) => expect(body.code).toBe('DELINQUENCY_SCHEDULE_BLOCKED'));
    await request(app.getHttpServer()).patch(`/schedule/${existingSerId}`).set(auth(adminToken)).send({
      scope: 'this', onDate: FROM, startMin: 720, endMin: 780,
    }).expect(409).expect(({ body }) => expect(body.code).toBe('DELINQUENCY_SCHEDULE_BLOCKED'));
    await request(app.getHttpServer()).patch(`/schedule/${emptySerId}/roster`).set(auth(adminToken)).send({
      op: 'add', onDate: FROM, studentId: STUDENT,
    }).expect(409).expect(({ body }) => expect(body.code).toBe('DELINQUENCY_SCHEDULE_BLOCKED'));
    await expect(q(`INSERT INTO ser_stu(ser_id,student_id,from_date) VALUES($1,$2,$3::date)`, [emptySerId, STUDENT, FROM]))
      .rejects.toThrow(/DELINQUENCY_SCHEDULE_BLOCKED/);
    expect(await q(`SELECT student_id FROM ser_stu WHERE ser_id=$1`, [existingSerId]))
      .toEqual([{ student_id: String(STUDENT) }]);
  });

  it('부분 납부는 해제를 막고 전액 입금 뒤 해제·새 일정 저장을 허용한다', async () => {
    await q(`UPDATE inv SET paid_amount=50000,state='partial' WHERE id=$1`, [invoiceId]);
    await action('release', 1, '부분 납부 확인').expect(409)
      .expect(({ body }) => expect(body.code).toBe('DELINQUENCY_RELEASE_BALANCE_REMAINS'));
    await q(`UPDATE inv SET paid_amount=100000,state='paid',paid_at=now() WHERE id=$1`, [invoiceId]);
    const released = (await action('release', 1, '전액 입금 확인').expect(201)).body.item;
    expect(released).toMatchObject({ state: 'released', stateLabel: '정지 해제', version: 2, canRelease: false });
    await request(app.getHttpServer()).get('/accounting/delinquency-suspensions').set(auth(adminToken))
      .expect(200).expect(({ body }) => expect(body.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ studentId: STUDENT, state: 'released', version: 2 }),
      ])));
    await request(app.getHttpServer()).patch(`/schedule/${emptySerId}/roster`).set(auth(adminToken)).send({
      op: 'add', onDate: FROM, studentId: STUDENT,
    }).expect(200);
  });

  it('event 변조와 receipt 없는 current 직접 변경을 DB가 거절한다', async () => {
    await expect(q(`UPDATE delinquency_suspension_event SET reason='변조' WHERE student_id=$1`, [STUDENT]))
      .rejects.toThrow(/event is immutable/);
    await expect(ds.transaction(async (m) => {
      await m.query(`UPDATE delinquency_suspension SET row_version=row_version+1 WHERE student_id=$1`, [STUDENT]);
    })).rejects.toThrow(/DELINQUENCY_CURRENT_RECEIPT_MISSING/);
  });
});
