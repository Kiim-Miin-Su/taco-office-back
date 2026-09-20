/** @file-guide
 * 목적: perm-sidedoor-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * **S4 — 권한 옆문 넷** (2026-09-20 전수 검수 §3).
 *
 * 넷 다 「권한이 **없는** 것」이 아니라 「같은 규칙이 **한 곳에만** 있었던 것」이다. 그래서 회귀도
 * 한 자리만 보지 않고 **같은 규칙을 쓰는 다른 경로와 나란히** 둔다 — 다음에 경로가 하나 더 생겨도
 * 여기서 걸린다.
 *
 * ① 「+ 구성원」의 시급이 `canWage` 를 안 봤다 — `insertWage` 를 타는 다른 두 경로는 전부 요구한다.
 * ② 「끝난 것 지우기」가 `canCrudAll` 이면 **전사 하드 삭제**였다 — 화면은 보이는 것만 세는데.
 * ③ 컨설팅 **비공개 「지정」**이 `canHide` 없이 됐다 — §76 은 지정·열람 **둘 다** 대표 전용이라 적는다.
 * ④ 회의 할 일이 **그만둔 사람**에게 배정됐다 — 같은 파일의 다른 모든 경로는 `activeStaff` 를 쓴다.
 *
 * 실제 HTTP(가드 · DTO · 트랜잭션)와 격리 DB 로 돈다. 이 스위트 전용 staff 971~975 · stu 9971 을 쓴다.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('S4 권한 옆문 넷 — 같은 규칙이 한 곳에만 있던 자리', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceo = '';
  let mgr = '';
  let noWage = '';
  const PW = 'sidedoor-1234';
  const CEO = 971;
  const MGR = 972;       // 매니저 — 역할 파생으로 canWage true · canHide false
  const NOWAGE = 973;    // 매니저인데 can_wage=false 예외
  const TEACHER = 974;
  const RETIRED = 975;   // active=false
  const STU = 9971;
  const ids = [CEO, MGR, NOWAGE, TEACHER, RETIRED];
  const NEW_EMAIL = 'sidedoor-new@t.kr';
  let mtId = 0;
  const consIds: number[] = [];

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const api = (m: 'get' | 'post' | 'patch' | 'delete', url: string, token = ceo) =>
    (request(app.getHttpServer()) as unknown as Record<string, (u: string) => request.Test>)[m](url)
      .timeout({ response: 8000, deadline: 15000 })
      .set('Authorization', `Bearer ${token}`);

  const dropNewStaff = async () => {
    const rows = await q<{ id: string }>(`SELECT id FROM staff WHERE lower(email) = $1`, [NEW_EMAIL]);
    for (const r of rows) {
      await q(`DELETE FROM wage WHERE staff_id = $1`, [r.id]);
      await q(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = $1`, [r.id]);
      await q(`DELETE FROM staff WHERE id = $1`, [r.id]);
    }
  };

  const dropOwn = async () => {
    if (consIds.length) {
      await q(`DELETE FROM cons_event WHERE cons_id = ANY($1)`, [consIds]);
      await q(`DELETE FROM cons_item WHERE cons_id = ANY($1)`, [consIds]);
      await q(`DELETE FROM cons_pick WHERE cons_id = ANY($1)`, [consIds]);
      await q(`DELETE FROM cons_stu WHERE cons_id = ANY($1)`, [consIds]);
      await q(`DELETE FROM cons WHERE id = ANY($1)`, [consIds]);
      consIds.length = 0;
    }
    if (mtId) {
      await q(`DELETE FROM todo WHERE mt_id = $1`, [mtId]);
      await q(`DELETE FROM mtattd WHERE mt_id = $1`, [mtId]);
      await q(`DELETE FROM mtrec WHERE id = $1`, [mtId]);
      mtId = 0;
    }
    await q(`DELETE FROM todo WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [ids]);
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await dropNewStaff();
    await q(`DELETE FROM todo WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [ids]);
    await q(`DELETE FROM wage WHERE staff_id = ANY($1)`, [ids]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active, can_wage) VALUES
         ($1,'옆문대표','sd-ceo@t.kr','ceo',$6,true,NULL),
         ($2,'옆문매니저','sd-m@t.kr','manager',$6,true,NULL),
         ($3,'시급없는매니저','sd-nw@t.kr','manager',$6,true,false),
         ($4,'옆문강사','sd-t@t.kr','teacher',$6,true,NULL),
         ($5,'그만둔사람','sd-r@t.kr','teacher',$6,false,NULL)`,
      [CEO, MGR, NOWAGE, TEACHER, RETIRED, hash],
    );
    await q(`DELETE FROM stu WHERE id = $1`, [STU]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'옆문학생','10')`, [STU]);
    await q(`INSERT INTO tzg (id, name, tz) VALUES (1,'한국 (KST)','Asia/Seoul') ON CONFLICT (id) DO NOTHING`);

    const login = async (email: string) =>
      (await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ email, password: PW }).expect(201)).body.accessToken as string;
    ceo = await login('sd-ceo@t.kr');
    mgr = await login('sd-m@t.kr');
    noWage = await login('sd-nw@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await dropOwn();
        await dropNewStaff();
        await q(`DELETE FROM wage WHERE staff_id = ANY($1)`, [ids]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
        await q(`DELETE FROM stu WHERE id = $1`, [STU]);
      }
    } finally {
      await app?.close();
    }
  });

  /* ── ① 구성원 추가의 시급 ─────────────────────────────────────────── */

  it('① 시급 예외가 걸린 매니저는 「+ 구성원」으로도 시급을 못 세운다 — 만들기 자체는 막지 않는다', async () => {
    const base = { name: '새강사', email: NEW_EMAIL, password: 'sidedoor-new-1', role: 'teacher' as const };

    // 시급을 적으면 403 — 그리고 **아무것도 남지 않는다**(구성원도 안 생긴다)
    const blocked = await api('post', '/drawer/staff', noWage).send({ ...base, wageRate: 50000 }).expect(403);
    expect(blocked.body.code).toBe('WAGE_SET_FORBIDDEN');
    expect(await q(`SELECT id FROM staff WHERE lower(email) = $1`, [NEW_EMAIL])).toEqual([]);

    // 시급을 비우면 같은 사람이 그대로 만든다 — 막는 것은 시급 칸 하나다
    const made = await api('post', '/drawer/staff', noWage).send(base).expect(201);
    expect(made.body.wageRate).toBeNull();
    const newId = Number(made.body.id);
    expect(await q(`SELECT id FROM wage WHERE staff_id = $1`, [newId])).toEqual([]);

    // 시급을 다룰 수 있는 매니저는 그대로 세운다 — 권한이 있는 길은 안 막혔다
    await q(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = $1`, [newId]);
    await q(`DELETE FROM staff WHERE id = $1`, [newId]);
    const ok = await api('post', '/drawer/staff', mgr).send({ ...base, wageRate: 50000 }).expect(201);
    expect(ok.body.wageRate).toBe(50000);
    expect((await q(`SELECT rate FROM wage WHERE staff_id = $1`, [Number(ok.body.id)])).length).toBe(1);
  });

  /* ── ② 끝난 것 지우기 ─────────────────────────────────────────────── */

  it('② 「끝난 것 지우기」는 화면이 보낸 줄만 지운다 — 남의 것·안 보낸 것은 남고, 지운 줄은 log 에 남는다', async () => {
    const rows = await q<{ id: string }>(
      `INSERT INTO todo (title, from_id, to_id, done, src) VALUES
         ('보낸 것 · 내 것', $1, $1, true, 'manual'),
         ('안 보낸 것 · 내 것', $1, $1, true, 'manual'),
         ('남의 끝난 것', $2, $2, true, 'manual'),
         ('아직 안 끝난 것', $1, $1, false, 'manual')
       RETURNING id`,
      [MGR, TEACHER],
    );
    const [sent, kept, other, open] = rows.map((r) => Number(r.id));

    // 화면이 세고 있는 그 줄 + **끝나지 않은 줄**을 같이 보내도 끝난 것만 지워진다
    const res = await api('delete', '/drawer/todos/completed', mgr).send({ ids: [sent, open] }).expect(200);
    expect(res.body.deleted).toBe(1);

    const left = (await q<{ id: string }>(`SELECT id FROM todo WHERE id = ANY($1) ORDER BY id`, [[sent, kept, other, open]]))
      .map((r) => Number(r.id));
    // 안 보낸 내 것 · 남의 끝난 것 · 안 끝난 것은 그대로다 — 전사 삭제였다면 셋 중 둘이 사라졌다
    expect(left).toEqual([kept, other, open].sort((a, b) => a - b));

    // 하드 삭제라 지운 뒤에는 무엇이 있었는지 아무도 모른다 — 그래서 통째로 적는다
    const [log] = await q<{ before: Array<{ id: number; title: string }> }>(
      `SELECT before FROM log WHERE actor_id = $1 AND entity = 'TODO' AND action = 'clear' ORDER BY id DESC LIMIT 1`, [MGR],
    );
    expect(log.before.map((x) => x.title)).toEqual(['보낸 것 · 내 것']);

    // 남의 것도 **보내면** 지워진다(전체 탭에서 보인다) — 다만 보낸 것만이다
    const res2 = await api('delete', '/drawer/todos/completed', mgr).send({ ids: [other] }).expect(200);
    expect(res2.body.deleted).toBe(1);
    expect(await q(`SELECT id FROM todo WHERE id = $1`, [other])).toEqual([]);
  });

  it('② 빈 목록은 DTO 가 막는다 — 「전부」라는 뜻으로 읽히면 안 된다', async () => {
    await api('delete', '/drawer/todos/completed', mgr).send({ ids: [] }).expect(400);
  });

  /* ── ③ 컨설팅 비공개 「지정」 ──────────────────────────────────────── */

  const consBody = (share: string) => ({
    consType: 'admissions', studentIds: [STU], requester: 'mother',
    ownerId: CEO, amount: 100000, sessions: 1, startOn: '2026-09-01', endOn: '2026-12-31', share,
  });

  it('③ 비공개 지정은 대표만 — 매니저는 403 이고 아무것도 남지 않는다 (§76)', async () => {
    const blocked = await api('post', '/consulting', mgr).send({ ...consBody('private'), ownerId: MGR }).expect(403);
    expect(blocked.body.code).toBe('CONS_PRIVATE_FORBIDDEN');
    expect(await q(`SELECT id FROM cons WHERE share = 'private' AND owner_id = $1`, [MGR])).toEqual([]);

    // 다른 범위는 그대로 만든다 — 막는 것은 「비공개 지정」 하나다
    const open = await api('post', '/consulting', mgr).send({ ...consBody('all'), ownerId: MGR }).expect(201);
    consIds.push(Number(open.body.id));

    // 만든 뒤 비공개로 바꾸는 길도 같은 문을 지난다
    const moved = await api('patch', `/consulting/${open.body.id}/share`, mgr).send({ share: 'private' }).expect(403);
    expect(moved.body.code).toBe('CONS_PRIVATE_FORBIDDEN');
    expect((await q<{ share: string }>(`SELECT share FROM cons WHERE id = $1`, [Number(open.body.id)]))[0].share).toBe('all');

    // 대표는 그대로 지정한다
    const ceoMade = await api('post', '/consulting', ceo).send(consBody('private')).expect(201);
    consIds.push(Number(ceoMade.body.id));
    expect(ceoMade.body.share).toBe('private');
  });

  it('③ 단추도 같은 질문을 한다 — canSetPrivate 은 목록과 상세 둘 다에서 canHide 다 (D-R39)', async () => {
    const mine = await api('post', '/consulting', mgr).send({ ...consBody('all'), ownerId: MGR }).expect(201);
    consIds.push(Number(mine.body.id));
    expect(mine.body.capabilities.canSetPrivate).toBe(false);
    expect(mine.body.capabilities.canChangeShare).toBe(true); // 범위를 바꾸는 것과는 다른 층이다

    expect((await api('get', '/consulting', mgr).expect(200)).body.canSetPrivate).toBe(false);
    expect((await api('get', '/consulting', ceo).expect(200)).body.canSetPrivate).toBe(true);
  });

  /* ── ④ 회의 할 일은 활성 구성원에게만 ─────────────────────────────── */

  it('④ 그만둔 사람에게는 회의 할 일이 배정되지 않는다 — 할 일도 알림도 안 남는다', async () => {
    const [made] = await q<{ id: string }>(
      `INSERT INTO mtrec (mt_type, title, on_date) VALUES ('general','옆문 회의', CURRENT_DATE) RETURNING id`,
    );
    mtId = Number(made.id);

    await api('post', `/ops/meetings/${mtId}/todos`, ceo).send({ title: '그만둔 사람에게', toId: RETIRED }).expect(404);
    expect(await q(`SELECT id FROM todo WHERE mt_id = $1`, [mtId])).toEqual([]);
    expect(await q(`SELECT id FROM noti WHERE to_id = $1`, [RETIRED])).toEqual([]);

    // 활성 구성원에게는 그대로 간다 — 할 일과 알림이 한 트랜잭션이다 (D-R43)
    const ok = await api('post', `/ops/meetings/${mtId}/todos`, ceo).send({ title: '활성에게', toId: TEACHER }).expect(201);
    expect(ok.body.tasks.map((t: { title: string }) => t.title)).toEqual(['활성에게']);
    expect((await q(`SELECT id FROM noti WHERE to_id = $1`, [TEACHER])).length).toBe(1);
  });
});
