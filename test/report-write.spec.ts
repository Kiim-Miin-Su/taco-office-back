/** @file-guide
 * 목적: report-write.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

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
import { addD } from '../src/lib/recurrence';
import { todayKst } from '../src/lib/kst';
import { buildOpenApi } from '../src/openapi';
import { ReportsService } from '../src/modules/reports/reports.service';

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
  const STUDENT2 = RUN + 7;
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
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STUDENT, STUDENT2]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[TEACHER, OTHER, MANAGER, REVIEWER]]);
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
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
    await q(
      `INSERT INTO stu (id, name, grade) VALUES ($1, '리포트학생', '고2'), ($2, '학년없는학생', NULL)`,
      [STUDENT, STUDENT2],
    );
    await q(
      `INSERT INTO ser (id, kind_key, sub_key, teacher_id, mode, start_min, end_min, rrule, from_date, to_date, title)
       VALUES ($1, 'class', 'ap-chem', $2, 'offline', 540, 600, 'ONCE', $3, $3, '리포트 계약 테스트')`,
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
    await q(
      `INSERT INTO rep_stu (rep_id, student_id, deliver) VALUES ($1,$2,true), ($1,$3,true)`,
      [repId, STUDENT, STUDENT2],
    );

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
    try {
      if (ds?.isInitialized) await clean();
    } finally {
      await app?.close();
    }
  });

  const get = (token: string) => request(app.getHttpServer())
    .get(`/reports/${SER}/${DATE}`).set('Authorization', `Bearer ${token}`);
  const put = (token: string, value: Record<string, unknown>) => request(app.getHttpServer())
    .put(`/reports/${SER}/${DATE}/draft`).set('Authorization', `Bearer ${token}`).send(value);
  const submit = (token: string, value: Record<string, unknown>) => request(app.getHttpServer())
    .post(`/reports/${SER}/${DATE}/submit`).set('Authorization', `Bearer ${token}`).send(value);
  const review = (token: string, value: Record<string, unknown>) => request(app.getHttpServer())
    .post(`/reports/${SER}/${DATE}/review`).set('Authorization', `Bearer ${token}`).send(value);

  it.each([
    { date: DATE, start: 540, end: 600, label: '09:00–10:00' },
    { date: '2025-01-03', start: 1380, end: 1440, label: '23:00–24:00' },
    { date: DATE, start: null, end: null, label: '시간 미정' },
  ])('조회·상세·복사 시간은 실제 span을 따른다: $label', async ({ date, start, end, label }) => {
    await put(teacherToken, body).expect(200);
    const [original] = await q<{ span: string }>('SELECT span::text FROM ser_occ WHERE ser_id=$1 AND on_date=$2', [SER, DATE]);
    try {
      if (start === null) {
        await q('DELETE FROM ser_occ WHERE ser_id=$1 AND on_date=$2', [SER, DATE]);
      } else {
        await q(`UPDATE ser_occ SET span=tstzrange(
          ($3::date + $4 * interval '1 minute') AT TIME ZONE 'Asia/Seoul',
          ($3::date + $5 * interval '1 minute') AT TIME ZONE 'Asia/Seoul','[)')
          WHERE ser_id=$1 AND on_date=$2`, [SER, DATE, date, start, end]);
      }
      const result = (await get(teacherToken).expect(200)).body;
      expect(result).toMatchObject({ date, onDate: DATE, startMin: start, endMin: end });
      expect(result.exportFiles[0].plainText).toContain(`② 수업: ${date} · AP Chemistry · ${label}`);
      expect(result.exportFiles[0].fileName).toBe(`${date.replaceAll('-', '')}_리포트학생_고2_AP Chemistry_${start === null ? '시간미정' : label.slice(0, 5)}.png`);
      const list = await request(app.getHttpServer()).get('/reports').query({ from: date, to: date })
        .set('Authorization', `Bearer ${teacherToken}`).expect(200);
      expect(list.body.items.find((item: { id: number }) => item.id === repId))
        .toMatchObject({ date, onDate: DATE, startMin: start, endMin: end });
    } finally {
      await q(`INSERT INTO ser_occ (ser_id,on_date,teacher_id,canceled,span) VALUES ($1,$2,$3,false,$4::tstzrange)
        ON CONFLICT (ser_id,on_date) DO UPDATE SET span=EXCLUDED.span`, [SER, DATE, TEACHER, original.span]);
    }
  });

  it('파생 시간은 nullable 응답이며 리포트 쓰기 입력으로 허용하지 않는다', async () => {
    const schemas = buildOpenApi(app).components!.schemas!;
    for (const name of ['ReportRowDto', 'ReportDetailDto']) {
      expect(schemas[name]).toMatchObject({ properties: {
        startMin: { type: 'integer', nullable: true, minimum: 0, maximum: 1439 },
        endMin: { type: 'integer', nullable: true, minimum: 1, maximum: 1440 },
      } });
    }
    await put(teacherToken, { ...body, endMin: 600 }).expect(400);
  });

  it.each([
    { from: '2026-02-30' }, { to: '0000-01-01' }, { from: '2026-1-01' },
    { from: DATE, to: '2025-01-01' }, { teacherId: '0' }, { teacherId: '-1' },
    { teacherId: '1e2' }, { teacherId: '9007199254740992' }, { teacherId: '' },
    { teacherId: ['1', '2'] }, { state: 'approved' }, { state: '' }, { extra: 'unknown' },
  ])('리포트 query를 DB 조회 전에 거절한다: %j', async (query) => {
    const list = jest.spyOn(app.get(ReportsService), 'list');
    try {
      await request(app.getHttpServer()).get('/reports').query(query)
        .set('Authorization', `Bearer ${managerToken}`).expect(400);
      expect(list).not.toHaveBeenCalled();
    } finally { list.mockRestore(); }
  });

  it.each(['/reports/unwritten?teacherId=0', '/reports/unwritten?teacherId=1e2',
    '/reports/unwritten?extra=x', '/reports/1e2/2025-01-02', '/reports/9007199254740992/2025-01-02',
    `/reports/${SER}/2026-02-30`])('리포트 필터·상세 참조 형식을 검증한다: %s', async (path) => {
    await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${managerToken}`).expect(400);
  });

  it('유효한 숫자 필터도 강사의 본인 범위를 넓히지 않는다', async () => {
    const result = await request(app.getHttpServer()).get('/reports').query({ teacherId: OTHER, state: 'none' })
      .set('Authorization', `Bearer ${teacherToken}`).expect(200);
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]).toMatchObject({ serId: SER, teacherId: TEACHER });
  });

  it('Swagger query/path는 수기 string 대신 날짜·안전 정수·상태 enum 계약을 제공한다', () => {
    const paths = buildOpenApi(app).paths;
    expect(paths['/reports'].get?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'teacherId', required: false,
        schema: expect.objectContaining({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }),
      expect.objectContaining({ name: 'from', required: false, schema: expect.objectContaining({ type: 'string', format: 'date' }) }),
      expect.objectContaining({ name: 'state', required: false, schema: expect.objectContaining({ enum: ['na', 'plan', 'none', 'draft', 'wait', 'ok', 'rej'] }) }),
    ]));
    expect(paths['/reports/{serId}/{onDate}'].get?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'serId', required: true, schema: expect.objectContaining({ type: 'integer', maximum: Number.MAX_SAFE_INTEGER }) }),
    ]));
    for (const path of ['/reports', '/reports/unwritten', '/reports/deliveries', '/reports/deliveries/history']) {
      expect(paths[path].get?.responses['400']).toBeDefined();
    }
  });

  it('리포트 CRUD OpenAPI는 실제 성공 코드·상태 오류와 부모 잠금 계약을 노출한다', () => {
    const doc = buildOpenApi(app);
    for (const [action, method, success] of [['draft', 'put', '200'], ['submit', 'post', '201'], ['review', 'post', '201']] as const) {
      const operation = doc.paths[`/reports/{serId}/{onDate}/${action}`][method]!;
      expect(operation.description).toContain('부모 SER');
      expect(operation.responses[success]).toBeDefined();
      for (const status of ['400', '403', '404', '409']) {
        expect(operation.responses[status]).toMatchObject({
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorDto' } } },
        });
      }
    }
  });

  it.each((['past move', 'future move', 'teacher change', 'attendance cancel'] as const)
    .flatMap((mode) => (mode === 'teacher change' || mode === 'attendance cancel'
      ? ['draft', 'submit', 'review'] as const : ['draft', 'submit'] as const)
      .map((action) => ({ mode, action }))))(
    '선행 일정/출결 변경 후 리포트는 최신 값을 사용한다: $mode/$action', async ({ mode, action }) => {
      const date = addD(todayKst(), -1);
      const api = (method: 'post' | 'put' | 'patch' | 'delete', path: string, token = managerToken) =>
        request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`)
          .timeout({ response: 5000, deadline: 10000 });
      const created = await api('post', '/schedule').send({
        kindKey: 'class', subKey: 'ap-chem', mode: 'offline', fromDate: date, rrule: 'ONCE',
        startMin: 60, endMin: 120, teacherId: TEACHER, roomId: null, studentIds: [], title: 'report race',
      }).expect(201);
      const id = created.body.serIds[0] as number;
      const ref = `/reports/${id}/${date}`;
      let release!: () => void, ready!: () => void, consumerReady!: (pid: number) => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const paused = new Promise<void>((resolve) => { ready = resolve; });
      const started = new Promise<number>((resolve) => { consumerReady = resolve; });
      let first: Promise<request.Response> | undefined, second: Promise<request.Response> | undefined;
      let spy: jest.SpyInstance | undefined;
      try {
        if (action === 'review') await api('post', `${ref}/submit`, teacherToken).send(body).expect(201);
        const createRunner = ds.createQueryRunner.bind(ds);
        let writer: ReturnType<typeof createRunner> | undefined;
        let consumerSeen = false;
        spy = jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
          const runner = createRunner(...args);
          const query = runner.query.bind(runner);
          jest.spyOn(runner, 'query').mockImplementation(async (sql: string, parameters?: unknown[], structured?: boolean) => {
            const targets = parameters?.some((p: unknown) => Array.isArray(p) ? p.includes(id) : p === id);
            if (!writer && targets && sql.includes('FOR NO KEY UPDATE')) writer = runner;
            // 실제 선행 쓰기를 끝낸 뒤 commit만 보류한다. 업무 SQL/결과는 mock하지 않는다.
            if (runner === writer && sql === 'COMMIT') { ready(); await hold; }
            if (writer && runner !== writer && runner.isTransactionActive && targets && !consumerSeen
                && /FOR (NO KEY UPDATE|UPDATE OF r)/.test(sql)) {
              consumerSeen = true;
              const [{ pid }] = await query('SELECT pg_backend_pid() AS pid');
              consumerReady(pid);
            }
            return structured ? query(sql, parameters, true) : query(sql, parameters);
          });
          return runner;
        });
        first = Promise.resolve(mode === 'attendance cancel'
          ? api('put', `/schedule/${id}/${date}/attendance`).send({ result: 'canceled', reason: 'academy' })
          : api('patch', `/schedule/${id}`).send({ scope: 'this', onDate: date,
            ...(mode === 'teacher change' ? { teacherId: OTHER }
              : { startMin: 75, endMin: 135, ...(mode === 'future move' ? { date: addD(todayKst(), 1) } : {}) }),
          }));
        await Promise.race([paused, first.then(() => { throw new Error('선행 commit에 도달하지 못함'); })]);
        let completed = false;
        second = Promise.resolve(api(action === 'draft' ? 'put' : 'post', `${ref}/${action}`,
          action === 'review' ? managerToken : teacherToken)
          .send(action === 'review' ? { decision: 'approve' } : body));
        void second.then(() => { completed = true; }, () => { completed = true; });
        const pid = await Promise.race([started, second.then(() => { throw new Error('리포트 잠금에 도달하지 못함'); })]);
        let blocked = false;
        const deadline = Date.now() + 4000;
        while (!blocked && !completed) {
          [{ blocked }] = await q<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid]);
          if (Date.now() > deadline) throw new Error('리포트 경합 관측 시간 초과');
        }
        release();
        const [changed, saved] = await Promise.all([first, second]);
        expect(changed.status).toBe(200);
        const rejected = action !== 'review' && mode !== 'past move';
        expect(saved.status).toBe(rejected ? mode === 'teacher change' ? 403 : 400 : action === 'draft' ? 200 : 201);
        const rows = await q('SELECT state, body FROM rep WHERE ser_id=$1', [id]);
        if (rejected) {
          expect(saved.body.code).toBe(mode === 'teacher change' ? 'REPORT_FORBIDDEN'
            : mode === 'future move' ? 'REPORT_NOT_ENDED' : 'REPORT_CANCELED');
          expect(rows).toEqual([{ state: 'none', body: {} }]);
        } else {
          expect(rows).toEqual([{ state: action === 'review' ? 'ok' : action === 'submit' ? 'wait' : 'draft', body }]);
          expect(saved.body.teacherId).toBe(mode === 'teacher change' ? OTHER : TEACHER);
          if (mode === 'past move') expect(saved.body.startMin).toBe(75);
          if (action === 'review') {
            expect(await q('SELECT to_id::int FROM noti WHERE from_id=$1 AND to_id=ANY($2)',
              [MANAGER, [TEACHER, OTHER]])).toEqual([{ to_id: mode === 'teacher change' ? OTHER : TEACHER }]);
          }
        }
        expect(blocked).toBe(true);
      } finally {
        release();
        await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]);
        spy?.mockRestore();
        await q('DELETE FROM noti WHERE from_id=$1 AND to_id=ANY($2)', [MANAGER, [TEACHER, OTHER]]);
        await q("DELETE FROM log WHERE actor_id=$1 AND entity IN ('REP','ATT')", [MANAGER]);
        // 테스트 전용 회차만 FK 순서대로 정리한다. 제품 삭제는 REP/ATT 이력을 보존한다.
        await q('DELETE FROM att WHERE ser_id=$1', [id]);
        await q('DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id=$1)', [id]);
        await q('DELETE FROM rep WHERE ser_id=$1', [id]);
        await q('DELETE FROM ser_occ WHERE ser_id=$1', [id]);
        await q('DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id=$1)', [id]);
        await q('DELETE FROM exc WHERE ser_id=$1', [id]);
        await q('DELETE FROM ser_stu WHERE ser_id=$1', [id]);
        await q('DELETE FROM ser WHERE id=$1', [id]);
      }
    },
  );

  it('상세는 DB의 빈 body를 3개 입력으로 정규화하고 그 순서를 내려준다', async () => {
    const res = await get(teacherToken).expect(200);
    expect(res.body).toMatchObject({
      serId: SER,
      date: DATE,
      onDate: DATE,
      state: 'none',
      canEdit: true,
      canExport: false,
      exportFiles: [],
      subjectName: 'AP Chemistry',
      body: { content: '', progress: '', homework: '' },
    });
    expect(res.body.fields.map((field: { key: string }) => field.key)).toEqual(['content', 'progress', 'homework']);
  });

  it('담당이 아닌 강사는 조회·저장할 수 없다', async () => {
    expect((await get(otherToken).expect(403)).body.code).toBe('REPORT_FORBIDDEN');
    expect((await put(otherToken, body).expect(403)).body.code).toBe('REPORT_FORBIDDEN');
  });

  it('임시저장은 빈 값을 허용하고 REP.body에 세 키만 쓴다', async () => {
    const saved = await put(teacherToken, { content: '', progress: '', homework: '' }).expect(200);
    expect(saved.body).toMatchObject({
      canExport: true,
      subjectName: 'AP Chemistry',
      exportFiles: [
        {
          studentId: STUDENT,
          fileName: `${DATE.replaceAll('-', '')}_리포트학생_고2_AP Chemistry_09:00.png`,
        },
        {
          studentId: STUDENT2,
          fileName: `${DATE.replaceAll('-', '')}_학년없는학생_학년미정_AP Chemistry_09:00.png`,
        },
      ],
    });
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
    expect((await get(reviewerToken).expect(200)).body).toMatchObject({ canExport: false, exportFiles: [] });
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
