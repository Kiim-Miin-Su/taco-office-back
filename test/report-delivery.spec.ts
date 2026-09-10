/** @file-guide
 * 목적: report-delivery.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/** §48~§50: 학생별 승인 완료 집합 → private Blob → RSEND/PDFLOG → 재발송. */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApiBodyParser } from '../src/app.factory';
import { REPORT_FILE_STORE, type ReportFileStore } from '../src/modules/reports/report-file.store';
import { DEV_URL } from './db';
import { ReportsService } from '../src/modules/reports/reports.service';
import type { ReportDeliveryCreateDto } from '../src/modules/reports/reports.dto';
import { addD } from '../src/lib/recurrence';
import { todayKst } from '../src/lib/kst';
import { buildOpenApi } from '../src/openapi';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('리포트 발송 계약 (D-R8 · D-R15 · D-R42)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let managerToken = '';
  let teacherToken = '';
  const put = jest.fn<ReturnType<ReportFileStore['put']>, Parameters<ReportFileStore['put']>>();
  const remove = jest.fn<ReturnType<ReportFileStore['delete']>, Parameters<ReportFileStore['delete']>>();
  const store: ReportFileStore = { put, delete: remove };

  const RUN = 9_500_000 + process.pid * 20;
  const MANAGER = RUN + 1;
  const TEACHER = RUN + 2;
  const STUDENT_READY = RUN + 3;
  const STUDENT_BLOCKED = RUN + 4;
  const SER1 = RUN + 5;
  const SER2 = RUN + 6;
  const SER3 = RUN + 7;
  const DATE = '2025-02-03';
  const PW = 'report-delivery-1234';
  const MANAGER_EMAIL = `delivery-manager-${RUN}@t.kr`;
  const TEACHER_EMAIL = `delivery-teacher-${RUN}@t.kr`;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  const revisions = new Map<number, string>();

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  // 100KB를 넘겨 Nest 기본 파서 한계로 실제 브라우저 PNG가 막히는 회귀도 함께 검증한다.
  const png = `data:image/png;base64,${Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(128 * 1024, 1),
  ]).toString('base64')}`;

  const deliveryBody = (requestKey: string) => ({
    requestKey, onDate: DATE, studentId: STUDENT_READY,
    files: [rep1, rep2].map((repId) => ({
      repId,
      fileName: `${DATE.replaceAll('-', '')}_준비학생_고2_AP Chemistry_${repId === rep1 ? '09:00' : '10:00'}.png`,
      revision: revisions.get(repId)!,
      pngDataUrl: png,
    })),
  });

  async function clean(): Promise<void> {
    await q(`DELETE FROM pdflog WHERE ref_id IN (SELECT id FROM rsend WHERE student_id = ANY($1))`,
      [[STUDENT_READY, STUDENT_BLOCKED]]);
    await q(`DELETE FROM rsend WHERE student_id = ANY($1)`, [[STUDENT_READY, STUDENT_BLOCKED]]);
    await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [[SER1, SER2, SER3]]);
    await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [[SER1, SER2, SER3]]);
    await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [[SER1, SER2, SER3]]);
    await q(`DELETE FROM ser WHERE id = ANY($1)`, [[SER1, SER2, SER3]]);
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STUDENT_READY, STUDENT_BLOCKED]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[MANAGER, TEACHER]]);
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REPORT_FILE_STORE).useValue(store).compile();
    app = mod.createNestApplication({ bodyParser: false });
    configureApiBodyParser(app);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    ds = app.get(DataSource);
    await clean();

    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO kind (key,name,color,cap,grp,rep,rep_form,sort)
       VALUES ('class','정규 수업','#4A5461',4,'lesson',true,'dev',1) ON CONFLICT (key) DO NOTHING`,
    );
    await q(
      `INSERT INTO sub (key,name,color,active,sort)
       VALUES ('ap-chem','AP Chemistry','#2E6BFF',true,1) ON CONFLICT (key) DO NOTHING`,
    );
    await q(
      `INSERT INTO staff (id,name,email,role,password_hash,active)
       VALUES ($1,'발송매니저',$2,'manager',$3,true), ($4,'발송강사',$5,'teacher',$3,true)`,
      [MANAGER, MANAGER_EMAIL, hash, TEACHER, TEACHER_EMAIL],
    );
    await q(`INSERT INTO stu (id,name,grade) VALUES ($1,'준비학생','고2'), ($2,'차단학생','고1')`,
      [STUDENT_READY, STUDENT_BLOCKED]);
    for (const [serId, start] of [[SER1, 540], [SER2, 600], [SER3, 660]]) {
      await q(
        `INSERT INTO ser (id,kind_key,sub_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
         VALUES ($1,'class','ap-chem',$2,'offline',$3,$4,'ONCE',$5,$5,'발송 계약')`,
        [serId, TEACHER, start, start + 60, DATE],
      );
      await q(
        `INSERT INTO ser_occ (ser_id,on_date,teacher_id,canceled,span)
         VALUES ($1,$2,$3,false,tstzrange(
           ($2::date + ($4 || ' minutes')::interval) AT TIME ZONE 'Asia/Seoul',
           ($2::date + ($5 || ' minutes')::interval) AT TIME ZONE 'Asia/Seoul','[)'))`,
        [serId, DATE, TEACHER, start, start + 60],
      );
    }
    const insertRep = async (serId: number, state: 'ok' | 'none') => {
      const rows = await q<{ id: string }>(
        `INSERT INTO rep (
           ser_id,on_date,teacher_id,kind_key,lang,body,state,written_at,submitted_at,reviewed_at,reviewer_id
         ) VALUES (
           $1,$2,$3,'class','ko',$4::jsonb,$5::rep_state_t,
           CASE WHEN $5::text='ok' THEN now() END, CASE WHEN $5::text='ok' THEN now() END,
           CASE WHEN $5::text='ok' THEN now() END, CASE WHEN $5::text='ok' THEN $6::bigint END
         ) RETURNING id::text`,
        [
          serId, DATE, TEACHER,
          JSON.stringify({ content: `수업 ${serId}`, progress: '42p', homework: '43p' }), state, MANAGER,
        ],
      );
      return Number(rows[0].id);
    };
    rep1 = await insertRep(SER1, 'ok');
    rep2 = await insertRep(SER2, 'ok');
    rep3 = await insertRep(SER3, 'none');
    await q(
      `INSERT INTO rep_stu (rep_id,student_id,deliver) VALUES
       ($1,$4,true),($2,$4,true),($1,$5,true),($3,$5,true)`,
      [rep1, rep2, rep3, STUDENT_READY, STUDENT_BLOCKED],
    );
    expect(await q(
      `SELECT 1 FROM rep_stu rs JOIN rep r ON r.id=rs.rep_id WHERE r.on_date=$1 AND rs.deliver`, [DATE],
    )).toHaveLength(4);

    const login = async (email: string) => (
      await request(app.getHttpServer()).post('/auth/login').send({ email, password: PW }).expect(201)
    ).body.accessToken as string;
    managerToken = await login(MANAGER_EMAIL);
    teacherToken = await login(TEACHER_EMAIL);
    for (const serId of [SER1, SER2]) {
      const detail = await request(app.getHttpServer()).get(`/reports/${serId}/${DATE}`).set(auth(managerToken)).expect(200);
      revisions.set(detail.body.id, detail.body.exportFiles.find((f: {studentId: number}) => f.studentId === STUDENT_READY).revision);
    }
  });

  beforeEach(async () => {
    await q(`DELETE FROM pdflog WHERE ref_id IN (SELECT id FROM rsend WHERE student_id = $1)`, [STUDENT_READY]);
    await q(`DELETE FROM rsend WHERE student_id = $1`, [STUDENT_READY]);
    put.mockReset();
    remove.mockReset();
    put.mockImplementation(async (pathname) => `https://private.blob/${encodeURIComponent(pathname)}`);
    remove.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await clean();
    await app?.close();
  });

  /** 이 테스트가 만든 규칙만 FK 순서대로 회수한다. 유입/기존 회차가 같은 정리 절차를 쓴다. */
  async function removeTestSeries(id: number): Promise<void> {
    await q('DELETE FROM att WHERE ser_id=$1', [id]);
    await q('DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id=$1)', [id]);
    await q('DELETE FROM rep WHERE ser_id=$1', [id]);
    await q('DELETE FROM ser_occ WHERE ser_id=$1', [id]);
    await q('DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id=$1)', [id]);
    await q('DELETE FROM exc WHERE ser_id=$1', [id]);
    await q('DELETE FROM ser_stu WHERE ser_id=$1', [id]);
    await q('DELETE FROM ser WHERE id=$1', [id]);
  }

  /** 일정 API가 만드는 실제 투영을 재사용한다. 승인 상태만 테스트 fixture로 준비한다. */
  async function recentDelivery(run: (fixture: { id: number; date: string; body: ReportDeliveryCreateDto }) => Promise<void>): Promise<void> {
    const date = addD(todayKst(), -1);
    const created = await request(app.getHttpServer()).post('/schedule').set(auth(managerToken)).send({
      kindKey: 'class', subKey: 'ap-chem', teacherId: TEACHER, roomId: null, mode: 'offline',
      fromDate: date, rrule: 'ONCE', startMin: 60, endMin: 120, studentIds: [STUDENT_READY], title: 'delivery race',
    }).expect(201);
    const id = created.body.serIds[0] as number;
    try {
      await q(`UPDATE rep SET state='ok',body=$2::jsonb,written_at=now(),submitted_at=now(),
        reviewed_at=now(),reviewer_id=$3 WHERE ser_id=$1`,
      [id, JSON.stringify({ content: '경합 검증', progress: '42p', homework: '43p' }), MANAGER]);
      const queue = await request(app.getHttpServer()).get('/reports/deliveries').query({ onDate: date })
        .set(auth(managerToken)).expect(200);
      const target = queue.body.students.find((row: { student: { id: number } }) => row.student.id === STUDENT_READY);
      const report = target.reports.find((row: { serId: number }) => row.serId === id);
      const descriptor = report.exportFiles.find((row: { studentId: number }) => row.studentId === STUDENT_READY);
      await run({ id, date, body: { requestKey: '00000000-0000-4000-8000-000000000090', onDate: date,
        studentId: STUDENT_READY, files: [{ repId: report.id, fileName: descriptor.fileName, revision: descriptor.revision, pngDataUrl: png }] } });
    } finally {
      // 이 helper가 만든 규칙/학생/날짜의 테스트 행만 FK 순서대로 회수한다.
      await q(`DELETE FROM pdflog WHERE ref_id IN (SELECT id FROM rsend WHERE student_id=$1 AND on_date=$2)`, [STUDENT_READY, date]);
      await q('DELETE FROM rsend WHERE student_id=$1 AND on_date=$2', [STUDENT_READY, date]);
      await q("DELETE FROM log WHERE actor_id=$1 AND entity='ATT'", [MANAGER]);
      await removeTestSeries(id);
    }
  }

  it.each(['attendance cancel', 'schedule cancel', 'date move', 'end change'] as const)(
    '선행 일정/출결 commit을 기다린 뒤 오래된 발송을 거절한다: %s', async (mode) => {
      await recentDelivery(async ({ id, date, body }) => {
        let ready!: () => void, release!: () => void, seen!: (pid: number) => void;
        const paused = new Promise<void>((resolve) => { ready = resolve; });
        const hold = new Promise<void>((resolve) => { release = resolve; });
        const started = new Promise<number>((resolve) => { seen = resolve; });
        const createRunner = ds.createQueryRunner.bind(ds);
        let writer: ReturnType<typeof createRunner> | undefined, observed = false;
        let first: Promise<request.Response> | undefined, second: Promise<request.Response> | undefined;
        const spy = jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
          const runner = createRunner(...args), query = runner.query.bind(runner);
          jest.spyOn(runner, 'query').mockImplementation(async (sql: string, p?: unknown[], structured?: boolean) => {
            const target = p?.some((v) => Array.isArray(v) ? v.includes(id) : v === id);
            if (!writer && target && sql.includes('FOR NO KEY UPDATE')) writer = runner;
            if (runner === writer && sql === 'COMMIT') { ready(); await hold; }
            if (writer && runner !== writer && runner.isTransactionActive && !observed
              && /FOR (NO KEY UPDATE|UPDATE OF r)/.test(sql)) {
              observed = true;
              const [{ pid }] = await query('SELECT pg_backend_pid() AS pid');
              seen(pid);
            }
            return structured ? query(sql, p, true) : query(sql, p);
          });
          return runner;
        });
        try {
          first = Promise.resolve(mode === 'attendance cancel'
            ? request(app.getHttpServer()).put(`/schedule/${id}/${date}/attendance`).set(auth(managerToken))
              .send({ result: 'canceled', reason: 'academy' }).timeout(10000)
            : mode === 'schedule cancel'
              ? request(app.getHttpServer()).delete(`/schedule/${id}`).set(auth(managerToken))
                .send({ scope: 'this', onDate: date }).timeout(10000)
            : request(app.getHttpServer()).patch(`/schedule/${id}`).set(auth(managerToken)).send({
              scope: 'this', onDate: date, ...(mode === 'date move' ? { date: addD(date, 1) } : { endMin: 135 }),
            }).timeout(10000));
          await Promise.race([paused, first.then(() => { throw new Error('선행 commit에 도달하지 못함'); })]);
          let completed = false;
          second = Promise.resolve(request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
            .send(body).timeout(10000));
          void second.then(() => { completed = true; }, () => { completed = true; });
          const pid = await Promise.race([started, second.then(() => { throw new Error('발송 잠금에 도달하지 못함'); })]);
          let blocked = false;
          const deadline = Date.now() + 4000;
          while (!blocked && !completed) {
            [{ blocked }] = await q<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid]);
            if (Date.now() > deadline) throw new Error('발송 경합 관측 시간 초과');
          }
          release();
          const [changed, sent] = await Promise.all([first, second]);
          expect(changed.status).toBe(200);
          expect(sent.status).toBe(400);
          expect(sent.body.code).toBe(mode === 'end change' ? 'REPORT_DELIVERY_FILES_MISMATCH' : 'REPORT_DELIVERY_EMPTY');
          expect(blocked).toBe(true);
          expect(await q('SELECT id FROM rsend WHERE request_key=$1', [body.requestKey])).toEqual([]);
          expect(remove).toHaveBeenCalledTimes(1);
          expect(remove.mock.calls[0][0]).toHaveLength(1);
        } finally {
          release();
          await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]);
          spy.mockRestore();
        }
      });
    },
  );

  describe.each(['before request', 'during upload'] as const)('준비 집합 변경: %s', (timing) => {
    it.each(['create', 'roster', 'move'] as const)('미작성 회차 유입은 발송을 차단한다: %s', async (mode) => {
      await recentDelivery(async ({ date, body }) => {
        let incomingId: number | undefined;
        const future = addD(date, 1);
        const create = async (fromDate: string, studentIds: number[]) => {
          const result = await request(app.getHttpServer()).post('/schedule').set(auth(managerToken)).send({
            kindKey: 'class', subKey: 'ap-chem', teacherId: TEACHER, roomId: null, mode: 'offline',
            fromDate, rrule: 'ONCE', startMin: 180, endMin: 240, studentIds, title: 'delivery incoming',
          }).expect(201);
          incomingId = result.body.serIds[0] as number;
        };
        const change = async () => {
          if (mode === 'create') await create(date, [STUDENT_READY]);
          else if (mode === 'roster') {
            await request(app.getHttpServer()).patch(`/schedule/${incomingId}/roster`).set(auth(managerToken))
              .send({ op: 'add', onDate: date, studentId: STUDENT_READY }).expect(200);
          } else {
            await request(app.getHttpServer()).patch(`/schedule/${incomingId}`).set(auth(managerToken))
              .send({ scope: 'this', onDate: future, date }).expect(200);
          }
        };
        try {
          if (mode !== 'create') await create(mode === 'move' ? future : date, mode === 'move' ? [STUDENT_READY] : []);
          if (timing === 'before request') await change();
          else put.mockImplementationOnce(async () => { await change(); return 'https://private.blob/owned-incoming.png'; });
          const result = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken)).send(body);
          expect(result.status).toBe(409);
          expect(result.body.code).toBe('REPORT_DELIVERY_INCOMPLETE');
          expect(await q('SELECT id FROM rsend WHERE request_key=$1', [body.requestKey])).toEqual([]);
          if (timing === 'before request') expect(put).not.toHaveBeenCalled();
          else expect(remove).toHaveBeenCalledWith(['https://private.blob/owned-incoming.png']);
          const current = await request(app.getHttpServer()).get('/reports/deliveries').query({ onDate: date })
            .set(auth(managerToken)).expect(200);
          const target = current.body.students.find((row: { student: { id: number } }) => row.student.id === STUDENT_READY);
          expect(target).toMatchObject({ canSend: false, blockedCount: 1 });
          expect(target.reports).toHaveLength(2);
        } finally { if (incomingId !== undefined) await removeTestSeries(incomingId); }
      });
    });

    it('일정 취소도 출결 취소처럼 신규 발송 대상에서 제외한다', async () => {
      await recentDelivery(async ({ id, date, body }) => {
        const cancel = () => request(app.getHttpServer()).delete(`/schedule/${id}`).set(auth(managerToken))
          .send({ scope: 'this', onDate: date }).expect(200);
        if (timing === 'before request') await cancel();
        else put.mockImplementationOnce(async () => { await cancel(); return 'https://private.blob/owned-canceled.png'; });
        const result = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken)).send(body);
        expect(result.status).toBe(400);
        expect(result.body.code).toBe('REPORT_DELIVERY_EMPTY');
        expect(await q('SELECT id FROM rsend WHERE request_key=$1', [body.requestKey])).toEqual([]);
        if (timing === 'before request') expect(put).not.toHaveBeenCalled();
        else expect(remove).toHaveBeenCalledWith(['https://private.blob/owned-canceled.png']);
        const current = await request(app.getHttpServer()).get('/reports/deliveries').query({ onDate: date })
          .set(auth(managerToken)).expect(200);
        expect(current.body.students.some((row: { student: { id: number } }) => row.student.id === STUDENT_READY)).toBe(false);
      });
    });
  });

  it('일정 취소 뒤에도 이미 보낸 이력/상세 출력/재발송의 원본은 보존한다', async () => {
    await recentDelivery(async ({ id, date, body }) => {
      const saved = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken)).send(body).expect(201);
      const sendId = saved.body.item.id as number;
      const [snapshot] = await q('SELECT on_date,body,rep_ids FROM rsend WHERE id=$1', [sendId]);
      const files = await q('SELECT file_url FROM pdflog WHERE ref_id=$1', [sendId]);
      await request(app.getHttpServer()).delete(`/schedule/${id}`).set(auth(managerToken))
        .send({ scope: 'this', onDate: date }).expect(200);
      const detail = await request(app.getHttpServer()).get(`/reports/${id}/${date}`).set(auth(managerToken)).expect(200);
      expect(detail.body.canExport).toBe(true);
      expect(detail.body.exportFiles[0].revision).toBe(body.files[0].revision);
      const current = await request(app.getHttpServer()).get('/reports/deliveries').query({ onDate: date })
        .set(auth(managerToken)).expect(200);
      expect(current.body.students.some((row: { student: { id: number } }) => row.student.id === STUDENT_READY)).toBe(false);
      put.mockClear();
      const copy = await request(app.getHttpServer()).post(`/reports/deliveries/${sendId}/resend`).set(auth(managerToken))
        .send({ requestKey: '00000000-0000-4000-8000-000000000098' }).expect(201);
      expect(await q('SELECT on_date,body,rep_ids FROM rsend WHERE id=$1', [copy.body.item.id])).toEqual([snapshot]);
      expect(await q('SELECT file_url FROM pdflog WHERE ref_id=$1', [copy.body.item.id])).toEqual(files);
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });
  });

  it('업로드 중 종료 시각이 바뀌면 같은 파일명이어도 이전 PNG/새 본문 혼합 저장을 막는다', async () => {
    await recentDelivery(async ({ id, date, body }) => {
      put.mockImplementationOnce(async () => {
        await request(app.getHttpServer()).patch(`/schedule/${id}`).set(auth(managerToken))
          .send({ scope: 'this', onDate: date, endMin: 135 }).expect(200);
        return 'https://private.blob/owned-stale.png';
      });
      const result = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken)).send(body);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('REPORT_DELIVERY_FILES_MISMATCH');
      expect(await q('SELECT id FROM rsend WHERE request_key=$1', [body.requestKey])).toEqual([]);
      expect(remove).toHaveBeenCalledWith(['https://private.blob/owned-stale.png']);
    });
  });

  it('화면 조회 후 종료만 바뀐 오래된 출력은 업로드 전에 거절하고 새 조회는 저장한다', async () => {
    await recentDelivery(async ({ id, date, body }) => {
      await request(app.getHttpServer()).patch(`/schedule/${id}`).set(auth(managerToken))
        .send({ scope: 'this', onDate: date, endMin: 135 }).expect(200);
      const stale = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken)).send(body);
      expect(stale.status).toBe(400);
      expect(stale.body.code).toBe('REPORT_DELIVERY_FILES_MISMATCH');
      expect(put).not.toHaveBeenCalled();
      const current = await request(app.getHttpServer()).get(`/reports/${id}/${date}`).set(auth(managerToken)).expect(200);
      const descriptor = current.body.exportFiles[0];
      expect(descriptor.fileName).toBe(body.files[0].fileName);
      expect(descriptor.revision).toMatch(/^[a-f0-9]{64}$/);
      expect(descriptor.revision).not.toBe(body.files[0].revision);
      const saved = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
        .send({ ...body, files: [{ ...body.files[0], revision: descriptor.revision }] }).expect(201);
      expect(await q('SELECT body FROM rsend WHERE id=$1', [saved.body.item.id])).toEqual([{ body: descriptor.plainText }]);
    });
  });

  it.each(['connect', 'startTransaction'] as const)('업로드 후 %s 실패도 파일을 보상 삭제하고 runner를 해제한다', async (method) => {
    const createRunner = ds.createQueryRunner.bind(ds);
    let owned: ReturnType<typeof createRunner> | undefined;
    const spy = jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
      const runner = createRunner(...args);
      // 일반 조회 runner는 건드리지 않고 Blob 보존 후 전용 transaction만 실패시킨다.
      if (put.mock.calls.length === 2 && !owned) {
        owned = runner;
        jest.spyOn(runner, method).mockRejectedValueOnce(new Error(`test ${method} failure`));
        jest.spyOn(runner, 'release');
      }
      return runner;
    });
    try {
      await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
        .send(deliveryBody('00000000-0000-4000-8000-000000000091')).expect(500);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0][0]).toHaveLength(2);
      expect(owned?.release).toHaveBeenCalled();
      expect(await q('SELECT id FROM rsend WHERE request_key=$1', ['00000000-0000-4000-8000-000000000091'])).toEqual([]);
    } finally {
      // red 실행에서도 테스트가 열어 둔 연결을 남기지 않는다.
      if (owned && !owned.isReleased) await owned.release();
      spy.mockRestore();
    }
  });

  it.each([true, false])('동시 최초 발송 sameKey=%s: 한 감사 묶음만 남기고 패자 파일만 지운다', async (sameKey) => {
    let unblock!: () => void, puts = 0, finishedUploads = 0;
    const bothUploaded = new Promise<void>((resolve) => { unblock = resolve; });
    put.mockImplementation(async (pathname) => {
      const url = `https://private.blob/owned-concurrent-${++puts}.png`;
      // 각 요청의 마지막 파일에서만 만나 실제 업로드 선행/transaction 경합을 만든다.
      if (pathname.endsWith('10:00.png')) {
        if (++finishedUploads === 2) unblock();
        await bothUploaded;
      }
      return url;
    });
    const firstBody = deliveryBody('00000000-0000-4000-8000-000000000092');
    const secondBody = { ...firstBody, requestKey: sameKey ? firstBody.requestKey : '00000000-0000-4000-8000-000000000093' };
    try {
      const results = await Promise.all([firstBody, secondBody].map((body) =>
        request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken)).send(body).timeout(10000)));
      expect(results.map((r) => r.status).sort()).toEqual(sameKey ? [201, 201] : [201, 409]);
      if (sameKey) expect(results[0].body.item.id).toBe(results[1].body.item.id);
      else expect(results.find((r) => r.status === 409)?.body.code).toBe('REPORT_DELIVERY_ALREADY_SENT');
      expect(await q('SELECT id FROM rsend WHERE student_id=$1 AND on_date=$2', [STUDENT_READY, DATE])).toHaveLength(1);
      const persisted = await q<{file_url: string}>(`SELECT file_url FROM pdflog WHERE ref_id IN
        (SELECT id FROM rsend WHERE student_id=$1 AND on_date=$2)`, [STUDENT_READY, DATE]);
      expect(persisted).toHaveLength(2);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0][0]).toHaveLength(2);
      expect(persisted.some((row) => remove.mock.calls[0][0].includes(row.file_url))).toBe(false);
    } finally { unblock(); }
  });

  it.each([true, false])('동시 재발송 sameKey=%s: 원본 날짜/본문/파일은 불변이다', async (sameKey) => {
    const original = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
      .send(deliveryBody('00000000-0000-4000-8000-000000000094')).expect(201);
    const id = original.body.item.id as number;
    const [snapshot] = await q('SELECT on_date,body,rep_ids FROM rsend WHERE id=$1', [id]);
    put.mockClear();
    const keys = ['00000000-0000-4000-8000-000000000095', sameKey
      ? '00000000-0000-4000-8000-000000000095' : '00000000-0000-4000-8000-000000000096'];
    let ready!: () => void, arrivals = 0;
    const bothPastFastPath = new Promise<void>((resolve) => { ready = resolve; });
    const createRunner = ds.createQueryRunner.bind(ds);
    const spy = jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
      const runner = createRunner(...args), query = runner.query.bind(runner);
      jest.spyOn(runner, 'query').mockImplementation(async (sql: string, p?: unknown[], structured?: boolean) => {
        if (sql.includes('FROM rsend WHERE id=$1 FOR UPDATE') && p?.[0] === id) {
          if (++arrivals === 2) ready();
          // 두 요청 모두 빠른 멱등 조회를 통과한 뒤 실제 같은 RSEND 잠금에 진입한다.
          await bothPastFastPath;
        }
        return structured ? query(sql, p, true) : query(sql, p);
      });
      return runner;
    });
    const pending = keys.map((requestKey) => Promise.resolve(request(app.getHttpServer())
      .post(`/reports/deliveries/${id}/resend`).set(auth(managerToken)).send({ requestKey }).timeout(10000).expect(201)));
    let results: request.Response[];
    try { results = await Promise.all(pending); expect(arrivals).toBe(2); }
    finally { ready(); await Promise.allSettled(pending); spy.mockRestore(); }
    const copies = await q('SELECT on_date,body,rep_ids FROM rsend WHERE source_send_id=$1', [id]);
    expect(copies).toEqual(Array.from({ length: sameKey ? 1 : 2 }, () => snapshot));
    expect(results[0].body.item.id === results[1].body.item.id).toBe(sameKey);
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await q('SELECT on_date,body,rep_ids FROM rsend WHERE id=$1', [id])).toEqual([snapshot]);
  });

  it('매니저 큐는 학생별 승인 집합을 만들고 미작성 학생을 차단한다', async () => {
    await request(app.getHttpServer()).get('/reports/deliveries').query({ onDate: DATE })
      .set(auth(teacherToken)).expect(403);
    const res = await request(app.getHttpServer()).get('/reports/deliveries').query({ onDate: DATE })
      .set(auth(managerToken)).expect(200);
    expect(res.body).toMatchObject({ onDate: DATE, total: 2, remaining: 1, blocked: 1 });
    expect(res.body.students.find((item: { student: { id: number } }) => item.student.id === STUDENT_READY))
      .toMatchObject({ canSend: true, blockedCount: 0 });
    expect(res.body.students.find((item: { student: { id: number } }) => item.student.id === STUDENT_BLOCKED))
      .toMatchObject({ canSend: false, blockedCount: 1 });
  });

  it('추가 키·파일 누락·가짜 PNG를 저장 전에 거절한다', async () => {
    const base = { requestKey: '00000000-0000-4000-8000-000000000001', onDate: DATE, studentId: STUDENT_READY };
    await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
      .send({ ...base, files: [], extra: true }).expect(400);
    const missing = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
      .send({ ...base, files: [{ repId: rep1, fileName: 'x.png', revision: revisions.get(rep1), pngDataUrl: png }] }).expect(400);
    expect(missing.body.code).toBe('REPORT_DELIVERY_FILES_MISMATCH');
    const fake = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
      .send({
        ...base,
        files: [rep1, rep2].map((repId) => ({
          repId,
          fileName: `${DATE.replaceAll('-', '')}_준비학생_고2_AP Chemistry_${repId === rep1 ? '09:00' : '10:00'}.png`,
          revision: revisions.get(repId),
          pngDataUrl: 'data:image/png;base64,ZmFrZQ==',
        })),
      }).expect(400);
    expect(fake.body.code).toBe('REPORT_DELIVERY_PNG_FORMAT');
    expect(put).not.toHaveBeenCalled();
  });

  it.each([undefined, 'invalid', '0'.repeat(64)])('누락/잘못된 출력 revision은 Blob 전에 거절한다: %s', async (revision) => {
    const body = deliveryBody('00000000-0000-4000-8000-000000000097');
    const result = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
      .send({ ...body, files: body.files.map((file) => ({ ...file, revision })) }).expect(400);
    if (revision?.length === 64) expect(result.body.code).toBe('REPORT_DELIVERY_FILES_MISMATCH');
    expect(put).not.toHaveBeenCalled();
  });

  it('생성 OpenAPI는 출력 revision의 필수 입출력과 현재 재검증/보상 계약을 노출한다', () => {
    const doc = buildOpenApi(app);
    for (const name of ['ReportExportFileDto', 'ReportDeliveryFileInputDto']) {
      expect(doc.components?.schemas?.[name]).toMatchObject({
        required: expect.arrayContaining(['revision']),
        properties: { revision: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
      });
    }
    const operation = doc.paths['/reports/deliveries'].post!;
    expect(operation.description).toContain('부모 SER');
    for (const status of ['201', '400', '403', '409']) expect(operation.responses[status]).toBeDefined();
  });

  it.each([
    '/reports/deliveries?onDate=2025-02-30', '/reports/deliveries?onDate=',
    '/reports/deliveries/history?onDate=2025-02-30', '/reports/deliveries/history?repId=1e2',
    '/reports/deliveries/history?repId=9007199254740992',
  ])('발송 query 날짜와 참조를 DB 전에 검증한다: %s', async (path) => {
    await request(app.getHttpServer()).get(path).set(auth(managerToken)).expect(400);
  });

  it.each([
    { onDate: '2025-02-30' }, { studentId: '1e2' }, { studentId: 9007199254740992 },
  ])('발송 body의 날짜/학생 식별자 형식을 검증한다: %j', async (change) => {
    const deliver = jest.spyOn(app.get(ReportsService), 'deliver');
    try {
      await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
        .send({ ...deliveryBody('00000000-0000-4000-8000-000000000081'), ...change }).expect(400);
      expect(deliver).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    } finally { deliver.mockRestore(); }
  });

  it('옮긴 수업은 실제 날짜로 발송하고 이후 이동에도 발송 당시 날짜·본문은 보존한다', async () => {
    const movedDate = '2025-02-04';
    const [original] = await q<{ span: string }>('SELECT span::text FROM ser_occ WHERE ser_id=$1', [SER1]);
    try {
      await q(`UPDATE ser_occ SET span=tstzrange(lower(span)+interval '1 day', upper(span)+interval '1 day','[)')
        WHERE ser_id=$1`, [SER1]);
      const queue = await request(app.getHttpServer()).get('/reports/deliveries').query({ onDate: movedDate })
        .set(auth(managerToken)).expect(200);
      expect(queue.body).toMatchObject({ onDate: movedDate, total: 2, remaining: 2, blocked: 0 });
      const target = queue.body.students.find((item: { student: { id: number } }) => item.student.id === STUDENT_READY);
      expect(target.reports).toHaveLength(1);
      expect(target.reports[0]).toMatchObject({ id: rep1, date: movedDate, onDate: DATE });
      const oldQueue = await request(app.getHttpServer()).get('/reports/deliveries').query({ onDate: DATE })
        .set(auth(managerToken)).expect(200);
      expect(oldQueue.body.students.flatMap((item: { reports: { id: number }[] }) => item.reports).some((r: {id: number}) => r.id === rep1)).toBe(false);
      const descriptor = target.reports[0].exportFiles.find((file: {studentId: number}) => file.studentId === STUDENT_READY);
      const sent = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
        .send({ requestKey: '00000000-0000-4000-8000-000000000082', onDate: movedDate, studentId: STUDENT_READY,
          files: [{ repId: rep1, fileName: descriptor.fileName, revision: descriptor.revision, pngDataUrl: png }] }).expect(201);
      const [saved] = await q<{ on_date: string; body: string }>(
        `SELECT to_char(on_date,'YYYY-MM-DD') on_date,body FROM rsend WHERE id=$1`, [sent.body.item.id]);
      expect(saved).toEqual({ on_date: movedDate, body: descriptor.plainText });
      await q('UPDATE ser_occ SET span=$2::tstzrange WHERE ser_id=$1', [SER1, original.span]);
      const history = await request(app.getHttpServer()).get('/reports/deliveries/history').query({ onDate: movedDate })
        .set(auth(managerToken)).expect(200);
      expect(history.body.items[0]).toMatchObject({ id: sent.body.item.id, onDate: movedDate });
      const resent = await request(app.getHttpServer()).post(`/reports/deliveries/${sent.body.item.id}/resend`)
        .set(auth(managerToken)).send({ requestKey: '00000000-0000-4000-8000-000000000083' }).expect(201);
      const [copy] = await q<{on_date: string; body: string}>(
        `SELECT to_char(on_date,'YYYY-MM-DD') on_date,body FROM rsend WHERE id=$1`, [resent.body.item.id]);
      expect(copy).toEqual(saved);
    } finally {
      await q('UPDATE ser_occ SET span=$2::tstzrange WHERE ser_id=$1', [SER1, original.span]);
    }
  });

  it('학생 1명 발송을 Blob·RSEND·PDFLOG에 한 번 기록하고 같은 key 재시도는 재사용한다', async () => {
    const body = deliveryBody('00000000-0000-4000-8000-000000000010');
    const first = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
      .send(body).expect(201);
    expect(first.body.item).toMatchObject({
      sourceSendId: null, studentId: STUDENT_READY, repIds: [rep1, rep2], fileCount: 2,
    });
    expect(put).toHaveBeenCalledTimes(2);
    const retried = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
      .send(body).expect(201);
    expect(retried.body.item.id).toBe(first.body.item.id);
    expect(put).toHaveBeenCalledTimes(2);
    const reused = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
      .send({ ...body, onDate: '2025-02-04' }).expect(409);
    expect(reused.body.code).toBe('REPORT_DELIVERY_REQUEST_KEY_REUSED');

    const [saved] = await q<{ rep_ids: number[]; channel: string; body: string }>(
      `SELECT rep_ids,channel,body FROM rsend WHERE id=$1`, [first.body.item.id],
    );
    expect(saved).toMatchObject({ rep_ids: [rep1, rep2], channel: 'blob' });
    expect(saved.body).toContain('① 학생: 준비학생 · 고2');
    expect(saved.body).toContain(`② 수업: ${DATE} · AP Chemistry · 09:00–10:00`);
    expect(saved.body).toContain(`② 수업: ${DATE} · AP Chemistry · 10:00–11:00`);
    expect(saved.body).toContain('③ 수업 내용');
    expect(await q(`SELECT 1 FROM pdflog WHERE kind='report_png' AND ref_id=$1`, [first.body.item.id]))
      .toHaveLength(2);
  });

  it('두 번째 Blob 저장이 실패하면 먼저 저장한 파일을 보상 삭제하고 이력을 남기지 않는다', async () => {
    put.mockResolvedValueOnce('https://private.blob/first.png').mockRejectedValueOnce(new Error('blob failed'));
    await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
      .send(deliveryBody('00000000-0000-4000-8000-000000000020')).expect(500);
    expect(remove).toHaveBeenCalledWith(['https://private.blob/first.png']);
    expect(await q(`SELECT 1 FROM rsend WHERE request_key=$1`, ['00000000-0000-4000-8000-000000000020']))
      .toHaveLength(0);
  });

  it('최초 발송 중복은 막고 재발송은 Blob을 복제하지 않은 새 감사행이다', async () => {
    const sourceResponse = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
      .send(deliveryBody('00000000-0000-4000-8000-000000000011')).expect(201);
    put.mockClear();
    const duplicate = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
      .send(deliveryBody('00000000-0000-4000-8000-000000000012')).expect(409);
    expect(duplicate.body.code).toBe('REPORT_DELIVERY_ALREADY_SENT');
    expect(put).not.toHaveBeenCalled();

    const sourceId = sourceResponse.body.item.id as number;
    const resend = await request(app.getHttpServer()).post(`/reports/deliveries/${sourceId}/resend`)
      .set(auth(managerToken)).send({ requestKey: '00000000-0000-4000-8000-000000000013' }).expect(201);
    expect(resend.body.item).toMatchObject({
      sourceSendId: sourceId, studentId: STUDENT_READY, repIds: [rep1, rep2], fileCount: 2,
    });
    expect(resend.body.item.id).not.toBe(sourceId);
    expect(put).not.toHaveBeenCalled();
    const [row] = await q<{ source_send_id: string }>(`SELECT source_send_id::text FROM rsend WHERE id=$1`,
      [resend.body.item.id]);
    expect(Number(row.source_send_id)).toBe(sourceId);
    const reused = await request(app.getHttpServer()).post(`/reports/deliveries/${sourceId}/resend`)
      .set(auth(managerToken)).send({ requestKey: '00000000-0000-4000-8000-000000000011' }).expect(409);
    expect(reused.body.code).toBe('REPORT_DELIVERY_REQUEST_KEY_REUSED');
  });
});
