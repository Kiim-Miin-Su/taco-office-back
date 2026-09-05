/**
 * 출결 수직 계약 — 권한 → DTO → 전이 가드 → ATT 현재값 → LOG revision.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('회차 출결 계약 (D-R35)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let teacherToken = '';
  let managerToken = '';
  const originalDatabaseUrl = process.env.DATABASE_URL;

  const RUN = 9_700_000 + process.pid * 10;
  const TEACHER = RUN + 1;
  const MANAGER = RUN + 2;
  const PAST = RUN + 3;
  const FUTURE = RUN + 4;
  const CANCELED = RUN + 5;
  const STUDENT = RUN + 6;
  const KIND = `at${process.pid}`.slice(0, 16);
  const PAST_DATE = '2025-01-02';
  const FUTURE_DATE = '2099-01-02';
  const PW = 'attendance-1234';
  const TEACHER_EMAIL = `attendance-teacher-${RUN}@t.kr`;
  const MANAGER_EMAIL = `attendance-manager-${RUN}@t.kr`;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;

  async function clean(): Promise<void> {
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[TEACHER, MANAGER]]);
    await q(`DELETE FROM att WHERE ser_id = ANY($1)`, [[PAST, FUTURE, CANCELED]]);
    await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [[PAST, FUTURE, CANCELED]]);
    await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [[PAST, FUTURE, CANCELED]]);
    await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [[PAST, FUTURE, CANCELED]]);
    await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [[PAST, FUTURE, CANCELED]]);
    await q(`DELETE FROM ser WHERE id = ANY($1)`, [[PAST, FUTURE, CANCELED]]);
    await q(`DELETE FROM stu WHERE id=$1`, [STUDENT]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[TEACHER, MANAGER]]);
    await q(`DELETE FROM kind WHERE key=$1`, [KIND]);
  }

  beforeAll(async () => {
    // AppModule 의 TypeORM 옵션은 import 시점에 DATABASE_URL 을 고정한다.
    // 파괴적 E2E가 release/dev DB에 붙지 않도록 안전 확인 뒤 동적 import 한다.
    process.env.DATABASE_URL = assertScratch(TEST_URL);
    const { AppModule } = await import('../src/app.module');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    ds = app.get(DataSource);
    const connectedUrl = 'url' in ds.options ? ds.options.url : undefined;
    assertScratch(typeof connectedUrl === 'string' ? connectedUrl : undefined);
    await clean();

    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO kind (key,name,color,cap,grp,rep,sort)
       VALUES ($1,'출결 테스트','#2563EB',4,'lesson',true,999)`,
      [KIND],
    );
    await q(
      `INSERT INTO staff (id,name,email,role,password_hash,active)
       VALUES ($1,'출결강사',$2,'teacher',$3,true), ($4,'출결매니저',$5,'manager',$3,true)`,
      [TEACHER, TEACHER_EMAIL, hash, MANAGER, MANAGER_EMAIL],
    );
    await q(`INSERT INTO stu (id,name,grade) VALUES ($1,'출결학생','고2')`, [STUDENT]);
    for (const [serId, date, title] of [
      [PAST, PAST_DATE, '출결 지난 수업'],
      [FUTURE, FUTURE_DATE, '출결 미래 수업'],
      [CANCELED, PAST_DATE, '출결 휴강 수업'],
    ] as const) {
      await q(
        `INSERT INTO ser (id,kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
         VALUES ($1,$2,$3,'offline',540,600,'ONCE',$4,$4,$5)`,
        [serId, KIND, TEACHER, date, title],
      );
      await q(
        `INSERT INTO ser_occ (ser_id,on_date,teacher_id,canceled,span)
         VALUES ($1,$2,$3,$4,
           tstzrange(($2::date + time '09:00') AT TIME ZONE 'Asia/Seoul',
                     ($2::date + time '10:00') AT TIME ZONE 'Asia/Seoul','[)'))`,
        [serId, date, TEACHER, serId === CANCELED],
      );
    }
    await q(`INSERT INTO ser_stu (ser_id,student_id) VALUES ($1,$2)`, [PAST, STUDENT]);
    await q(
      `INSERT INTO rep (ser_id,on_date,teacher_id,kind_key,lang,body,state)
       VALUES ($1,$2,$3,$4,'ko','{}'::jsonb,'none')`,
      [PAST, PAST_DATE, TEACHER, KIND],
    );

    const login = async (email: string) => (
      await request(app.getHttpServer()).post('/auth/login').send({ email, password: PW }).expect(201)
    ).body.accessToken as string;
    teacherToken = await login(TEACHER_EMAIL);
    managerToken = await login(MANAGER_EMAIL);
  });

  beforeEach(async () => {
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[TEACHER, MANAGER]]);
    await q(`DELETE FROM att WHERE ser_id = ANY($1)`, [[PAST, FUTURE, CANCELED]]);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await clean();
    await app?.close();
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
  });

  const save = (token: string, serId: number, onDate: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .put(`/schedule/${serId}/${onDate}/attendance`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const clear = (token: string, serId = PAST, onDate = PAST_DATE) =>
    request(app.getHttpServer())
      .delete(`/schedule/${serId}/${onDate}/attendance`)
      .set('Authorization', `Bearer ${token}`);

  it('목록은 같은 ATT 현재값과 서버 권한 모드를 역할별로 내려준다', async () => {
    const manager = await request(app.getHttpServer())
      .get('/schedule/occurrences').query({ from: PAST_DATE, to: PAST_DATE })
      .set('Authorization', `Bearer ${managerToken}`).expect(200);
    const teacher = await request(app.getHttpServer())
      .get('/schedule/occurrences').query({ from: PAST_DATE, to: PAST_DATE })
      .set('Authorization', `Bearer ${teacherToken}`).expect(200);
    expect(manager.body.items.find((x: { serId: number }) => x.serId === PAST)).toMatchObject({
      attendanceMode: 'manage', attendance: null,
    });
    expect(teacher.body.items.find((x: { serId: number }) => x.serId === PAST)).toMatchObject({
      attendanceMode: 'readonly', attendance: null,
    });
  });

  it('강사·종료 전·관리 취소 회차와 잘못된 DTO를 각 경계에서 막는다', async () => {
    await save(teacherToken, PAST, PAST_DATE, { result: 'completed' }).expect(403);
    expect((await save(managerToken, FUTURE, FUTURE_DATE, { result: 'completed' }).expect(409)).body.code)
      .toBe('ATTENDANCE_NOT_AVAILABLE');
    expect((await save(managerToken, CANCELED, PAST_DATE, { result: 'completed' }).expect(409)).body.code)
      .toBe('ATTENDANCE_NOT_AVAILABLE');
    expect((await save(managerToken, PAST, PAST_DATE, { result: 'canceled' }).expect(400)).body.code)
      .toBe('ATTENDANCE_REASON_REQUIRED');
    expect((await save(managerToken, PAST, PAST_DATE, { result: 'completed', reason: 'academy' }).expect(400)).body.code)
      .toBe('ATTENDANCE_REASON_FORBIDDEN');
    await save(managerToken, PAST, PAST_DATE, { result: 'completed', legacy: true }).expect(400);
    await save(managerToken, PAST, '2025-1-2', { result: 'completed' }).expect(400);
  });

  it('생성·정정·초기화는 현재값 하나와 append-only LOG revision을 남긴다', async () => {
    const created = await save(managerToken, PAST, PAST_DATE, { result: 'completed' }).expect(200);
    expect(created.body.attendance).toMatchObject({
      result: 'completed', reason: null, confirmedBy: MANAGER, confirmedByName: '출결매니저',
    });
    const attendanceId = created.body.attendance.id as number;

    const updated = await save(managerToken, PAST, PAST_DATE, {
      result: 'canceled', reason: 'student_absent',
    }).expect(200);
    expect(updated.body.attendance).toMatchObject({ id: attendanceId, result: 'canceled', reason: 'student_absent' });

    const listed = await request(app.getHttpServer())
      .get('/schedule/occurrences').query({ from: PAST_DATE, to: PAST_DATE })
      .set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(listed.body.items.find((x: { serId: number }) => x.serId === PAST).attendance)
      .toMatchObject({ id: attendanceId, result: 'canceled', reason: 'student_absent' });

    expect((await clear(managerToken).expect(200)).body.attendance).toBeNull();
    expect(await q(`SELECT 1 FROM att WHERE ser_id=$1 AND on_date=$2`, [PAST, PAST_DATE])).toHaveLength(0);
    const logs = await q<{ action: string; before: unknown; after: unknown }>(
      `SELECT action,before,after FROM log WHERE entity='ATT' AND entity_id=$1 ORDER BY id`, [attendanceId],
    );
    expect(logs.map((x) => x.action)).toEqual(['create', 'update', 'clear']);
    expect(logs[0]!.before).toBeNull();
    expect(logs[1]!.before).toMatchObject({ result: 'completed' });
    expect(logs[2]!.after).toBeNull();
    expect((await clear(managerToken).expect(404)).body.code).toBe('ATTENDANCE_NOT_FOUND');
  });

  it('동시 확정도 회차 잠금으로 직렬화해 현재값은 하나만 둔다', async () => {
    const [a, b] = await Promise.all([
      save(managerToken, PAST, PAST_DATE, { result: 'completed' }),
      save(managerToken, PAST, PAST_DATE, { result: 'canceled', reason: 'academy' }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await q(`SELECT 1 FROM att WHERE ser_id=$1 AND on_date=$2`, [PAST, PAST_DATE])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM log WHERE actor_id=$1 AND entity='ATT'`, [MANAGER])).toHaveLength(2);
  });

  it('취소 출결은 리포트·현황판·대표 집계가 ATT를 직접 읽어 제외한다', async () => {
    const saved = await save(managerToken, PAST, PAST_DATE, {
      result: 'canceled', reason: 'student_absent',
    }).expect(200);
    expect(saved.body.attendance.countsForPay).toBe(false);

    const schedule = await request(app.getHttpServer())
      .get('/schedule/occurrences').query({ from: PAST_DATE, to: PAST_DATE })
      .set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(schedule.body.items.find((x: { serId: number }) => x.serId === PAST)).toMatchObject({
      repState: 'na', attendance: { result: 'canceled', countsForPay: false },
    });

    const unwritten = await request(app.getHttpServer())
      .get('/reports/unwritten').set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(unwritten.body.items.some((x: { serId: number }) => x.serId === PAST)).toBe(false);

    const board = await request(app.getHttpServer())
      .get('/board').query({ from: PAST_DATE, to: PAST_DATE })
      .set('Authorization', `Bearer ${managerToken}`).expect(200);
    const boardRow = board.body.rows.find((x: { serId: number }) => x.serId === PAST);
    expect(boardRow.canceled).toBe(true);
    expect(boardRow.marks.find((x: { key: string }) => x.key === 'report').na).toBe(true);

    const exec = await request(app.getHttpServer())
      .get('/exec').query({ from: PAST_DATE, to: PAST_DATE })
      .set('Authorization', `Bearer ${managerToken}`).expect(200);
    const stat = (key: string) => exec.body.stats.find((x: { key: string }) => x.key === key).value;
    expect(stat('lessons')).toBe(0);
    expect(stat('canceled')).toBe(2);
    expect(stat('students')).toBe(0);
    expect(stat('unwritten')).toBe(0);
  });

  it('DB CHECK도 DTO를 우회한 잘못된 결과·사유 조합을 거절한다', async () => {
    await expect(q(
      `INSERT INTO att (ser_id,on_date,result,reason,confirmed_by)
       VALUES ($1,$2,'completed','academy',$3)`,
      [PAST, PAST_DATE, MANAGER],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('출결 이력이 붙은 SER 전체 삭제는 물리 삭제 대신 기간을 마감한다', async () => {
    await save(managerToken, PAST, PAST_DATE, { result: 'completed' }).expect(200);
    const removed = await request(app.getHttpServer())
      .delete(`/schedule/${PAST}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ scope: 'all', onDate: PAST_DATE })
      .expect(200);
    expect(removed.body.log.join(' ')).toContain('참조 있음');
    expect(await q(`SELECT 1 FROM ser WHERE id=$1`, [PAST])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM att WHERE ser_id=$1`, [PAST])).toHaveLength(1);
  });
});
