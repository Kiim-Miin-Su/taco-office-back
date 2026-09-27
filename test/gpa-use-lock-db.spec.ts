/** @file-guide
 * 목적: gpa-use-lock-db.spec.ts — §82 GPA 소비 기록 승인·되돌림(setUseState) · 기록(createUse) · 배정(putAlloc)의 잠금과 사이클 마감 경합 회귀 (test · W11 PB-12-3 · A')
 * 책임/재사용: GpaService 공개 메서드를 실제 두 연결에서 부르고, 이 스위트가 만든 9xx 행만 지운다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * PB-12-3 — `setUseState` 는 **잠그지 않고** 사이클이 열렸는지를 **트랜잭션 밖에서** 봤다.
 *
 * 그래서 두 가지가 샜다.
 *  ① `closeCycle` 이 사이클 행을 잠그고 닫는 동안(아직 커밋 전) 승인이 들어오면, 승인은 「열림」을 읽고
 *    `gpa_use` 를 고친다 — 닫힌 사이클에 승인 도장이 찍히거나(마감이 셌던 승인 대기 0 이 거짓이 된다),
 *    되돌림이면 닫힌 사이클에 대기 줄이 생긴다.
 *  ② 이미 승인된 줄을 다른 사람이 한 번 더 승인하면 **첫 도장을 덮었다**(누가 · 언제 승인했는지가 바뀐다).
 *
 * 이 스위트는 두 연결이 필요해서 트랜잭션 되돌리기로 치우지 못한다 — 만든 행을 끝에 직접 지운다.
 */
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { GpaCycle } from '../src/entities';
import { GpaService } from '../src/modules/gpa/gpa.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
const url = TEST_URL ? assertScratch(TEST_URL) : '';
jest.setTimeout(60_000);

const COORD = 9341;
const APPROVER = 9342;
const APPROVER_B = 9343;
const STUDENT = 9341;

d('§82 GPA 승인·되돌림 잠금 (W11 PB-12-3)', () => {
  let ds: DataSource;
  let svc: GpaService;
  let cycleId = 0;
  const uses: number[] = [];

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
    svc = new GpaService(ds.getRepository(GpaCycle));
    await ds.query(
      `INSERT INTO staff (id,name,email,role,active) VALUES
         ($1,'잠금 코디','gpa-lock-coord@test','manager',true),
         ($2,'잠금 승인','gpa-lock-approver@test','manager',true),
         ($3,'잠금 승인 둘','gpa-lock-approver-b@test','manager',true)
       ON CONFLICT (id) DO NOTHING`, [COORD, APPROVER, APPROVER_B]);
    await ds.query(`INSERT INTO stu (id,name) VALUES ($1,'잠금 학생') ON CONFLICT (id) DO NOTHING`, [STUDENT]);
    await ds.query(`INSERT INTO gpasvc (key,name,point,sort) VALUES ('hw','숙제 지원',1,1) ON CONFLICT (key) DO NOTHING`);
  });

  beforeEach(async () => {
    const [cy] = await ds.query(
      `INSERT INTO gpa_cycle (no, from_date, to_date) VALUES (93, '2099-03-02', '2099-03-29') RETURNING id`,
    ) as Array<{ id: string }>;
    cycleId = Number(cy.id);
  });

  afterEach(async () => {
    if (uses.length) {
      await ds.query(`DELETE FROM log WHERE entity = 'GPA_USE' AND entity_id = ANY($1::bigint[])`, [uses]);
      uses.length = 0;
    }
    // 경합 시험이 (고치기 전 코드로) 닫힌 사이클에 줄을 남겼을 수 있다 — 사이클째 치운다
    await ds.query(`DELETE FROM gpa_use WHERE cycle_id = $1`, [cycleId]);
    await ds.query(`DELETE FROM gpa_alloc WHERE cycle_id = $1`, [cycleId]);
    await ds.query(`DELETE FROM gpa_cycle WHERE id = $1`, [cycleId]);
  });

  afterAll(async () => {
    await ds?.query(`DELETE FROM log WHERE actor_id = ANY($1::bigint[])`, [[COORD, APPROVER, APPROVER_B]]);
    await ds?.query(`DELETE FROM stu WHERE id = $1 AND name = '잠금 학생'`, [STUDENT]);
    await ds?.query(`DELETE FROM staff WHERE id = ANY($1::bigint[]) AND email LIKE 'gpa-lock-%@test'`, [[COORD, APPROVER, APPROVER_B]]);
    if (ds?.isInitialized) await ds.destroy();
  });

  async function waitRow(): Promise<number> {
    const [row] = await ds.query(
      `INSERT INTO gpa_use (cycle_id, student_id, svc_key, points, on_date, coord_id, state)
       VALUES ($1, $2, 'hw', 1, '2099-03-04', $3, 'wait') RETURNING id`, [cycleId, STUDENT, COORD],
    ) as Array<{ id: string }>;
    const id = Number(row.id);
    uses.push(id);
    return id;
  }

  const stamp = async (id: number) => (await ds.query(
    `SELECT state, approved_by, approved_at FROM gpa_use WHERE id = $1`, [id],
  ))[0] as { state: string; approved_by: string | null; approved_at: Date | null };

  it('이미 승인된 줄을 다시 승인하면 거절하고 첫 도장(누가 · 언제)을 그대로 둔다', async () => {
    const id = await waitRow();
    await svc.setUseState(id, APPROVER, { state: 'ok' });
    const first = await stamp(id);
    expect(first).toMatchObject({ state: 'ok', approved_by: String(APPROVER) });

    await expect(svc.setUseState(id, APPROVER_B, { state: 'ok' }))
      .rejects.toMatchObject({ status: 409, response: { code: 'USE_STATE_UNCHANGED' } });
    const after = await stamp(id);
    expect(after.approved_by).toBe(String(APPROVER));
    expect(after.approved_at?.toISOString()).toBe(first.approved_at?.toISOString());
    // 거절한 쓰기는 원장에 줄을 남기지 않는다
    const logs = await ds.query(`SELECT action FROM log WHERE entity = 'GPA_USE' AND entity_id = $1 ORDER BY id`, [id]);
    expect(logs.map((r: { action: string }) => r.action)).toEqual(['approve']);
  });

  it('대기 줄을 다시 대기로 되돌리는 것도 거절한다 — 같은 상태로의 전이는 쓰기가 아니다', async () => {
    const id = await waitRow();
    await expect(svc.setUseState(id, APPROVER, { state: 'wait' }))
      .rejects.toMatchObject({ status: 409, response: { code: 'USE_STATE_UNCHANGED' } });
    expect((await stamp(id)).state).toBe('wait');
  });

  it('마감이 사이클을 잠근 채 진행 중이면 승인은 그 커밋을 기다렸다가 CYCLE_CLOSED 로 거절된다', async () => {
    const id = await waitRow();
    // closeCycle 이 하는 일을 한 연결에서 절반만 한다 — 사이클을 잠그고 닫았지만 아직 커밋 전이다
    const closer = ds.createQueryRunner();
    await closer.connect();
    await closer.startTransaction();
    try {
      await closer.query(`SELECT id FROM gpa_cycle WHERE id = $1 FOR UPDATE`, [cycleId]);
      await closer.query(`UPDATE gpa_cycle SET closed = true WHERE id = $1`, [cycleId]);

      const approving = svc.setUseState(id, APPROVER, { state: 'ok' }).then(
        () => 'approved' as const,
        (e: { response?: { code?: string } }) => e.response?.code ?? 'error',
      );
      // 승인이 먼저 끝나 버리면(잠그지 않으면) 여기서 이미 'approved' 로 정해진다
      await new Promise((resolve) => setTimeout(resolve, 400));
      await closer.commitTransaction();
      expect(await approving).toBe('CYCLE_CLOSED');
    } finally {
      if (closer.isTransactionActive) await closer.rollbackTransaction();
      await closer.release();
    }
    expect(await stamp(id)).toMatchObject({ state: 'wait', approved_by: null });
  });

  it('닫힌 사이클의 승인 줄은 되돌릴 수 없다 — 닫힌 뒤에 대기 줄이 생기지 않는다', async () => {
    const id = await waitRow();
    await svc.setUseState(id, APPROVER, { state: 'ok' });
    await ds.query(`UPDATE gpa_cycle SET closed = true WHERE id = $1`, [cycleId]);
    await expect(svc.setUseState(id, APPROVER, { state: 'wait' }))
      .rejects.toMatchObject({ status: 409, response: { code: 'CYCLE_CLOSED' } });
    expect((await stamp(id)).state).toBe('ok');
  });

  /*
   * A' 후속 — 기록(createUse)과 배정(putAlloc)도 같은 구멍이었다. 사이클 열림을 **트랜잭션 밖에서 잠그지 않고** 본 뒤
   * 쓰므로, 마감이 사이클을 잡고 닫는 동안(커밋 전) 들어온 쓰기는 「열림」을 읽고 FK 잠금만 기다렸다가 **닫힌 사이클에**
   * 대기 줄 · 배정을 남겼다(마감이 센 「승인 대기 0」 · 소멸 포인트가 거짓이 된다).
   */
  async function whileClosing<T>(write: () => Promise<T>): Promise<string> {
    const closer = ds.createQueryRunner();
    await closer.connect();
    await closer.startTransaction();
    try {
      await closer.query(`SELECT id FROM gpa_cycle WHERE id = $1 FOR UPDATE`, [cycleId]);
      await closer.query(`UPDATE gpa_cycle SET closed = true WHERE id = $1`, [cycleId]);
      const outcome = write().then(
        () => 'written',
        (e: { response?: { code?: string } }) => e.response?.code ?? 'error',
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      await closer.commitTransaction();
      return await outcome;
    } finally {
      if (closer.isTransactionActive) await closer.rollbackTransaction();
      await closer.release();
    }
  }

  const useCount = async () => Number((await ds.query(
    `SELECT count(*)::int AS n FROM gpa_use WHERE cycle_id = $1`, [cycleId],
  ))[0].n);

  it('마감이 진행 중이면 기록(createUse)은 그 커밋을 기다렸다가 CYCLE_CLOSED — 닫힌 사이클에 대기 줄이 생기지 않는다', async () => {
    const got = await whileClosing(() => svc.createUse(COORD, {
      cycleId, studentId: STUDENT, svcKey: 'hw', onDate: '2099-03-05',
    }));
    expect(got).toBe('CYCLE_CLOSED');
    expect(await useCount()).toBe(0);
  });

  it('남의 트랜잭션에서 부르는 기록(N-99 승인 경로 · createUse(…, em))도 같은 잠금 규칙을 지난다', async () => {
    const approver = ds.createQueryRunner();
    await approver.connect();
    await approver.startTransaction();
    try {
      const got = await whileClosing(() => svc.createUse(COORD, {
        cycleId, studentId: STUDENT, svcKey: 'hw', onDate: '2099-03-05',
      }, approver.manager));
      expect(got).toBe('CYCLE_CLOSED');
    } finally {
      if (approver.isTransactionActive) await approver.rollbackTransaction();
      await approver.release();
    }
    expect(await useCount()).toBe(0);
  });

  it('마감이 진행 중이면 배정(putAlloc)도 CYCLE_CLOSED — 닫힌 사이클의 배정(소멸 포인트의 근거)이 바뀌지 않는다', async () => {
    const got = await whileClosing(() => svc.putAlloc(COORD, { cycleId, studentId: STUDENT, points: 8 }));
    expect(got).toBe('CYCLE_CLOSED');
    const alloc = await ds.query(`SELECT points FROM gpa_alloc WHERE cycle_id = $1`, [cycleId]);
    expect(alloc).toEqual([]);
  });

  it('열린 사이클의 기록 · 배정은 그대로 된다 — 잠금은 막는 값이 아니라 차례다', async () => {
    const use = await svc.createUse(COORD, { cycleId, studentId: STUDENT, svcKey: 'hw', onDate: '2099-03-05' });
    uses.push(use.id);
    expect(use).toMatchObject({ state: 'wait', points: 1 });
    const alloc = await svc.putAlloc(COORD, { cycleId, studentId: STUDENT, points: 8 });
    expect(alloc).toMatchObject({ alloc: 8, used: 0, wait: 1, remain: 7 });
  });
});
