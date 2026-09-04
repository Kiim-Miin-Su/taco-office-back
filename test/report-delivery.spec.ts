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
      .send({ ...base, files: [{ repId: rep1, fileName: 'x.png', pngDataUrl: png }] }).expect(400);
    expect(missing.body.code).toBe('REPORT_DELIVERY_FILES_MISMATCH');
    const fake = await request(app.getHttpServer()).post('/reports/deliveries').set(auth(managerToken))
      .send({
        ...base,
        files: [rep1, rep2].map((repId) => ({
          repId,
          fileName: `${DATE.replaceAll('-', '')}_준비학생_고2_AP Chemistry_${repId === rep1 ? '09:00' : '10:00'}.png`,
          pngDataUrl: 'data:image/png;base64,ZmFrZQ==',
        })),
      }).expect(400);
    expect(fake.body.code).toBe('REPORT_DELIVERY_PNG_FORMAT');
    expect(put).not.toHaveBeenCalled();
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
