/** @file-guide
 * 목적: S4-a GUIDE 내부 전달·본인 확인의 실제 HTTP/권한/원자성/재조회 회귀 (test)
 * 책임/재사용: 기존 AppModule/ValidationPipe/AuthService와 scratch DB fixture를 재사용한다. 아직 없는 service 함수를 직접 참조하지 않는다.
 * 검증/작업 지침: docs/AGENT.md · docs/sprint/evidence/TBO-52/s4-guide/backend-contract.md
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource, QueryRunner } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { dataSourceOptions } from '../src/data-source';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

type Row = Record<string, unknown>;
type State = 'draft' | 'ready' | 'sent' | 'read';
type GuideView = { id: number; state: State; body: string | null; canSend: boolean; canAck: boolean;
  sendBlockedReason: string | null; sentAt: string | null; acknowledgedAt: string | null;
  acknowledgedAfterSeconds: number | null };

d('S4-a GUIDE 내부 발송·확인 HTTP/DB', () => {
  let app: INestApplication;
  let ds: DataSource;
  let guideId: number;
  const ADMIN = 29941, A = 29942, B = 29943, MANAGER = 29944, STUDENT = 29941;
  const actors = [ADMIN, A, B, MANAGER];
  const ids: number[] = [];
  const tokens = new Map<number, string>();
  const DAY = '2041-01-10';
  const BODY = 'S4A 안내 본문 — 수신 당시 확정한 말';
  const sql = <T = Row>(statement: string, params: unknown[] = []): Promise<T[]> => ds.query(statement, params) as Promise<T[]>;
  const http = (method: 'get' | 'post' | 'put', path: string, actor = ADMIN) =>
    request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${tokens.get(actor)}`)
      .timeout({ response: 10000, deadline: 20000 });
  const send = (id: number | string = guideId, actor = ADMIN) => http('post', `/guides/${id}/send`, actor);
  const ack = (id: number | string = guideId, actor = A) => http('post', `/teacher/guides/${id}/ack`, actor);
  const received = async (actor = A) => (await http('get', '/teacher/guides/received', actor).expect(200)).body as { items: GuideView[] };
  const current = async () => ((await http('get', '/guides').expect(200)).body.guides as GuideView[]).find(g => g.id === guideId)!;
  const make = async (state: State = 'ready', teacher: number | null = A, body: string | null = BODY) => {
    const [g] = await sql(`INSERT INTO guide(student_id,teacher_id,reason,state,body,due_on,created_by)
      VALUES ($1,$2,'new',$3::guide_state_t,$4,$5::date,$6) RETURNING id`, [STUDENT, teacher, state, body, DAY, ADMIN]);
    const id = Number(g.id); ids.push(id); return id;
  };
  const state = (value: State) => sql('UPDATE guide SET state=$1::guide_state_t WHERE id=$2', [value, guideId]);
  const snapshot = async () => ({
    guides: await sql('SELECT * FROM guide WHERE id=ANY($1::bigint[]) ORDER BY id', [ids]),
    history: await sql('SELECT * FROM hist WHERE by_id=ANY($1::bigint[]) ORDER BY id', [actors]),
    notifications: await sql('SELECT * FROM noti WHERE to_id=ANY($1::bigint[]) OR from_id=ANY($1::bigint[]) ORDER BY id', [actors]),
    parentNotices: await sql('SELECT * FROM pnoti WHERE student_id=$1 OR staff_id=ANY($2::bigint[]) ORDER BY id', [STUDENT, actors]),
  });
  const reject = async (call: request.Test, status: number, code?: string) => {
    const before = await snapshot();
    const res = await call;
    expect({ status: res.status, state: await snapshot() }).toEqual({ status, state: before });
    if (code) expect(res.body).toMatchObject({ code });
  };
  const hist = () => sql('SELECT action,by_id FROM hist WHERE entity=$1 AND ref_id=$2 ORDER BY at,id', ['guide', guideId]);

  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DataSource).useValue(ds).compile();
    app = module.createNestApplication();
    app.useLogger(false); app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const password = 's4a-local-fixture-only';
    const hash = await bcrypt.hash(password, 4);
    for (const [id, role] of [[ADMIN, 'admin'], [A, 'teacher'], [B, 'teacher'], [MANAGER, 'manager']] as const) {
      const email = `s4a-${id}@t.invalid`;
      await sql('INSERT INTO staff(id,name,email,role,password_hash,active) VALUES ($1,$2,$3,$4,$5,true)', [id, `S4A ${role} ${id}`, email, role, hash]);
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(201);
      tokens.set(id, res.body.accessToken as string);
    }
    await sql('INSERT INTO stu(id,name) VALUES ($1,$2)', [STUDENT, 'S4A 수신 학생']);
  });
  beforeEach(async () => { guideId = await make(); });
  afterEach(async () => {
    jest.restoreAllMocks();
    await sql('DELETE FROM hist WHERE by_id=ANY($1::bigint[])', [actors]);
    await sql('DELETE FROM noti WHERE to_id=ANY($1::bigint[]) OR from_id=ANY($1::bigint[])', [actors]);
    await sql('DELETE FROM pnoti WHERE student_id=$1 OR staff_id=ANY($2::bigint[])', [STUDENT, actors]);
    await sql('DELETE FROM guide WHERE id=ANY($1::bigint[])', [ids]); ids.length = 0;
    await sql('DELETE FROM diag WHERE student_id=$1', [STUDENT]);
    await sql(`UPDATE staff SET active=true,role=(CASE WHEN id=$1 THEN 'admin' WHEN id=$2 THEN 'manager' ELSE 'teacher' END)::role_t WHERE id=ANY($3::bigint[])`, [ADMIN, MANAGER, actors]);
  });
  afterAll(async () => {
    if (ds?.isInitialized) {
      await sql('DELETE FROM stu WHERE id=$1', [STUDENT]);
      await sql('DELETE FROM staff WHERE id=ANY($1::bigint[])', [actors]);
    }
    if (app) await app.close();
    if (ds?.isInitialized) await ds.destroy();
  });

  it('환경 대조군: 기존 본문 HTTP 저장→ready→SQL/HIST 경로는 실제로 동작한다', async () => {
    await state('draft');
    const res = await http('put', `/guides/${guideId}/body`).send({ body: BODY }).expect(200);
    expect(res.body).toMatchObject({ id: guideId, state: 'ready', body: BODY });
    expect(await hist()).toEqual([{ action: 'guide_write', by_id: String(ADMIN) }]);
  });

  it('관리자 작성→내부발송→수신강사확인→관리자 새GET과 최초시각이 일치한다', async () => {
    await state('draft');
    const written = await http('put', `/guides/${guideId}/body`).send({ body: BODY }).expect(200);
    expect(written.body).toMatchObject({ canSend: true, canAck: false, sendBlockedReason: null, acknowledgedAfterSeconds: null });
    const sent = await send().send({}).expect(200);
    expect(sent.body).toMatchObject({ id: guideId, state: 'sent', body: BODY, canSend: false, canAck: false, acknowledgedAt: null });
    expect(sent.body.sentAt).toMatch(/\+09:00$/);
    expect((await received()).items.find(g => g.id === guideId)).toMatchObject({ state: 'sent', canSend: false, canAck: true, body: BODY });
    const read = await ack().expect(200);
    expect(read.body).toMatchObject({ state: 'read', canSend: false, canAck: false, sentAt: sent.body.sentAt });
    expect(read.body.acknowledgedAfterSeconds).toEqual(expect.any(Number));
    expect(read.body.acknowledgedAfterSeconds).toBeGreaterThanOrEqual(0);
    expect(await current()).toMatchObject({ state: 'read', acknowledgedAt: read.body.acknowledgedAt, acknowledgedAfterSeconds: read.body.acknowledgedAfterSeconds });
    expect(await hist()).toEqual([
      { action: 'guide_write', by_id: String(ADMIN) }, { action: 'guide_send', by_id: String(ADMIN) }, { action: 'guide_ack', by_id: String(A) },
    ]);
    expect((await snapshot()).notifications).toEqual([expect.objectContaining({ to_id: String(A), from_id: String(ADMIN), link: `/teacher/guides?guideId=${guideId}`, category: 'schedule' })]);
    expect((await snapshot()).parentNotices).toEqual([]);
  });

  it('수신함은본인sent/read만·위조teacherId query무효·최신진단/교재projection비노출·GET쓰기0', async () => {
    const sent = await make('sent'), read = await make('read');
    await make('draft'); await make('sent', B);
    await sql('INSERT INTO diag(student_id,level_summary,created_by) VALUES ($1,$2,$3)', [STUDENT, 'S4A PRIVATE LATEST DIAG', B]);
    const before = await snapshot();
    const res = await http('get', '/teacher/guides/received', A).query({ teacherId: B }).expect(200);
    expect(res.body.items.map((g: GuideView) => g.id).sort()).toEqual([sent, read].sort());
    expect(res.body.items.find((g: GuideView) => g.id === sent)).toMatchObject({ canSend: false, canAck: true });
    expect(res.body.items.find((g: GuideView) => g.id === read)).toMatchObject({ canSend: false, canAck: false });
    expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE LATEST DIAG|"diagnostic"|"books"|"guidance"/);
    expect(await snapshot()).toEqual(before);
  });

  it('소유권없는GUIDE와없는GUIDE는같은404·상태노출/쓰기0', async () => {
    await state('sent');
    await received(B); // route 부재404를 권한 성공으로 잘못 세지 않는 양성 대조
    const before = await snapshot();
    const other = await ack(guideId, B), absent = await ack(900000000, B);
    expect({ status: other.status, body: other.body }).toEqual({ status: absent.status, body: absent.body });
    expect(other.status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it.each([[false, false], [true, false], [false, true], [true, true]] as const)('최종admin=%s/crud=%s는버튼과send의같은방어다', async (canAdminPage, canCrudAll) => {
    const auth = app.get(AuthService), currentUser = auth.currentUser.bind(auth);
    // STAFF에 독립10/01 컬럼이 없어 최종 projection만 대체한다. HTTP JWT/guard/SQL은 실제 경로다.
    jest.spyOn(auth, 'currentUser').mockImplementation(async id => ({ ...await currentUser(id), perms: { canAdminPage, canCrudAll } }));
    const allowed = canAdminPage && canCrudAll;
    if (canAdminPage) {
      const g = await current();
      expect(g).toMatchObject({ canSend: allowed, canAck: false });
      if (!allowed) expect(g.sendBlockedReason).toEqual(expect.any(String));
    }
    if (allowed) await send().expect(200);
    else await reject(send(), 403);
  });

  it.each(['send', 'ack', 'received'] as const)('익명%s는401·쓰기0', async action => {
    const path = action === 'send' ? `/guides/${guideId}/send` : action === 'ack' ? `/teacher/guides/${guideId}/ack` : '/teacher/guides/received';
    await reject(request(app.getHttpServer())[action === 'received' ? 'get' : 'post'](path), 401);
  });
  it('실제강사send와관리자대리ack/received는403', async () => {
    await state('sent');
    await reject(send(guideId, A), 403);
    await reject(ack(guideId, ADMIN), 403);
    await reject(http('get', '/teacher/guides/received', MANAGER), 403);
  });
  it.each([['role', 'manager', 403], ['active', false, 401]] as const)('기발급수신강사토큰의%s회수도반영한다', async (field, value, status) => {
    await state('sent');
    await sql(`UPDATE staff SET ${field}=$1 WHERE id=$2`, [value, A]);
    await reject(ack(), status);
    await reject(http('get', '/teacher/guides/received', A), status);
  });

  it.each(['send', 'ack'] as const)('%s는십진양의안전정수id만허용한다', async action => {
    for (const id of ['0', '-1', '1.2', '1e3', '0x10', '%201', '9007199254740992']) {
      await reject(action === 'send' ? send(id) : ack(id), 400);
    }
  });
  it.each(['teacherId', 'studentId', 'state', 'body', 'sentAt', 'acknowledgedAt'])('extra body %s는두행위모두400·서버대상/상태/시각통제', async field => {
    await state('sent');
    const body = { [field]: field === 'teacherId' ? B : '위조 입력' };
    await reject(send().send(body), 400);
    await reject(ack().send(body), 400);
  });
  it('배열body는빈행위DTO를우회할수없다', async () => {
    await reject(send().send([]), 400);
    await reject(ack().send([{ teacherId: B }]), 400);
  });
  it.each(['null', '"위조 입력"', '123', 'true'])('JSON 비객체 %s는 send/ack 모두400·DB불변', async raw => {
    // .send(null)은 빈 요청이 되므로 JSON 원문과 content type을 명시한다.
    await reject(send().set('Content-Type', 'application/json').send(raw), 400);
    await state('sent');
    await reject(ack().set('Content-Type', 'application/json').send(raw), 400);
  });
  it('draft send와draft/ready ack는상태409·쓰기0', async () => {
    await state('draft');
    await reject(send(), 409, 'GUIDE_NOT_READY');
    await reject(ack(), 409, 'GUIDE_NOT_SENT');
    await state('ready');
    await reject(ack(), 409, 'GUIDE_NOT_SENT');
  });
  it.each([null, '', '   '])('ready의빈본문%j는최초send409·canSend와사유일치', async body => {
    await sql('UPDATE guide SET body=$1 WHERE id=$2', [body, guideId]);
    await reject(send(), 409, 'GUIDE_BODY_EMPTY');
    expect(await current()).toMatchObject({ canSend: false, sendBlockedReason: expect.any(String) });
  });
  it.each(['none', 'inactive', 'manager'] as const)('수신자%s는최초send409·canSend와사유일치', async target => {
    if (target === 'none') await sql('UPDATE guide SET teacher_id=NULL WHERE id=$1', [guideId]);
    if (target === 'inactive') await sql('UPDATE staff SET active=false WHERE id=$1', [A]);
    if (target === 'manager') await sql(`UPDATE staff SET role='manager' WHERE id=$1`, [A]);
    await reject(send(), 409, 'GUIDE_RECIPIENT_UNAVAILABLE');
    expect(await current()).toMatchObject({ canSend: false, sendBlockedReason: expect.any(String) });
  });
  it.each(['sent', 'read'] as const)('기%s의반복send는비활성수신자/legacy이력없음도그대로반환·새시각0', async prior => {
    await state(prior);
    await sql('UPDATE staff SET active=false WHERE id=$1', [A]);
    const before = await snapshot();
    const res = await send().expect(200);
    expect(res.body).toMatchObject({ state: prior, sentAt: null, acknowledgedAt: null, acknowledgedAfterSeconds: null, canSend: false });
    expect(await snapshot()).toEqual(before);
  });
  it('기read반복ack는legacy이력빈칸을복구하지않는다', async () => {
    await state('read'); const before = await snapshot();
    const res = await ack().expect(200);
    expect(res.body).toMatchObject({ state: 'read', sentAt: null, acknowledgedAt: null, acknowledgedAfterSeconds: null, canAck: false });
    expect(await snapshot()).toEqual(before);
  });
  it('legacy sent최초ack는실제확인만기록하고가짜발송시각을만들지않는다', async () => {
    await state('sent');
    const res = await ack().expect(200);
    expect(res.body).toMatchObject({ state: 'read', sentAt: null, acknowledgedAfterSeconds: null });
    expect(res.body.acknowledgedAt).toMatch(/\+09:00$/);
    expect(await hist()).toEqual([{ action: 'guide_ack', by_id: String(A) }]);
    expect((await snapshot()).notifications).toEqual([]);
  });
  it('경과초는GUIDE최초HIST두시각만사용하고같은id의PNOTI발송은섞지않는다', async () => {
    await state('read');
    await sql(`INSERT INTO hist(entity,ref_id,action,by_id,at) VALUES
      ('pnoti',$1,'guide_send',$2,'2040-01-01T00:00:00Z'),
      ('guide',$1,'guide_send',$2,'2041-01-10T00:00:00Z'),
      ('guide',$1,'guide_ack',$3,'2041-01-10T00:01:35Z')`, [guideId, ADMIN, A]);
    const before = await snapshot();
    expect(await current()).toMatchObject({ sentAt: '2041-01-10T09:00:00+09:00', acknowledgedAt: '2041-01-10T09:01:35+09:00', acknowledgedAfterSeconds: 95 });
    const students = await http('get', '/guides/students').expect(200);
    expect(students.body.items.find((s: { studentId: number }) => s.studentId === STUDENT).latestGuide).toMatchObject({ acknowledgedAfterSeconds: 95, canSend: false, canAck: false });
    const history = await http('get', '/guides/history').query({ anchor: DAY, span: 'day' }).expect(200);
    expect(history.body.days.flatMap((day: { items: GuideView[] }) => day.items).find((g: GuideView) => g.id === guideId)).toMatchObject({ acknowledgedAfterSeconds: 95 });
    expect(await snapshot()).toEqual(before);
  });
  it('역전된legacy시각은경과0으로꾸미지않고null로조회한다', async () => {
    await state('read');
    await sql(`INSERT INTO hist(entity,ref_id,action,by_id,at) VALUES
      ('guide',$1,'guide_send',$2,'2041-01-10T00:02:00Z'),('guide',$1,'guide_ack',$3,'2041-01-10T00:01:00Z')`, [guideId, ADMIN, A]);
    expect(await current()).toMatchObject({ acknowledgedAfterSeconds: null });
  });
  it('동시send/ack는각전이1회·NOTI1개·첫이력보존으로수렴한다', async () => {
    const sent = await Promise.all([send(), send()]);
    expect(sent.map(r => r.status)).toEqual([200, 200]);
    expect(sent[0].body.sentAt).toBe(sent[1].body.sentAt);
    const read = await Promise.all([ack(), ack()]);
    expect(read.map(r => r.status)).toEqual([200, 200]);
    expect(read[0].body.acknowledgedAt).toBe(read[1].body.acknowledgedAt);
    expect((await hist()).map(r => r.action)).toEqual(['guide_send', 'guide_ack']);
    expect((await snapshot()).notifications).toHaveLength(1);
    const before = await snapshot(); await send().expect(200); await ack().expect(200);
    expect(await snapshot()).toEqual(before);
  });
  it('본문수정과send경합은동일GUIDE를직렬화하고보낸뒤의본문수정은거절한다', async () => {
    const nextBody = '발송 전에 확정된 수정 본문';
    const [sent, written] = await Promise.all([send(), http('put', `/guides/${guideId}/body`).send({ body: nextBody })]);
    expect(sent.status).toBe(200);
    expect([200, 409]).toContain(written.status);
    expect(await current()).toMatchObject({ state: 'sent', body: written.status === 200 ? nextBody : BODY });
    expect((await hist()).filter(h => h.action === 'guide_send')).toHaveLength(1);
    expect((await hist()).filter(h => h.action === 'guide_write')).toHaveLength(written.status === 200 ? 1 : 0);
    await reject(http('put', `/guides/${guideId}/body`).send({ body: '발송 후 변조' }), 409, 'GUIDE_ALREADY_SENT');
    await ack().expect(200);
    await reject(http('put', `/guides/${guideId}/body`).send({ body: '확인 후 변조' }), 409, 'GUIDE_ALREADY_SENT');
  });
  it('A의발송후B새안내는수신범위와확인을분리하고A본문/대상불변이다', async () => {
    await state('sent'); const otherId = await make('ready', B, 'B에게만 보낸 새 안내');
    const [original] = await sql('SELECT teacher_id,body FROM guide WHERE id=$1', [guideId]);
    await send(otherId).expect(200);
    expect((await received(A)).items.map(g => g.id)).toEqual([guideId]);
    expect((await received(B)).items.map(g => g.id)).toEqual([otherId]);
    await reject(ack(otherId, A), 404); await reject(ack(guideId, B), 404);
    await ack(guideId, A).expect(200);
    expect(await sql('SELECT teacher_id,body FROM guide WHERE id=$1', [guideId])).toEqual([original]);
  });

  it.each(['hist', 'noti'] as const)('최초send의%s실패는GUIDE/이력/알림을전부rollback한다', async table => {
    let injected = false;
    const create = ds.createQueryRunner.bind(ds);
    jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
      const runner = create(...args), run = runner.query.bind(runner);
      jest.spyOn(runner, 'query').mockImplementation(async (statement: string, params?: unknown[], structured?: boolean) => {
        if (runner.isTransactionActive && new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, 'i').test(statement)) {
          injected = true; throw new Error(`S4A intentional ${table} failure`);
        }
        return structured ? run(statement, params, true) : run(statement, params);
      });
      return runner;
    });
    const before = await snapshot(), res = await send();
    expect({ status: res.status, injected, state: await snapshot() }).toEqual({ status: 500, injected: true, state: before });
  });
  it('ack의HIST실패도read만따로남기지않는다', async () => {
    await state('sent'); let injected = false;
    const create = ds.createQueryRunner.bind(ds);
    jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
      const runner = create(...args), run = runner.query.bind(runner);
      jest.spyOn(runner, 'query').mockImplementation(async (statement: string, params?: unknown[], structured?: boolean) => {
        if (runner.isTransactionActive && /INSERT\s+INTO\s+hist\b/i.test(statement)) {
          injected = true; throw new Error('S4A intentional acknowledgement history failure');
        }
        return structured ? run(statement, params, true) : run(statement, params);
      });
      return runner;
    });
    const before = await snapshot(), res = await ack();
    expect({ status: res.status, injected, state: await snapshot() }).toEqual({ status: 500, injected: true, state: before });
  });

  it('최초send의활성수신자확인동안STAFF변경이잠금을기다린다', async () => {
    let release!: () => void, ready!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const paused = new Promise<void>(resolve => { ready = resolve; });
    let sending: QueryRunner | undefined;
    const create = ds.createQueryRunner.bind(ds);
    const spy = jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
      const runner = create(...args), run = runner.query.bind(runner);
      jest.spyOn(runner, 'query').mockImplementation(async (statement: string, params?: unknown[], structured?: boolean) => {
        const execute = () => structured ? run(statement, params, true) : run(statement, params);
        if (!sending && runner.isTransactionActive && /FROM\s+staff\b/i.test(statement) && /active/i.test(statement)) {
          sending = runner; const result = await execute(); ready(); await hold; return result;
        }
        return execute();
      });
      return runner;
    });
    const first = Promise.resolve(send());
    let changer: QueryRunner | undefined, changed: Promise<unknown> | undefined;
    try {
      await Promise.race([paused, first.then(res => { throw new Error(`활성수신자확인에 도달하지 않음: HTTP ${res.status}`); })]);
      changer = create(); await changer.connect();
      const [{ pid }] = await changer.query('SELECT pg_backend_pid() AS pid') as { pid: number }[];
      let done = false;
      changed = changer.query('UPDATE staff SET active=false WHERE id=$1', [A]).then(result => { done = true; return result; });
      let blocked = false; const until = Date.now() + 4000;
      while (!blocked && !done) {
        [{ blocked }] = await sql<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid]);
        if (Date.now() > until) throw new Error('수신 STAFF 잠금 대기 관측 시간 초과');
      }
      release(); const res = await first; await changed;
      expect({ status: res.status, blocked }).toEqual({ status: 200, blocked: true });
      expect(await sql('SELECT active FROM staff WHERE id=$1', [A])).toEqual([{ active: false }]);
      expect((await hist()).map(h => h.action)).toEqual(['guide_send']);
    } finally {
      release(); await Promise.allSettled([first, ...(changed ? [changed] : [])]);
      if (changer && !changer.isReleased) await changer.release();
      spy.mockRestore();
    }
  });
});
