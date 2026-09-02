/**
 * 리포트 세로 계약 — HTTP DTO → 방어 규칙 → REP.body·상태가 한 흐름인지 본다.
 * 테스트 행은 고정된 높은 id대를 쓰고 매 케이스 전에 복원한다.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('리포트 쓰기 계약 (D-R7 · D-R15 · D-R40)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let repId = 0;
  let teacherToken = '';
  let otherToken = '';
  let managerToken = '';

  /** 동시에 두 Jest 프로세스가 돌아도 테스트 행·계정을 서로 지우지 않는다. */
  const RUN = 9_000_000 + process.pid * 10;
  const SER = RUN + 1;
  const TEACHER = RUN + 2;
  const OTHER = RUN + 3;
  const MANAGER = RUN + 4;
  const STUDENT = RUN + 5;
  const TEACHER_EMAIL = `report-teacher-${RUN}@t.kr`;
  const OTHER_EMAIL = `report-other-${RUN}@t.kr`;
  const MANAGER_EMAIL = `report-manager-${RUN}@t.kr`;
  const DATE = '2025-01-02';
  const PW = 'report-write-1234';
  const body = { content: '미분 응용 문제를 풀었습니다.', progress: '수학 II 42p까지', homework: '43~45p 풀기' };

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;

  async function clean(): Promise<void> {
    await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id=$1)`, [SER]);
    await q(`DELETE FROM rep WHERE ser_id=$1`, [SER]);
    await q(`DELETE FROM ser_occ WHERE ser_id=$1`, [SER]);
    await q(`DELETE FROM ser WHERE id=$1`, [SER]);
    await q(`DELETE FROM stu WHERE id=$1`, [STUDENT]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[TEACHER, OTHER, MANAGER]]);
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    ds = app.get(DataSource);

    await clean();
    const hash = await bcrypt.hash(PW, 4);
    for (const person of [
      [TEACHER, '리포트강사', TEACHER_EMAIL, 'teacher'],
      [OTHER, '다른강사', OTHER_EMAIL, 'teacher'],
      [MANAGER, '리포트매니저', MANAGER_EMAIL, 'manager'],
    ] as const) {
      await q(
        `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES ($1,$2,$3,$4,$5,true)`,
        [person[0], person[1], person[2], person[3], hash],
      );
    }
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1, '리포트학생', '10')`, [STUDENT]);
    await q(
      `INSERT INTO ser (id, kind_key, sub_key, teacher_id, mode, start_min, end_min, rrule, from_date, to_date, title)
       VALUES ($1, 'class', NULL, $2, 'offline', 540, 600, 'ONCE', $3, $3, '리포트 계약 테스트')`,
      [SER, TEACHER, DATE],
    );
    await q(
      `INSERT INTO ser_occ (ser_id, on_date, teacher_id, canceled, span)
       VALUES ($1, $2, $3, false,
         tstzrange(($2::date + time '09:00') AT TIME ZONE 'Asia/Seoul',
                   ($2::date + time '10:00') AT TIME ZONE 'Asia/Seoul', '[)'))`,
      [SER, DATE, TEACHER],
    );
    const reps = await q<{ id: string }>(
      `INSERT INTO rep (ser_id, on_date, teacher_id, kind_key, lang, body, state)
       VALUES ($1, $2, $3, 'class', 'ko', '{}'::jsonb, 'none') RETURNING id::text`,
      [SER, DATE, TEACHER],
    );
    repId = Number(reps[0].id);
    await q(`INSERT INTO rep_stu (rep_id, student_id, deliver) VALUES ($1,$2,true)`, [repId, STUDENT]);

    const login = async (email: string) => {
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    teacherToken = await login(TEACHER_EMAIL);
    otherToken = await login(OTHER_EMAIL);
    managerToken = await login(MANAGER_EMAIL);
  });

  beforeEach(async () => {
    await q(
      `UPDATE rep SET body='{}'::jsonb, state='none', written_at=NULL, submitted_at=NULL,
                      reviewed_at=NULL, reviewer_id=NULL, reject_reason=NULL WHERE id=$1`,
      [repId],
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) await clean();
    await app?.close();
  });

  const get = (token: string) => request(app.getHttpServer())
    .get(`/reports/${SER}/${DATE}`).set('Authorization', `Bearer ${token}`);
  const put = (token: string, value: Record<string, unknown>) => request(app.getHttpServer())
    .put(`/reports/${SER}/${DATE}/draft`).set('Authorization', `Bearer ${token}`).send(value);
  const submit = (token: string, value: Record<string, unknown>) => request(app.getHttpServer())
    .post(`/reports/${SER}/${DATE}/submit`).set('Authorization', `Bearer ${token}`).send(value);

  it('상세는 DB의 빈 body를 3개 입력으로 정규화하고 그 순서를 내려준다', async () => {
    const res = await get(teacherToken).expect(200);
    expect(res.body).toMatchObject({
      serId: SER,
      date: DATE,
      onDate: DATE,
      state: 'none',
      canEdit: true,
      body: { content: '', progress: '', homework: '' },
    });
    expect(res.body.fields.map((field: { key: string }) => field.key)).toEqual(['content', 'progress', 'homework']);
  });

  it('담당이 아닌 강사는 조회·저장할 수 없다', async () => {
    expect((await get(otherToken).expect(403)).body.code).toBe('REPORT_FORBIDDEN');
    expect((await put(otherToken, body).expect(403)).body.code).toBe('REPORT_FORBIDDEN');
  });

  it('임시저장은 빈 값을 허용하고 REP.body에 세 키만 쓴다', async () => {
    await put(teacherToken, { content: '', progress: '', homework: '' }).expect(200);
    const row = (await q<{ state: string; body: Record<string, string> }>(
      `SELECT state, body FROM rep WHERE id=$1`, [repId],
    ))[0];
    expect(row.state).toBe('draft');
    expect(row.body).toEqual({ content: '', progress: '', homework: '' });
  });

  it('DTO에 없는 입력 키와 빈 제출을 각각 막는다', async () => {
    await put(teacherToken, { ...body, understanding: '구 입력' }).expect(400);
    const blank = await submit(teacherToken, { ...body, progress: '  ' }).expect(400);
    expect(blank.body.code).toBe('REPORT_FIELD_REQUIRED');
  });

  it('전체 관리 권한은 제출할 수 있고 최초 제출 시각은 재제출해도 바뀌지 않는다', async () => {
    const first = await submit(managerToken, body).expect(201);
    expect(first.body).toMatchObject({ state: 'wait', written: true, canEdit: false, body });
    const firstAt = first.body.submittedAt as string;
    expect(firstAt).toBeTruthy();
    expect((await submit(managerToken, body).expect(409)).body.code).toBe('REPORT_LOCKED');

    await q(`UPDATE rep SET state='rej', reviewed_at=now(), reject_reason='보완 필요' WHERE id=$1`, [repId]);
    const again = await submit(teacherToken, { ...body, homework: '46p까지' }).expect(201);
    expect(again.body.submittedAt).toBe(firstAt);
    expect(again.body.rejectReason).toBeNull();
  });
});
