/** @file-guide
 * 목적: BOC-11E 시간당 단가 API의 권한·DTO·멱등·교체·종료와 PostgreSQL 재조회를 검증한다.
 * 책임/재사용: 실제 AppModule과 인증 세션을 사용하며 서비스 단위 DB 시험의 계산 시나리오를 복제하지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11E-HOURLY-RATE-POLICY-2026-10-09.md · migration 1768600000000
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

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('TBO-55 BOC-11E 시간당 단가 HTTP 계약', () => {
  let app: INestApplication;
  let ds: DataSource;
  let adminToken = '';
  let teacherToken = '';
  let restrictedToken = '';

  const ADMIN = 9948601;
  const TEACHER = 9948602;
  const RESTRICTED = 9948603;
  const STUDENT = 9948604;
  const PASSWORD = 'boc11-hourly-1234';
  const FROM = '2097-01-01';
  const REPLACED_FROM = '2097-02-01';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    ds.query(sql, params) as Promise<T[]>;

  const cleanup = async () => {
    await ds.transaction(async (m) => {
      await m.query(`ALTER TABLE hourly_rate_policy_event DISABLE TRIGGER hourly_rate_policy_event_immutable`);
      await m.query(`ALTER TABLE hourly_rate_policy_request DISABLE TRIGGER hourly_rate_policy_request_immutable`);
      await m.query(`ALTER TABLE hourly_rate_policy DISABLE TRIGGER hourly_rate_policy_row_guard`);
      await m.query(`DELETE FROM hourly_rate_policy_event WHERE actor_id=ANY($1::bigint[])`, [[ADMIN, TEACHER, RESTRICTED]]);
      await m.query(`DELETE FROM hourly_rate_policy_request WHERE actor_id=ANY($1::bigint[])`, [[ADMIN, TEACHER, RESTRICTED]]);
      await m.query(`DELETE FROM hourly_rate_policy WHERE created_by=ANY($1::bigint[])`, [[ADMIN, TEACHER, RESTRICTED]]);
      await m.query(`ALTER TABLE hourly_rate_policy ENABLE TRIGGER hourly_rate_policy_row_guard`);
      await m.query(`ALTER TABLE hourly_rate_policy_request ENABLE TRIGGER hourly_rate_policy_request_immutable`);
      await m.query(`ALTER TABLE hourly_rate_policy_event ENABLE TRIGGER hourly_rate_policy_event_immutable`);
    });
    await q(`DELETE FROM log WHERE actor_id=ANY($1::bigint[])`, [[ADMIN, TEACHER, RESTRICTED]]);
    await q(`DELETE FROM stu WHERE id=$1`, [STUDENT]);
    await q(`DELETE FROM staff WHERE id=ANY($1::bigint[])`, [[ADMIN, TEACHER, RESTRICTED]]);
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
      ($1,'시간단가관리자','boc11-hourly-admin@t.kr','admin',$4,true,NULL),
      ($2,'시간단가강사','boc11-hourly-teacher@t.kr','teacher',$4,true,NULL),
      ($3,'시간단가권한회수','boc11-hourly-restricted@t.kr','admin',$4,true,false)`, [ADMIN, TEACHER, RESTRICTED, hash]);
    await markSetupDone(q, [ADMIN, TEACHER, RESTRICTED]);
    await q(`INSERT INTO stu(id,name,grade,school) VALUES($1,'시간단가학생','G8','정합중')`, [STUDENT]);

    const login = async (loginId: string) => (await request(app.getHttpServer())
      .post('/auth/login').send({ loginId, password: PASSWORD }).expect(201)).body.accessToken as string;
    adminToken = await login('boc11-hourly-admin@t.kr');
    teacherToken = await login('boc11-hourly-teacher@t.kr');
    restrictedToken = await login('boc11-hourly-restricted@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) await cleanup();
    } finally {
      await app?.close();
    }
  });

  it('canMoney가 없는 강사와 권한 회수 관리자는 조회·쓰기를 할 수 없다', async () => {
    const payload = {
      scope: 'general', hourlyAmount: 60000, effectiveFrom: FROM, requestKey: randomUUID(),
    };
    await request(app.getHttpServer()).get('/accounting/rates').set(auth(teacherToken)).expect(403);
    await request(app.getHttpServer()).get('/accounting/rates').set(auth(restrictedToken)).expect(403);
    await request(app.getHttpServer()).post('/accounting/hourly-rates').set(auth(teacherToken)).send(payload).expect(403);
    await request(app.getHttpServer()).post('/accounting/hourly-rates').set(auth(restrictedToken)).send(payload).expect(403);
  });

  it('scope 형상·학생 사유·상한·알 수 없는 입력을 DTO와 서비스가 거절한다', async () => {
    const api = () => request(app.getHttpServer()).post('/accounting/hourly-rates').set(auth(adminToken));
    await api().send({ scope: 'general', studentId: STUDENT, hourlyAmount: 60000, effectiveFrom: FROM,
      requestKey: randomUUID() }).expect(400).expect(({ body }) => expect(body.code).toBe('HOURLY_RATE_SCOPE_SHAPE'));
    await api().send({ scope: 'student', studentId: STUDENT, hourlyAmount: 40000, effectiveFrom: FROM,
      requestKey: randomUUID() }).expect(400);
    await api().send({ scope: 'group', capacity: 101, hourlyAmount: 45000, effectiveFrom: FROM,
      requestKey: randomUUID() }).expect(400);
    await api().send({ scope: 'general', hourlyAmount: 60000, effectiveFrom: FROM,
      requestKey: randomUUID(), unexpected: true }).expect(400);
  });

  it('생성·exact retry·조회·교체·stale·종료가 request/event와 함께 재조회된다', async () => {
    const createKey = randomUUID();
    const createPayload = {
      scope: 'general', hourlyAmount: 60000, effectiveFrom: FROM, requestKey: createKey,
    };
    const created = (await request(app.getHttpServer()).post('/accounting/hourly-rates').set(auth(adminToken))
      .send(createPayload).expect(201)).body;
    expect(created).toMatchObject({ replayed: false, item: {
      scope: 'general', hourlyAmount: 60000, effectiveFrom: FROM, version: 1, state: 'scheduled',
    } });
    const sourceId = created.item.id as number;
    await request(app.getHttpServer()).post('/accounting/hourly-rates').set(auth(adminToken))
      .send(createPayload).expect(201).expect(({ body }) => expect(body).toMatchObject({ replayed: true, item: { id: sourceId } }));
    await request(app.getHttpServer()).post('/accounting/hourly-rates').set(auth(adminToken))
      .send({ ...createPayload, hourlyAmount: 61000 }).expect(409)
      .expect(({ body }) => expect(body.code).toBe('HOURLY_RATE_KEY_REUSED'));

    await request(app.getHttpServer()).get('/accounting/rates').set(auth(adminToken)).expect(200)
      .expect(({ body }) => expect(body.hourlyRates).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: sourceId, hourlyAmount: 60000, events: [expect.objectContaining({ action: 'created' })] }),
      ])));

    const replaceKey = randomUUID();
    const replaced = (await request(app.getHttpServer()).patch(`/accounting/hourly-rates/${sourceId}`)
      .set(auth(adminToken)).send({ expectedVersion: 1, hourlyAmount: 80000, effectiveFrom: REPLACED_FROM,
        reason: '새 학기 일반 단가 반영', requestKey: replaceKey }).expect(200)).body;
    expect(replaced).toMatchObject({ replayed: false, item: {
      scope: 'general', hourlyAmount: 80000, effectiveFrom: REPLACED_FROM, version: 1, state: 'scheduled',
    } });
    const resultId = replaced.item.id as number;
    await request(app.getHttpServer()).get('/accounting/rates').set(auth(adminToken)).expect(200)
      .expect(({ body }) => expect(body.hourlyRates).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: sourceId, version: 2, state: 'voided', canEdit: false, canRetire: false }),
      ])));
    await request(app.getHttpServer()).patch(`/accounting/hourly-rates/${sourceId}`).set(auth(adminToken))
      .send({ expectedVersion: 1, hourlyAmount: 81000, effectiveFrom: '2097-03-01',
        reason: '오래된 화면의 교체', requestKey: randomUUID() }).expect(409)
      .expect(({ body }) => expect(body.code).toBe('HOURLY_RATE_STALE'));
    await request(app.getHttpServer()).delete(`/accounting/hourly-rates/${sourceId}`).set(auth(adminToken))
      .send({ expectedVersion: 2, reason: '교체 원본 재종료 차단', requestKey: randomUUID() }).expect(409)
      .expect(({ body }) => expect(body.code).toBe('HOURLY_RATE_NOT_ACTIVE'));

    const retired = (await request(app.getHttpServer()).delete(`/accounting/hourly-rates/${resultId}`)
      .set(auth(adminToken)).send({ expectedVersion: 1, reason: '예정 정책 취소', requestKey: randomUUID() }).expect(200)).body;
    expect(retired).toMatchObject({ replayed: false, item: { id: resultId, version: 2, state: 'voided' } });

    expect(await q(`SELECT id,row_version,voided FROM hourly_rate_policy WHERE id=ANY($1::bigint[]) ORDER BY id`,
      [[sourceId, resultId]])).toEqual([
      { id: String(sourceId), row_version: 2, voided: true },
      { id: String(resultId), row_version: 2, voided: true },
    ]);
    expect(await q(`SELECT action,count(*)::int AS count FROM hourly_rate_policy_request
      WHERE actor_id=$1 GROUP BY action ORDER BY action`, [ADMIN])).toEqual([
      { action: 'created', count: 1 }, { action: 'replaced', count: 1 }, { action: 'retired', count: 1 },
    ]);
    expect(await q(`SELECT action,count(*)::int AS count FROM hourly_rate_policy_event
      WHERE actor_id=$1 GROUP BY action ORDER BY action`, [ADMIN])).toEqual([
      { action: 'created', count: 2 }, { action: 'retired', count: 1 }, { action: 'superseded', count: 1 },
    ]);
  });

  it('오늘까지 종료한 정책은 가격 상태가 current여도 추가 교체·종료가 닫힌다', async () => {
    const today = todayKst();
    const made = (await request(app.getHttpServer()).post('/accounting/hourly-rates').set(auth(adminToken)).send({
      scope: 'group', capacity: 5, hourlyAmount: 41000, effectiveFrom: today, effectiveTo: today,
      reason: '당일 종료 검수', requestKey: randomUUID(),
    }).expect(201)).body;
    const id = made.item.id as number;
    await request(app.getHttpServer()).delete(`/accounting/hourly-rates/${id}`).set(auth(adminToken)).send({
      expectedVersion: 1, reason: '오늘까지만 적용', requestKey: randomUUID(),
    }).expect(200).expect(({ body }) => expect(body.item).toMatchObject({
      state: 'current', version: 2, canEdit: false, canRetire: false,
    }));
    await request(app.getHttpServer()).patch(`/accounting/hourly-rates/${id}`).set(auth(adminToken)).send({
      expectedVersion: 2, hourlyAmount: 42000, effectiveFrom: addDays(today, 1),
      reason: '종료 뒤 교체 차단', requestKey: randomUUID(),
    }).expect(409).expect(({ body }) => expect(body.code).toBe('HOURLY_RATE_NOT_ACTIVE'));
    await request(app.getHttpServer()).delete(`/accounting/hourly-rates/${id}`).set(auth(adminToken)).send({
      expectedVersion: 2, reason: '중복 종료 차단', requestKey: randomUUID(),
    }).expect(409).expect(({ body }) => expect(body.code).toBe('HOURLY_RATE_NOT_ACTIVE'));
  });
});
