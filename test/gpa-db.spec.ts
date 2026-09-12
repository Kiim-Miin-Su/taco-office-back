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
});
