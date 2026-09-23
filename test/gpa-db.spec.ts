/** @file-guide
 * 목적: GPA 잔여/사이클 및 선택 기록지 URL의 실제 HTTP·권한·DB 계약 회귀 (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource, QueryRunner } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { GpaUseCreateDto } from '../src/modules/gpa/gpa.dto';
import { dataSourceOptions } from '../src/data-source';
import { GpaCycle } from '../src/entities';
import { GpaService } from '../src/modules/gpa/gpa.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('§4.5·§82 GPA 4표 — 잔여 계산과 사이클 잠금 (N-13 채택 · C34)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let cycleId: number;

  const svc = () => new GpaService(q.manager.getRepository(GpaCycle));

  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES (41,'코디','gpa41@t.kr','manager') ON CONFLICT (id) DO NOTHING`);
    // 승인자는 기록자와 다른 사람이어야 한다 (S1 자기 승인 금지 · gpa_use_no_self_approve)
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES (43,'승인자','gpa43@t.kr','manager') ON CONFLICT (id) DO NOTHING`);
    await q.query(`INSERT INTO stu (id,name) VALUES (91,'지파일'),(92,'지파이') ON CONFLICT (id) DO NOTHING`);
    await q.query(`INSERT INTO gpasvc (key,name,point,sort) VALUES ('hw','숙제 지원',1,1),('test','Test 대비',4,4)
                   ON CONFLICT (key) DO NOTHING`);
    const [cy] = await q.query(
      `INSERT INTO gpa_cycle (no, from_date, to_date) VALUES (7, '2026-10-05', '2026-11-01') RETURNING id`) as { id: string }[];
    cycleId = Number(cy.id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('잔여 = 배정 − 사용(ok) − 대기(wait) 를 서버가 계산하고 초과는 over 로 붉게 안내한다', async () => {
    await q.query(`INSERT INTO gpa_alloc (cycle_id,student_id,coord_id,points) VALUES ($1,91,41,8)`, [cycleId]);
    await q.query(`INSERT INTO gpa_use (cycle_id,student_id,svc_key,points,on_date,coord_id,state)
                   VALUES ($1,91,'test',4,'2026-10-07',41,'ok'), ($1,91,'hw',1,'2026-10-08',41,'wait'),
                          ($1,92,'test',4,'2026-10-09',41,'ok')`, [cycleId]);
    const b = await svc().board('2026-10-10');
    expect(b.cycle).toMatchObject({ no: 7, closed: false });
    const s91 = b.students.find((s) => s.studentId === 91)!;
    expect(s91).toMatchObject({ alloc: 8, used: 4, wait: 1, remain: 3, over: false });
    // 배정 없이 소비만 있는 학생도 보드에 보인다 — 숨기면 초과를 못 본다
    const s92 = b.students.find((s) => s.studentId === 92)!;
    expect(s92).toMatchObject({ alloc: 0, used: 4, remain: -4, over: true });
    expect(b.totalAlloc).toBe(8);
    expect(b.totalRemain).toBe(-1);
    expect(b.uses.map((u) => u.onDate)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
  });

  /**
   * 원본 §82 의 머리와 학생 카드 — C86-c.
   * 「N회 진행」과 카드의 서비스 칩은 **서버가 센다**. 화면이 `uses` 를 다시 훑으면
   * 「남은 9p」와 칩의 합이 갈린다 (D-R37 · N-19).
   */
  it('머리의 「N회 진행」은 승인 대기도 센다 — 기록이 있다는 것은 회차가 있었다는 뜻이다', async () => {
    await q.query(`INSERT INTO gpa_alloc (cycle_id,student_id,coord_id,points) VALUES ($1,91,41,10)`, [cycleId]);
    await q.query(`INSERT INTO gpa_use (cycle_id,student_id,svc_key,points,on_date,coord_id,state)
                   VALUES ($1,91,'hw',1,'2026-10-06',41,'ok'), ($1,91,'hw',1,'2026-10-07',41,'wait')`, [cycleId]);
    const b = await svc().board('2026-10-10');
    expect(b.totalUses).toBe(2);
    expect(b.totalUsed).toBe(1);
    expect(b.totalWait).toBe(1);
  });

  it('카드의 서비스 칩은 회수·포인트 합이고 규정 순서를 따르며 0 인 갈래는 없다', async () => {
    await q.query(`INSERT INTO gpa_alloc (cycle_id,student_id,coord_id,points) VALUES ($1,91,41,12)`, [cycleId]);
    await q.query(`INSERT INTO gpa_use (cycle_id,student_id,svc_key,points,on_date,coord_id,state)
                   VALUES ($1,91,'hw',1,'2026-10-06',41,'ok'), ($1,91,'hw',1,'2026-10-07',41,'ok'),
                          ($1,91,'test',4,'2026-10-08',41,'wait')`, [cycleId]);
    const b = await svc().board('2026-10-10');
    const s91 = b.students.find((s) => s.studentId === 91)!;
    // 승인 대기도 센다 — 잔여에서 이미 빠졌으므로 칩에서만 빼면 두 수가 갈린다
    expect(s91.svcs.map((v) => [v.key, v.count, v.points])).toEqual([['hw', 2, 2], ['test', 1, 4]]);
    expect(s91.svcs.reduce((a, v) => a + v.points, 0)).toBe(s91.used + s91.wait);
    expect(b.students.find((s) => s.studentId === 92)?.svcs ?? []).toEqual([]);
  });

  it('학생은 **잔여 적은 순**이다 — 초과가 맨 앞에 온다 (원본 §82 머리)', async () => {
    await q.query(`INSERT INTO gpa_alloc (cycle_id,student_id,coord_id,points)
                   VALUES ($1,91,41,12), ($1,92,41,2)`, [cycleId]);
    await q.query(`INSERT INTO gpa_use (cycle_id,student_id,svc_key,points,on_date,coord_id,state)
                   VALUES ($1,92,'test',4,'2026-10-08',41,'ok')`, [cycleId]);
    const b = await svc().board('2026-10-10');
    expect(b.students.map((s) => [s.studentId, s.remain])).toEqual([[92, -2], [91, 12]]);
  });

  it('기록은 wait 로 들어가고 포인트는 규정 스냅샷이다 — 규정이 바뀌어도 과거는 그대로', async () => {
    const made = await svc().createUse(41, { cycleId, studentId: 91, svcKey: 'test', onDate: '2026-10-06' });
    expect(made).toMatchObject({ state: 'wait', points: 4, coordName: '코디' });
    await q.query(`UPDATE gpasvc SET point = 9 WHERE key = 'test'`);
    const b = await svc().board('2026-10-06');
    expect(b.uses[0].points).toBe(4);
  });

  it('사이클 창 밖 날짜는 OUT_OF_CYCLE, 닫힌 사이클은 CYCLE_CLOSED 로 전부 잠긴다', async () => {
    await expect(svc().createUse(41, { cycleId, studentId: 91, svcKey: 'hw', onDate: '2026-11-02' }))
      .rejects.toMatchObject({ response: { code: 'OUT_OF_CYCLE' } });
    await q.query(`UPDATE gpa_cycle SET closed = true WHERE id = $1`, [cycleId]);
    await expect(svc().createUse(41, { cycleId, studentId: 91, svcKey: 'hw', onDate: '2026-10-06' }))
      .rejects.toMatchObject({ response: { code: 'CYCLE_CLOSED' } });
    await expect(svc().putAlloc(41, { cycleId, studentId: 91, points: 5 }))
      .rejects.toMatchObject({ response: { code: 'CYCLE_CLOSED' } });
  });

  it('승인·되돌림이 잔여에 그대로 반영되고, 승인분 삭제는 USE_APPROVED 로 거절된다', async () => {
    await q.query(`INSERT INTO gpa_alloc (cycle_id,student_id,coord_id,points) VALUES ($1,91,41,8)`, [cycleId]);
    const made = await svc().createUse(41, { cycleId, studentId: 91, svcKey: 'test', onDate: '2026-10-06' });
    const ok = await svc().setUseState(made.id, 43, { state: 'ok' });
    expect(ok).toMatchObject({ state: 'ok', approvedByName: '승인자' });
    await expect(svc().deleteUse(made.id, 43)).rejects.toMatchObject({ response: { code: 'USE_APPROVED' } });
    const back = await svc().setUseState(made.id, 43, { state: 'wait' });
    expect(back.state).toBe('wait');
    // 되돌리면 도장도 지워진다 — 승인자가 남아 있으면 거짓말이 된다
    expect(back.approvedByName).toBeNull();
    await expect(svc().deleteUse(made.id, 43)).resolves.toEqual({ ok: true });
    const b = await svc().board('2026-10-06');
    expect(b.students.find((s) => s.studentId === 91)).toMatchObject({ used: 0, wait: 0, remain: 8 });
  });

  /**
   * ⭐ **대표 결정 2026-09-21 「자기 결재 금지도 함께 푼다」** — S1 이 GPA 사용에 건 자기 결재 금지가 꺼졌다.
   * 켜고 끄는 자리는 `lib/approval.SELF_APPROVAL_GUARDED` 배열 하나이고, **DB 의 `gpa_use_no_self_approve`
   * CHECK 도 마이그레이션 54 가 함께 걷었다** — 판정만 열고 제약을 두면 단추는 서는데 표가 거절한다(S5 결함).
   *
   * 그래서 시험도 **자리를 그대로 두고 답만 뒤집는다**: 적은 사람이 스스로 승인해도 통과하고,
   * **도장은 그대로 남는다**(누가 승인했는지는 여전히 행에 적힌다 — 그것은 자기 결재 금지와 다른 일이다).
   */
  it('⭐ 기록한 사람도 자기 기록을 승인한다 — 도장은 그대로 남는다 (대표 결정 2026-09-21 · 원문 S1 은 금지)', async () => {
    const made = await svc().createUse(41, { cycleId, studentId: 91, svcKey: 'hw', onDate: '2026-10-06' });
    const self = await svc().setUseState(made.id, 41, { state: 'ok' });
    expect(self).toMatchObject({ state: 'ok', approvedByName: '코디', coordName: '코디' });
    expect(self.approvedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 표도 더 이상 막지 않는다 — 판정과 제약이 같이 움직였다 (마이그레이션 54 가 CHECK 를 걷었다).
    // 한쪽만 열면 단추는 서는데 표가 거절한다 — 그래서 직접 SQL 로 한 번 더 확인한다.
    await q.query(`UPDATE gpa_use SET approved_by = 41 WHERE id = $1`, [made.id]);

    // 되돌림은 그대로 자기도 한다 — 승인이 아니라 취소다
    await expect(svc().setUseState(made.id, 41, { state: 'wait' })).resolves.toMatchObject({ state: 'wait' });
    // 남이 승인하는 길도 그대로다
    const ok = await svc().setUseState(made.id, 43, { state: 'ok' });
    expect(ok).toMatchObject({ state: 'ok', approvedByName: '승인자', coordName: '코디' });
  });

  /**
   * **단추가 열리는지도 서버가 정한다** — 화면은 `canApprove` 한 줄만 읽는다 (D-R39). 그 규약은 그대로고,
   * 대표 결정 2026-09-21 로 **자기 기록에도 단추가 선다**(쓰기가 실제로 통과하므로 그래야 한다 —
   * 닫아 두면 「서버는 받는데 단추가 없는」 반대 방향의 S5 결함이 된다).
   */
  it('승인 단추는 서버가 연다 — 이제 기록한 사람에게도 열리고, 쓰기와 같은 답이다 (D-R39)', async () => {
    const made = await svc().createUse(41, { cycleId, studentId: 91, svcKey: 'hw', onDate: '2026-10-06' });
    expect(made.canApprove).toBe(true); // 방금 적은 사람에게도 열린다

    const rowFor = async (viewerId?: number) =>
      (await svc().board('2026-10-06', viewerId)).uses.find((u) => u.id === made.id)!;
    expect((await rowFor(41)).canApprove).toBe(true);
    expect((await rowFor(43)).canApprove).toBe(true);
    // **보는 사람을 모르면 여전히 닫는다** — 자기 결재 금지와 별개의 규약이다(모르는 쪽으로 열면
    // 그 자리가 다음 불일치가 된다). 컨트롤러는 언제나 채워 보내고, 되돌릴 때 이 줄이 다시 경계가 된다.
    expect((await rowFor()).canApprove).toBe(false);

    // 승인되고 나면 더 승인할 것이 없다 — 상태가 가르는 것은 그대로다
    await svc().setUseState(made.id, 43, { state: 'ok' });
    expect((await rowFor(43)).canApprove).toBe(false);
  });

  it('배정 upsert — (사이클, 학생) 하나·0 은 회수, DB UNIQUE 가 이중 배정을 막는다', async () => {
    const a1 = await svc().putAlloc(41, { cycleId, studentId: 91, points: 12 });
    expect(a1).toMatchObject({ alloc: 12, remain: 12, coordName: '코디' });
    const a2 = await svc().putAlloc(41, { cycleId, studentId: 91, points: 0 });
    expect(a2).toMatchObject({ alloc: 0, remain: 0 });
    await expect(q.query(`INSERT INTO gpa_alloc (cycle_id,student_id,points) VALUES ($1,91,3)`, [cycleId]))
      .rejects.toMatchObject({ message: expect.stringContaining('gpa_alloc_cycle_student') });
  });

  it('state 는 wait|ok 뿐 — DB CHECK 가 직접 INSERT 도 막는다', async () => {
    await expect(q.query(`INSERT INTO gpa_use (cycle_id,student_id,svc_key,points,on_date,state)
                          VALUES ($1,91,'hw',1,'2026-10-06','maybe')`, [cycleId]))
      .rejects.toMatchObject({ message: expect.stringContaining('gpa_use_state_check') });
  });

  it('소비 포인트는 양수다 — DB CHECK', async () => {
    await expect(q.query(`INSERT INTO gpa_use (cycle_id,student_id,svc_key,points,on_date)
                          VALUES ($1,91,'hw',0,'2026-10-06')`, [cycleId]))
      .rejects.toMatchObject({ message: expect.stringContaining('gpa_use_points_check') });
  });

  it('사이클이 하나도 없으면 빈 보드 — 미래 사이클을 임의로 만들지 않는다', async () => {
    await q.query(`DELETE FROM gpa_use`); await q.query(`DELETE FROM gpa_alloc`); await q.query(`DELETE FROM gpa_cycle`);
    const b = await svc().board('2026-10-10');
    expect(b.cycle).toBeNull();
    expect(b.students).toEqual([]);
    expect(b.services.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * C95 · O-150 — 마감이 다음 사이클을 연다. 4주마다 하는 일이 한 번에 끝나야 다음 기록이 막히지 않는다.
   * `closeCycle` 은 제 트랜잭션을 열므로 이 스위트의 러너 트랜잭션 밖에서 돌리고 스스로 치운다 —
   * beforeEach 가 아직 커밋하지 않은 행(staff 41 · stu 91 · gpasvc hw)과 **겹치지 않는 키**만 쓴다(겹치면 그 잠금을 기다리다 멈춘다).
   */
  it('뒤에 사이클이 없으면 마감이 끝날 다음 날부터 4주를 연다 — 도장·소멸 포인트·로그 (O-150)', async () => {
    const outer = new GpaService(ds.getRepository(GpaCycle));
    const made = (await ds.query(`INSERT INTO gpa_cycle (no, from_date, to_date) VALUES (95, '2020-01-06', '2020-02-02') RETURNING id`)) as { id: string }[];
    const id = Number(made[0]!.id);
    await ds.query(`INSERT INTO staff (id,name,email,role) VALUES (42,'마감자','gpa42@t.kr','manager') ON CONFLICT (id) DO NOTHING`);
    await ds.query(`INSERT INTO stu (id,name) VALUES (93,'지파삼') ON CONFLICT (id) DO NOTHING`);
    await ds.query(`INSERT INTO gpasvc (key,name,point,sort) VALUES ('c95','마감 표본',1,9)`);
    let openedId: number | null = null;
    try {
      await ds.query(`INSERT INTO gpa_alloc (cycle_id,student_id,coord_id,points) VALUES ($1,93,42,9)`, [id]);
      await ds.query(`INSERT INTO gpa_use (cycle_id,student_id,svc_key,points,on_date,coord_id,state) VALUES ($1,93,'c95',1,'2020-01-10',42,'ok')`, [id]);
      const r = await outer.closeCycle(42, id);
      openedId = r.opened?.id ?? null;
      expect(r.cycle).toMatchObject({ id, closed: true, closedByName: '마감자', canClose: false });
      expect(r.opened).toMatchObject({ no: 96, from: '2020-02-03', to: '2020-03-01', closed: false });
      expect(r.students).toEqual([{ studentId: 93, name: '지파삼', remain: 8 }]);
      expect(r.expiredPoints).toBe(8);
      await expect(outer.closeCycle(42, id)).rejects.toMatchObject({ response: { code: 'CYCLE_CLOSED' } });
      const logs = (await ds.query(`SELECT action FROM log WHERE entity = 'GPA_CYCLE' AND entity_id = $1`, [id])) as { action: string }[];
      expect(logs.map((l) => l.action)).toEqual(['close']);
    } finally {
      await ds.query(`DELETE FROM log WHERE entity = 'GPA_CYCLE' AND entity_id = $1`, [id]);
      await ds.query(`DELETE FROM gpa_use WHERE cycle_id = $1`, [id]);
      await ds.query(`DELETE FROM gpa_alloc WHERE cycle_id = $1`, [id]);
      await ds.query(`DELETE FROM gpa_cycle WHERE id = ANY($1)`, [[id, ...(openedId ? [openedId] : [])]]);
      await ds.query(`DELETE FROM stu WHERE id = 93`);
      await ds.query(`DELETE FROM staff WHERE id = 42`);
      await ds.query(`DELETE FROM gpasvc WHERE key = 'c95'`);
    }
  });
});


/** S3-c — URL 입력은 실제 HTTP pipe/guard를 지나며 scratch의 소유 행만 정리한다. */
d('S3-c GPA 선택 기록지 URL HTTP·DB', () => {
  let app: INestApplication;
  let ds: DataSource;
  let cycleId: number;
  let ownsService = false;
  let point: number;
  const ADMIN = 29891;
  const TEACHER = 29892;
  const STUDENT = 29891;
  const DAY = '2040-01-10';
  const PASSWORD = 's3c-local-fixture-only';
  const tokens = new Map<number, string>();
  const sql = <T = Record<string, unknown>>(statement: string, params: unknown[] = []): Promise<T[]> =>
    ds.query(statement, params) as Promise<T[]>;
  const http = (method: 'get' | 'post', path: string, actor = ADMIN) =>
    request(app.getHttpServer())[method](path)
      .set('Authorization', `Bearer ${tokens.get(actor)}`)
      .timeout({ response: 10000, deadline: 20000 });
  const valid = () => ({ cycleId, studentId: STUDENT, svcKey: 'hw', onDate: DAY, startMin: 600 });
  const snapshot = async () => ({
    uses: await sql('SELECT * FROM gpa_use WHERE cycle_id=$1 ORDER BY id', [cycleId]),
    allocs: await sql('SELECT * FROM gpa_alloc WHERE cycle_id=$1 ORDER BY id', [cycleId]),
    cycle: await sql('SELECT * FROM gpa_cycle WHERE id=$1', [cycleId]),
    logs: await sql('SELECT * FROM log WHERE actor_id=$1 ORDER BY id', [ADMIN]),
    totals: await sql(`SELECT COALESCE(sum(points) FILTER (WHERE state='ok'),0)::int AS used,
      COALESCE(sum(points) FILTER (WHERE state='wait'),0)::int AS wait FROM gpa_use WHERE cycle_id=$1`, [cycleId]),
  });
  const board = async () => (await http('get', '/gpa').query({ anchor: DAY }).expect(200)).body;
  const accepted = async (noteUrl: unknown) => {
    const before = await board();
    const res = await http('post', '/gpa/uses').send({ ...valid(), noteUrl }).expect(201);
    const expected = typeof noteUrl === 'string' ? noteUrl.trim() || null : null;
    const [stored] = await sql('SELECT note_url,points,state,coord_id FROM gpa_use WHERE id=$1', [res.body.id]);
    const fresh = await board();
    expect(res.body).toMatchObject({ noteUrl: expected, state: 'wait', points: point, studentId: STUDENT });
    expect(stored).toMatchObject({ note_url: expected, state: 'wait', points: point, coord_id: String(ADMIN) });
    expect(fresh.uses.find((u: { id: number }) => u.id === res.body.id)).toMatchObject({ noteUrl: expected, state: 'wait' });
    expect({ uses: fresh.totalUses, alloc: fresh.totalAlloc, used: fresh.totalUsed, wait: fresh.totalWait, remain: fresh.totalRemain })
      .toEqual({ uses: before.totalUses + 1, alloc: before.totalAlloc, used: before.totalUsed, wait: before.totalWait + point, remain: before.totalRemain - point });
  };
  const rejected = async (noteUrl: unknown) => {
    const before = await snapshot();
    const priorBoard = await board();
    const res = await http('post', '/gpa/uses').send({ ...valid(), noteUrl });
    expect({ status: res.status, state: await snapshot() }).toEqual({ status: 400, state: before });
    expect(await board()).toEqual(priorBoard);
    expect(JSON.stringify(res.body)).toMatch(/noteUrl|기록지 URL/);
  };

  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource).useValue(ds).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const hash = await bcrypt.hash(PASSWORD, 4);
    await sql(`INSERT INTO staff(id,name,email,role,password_hash,active) VALUES
      ($1,'S3C 관리자','s3c-admin@t.invalid','admin',$3,true),
      ($2,'S3C 강사','s3c-teacher@t.invalid','teacher',$3,true)`, [ADMIN, TEACHER, hash]);
    await sql(`INSERT INTO stu(id,name) VALUES ($1,'S3C 기록지 학생')`, [STUDENT]);
    // 서비스 키는 DTO의 원문5종이다. 이미 있는 규정은 수정하지 않고 원래 포인트를 사용한다.
    const added = await sql(`INSERT INTO gpasvc(key,name,point,sort) VALUES ('hw','S3C 숙제',1,1)
      ON CONFLICT (key) DO NOTHING RETURNING key`);
    ownsService = added.length > 0;
    point = Number((await sql('SELECT point FROM gpasvc WHERE key=$1', ['hw']))[0].point);
    for (const [actor, email] of [[ADMIN, 's3c-admin@t.invalid'], [TEACHER, 's3c-teacher@t.invalid']] as const) {
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD }).expect(201);
      tokens.set(actor, res.body.accessToken as string);
    }
  });
  beforeEach(async () => {
    const [cycle] = await sql(`INSERT INTO gpa_cycle(no,from_date,to_date) VALUES (29891,'2040-01-01','2040-01-28') RETURNING id`);
    cycleId = Number(cycle.id);
    await sql(`INSERT INTO gpa_alloc(cycle_id,student_id,coord_id,points) VALUES ($1,$2,$3,12)`, [cycleId, STUDENT, ADMIN]);
    await sql(`INSERT INTO gpa_use(cycle_id,student_id,svc_key,points,on_date,coord_id,note_url,state)
      VALUES ($1,$2,'hw',$3,$4,$5,'https://example.test/existing','wait')`, [cycleId, STUDENT, point, DAY, ADMIN]);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await sql('DELETE FROM gpa_use WHERE cycle_id=$1', [cycleId]);
    await sql('DELETE FROM gpa_alloc WHERE cycle_id=$1', [cycleId]);
    await sql('DELETE FROM gpa_cycle WHERE id=$1', [cycleId]);
    await sql(`UPDATE staff SET role='admin',active=true WHERE id=$1`, [ADMIN]);
  });
  afterAll(async () => {
    if (ds?.isInitialized) {
      await sql('DELETE FROM stu WHERE id=$1', [STUDENT]);
      await sql('DELETE FROM staff WHERE id=ANY($1::bigint[])', [[ADMIN, TEACHER]]);
      if (ownsService) await sql(`DELETE FROM gpasvc WHERE key='hw'`);
    }
    if (app) await app.close();
    if (ds?.isInitialized) await ds.destroy();
  });

  it.each([
    ['HTTP', 'http://example.test/note'],
    ['HTTPS query/fragment', 'https://example.test/note?a=1&b=2#part'],
    ['앞뒤 일반 공백', '  https://example.test/note  '],
    ['유니코드 host/path', 'https://예시.한국/기록지'],
    ['생략', undefined], ['null', null], ['빈 문자열', ''],
    ['공백', '   '], ['탭/개행만', '\t\n\r'],
  ])('%s는 기존 trim/NULL 저장·POST→새GET·잔여 감소가 일치한다', async (_label, noteUrl) => {
    await accepted(noteUrl);
  });

  it.each(['a', '😀'])('원문500/501자 %s 경계는 기존 MaxLength의 Unicode 문자수를 따른다', async (char) => {
    const prefix = 'https://example.test/';
    await accepted(prefix + char.repeat(500 - prefix.length));
    await rejected(prefix + char.repeat(501 - prefix.length));
  });
  it('원문 공백포함500자는 trim 저장하고501자는 trim후 짧아도 거절한다', async () => {
    const url = 'https://example.test/note';
    await accepted(url + ' '.repeat(500 - url.length));
    await rejected(url + ' '.repeat(501 - url.length));
  });
  it('trim-empty500자는NULL,501자는URL blank옵션과 무관하게 거절한다', async () => {
    await accepted(' \t\r\n'.repeat(125));
    await rejected(' '.repeat(501));
  });
  it.each([0, 1, true, false, [], ['https://example.test'], {}, { url: 'https://example.test' }].map((value) => [value]))('비문자열 %j는400·기존사용/배정/잔여/로그불변', rejected);
  it.each([
    'javascript:alert(1)', 'data:text/html,test', 'file:///tmp/note', 'ftp://example.test/note',
    '//example.test/note', '/note', 'example.test/note', 'https://', 'https:///example.test/note',
    'https://user:password@example.test/note', 'https://user@example.test/note',
    'https://example.test/a b', 'https://example.test/a\tb', 'https://example.test/a\nb',
    '\nhttps://example.test/note', 'https://example.test/note\t',
    'https://example.test/\u0000', 'https://example.test/\u007f', 'https://example.test\\note',
  ])('위험/비절대 URL %s는400·정상동봉필드도저장하지않음', rejected);

  it('익명401·실제강사403은읽기/생성거절·DB불변이다', async () => {
    const before = await snapshot();
    for (const actor of [undefined, TEACHER]) {
      for (const method of ['get', 'post'] as const) {
        const path = method === 'get' ? '/gpa' : '/gpa/uses';
        const call = actor === undefined ? request(app.getHttpServer())[method](path) : http(method, path, actor);
        const res = method === 'get' ? await call.query({ anchor: DAY }) : await call.send(valid());
        expect(res.status).toBe(actor === undefined ? 401 : 403);
      }
    }
    expect(await snapshot()).toEqual(before);
  });
  it.each([[false, false], [true, false], [false, true], [true, true]] as const)('최종admin=%s/crud=%s는기존두권한정책을보존한다', async (canAdminPage, canCrudAll) => {
      const auth = app.get(AuthService);
      const current = auth.currentUser.bind(auth);
      // STAFF에는 독립10/01 칸이 없으므로 최종 projection만 바꾸고 실제 JWT/guard/SQL을 통과한다.
      jest.spyOn(auth, 'currentUser').mockImplementation(async (id) => ({ ...await current(id), perms: { canAdminPage, canCrudAll } }));
      const before = await snapshot();
      const read = await http('get', '/gpa').query({ anchor: DAY });
      const created = await http('post', '/gpa/uses').send({ ...valid(), noteUrl: 'https://example.test/note' });
      const allowed = canAdminPage && canCrudAll;
      expect({ read: read.status, create: created.status }).toEqual({ read: allowed ? 200 : 403, create: allowed ? 201 : 403 });
      if (!allowed) expect(await snapshot()).toEqual(before);
    });
  it.each([['role', 'teacher', 403], ['active', false, 401]] as const)('기발급토큰의%s회수도다시확인하고쓰기0', async (field, value, status) => {
      await sql(`UPDATE staff SET ${field}=$1 WHERE id=$2`, [value, ADMIN]);
      const before = await snapshot();
      await http('get', '/gpa').query({ anchor: DAY }).expect(status);
      await http('post', '/gpa/uses').send(valid()).expect(status);
      expect(await snapshot()).toEqual(before);
    });
  it('선택URL의null·길이계약을Swagger에도명시한다', () => {
    expect(Reflect.getMetadata('swagger/apiModelProperties', GpaUseCreateDto.prototype, 'noteUrl'))
      .toMatchObject({ type: String, required: false, nullable: true, maxLength: 500 });
  });
});
