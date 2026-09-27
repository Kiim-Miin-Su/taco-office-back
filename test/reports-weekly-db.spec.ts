/** @file-guide
 * 목적: reports-weekly-db.spec.ts — N-54 주간 묶음 · 7-3 ① 파일의 리포트 칸 · N-73 report.write 감사를 실제 HTTP/권한/DB 로 검증한다 (W11 · R2).
 * 책임/재사용: 기존 AppModule/ValidationPipe/AuthService 와 scratch DB 를 재사용하고 발송기는 FakeSender 로 갈아 끼운다.
 *   판정·문장은 서비스(weekly-bundle · reports · guardians · files) 한 벌에서 오고 테스트는 결과만 본다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 보는 것:
 *   ① 강사는 주간 묶음을 못 본다 · 못 쓴다(403) — 연락처·학생 글이 강사에게 내려가지 않는다
 *   ② 묶음은 그 주(월~일) 쓴 리포트를 **읽을 때** 모은다 — 날짜는 월요일로 맞춘다 · 승인 안 된 것이 있으면 못 보낸다
 *   ③ 총평은 `{summary, by, at}` 만 저장된다 — 빈 총평 400 · 리포트 없는 학생 409 · DB CHECK 가 다른 모양을 막는다
 *   ④ 보내기는 보호자 선택 발송으로 — 본문이 서버가 모은 글과 다르면 409 · 회차 안내와 함께면 400 · 원장 줄에 wrep_id
 *   ⑤ 한 번 나간 묶음의 총평은 고치지 않는다(409) — 원장에는 본문이 없어 같은 글을 다시 만들 수 있어야 한다
 *   ⑥ report.write 감사 — 쓰면 log(REP · write) 한 줄 · 잠긴 리포트를 쓰려다 409 면 0 줄
 *   ⑦ 파일의 리포트 칸(pdflog.rep_id) — 한 묶음에 든 **남의 리포트 PNG** 는 열지 못한다 · 옛 줄(rep_id NULL)은 예전처럼 묶음으로 판정
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { dataSourceOptions } from '../src/data-source';
import { SENDER } from '../src/modules/notify/sender';
import { FakeSender } from './fake-sender';
import { assertScratch, blockedBy, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(90_000);

type Row = Record<string, unknown>;
type Bundle = {
  studentId: number; wrepId: number | null; summary: { text: string; byId: number } | null; legacy: boolean;
  lessons: Array<{ repId: number; state: string; approved: boolean; body: unknown }>;
  lessonCount: number; approvedCount: number;
  canWriteSummary: boolean; summaryBlockedReason: string | null;
  canSend: boolean; sendBlockedReason: string | null; plainText: string | null; subject: string;
  sentAt: string | null; attemptCount: number;
};
type WeekList = { weekOf: string; weekTo: string; label: string; total: number; remaining: number; bundles: Bundle[] };

d('W11 R2 주간 묶음(N-54) · 파일의 리포트 칸 · report.write 감사 — HTTP/DB', () => {
  let app: INestApplication;
  let ds: DataSource;
  const fake = new FakeSender();
  const ADMIN = 64401, T1 = 64402, T2 = 64403;
  const staff = [ADMIN, T1, T2];
  const S1 = 964401, S2 = 964402, S3 = 964403;
  const students = [S1, S2, S3];
  const SER1 = 964401, SER2 = 964402, SER3 = 964403, SER4 = 964404;
  const sers = [SER1, SER2, SER3, SER4];
  const KIND = 'w11-r2-weekly';
  const FILE_A = 964401, FILE_B = 964402, FILE_OLD = 964403;
  const files = [FILE_A, FILE_B, FILE_OLD];
  const tokens = new Map<number, string>();
  const rep = new Map<number, number>();

  const sql = <T = Row>(statement: string, params: unknown[] = []): Promise<T[]> => ds.query(statement, params) as Promise<T[]>;
  const http = (method: 'get' | 'put' | 'post', path: string, actor = ADMIN) =>
    request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${tokens.get(actor)}`)
      .timeout({ response: 15000, deadline: 30000 });
  const week = async (weekOf = '2026-08-05'): Promise<WeekList> =>
    (await http('get', `/reports/weekly?weekOf=${weekOf}`).expect(200)).body as WeekList;
  const bundleOf = (list: WeekList, studentId: number) => list.bundles.find((b) => b.studentId === studentId);
  /** 막혀야 할 SQL — 트랜잭션 안 세이브포인트에서 부르고 통째로 되돌린다(돌려받는 것은 오류 문장) */
  const blocked = async (statement: string, params: unknown[] = []): Promise<string> => {
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try { return await blockedBy(qr, statement, params); } finally { await qr.rollbackTransaction(); await qr.release(); }
  };

  const cleanup = async () => {
    await sql('DELETE FROM guardian_send WHERE student_id = ANY($1::bigint[])', [students]);
    await sql('DELETE FROM guardian WHERE student_id = ANY($1::bigint[])', [students]);
    await sql('DELETE FROM pnoti WHERE student_id = ANY($1::bigint[])', [students]);
    await sql('DELETE FROM wrep WHERE student_id = ANY($1::bigint[])', [students]);
    await sql('DELETE FROM pdflog WHERE ref_id IN (SELECT id FROM rsend WHERE student_id = ANY($1::bigint[]))', [students]);
    await sql('DELETE FROM rsend WHERE student_id = ANY($1::bigint[])', [students]);
    await sql('DELETE FROM file WHERE id = ANY($1::bigint[])', [files]);
    await sql('DELETE FROM log WHERE actor_id = ANY($1::bigint[])', [staff]);
    await sql('DELETE FROM noti WHERE to_id = ANY($1::bigint[]) OR from_id = ANY($1::bigint[])', [staff]);
    await sql('DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1::bigint[]))', [sers]);
    await sql('DELETE FROM rep WHERE ser_id = ANY($1::bigint[])', [sers]);
    await sql('DELETE FROM ser_occ WHERE ser_id = ANY($1::bigint[])', [sers]);
    await sql('DELETE FROM ser_stu WHERE ser_id = ANY($1::bigint[])', [sers]);
    await sql('DELETE FROM ser WHERE id = ANY($1::bigint[])', [sers]);
  };

  /** 지난 한 회차 + 리포트 한 줄 — 상태 도장은 rep_review_contract 모양 그대로 */
  const lesson = async (ser: number, teacher: number, on: string, hour: number, state: 'none' | 'wait' | 'ok', kids: number[]) => {
    await sql(`INSERT INTO ser (id,kind_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date,title)
      VALUES ($1,$2,$3,'online',$4,$5,'ONCE',$6::date,$6::date,NULL)`, [ser, KIND, teacher, hour * 60, hour * 60 + 60, on]);
    for (const kid of kids) await sql('INSERT INTO ser_stu (ser_id,student_id) VALUES ($1,$2)', [ser, kid]);
    await sql(`INSERT INTO ser_occ (ser_id,on_date,teacher_id,span)
      VALUES ($1,$2::date,$3, tstzrange(($2::date + make_interval(hours => $4)) AT TIME ZONE 'Asia/Seoul',
                                        ($2::date + make_interval(hours => $4 + 1)) AT TIME ZONE 'Asia/Seoul','[)'))`,
    [ser, on, teacher, hour]);
    const written = state !== 'none';
    const [row] = await sql<{ id: string }>(
      `INSERT INTO rep (ser_id,on_date,teacher_id,kind_key,state,body,written_at,submitted_at,reviewed_at,reviewer_id)
       VALUES ($1,$2,$3,$4,$5::rep_state_t,$6::jsonb,$7,$7,$8,$9) RETURNING id`,
      [ser, on, teacher, KIND, state,
        JSON.stringify(written ? { content: `${on} 수업 내용`, progress: `${on} 진도`, homework: `${on} 숙제` } : {}),
        written ? `${on}T12:00:00Z` : null, state === 'ok' ? `${on}T13:00:00Z` : null, state === 'ok' ? ADMIN : null],
    );
    rep.set(ser, Number(row.id));
    for (const kid of kids) await sql('INSERT INTO rep_stu (rep_id,student_id,deliver) VALUES ($1,$2,true)', [Number(row.id), kid]);
  };

  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource).useValue(ds)
      .overrideProvider(SENDER).useValue(fake)
      .compile();
    app = module.createNestApplication();
    app.useLogger(false); app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');

    await cleanup();
    await sql('DELETE FROM stu WHERE id = ANY($1::bigint[])', [students]);
    await sql('DELETE FROM staff WHERE id = ANY($1::bigint[])', [staff]);
    await sql('DELETE FROM kind WHERE key = $1', [KIND]);
    const password = 'w11-r2-weekly-local-fixture-only';
    const hash = await bcrypt.hash(password, 4);
    for (const [id, role, name] of [[ADMIN, 'admin', 'R2 관리자'], [T1, 'teacher', 'R2 강사 가'], [T2, 'teacher', 'R2 강사 나']] as const) {
      const email = `w11-r2-${id}@t.invalid`;
      await sql('INSERT INTO staff(id,name,email,role,password_hash,active) VALUES ($1,$2,$3,$4,$5,true)', [id, name, email, role, hash]);
      const res = await request(app.getHttpServer()).post('/auth/login').send({ loginId: email, password }).expect(201);
      tokens.set(id, res.body.accessToken as string);
    }
    await sql(`INSERT INTO stu(id,name,grade) VALUES ($1,'R2 학생 가','G9'),($2,'R2 학생 나','G8'),($3,'R2 학생 다','G7')`, students);
    await sql(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'R2 주간 수업','#123456',8,'lesson',true)`, [KIND]);
  });

  beforeEach(async () => {
    await cleanup();
    fake.readyMap = { email: true, sms: false };
    fake.reply = () => ({ configured: true, ok: true, providerId: 'fake-weekly', error: null });
    fake.calls = [];
    // 2026-08-03(월) ~ 08-09(일) — 학생 가: 승인 1 + 승인 대기 1 · 학생 나: 승인 1
    await lesson(SER1, T1, '2026-08-04', 10, 'ok', [S1, S2]);
    await lesson(SER2, T2, '2026-08-06', 14, 'wait', [S1]);
    // 다른 주(07-13 주) — 감사 시험용 · 학생 다
    await lesson(SER3, T1, '2026-07-15', 9, 'none', [S3]);
    await lesson(SER4, T1, '2026-07-16', 9, 'ok', [S3]);
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await cleanup();
        await sql('DELETE FROM stu WHERE id = ANY($1::bigint[])', [students]);
        await sql('DELETE FROM staff WHERE id = ANY($1::bigint[])', [staff]);
        await sql('DELETE FROM kind WHERE key = $1', [KIND]);
      }
    } finally {
      if (app) await app.close();
      if (ds?.isInitialized) await ds.destroy();
    }
  });

  it('① 강사는 주간 묶음을 못 본다 · 못 쓴다 — 403 이고 아무것도 안 남는다', async () => {
    await http('get', '/reports/weekly?weekOf=2026-08-05', T1).expect(403);
    await http('put', '/reports/weekly', T1).send({ studentId: S2, weekOf: '2026-08-05', summary: '강사가 쓴 총평' }).expect(403);
    expect(await sql('SELECT id FROM wrep WHERE student_id = $1', [S2])).toEqual([]);
  });

  it('② 묶음은 그 주 쓴 리포트를 읽을 때 모은다 — 아무 날을 줘도 월요일로 맞추고, 승인 안 된 것이 있으면 못 보낸다', async () => {
    const list = await week('2026-08-07');
    expect(list).toMatchObject({ weekOf: '2026-08-03', weekTo: '2026-08-09', label: '08-03 ~ 08-09' });
    const a = bundleOf(list, S1)!;
    const b = bundleOf(list, S2)!;
    expect(a).toMatchObject({ lessonCount: 2, approvedCount: 1, canWriteSummary: true, canSend: false, plainText: null, wrepId: null });
    expect(a.sendBlockedReason).toBe('승인되지 않은 리포트가 1건 있습니다');
    expect(a.lessons.map((l) => l.repId)).toEqual([rep.get(SER1), rep.get(SER2)]);
    expect(b).toMatchObject({ lessonCount: 1, approvedCount: 1, canSend: false, sendBlockedReason: '총평을 먼저 써야 보낼 수 있습니다' });
    // 다른 주의 학생은 이 주 묶음에 없다 · 아무것도 저장하지 않았다
    expect(bundleOf(list, S3)).toBeUndefined();
    expect(await sql('SELECT id FROM wrep WHERE student_id = ANY($1::bigint[])', [students])).toEqual([]);
  });

  it('③ 총평은 {summary, by, at} 만 저장된다 — 빈 총평 400 · 리포트 없는 학생 409 · DB 가 다른 모양을 막는다', async () => {
    await http('put', '/reports/weekly').send({ studentId: S2, weekOf: '2026-08-05', summary: '   ' }).expect(400)
      .expect(({ body }) => expect(body.code).toBe('WEEKLY_SUMMARY_REQUIRED'));
    await http('put', '/reports/weekly').send({ studentId: S3, weekOf: '2026-08-05', summary: '리포트 없는 주' }).expect(409)
      .expect(({ body }) => expect(body.code).toBe('WEEKLY_NO_LESSONS'));
    expect(await sql('SELECT id FROM wrep WHERE student_id = ANY($1::bigint[])', [students])).toEqual([]);

    const saved = (await http('put', '/reports/weekly').send({ studentId: S2, weekOf: '2026-08-08', summary: '  이번 주 잘했습니다  ' })
      .expect(200)).body as Bundle;
    expect(saved).toMatchObject({ summary: { text: '이번 주 잘했습니다', byId: ADMIN }, canSend: true, sendBlockedReason: null });
    expect(saved.plainText).toContain('③ 수업 내용\n2026-08-04 수업 내용');
    expect(saved.plainText!.endsWith('총평\n이번 주 잘했습니다')).toBe(true);
    const [row] = await sql<{ week_of: string; body: Record<string, unknown> }>(
      `SELECT to_char(week_of,'YYYY-MM-DD') AS week_of, body FROM wrep WHERE student_id = $1`, [S2]);
    expect(row.week_of).toBe('2026-08-03');
    expect(Object.keys(row.body).sort()).toEqual(['at', 'by', 'summary']);
    expect(row.body).toMatchObject({ summary: '이번 주 잘했습니다', by: ADMIN });

    // 다른 모양은 DB 가 막는다 — 칸이 더 있거나 · 월요일이 아니거나
    expect(await blocked(`UPDATE wrep SET body = body || '{"lessons":[]}'::jsonb WHERE student_id = $1`, [S2])).toContain('wrep_body_summary');
    expect(await blocked(`INSERT INTO wrep (student_id, week_of, body) VALUES ($1, '2026-08-04', NULL)`, [S1])).toContain('wrep_week_monday');
  });

  it('④⑤ 보내기는 보호자 선택 발송 — 본문이 다르면 409 · 회차 안내와 함께면 400 · 원장에 wrep_id · 나간 뒤 총평은 잠긴다', async () => {
    const [g] = await sql<{ id: string }>(
      `INSERT INTO guardian (student_id,name,relation,email,receive_email,is_primary,created_by)
       VALUES ($1,'R2 보호자','어머니','r2-guardian@t.invalid',true,true,$2) RETURNING id`, [S2, ADMIN]);
    const saved = (await http('put', '/reports/weekly').send({ studentId: S2, weekOf: '2026-08-03', summary: '총평입니다' })
      .expect(200)).body as Bundle;
    const send = (body: Row) => http('post', '/guardians/send').send({
      studentId: S2, guardianIds: [Number(g.id)], channels: ['email'], requestKey: randomUUID(), ...body,
    });

    await send({ wrepId: saved.wrepId, body: `${saved.plainText} (고침)` }).expect(409)
      .expect(({ body }) => expect(body.code).toBe('WEEKLY_BUNDLE_CHANGED'));
    const [notice] = await sql<{ id: string }>(
      `INSERT INTO pnoti (ser_id,on_date,student_id,channel,body,audience) VALUES ($1,'2026-08-04',$2,'sms','안내','parent') RETURNING id`,
      [SER1, S2]);
    await send({ wrepId: saved.wrepId, pnotiId: Number(notice.id), body: saved.plainText }).expect(400)
      .expect(({ body }) => expect(body.code).toBe('GUARDIAN_SEND_ONE_SOURCE'));
    expect(fake.calls).toHaveLength(0);
    expect(await sql('SELECT id FROM guardian_send WHERE student_id = $1', [S2])).toEqual([]);

    // 승인 안 된 리포트가 든 묶음은 못 보낸다(학생 가)
    const [g1] = await sql<{ id: string }>(
      `INSERT INTO guardian (student_id,name,email,receive_email,is_primary,created_by)
       VALUES ($1,'R2 보호자 가','r2-guardian-a@t.invalid',true,true,$2) RETURNING id`, [S1, ADMIN]);
    await http('put', '/reports/weekly').send({ studentId: S1, weekOf: '2026-08-03', summary: '가 총평' }).expect(200);
    const [w1] = await sql<{ id: string }>('SELECT id FROM wrep WHERE student_id = $1', [S1]);
    await http('post', '/guardians/send').send({
      studentId: S1, guardianIds: [Number(g1.id)], channels: ['email'], requestKey: randomUUID(), wrepId: Number(w1.id), body: '아무 글',
    }).expect(409).expect(({ body }) => expect(body.code).toBe('WEEKLY_NOT_SENDABLE'));

    // 제대로 보내면 원장 줄이 그 묶음을 가리킨다
    await send({ wrepId: saved.wrepId, body: saved.plainText, subject: saved.subject }).expect(200);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ channel: 'email', body: saved.plainText, subject: saved.subject });
    const ledger = await sql<{ wrep_id: string; pnoti_id: string | null; status: string }>(
      'SELECT wrep_id, pnoti_id, status FROM guardian_send WHERE student_id = $1', [S2]);
    expect(ledger).toEqual([{ wrep_id: String(saved.wrepId), pnoti_id: null, status: 'sent' }]);
    const after = bundleOf(await week(), S2)!;
    expect(after).toMatchObject({ attemptCount: 1, canWriteSummary: false, summaryBlockedReason: '이미 보호자에게 보낸 묶음이라 총평을 고칠 수 없습니다' });
    expect(after.sentAt).not.toBeNull();
    expect((await week()).remaining).toBe(1);

    // ⑤ 나간 뒤 총평은 잠긴다 — 409 이고 저장된 글은 그대로
    await http('put', '/reports/weekly').send({ studentId: S2, weekOf: '2026-08-03', summary: '바꾼 총평' }).expect(409)
      .expect(({ body }) => expect(body.code).toBe('WEEKLY_ALREADY_SENT'));
    const [row] = await sql<{ body: { summary: string } }>('SELECT body FROM wrep WHERE student_id = $1', [S2]);
    expect(row.body.summary).toBe('총평입니다');
    // 회차 안내와 주간 묶음을 동시에 가리키는 줄은 DB 가 막는다
    expect(await blocked('UPDATE guardian_send SET pnoti_id = $1 WHERE student_id = $2', [Number(notice.id), S2]))
      .toContain('guardian_send_one_source');
  });

  it('⑥ report.write 감사 — 쓰면 log(REP · write) 한 줄 · 잠긴 리포트를 쓰려다 409 면 0 줄', async () => {
    const body = { content: '관리자가 쓴 내용', progress: '12쪽', homework: '13쪽' };
    await http('put', `/reports/${SER3}/2026-07-15/draft`).send(body).expect(200);
    await http('post', `/reports/${SER3}/2026-07-15/submit`).send(body).expect(201);
    const rows = await sql<{ entity: string; action: string; actor_id: string; before: Row; after: Row }>(
      `SELECT entity, action, actor_id, before, after FROM log WHERE entity = 'REP' AND entity_id = $1 ORDER BY id`, [rep.get(SER3)]);
    expect(rows.map((r) => [r.entity, r.action, Number(r.actor_id)])).toEqual([['REP', 'write', ADMIN], ['REP', 'write', ADMIN]]);
    expect(rows[0].before).toMatchObject({ state: 'none', reviewedAt: null, rejectReason: null });
    expect(rows[0].after).toEqual({ state: 'draft', submitted: false });
    expect(rows[1].after).toEqual({ state: 'wait', submitted: true });
    // 본문(학생 기록)은 원장에 싣지 않는다
    expect(JSON.stringify(rows)).not.toContain('관리자가 쓴 내용');

    await http('put', `/reports/${SER4}/2026-07-16/draft`).send(body).expect(409)
      .expect(({ body: err }) => expect(err.code).toBe('REPORT_LOCKED'));
    expect(await sql(`SELECT id FROM log WHERE entity = 'REP' AND entity_id = $1`, [rep.get(SER4)])).toEqual([]);
  });

  it('⑦ 파일의 리포트 칸 — 한 묶음 안 남의 리포트 PNG 는 못 연다 · 옛 줄(rep_id NULL)은 예전처럼 묶음으로 판정한다', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const sha = createHash('sha256').update(png).digest('hex');
    for (const id of files) {
      await sql(`INSERT INTO file (id,kind,name,mime,bytes,sha256,data,uploaded_by) VALUES ($1,'report-png',$2,'image/png',$3,$4,$5,$6)`,
        [id, `r2-${id}.png`, png.length, sha, png, ADMIN]);
    }
    const [sent] = await sql<{ id: string }>(
      `INSERT INTO rsend (student_id,on_date,rep_ids,channel,body,sent_by,request_key)
       VALUES ($1,'2026-08-04',$2::jsonb,'blob','본문',$3,$4) RETURNING id`,
      [S1, JSON.stringify([rep.get(SER1), rep.get(SER2)]), ADMIN, randomUUID()]);
    await sql(`INSERT INTO pdflog (kind,ref_id,file_url,rep_id) VALUES
      ('report_png',$1,$2,$3), ('report_png',$1,$4,$5), ('report_png',$1,$6,NULL)`,
    [Number(sent.id), `/files/${FILE_A}`, rep.get(SER1), `/files/${FILE_B}`, rep.get(SER2), `/files/${FILE_OLD}`]);

    await http('get', `/files/${FILE_A}`, T1).expect(200);
    await http('get', `/files/${FILE_B}`, T1).expect(403);   // 같은 묶음 · 남(강사 나)의 리포트 장
    await http('get', `/files/${FILE_B}`, T2).expect(200);
    await http('get', `/files/${FILE_A}`, T2).expect(403);
    await http('get', `/files/${FILE_OLD}`, T1).expect(200); // 옛 줄 — 묶음 판정 그대로(N-25)
    await http('get', `/files/${FILE_B}`, ADMIN).expect(200);
    // 리포트가 없는 id 는 FK 가 막는다
    expect(await blocked(`UPDATE pdflog SET rep_id = -1 WHERE ref_id = $1 AND rep_id IS NULL`, [Number(sent.id)])).toContain('pdflog_rep_id_fkey');
  });
});
