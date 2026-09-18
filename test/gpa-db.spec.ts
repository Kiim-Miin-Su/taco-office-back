/** @file-guide
 * 목적: gpa-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { DataSource, QueryRunner } from 'typeorm';
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
    const ok = await svc().setUseState(made.id, { state: 'ok' });
    expect(ok.state).toBe('ok');
    await expect(svc().deleteUse(made.id)).rejects.toMatchObject({ response: { code: 'USE_APPROVED' } });
    const back = await svc().setUseState(made.id, { state: 'wait' });
    expect(back.state).toBe('wait');
    await expect(svc().deleteUse(made.id)).resolves.toEqual({ ok: true });
    const b = await svc().board('2026-10-06');
    expect(b.students.find((s) => s.studentId === 91)).toMatchObject({ used: 0, wait: 0, remain: 8 });
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
