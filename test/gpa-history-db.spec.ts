/** @file-guide
 * 목적: gpa-history-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §82 「{학생} 회차 내역」 읽는 표의 시각 — 「08-21 18:00–18:45」 (spec-1to1 g7 82-8).
 *
 * 기록(`gpa_use`)에는 끝 시각 칸이 없다. 끝은 **연결된 회차가 그날 실제로 놓인 자리**(`ser_occ.span`)에서 읽는다 —
 * 회차를 옮기면 끝도 따라간다. 회차가 없는 기록은 null 이다(없는 끝을 지어내지 않는다).
 * 보드 · 기록 응답 · 승인 응답이 같은 모양을 읽는지도 본다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { GpaCycle } from '../src/entities';
import { GpaService } from '../src/modules/gpa/gpa.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('§82 회차 내역 — 끝 시각은 연결 회차에서 읽는다 (82-8)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let cycleId = 0;
  let serId = 0;
  let coordId = 0;
  let approverId = 0;
  let studentId = 0;

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
    const staff = (name: string, email: string) => q.query(
      `INSERT INTO staff (name, email, role, active, tz) VALUES ($1,$2,'manager',true,'Asia/Seoul') RETURNING id`, [name, email],
    ) as Promise<Array<{ id: string }>>;
    coordId = Number((await staff('회차 코디', 'gpa-hist-coord@t.kr'))[0].id);
    approverId = Number((await staff('회차 승인', 'gpa-hist-ok@t.kr'))[0].id);
    studentId = Number(((await q.query(`INSERT INTO stu (name) VALUES ('회차학생') RETURNING id`)) as Array<{ id: string }>)[0].id);
    await q.query(`INSERT INTO gpasvc (key,name,point,sort) VALUES ('hw','숙제 지원',1,1) ON CONFLICT (key) DO NOTHING`);
    cycleId = Number(((await q.query(
      `INSERT INTO gpa_cycle (no, from_date, to_date) VALUES (8, '2026-11-02', '2026-11-29') RETURNING id`,
    )) as Array<{ id: string }>)[0].id);
    // 스크래치 DB 는 마이그레이션만 돼 있다 — 이 스위트의 종류를 스스로 둔다(트랜잭션이 끝나면 사라진다)
    await q.query(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ('gpa_hist_qa','GPA 회차 QA','#333333',4,'lesson',false)
                   ON CONFLICT (key) DO NOTHING`);
    serId = Number(((await q.query(
      `INSERT INTO ser (kind_key, teacher_id, mode, start_min, end_min, rrule, from_date, to_date, title)
       VALUES ('gpa_hist_qa', $1, 'offline', 1080, 1125, 'ONCE', '2026-11-05', '2026-11-05', 'GPA 회차') RETURNING id`,
      [coordId],
    )) as Array<{ id: string }>)[0].id);
    await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, teacher_id, canceled, span)
       VALUES ($1, '2026-11-05', $2, false,
               tstzrange(('2026-11-05'::date + time '18:00') AT TIME ZONE 'Asia/Seoul',
                         ('2026-11-05'::date + time '18:45') AT TIME ZONE 'Asia/Seoul', '[)'))`,
      [serId, coordId],
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('회차에 연결된 기록은 그 회차의 끝 시각을 준다 — 연결이 없으면 null 이다', async () => {
    await q.query(
      `INSERT INTO gpa_use (cycle_id, student_id, ser_id, svc_key, points, on_date, start_min, coord_id, state)
       VALUES ($1,$2,$3,'hw',1,'2026-11-05',1080,$4,'wait'), ($1,$2,NULL,'hw',1,'2026-11-06',1080,$4,'wait')`,
      [cycleId, studentId, serId, coordId],
    );
    const b = await svc().board('2026-11-10');
    expect(b.uses.map((u) => [u.onDate, u.startMin, u.endMin])).toEqual([
      ['2026-11-05', 1080, 1125],
      ['2026-11-06', 1080, null],
    ]);
  });

  it('회차를 옮기면 끝 시각도 따라간다 — 기록에 끝을 베껴 두지 않는다', async () => {
    await q.query(
      `INSERT INTO gpa_use (cycle_id, student_id, ser_id, svc_key, points, on_date, start_min, coord_id, state)
       VALUES ($1,$2,$3,'hw',1,'2026-11-05',1080,$4,'wait')`,
      [cycleId, studentId, serId, coordId],
    );
    await q.query(
      `UPDATE ser_occ SET span = tstzrange(('2026-11-05'::date + time '18:00') AT TIME ZONE 'Asia/Seoul',
                                            ('2026-11-05'::date + time '19:00') AT TIME ZONE 'Asia/Seoul', '[)')
        WHERE ser_id = $1`, [serId],
    );
    const b = await svc().board('2026-11-10');
    expect(b.uses[0].endMin).toBe(1140);
  });

  it('기록 응답과 승인 응답도 같은 모양이다 — 끝 시각이 빠지지 않는다', async () => {
    const made = await svc().createUse(
      coordId,
      { cycleId, studentId, svcKey: 'hw', onDate: '2026-11-05', startMin: 1080, serId },
    );
    expect(made.endMin).toBe(1125);
    const ok = await svc().setUseState(made.id, approverId, { state: 'ok' });
    expect(ok).toMatchObject({ state: 'ok', endMin: 1125 });
  });
});
