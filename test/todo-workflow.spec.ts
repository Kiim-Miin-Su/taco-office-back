/** @file-guide
 * 목적: §64 운영 할 일의 완료·기한 입력을 HTTP→권한→TODO/LOG→목록까지 검증한다.
 * 책임/재사용: 실제 AppModule/ValidationPipe와 로컬 DB를 사용하고 전용 사용자·할 일만 정리한다.
 * 검증/작업 지침: docs/sprint/evidence/TBO-52/s2-ops-todos/plan.md · docs/AGENT.md
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DrawerService } from '../src/modules/drawer/drawer.service';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('§64 할 일 완료·기한 HTTP/DB 정합성 (S2-b)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const CEO = 29981;
  const TEACHER = 29982;
  const OTHER = 29983;
  const OWNER = 29984;
  const actors = [CEO, TEACHER, OTHER, OWNER];
  const tokens = new Map<number, string>();
  const todoIds: number[] = [];
  let id: number;
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params) as Promise<T[]>;
  const api = (method: 'get' | 'post' | 'patch', path: string, actor = CEO) =>
    request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${tokens.get(actor)}`).timeout({ response: 10000, deadline: 20000 });
  const row = () => q(`SELECT title, done, to_id, from_id, src, mt_id, cpl_id, cons_id, plan_id, ser_id, to_char(on_date,'YYYY-MM-DD') AS on_date, created_at, to_char(due_on,'YYYY-MM-DD') AS due_on FROM todo WHERE id=$1`, [id]);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);
    const hash = await bcrypt.hash('todo-workflow-1234', 4);
    await q(`INSERT INTO staff (id,name,email,role,password_hash,active) VALUES
      ($1,'S2대표','s2todo-ceo@t.kr','ceo',$5,true),
      ($2,'S2동명이인','s2todo-teacher@t.kr','teacher',$5,true),
      ($3,'S2타인','s2todo-other@t.kr','teacher',$5,true),
      ($4,'S2동명이인','s2todo-owner@t.kr','manager',$5,true)`, [...actors, hash]);
    for (const [actor, email] of [[CEO, 'ceo'], [TEACHER, 'teacher'], [OTHER, 'other'], [OWNER, 'owner']] as const) {
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email: `s2todo-${email}@t.kr`, password: 'todo-workflow-1234' }).expect(201);
      tokens.set(actor, res.body.accessToken as string);
    }
  });
  beforeEach(async () => {
    const made = await api('post', '/drawer/todos').send({ title: 'S2 기한 검증', toId: TEACHER, dueOn: '2026-09-23' }).expect(201);
    id = Number(made.body.id);
    todoIds.push(id);
  });
  afterEach(async () => {
    await q(`DELETE FROM log WHERE entity='TODO' AND entity_id=ANY($1::bigint[])`, [todoIds]);
    await q(`DELETE FROM todo WHERE id=ANY($1::bigint[])`, [todoIds]);
    todoIds.length = 0;
  });
  afterAll(async () => {
    if (ds?.isInitialized) await q(`DELETE FROM staff WHERE id=ANY($1::bigint[])`, [actors]);
    if (app) await app.close();
  });

  it('기한 변경과 null 삭제가 새 DB 조회·운영·서랍에 같고 나머지 칸은 보존된다', async () => {
    const [before] = await row();
    await api('patch', `/drawer/todos/${id}`).send({ dueOn: '2026-09-28' }).expect(200, { ok: true });
    expect(await row()).toEqual([{ ...before, due_on: '2026-09-28' }]);
    for (const path of ['/ops', '/drawer']) {
      const res = await api('get', path).expect(200);
      expect(res.body.todos.find((t: { id: number }) => t.id === id)).toMatchObject({ dueOn: '2026-09-28', done: false, toId: TEACHER });
    }
    await api('patch', `/drawer/todos/${id}`).send({ dueOn: null }).expect(200);
    expect(await row()).toEqual([{ ...before, due_on: null }]);
    expect(await q(`SELECT actor_id, before, after FROM log WHERE entity='TODO' AND entity_id=$1 ORDER BY id`, [id])).toEqual([
      { actor_id: String(CEO), before: { done: false, dueOn: '2026-09-23' }, after: { done: false, dueOn: '2026-09-28' } },
      { actor_id: String(CEO), before: { done: false, dueOn: '2026-09-28' }, after: { done: false, dueOn: null } },
    ]);
  });

  it('done-only는 기존 발신자/수신자 권한과 기한을 보존하고 타인은404다', async () => {
    await api('patch', `/drawer/todos/${id}`, TEACHER).send({ done: true }).expect(200);
    await api('patch', `/drawer/todos/${id}`, OTHER).send({ done: false }).expect(404);
    expect((await row())[0]).toMatchObject({ done: true, due_on: '2026-09-23' });
    await api('patch', `/drawer/todos/${id}`).send({ done: false }).expect(200);
    // 생성한 강사가 다른 담당자에게 준 기존 행도 완료 가능하다.
    await q(`UPDATE todo SET from_id=$2,to_id=$3 WHERE id=$1`, [id, TEACHER, OWNER]);
    await api('patch', `/drawer/todos/${id}`, TEACHER).send({ done: true }).expect(200);
  });

  it.each(['2026-09-25', null])('강사의 기한 %s와 혼합 요청은403이며 done/날짜/LOG가 전부 불변이다', async (dueOn) => {
    const before = await row();
    await api('patch', `/drawer/todos/${id}`, TEACHER).send({ dueOn }).expect(403);
    await api('patch', `/drawer/todos/${id}`, TEACHER).send({ done: true, dueOn }).expect(403);
    expect(await row()).toEqual(before);
    expect(await q(`SELECT id FROM log WHERE entity='TODO' AND entity_id=$1`, [id])).toEqual([]);
  });

  it('관리자는 혼합 요청을 한 기록으로 저장하고 동일 값 재전송은 추가 LOG를 남기지 않는다', async () => {
    const body = { done: true, dueOn: '2026-09-29' };
    await api('patch', `/drawer/todos/${id}`).send(body).expect(200);
    await api('patch', `/drawer/todos/${id}`).send(body).expect(200);
    expect((await row())[0]).toMatchObject({ done: true, due_on: body.dueOn });
    expect(await q(`SELECT before,after FROM log WHERE entity='TODO' AND entity_id=$1`, [id])).toEqual([
      { before: { done: false, dueOn: '2026-09-23' }, after: body },
    ]);
  });

  it.each([
    { dueOn: '' }, { dueOn: '2026-02-30' }, { dueOn: '2025-02-29' }, { dueOn: '0000-01-01' },
    { dueOn: '2026-09-23T00:00:00Z' }, { dueOn: 20260923 }, { dueOn: [] },
    { done: null }, { done: 'true' }, { done: 1 },
    { title: '새 제목' }, { toId: OWNER }, { src: 'manual' }, { serId: 1 }, { fromId: OTHER },
    { done: true, dueOn: '2026-02-30' },
  ])('잘못된 본문 %j은400이며 저장되지 않는다', async (body) => {
    const before = await row();
    await api('patch', `/drawer/todos/${id}`).send(body).expect(400);
    expect(await row()).toEqual(before);
  });

  it.each(['0', '-1', '1.5', '1e3', '0x10', '9007199254740992', '1 OR 1=1'])('경로 %s는 안전한 양의 정수만 허용한다', async (key) => {
    await api('patch', `/drawer/todos/${encodeURIComponent(key)}`).send({ done: true }).expect(400);
    expect((await row())[0]).toMatchObject({ done: false });
  });

  it('빈 수정409, 삭제된 행404이고 잘못된 생성 기한도400이다', async () => {
    await api('patch', `/drawer/todos/${id}`).send({}).expect(409);
    await q(`DELETE FROM todo WHERE id=$1`, [id]);
    await api('patch', `/drawer/todos/${id}`).send({ dueOn: null }).expect(404);
    await api('post', '/drawer/todos').send({ title: '유효하지 않음', dueOn: '2026-02-30' }).expect(400);
  });

  it('연결 수업이 있는 할 일의 기한 변경은 출처·연결 회차·작성 시각을 보존한다', async () => {
    const [occ] = await q<{ ser_id: string; on_date: string }>(`SELECT ser_id,to_char(on_date,'YYYY-MM-DD') AS on_date FROM ser_occ ORDER BY ser_id,on_date LIMIT 1`);
    expect(occ).toBeDefined();
    await q(`UPDATE todo SET src='lesson',ser_id=$2,on_date=$3::date WHERE id=$1`, [id, occ.ser_id, occ.on_date]);
    const [before] = await row();
    await api('patch', `/drawer/todos/${id}`).send({ dueOn: null }).expect(200);
    expect(await row()).toEqual([{ ...before, due_on: null }]);
  });

  it('기한 저장 뒤 LOG의 NOT NULL 위반이 나면 실제 TODO UPDATE도 rollback한다', async () => {
    const before = await row();
    // HTTP에서는 인증된 actor만 온다. 여기서는 LOG 저장 장애를 실제 DB 제약으로 주입한다.
    await expect(app.get(DrawerService).patchTodo(id, { done: true, dueOn: null }, null as unknown as number, true))
      .rejects.toMatchObject({ driverError: { code: '23502' } });
    expect(await row()).toEqual(before);
    expect(await q(`SELECT id FROM log WHERE entity='TODO' AND entity_id=$1`, [id])).toEqual([]);
  });

  it.each([false, true])('done과 기한 동시 수정은 서로 덮어쓰지 않는다 (기한 먼저=%s)', async (dateFirst) => {
    const date = () => api('patch', `/drawer/todos/${id}`).send({ dueOn: '2028-02-29' }).expect(200);
    const done = () => api('patch', `/drawer/todos/${id}`, TEACHER).send({ done: true }).expect(200);
    await Promise.all(dateFirst ? [date(), done()] : [done(), date()]);
    expect((await row())[0]).toMatchObject({ done: true, due_on: '2028-02-29' });
  });

  it('기한을 기간 밖으로 옮기면 운영 조회에서 빠지고 null로 지우면 다시 나타난다', async () => {
    const path = '/ops?from=2026-09-01&to=2026-09-30';
    await api('patch', `/drawer/todos/${id}`).send({ dueOn: '2026-10-01' }).expect(200);
    expect((await api('get', path).expect(200)).body.todos.some((t: { id: number }) => t.id === id)).toBe(false);
    expect((await row())[0]).toMatchObject({ due_on: '2026-10-01' });
    await api('patch', `/drawer/todos/${id}`).send({ dueOn: null }).expect(200);
    expect((await api('get', path).expect(200)).body.todos.find((t: { id: number }) => t.id === id)).toMatchObject({ dueOn: null });
  });

  it('기한 없는 행은 기간 필터 뒤에도 남고 동명이인 담당·완료 집계는 ID로 갈린다', async () => {
    await q(`UPDATE todo SET due_on=null WHERE id=$1`, [id]);
    for (const [toId, done] of [[OWNER, false], [OWNER, true], [null, true]] as const) {
      const [made] = await q<{ id: string }>(`INSERT INTO todo (title,from_id,to_id,done,src) VALUES ('S2 출처 보존',$1,$2,$3,'lesson') RETURNING id`, [CEO, toId, done]);
      todoIds.push(Number(made.id));
    }
    const out = (await api('get', '/ops?from=2030-01-01&to=2030-01-01').expect(200)).body;
    expect(out.todos.find((t: { id: number }) => t.id === id)).toMatchObject({ toId: TEACHER, fromName: 'S2대표', srcLabel: '직접 등록', dueOn: null });
    expect(out.todos.find((t: { id: number }) => t.id === todoIds[1])).toMatchObject({ src: 'lesson', srcLabel: '수업' });
    expect(out.todoOwnerCounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: String(TEACHER), count: 1 }),
      expect.objectContaining({ key: String(OWNER), count: 1 }),
    ]));
    expect(out.todoDoneOwnerCounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: String(OWNER), count: 1 }),
      expect.objectContaining({ key: '__none__' }),
    ]));
    expect(out.todoOwnerCounts.reduce((n: number, c: { count: number }) => n + c.count, 0)).toBe(out.todos.filter((t: { done: boolean }) => !t.done).length);
    expect(out.todoDoneOwnerCounts.reduce((n: number, c: { count: number }) => n + c.count, 0)).toBe(out.todos.filter((t: { done: boolean }) => t.done).length);
  });
});
