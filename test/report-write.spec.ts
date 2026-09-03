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
  let reviewerToken = '';

  /** 동시에 두 Jest 프로세스가 돌아도 테스트 행·계정을 서로 지우지 않는다. */
  const RUN = 9_000_000 + process.pid * 10;
  const SER = RUN + 1;
  const TEACHER = RUN + 2;
  const OTHER = RUN + 3;
  const MANAGER = RUN + 4;
  const STUDENT = RUN + 5;
  const REVIEWER = RUN + 6;
  const TEACHER_EMAIL = `report-teacher-${RUN}@t.kr`;
  const OTHER_EMAIL = `report-other-${RUN}@t.kr`;
  const MANAGER_EMAIL = `report-manager-${RUN}@t.kr`;
  const REVIEWER_EMAIL = `report-reviewer-${RUN}@t.kr`;
  const DATE = '2025-01-02';
  const PW = 'report-write-1234';
  const body = { content: '미분 응용 문제를 풀었습니다.', progress: '수학 II 42p까지', homework: '43~45p 풀기' };

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;

  async function clean(): Promise<void> {
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[TEACHER, OTHER, MANAGER, REVIEWER]]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[TEACHER, OTHER, MANAGER, REVIEWER]]);
    await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id=$1)`, [SER]);
    await q(`DELETE FROM rep WHERE ser_id=$1`, [SER]);
    await q(`DELETE FROM ser_occ WHERE ser_id=$1`, [SER]);
    await q(`DELETE FROM ser WHERE id=$1`, [SER]);
    await q(`DELETE FROM stu WHERE id=$1`, [STUDENT]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[TEACHER, OTHER, MANAGER, REVIEWER]]);
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
      [REVIEWER, '리포트검토자', REVIEWER_EMAIL, 'teacher'],
    ] as const) {
      await q(
        `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES ($1,$2,$3,$4,$5,true)`,
        [person[0], person[1], person[2], person[3], hash],
      );
    }
    await q(`UPDATE staff SET can_approve=true WHERE id=$1`, [REVIEWER]);
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
    reviewerToken = await login(REVIEWER_EMAIL);
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
  const review = (token: string, value: Record<string, unknown>) => request(app.getHttpServer())
    .post(`/reports/${SER}/${DATE}/review`).set('Authorization', `Bearer ${token}`).send(value);

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

    await q(
      `UPDATE rep SET state='rej', reviewed_at=now(), reviewer_id=$2, reject_reason='보완 필요' WHERE id=$1`,
      [repId, MANAGER],
    );
    const again = await submit(teacherToken, { ...body, homework: '46p까지' }).expect(201);
    expect(again.body.submittedAt).toBe(firstAt);
    expect(again.body.rejectReason).toBeNull();
  });

  it('승인 권한·대기 상태·반려 사유를 막고 승인 이력을 원자적으로 남긴다', async () => {
    await submit(teacherToken, body).expect(201);
    expect((await review(teacherToken, { decision: 'approve' }).expect(403)).body.code)
      .toBe('REPORT_REVIEW_FORBIDDEN');
    expect((await review(managerToken, { decision: 'approve', reason: '불필요' }).expect(400)).body.code)
      .toBe('APPROVE_REASON_FORBIDDEN');
    expect((await review(managerToken, { decision: 'reject', reason: '  ' }).expect(400)).body.code)
      .toBe('REJECT_REASON_REQUIRED');

    const approved = await review(managerToken, { decision: 'approve' }).expect(201);
    expect(approved.body).toMatchObject({ state: 'ok', canReview: false, rejectReason: null });
    expect((await review(managerToken, { decision: 'approve' }).expect(409)).body.code)
      .toBe('REPORT_NOT_WAITING');

    const [row] = await q<{ reviewer_id: string; reviewed_at: string; reject_reason: string | null }>(
      `SELECT reviewer_id::text, reviewed_at::text, reject_reason FROM rep WHERE id=$1`, [repId],
    );
    expect(Number(row.reviewer_id)).toBe(MANAGER);
    expect(row.reviewed_at).toBeTruthy();
    expect(row.reject_reason).toBeNull();
    expect((await q(`SELECT 1 FROM log WHERE entity='REP' AND entity_id=$1 AND action='approve'`, [repId])))
      .toHaveLength(1);
    expect((await q(`SELECT 1 FROM noti WHERE to_id=$1 AND from_id=$2 AND link='/reports'`, [TEACHER, MANAGER])))
      .toHaveLength(1);
  });

  it('canApprove 예외 권한만 있는 검토자도 전건 큐와 상세를 읽고 검토할 수 있다', async () => {
    expect((await get(reviewerToken).expect(403)).body.code).toBe('REPORT_FORBIDDEN');
    const ownOnly = await request(app.getHttpServer())
      .get('/reports/unwritten').set('Authorization', `Bearer ${reviewerToken}`).expect(200);
    expect(ownOnly.body.total).toBe(0);

    await submit(teacherToken, body).expect(201);
    const list = await request(app.getHttpServer())
      .get('/reports').query({ state: 'wait' })
      .set('Authorization', `Bearer ${reviewerToken}`).expect(200);
    expect(list.body.items.some((item: { serId: number }) => item.serId === SER)).toBe(true);
    expect((await get(reviewerToken).expect(200)).body).toMatchObject({ canEdit: false, canReview: true });
    expect((await review(reviewerToken, { decision: 'approve' }).expect(201)).body.state).toBe('ok');
    expect((await get(reviewerToken).expect(200)).body).toMatchObject({ state: 'ok', canReview: false });
  });

  it('반려 사유가 상세에 보이고 재제출은 최초 제출 시각을 보존한다', async () => {
    const first = await submit(teacherToken, body).expect(201);
    const firstAt = first.body.submittedAt as string;
    const rejected = await review(managerToken, { decision: 'reject', reason: ' 진도를 보완해 주세요. ' }).expect(201);
    expect(rejected.body).toMatchObject({ state: 'rej', rejectReason: '진도를 보완해 주세요.', canEdit: true });

    const again = await submit(teacherToken, { ...body, progress: '수학 II 45p까지' }).expect(201);
    expect(again.body).toMatchObject({ state: 'wait', rejectReason: null, canEdit: false });
    expect(again.body.submittedAt).toBe(firstAt);
  });

  it('DB도 제출·검토 상태와 시각·검토자·사유의 불일치를 거절한다', async () => {
    await expect(q(`UPDATE rep SET state='wait' WHERE id=$1`, [repId])).rejects.toThrow();
    await expect(q(
      `UPDATE rep SET state='rej', written_at=now(), submitted_at=now(), reject_reason='사유' WHERE id=$1`,
      [repId],
    )).rejects.toThrow();
  });
});
