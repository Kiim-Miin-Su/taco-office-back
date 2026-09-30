/** @file-guide
 * 목적: teacher-meeting-http.spec.ts (test) — 강사 참석자의 회의 상세(N-32 후속 · W11 A' 후속 P)의 실제 HTTP
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * O 의 N-32 「안내 보내기」 알림 링크(`/ops?tab=meeting&meeting=`)를 강사는 못 열었다 — 강사 알림 서랍은 강사에게 열린 경로만 연다.
 * 그래서 링크를 **받는 사람이 열 수 있는 자리**로 보낸다(운영 화면을 못 여는 사람 → `/teacher?meeting=`). 거기서 같은 회의 상세를 읽는다.
 *
 *   ① 안내 알림 링크 — 강사 참석자는 `/teacher?meeting=N`, 매니저 참석자는 `/ops?tab=meeting&meeting=N` (보낸 사람에게는 가지 않는다)
 *   ② 강사 참석자는 상세를 연다 — 쓰기 단추 플래그는 꺼져 있고(canEdit · canSendNotice) 응답 단추만(canRespond) ·
 *      할 일은 **자기에게 온 것만** 체크 칸이 선다(canToggle) — 체크 쓰기(`PATCH /drawer/todos/:id`)의 판정과 같다
 *   ③ 참석 응답은 된다 · 속기록 · 안내 · 할 일 배정은 403 · 참석자가 아닌 강사는 404
 *   ④ 회의 할 일을 강사에게 배정하면 그 알림도 강사가 열 수 있는 자리(`/teacher?meeting=N`)로 간다 ·
 *      N-124: 활성 참석자만 배정한다 — 비참석자·비활성은 할 일과 알림을 남기지 않는다
 *
 * 이 스위트 전용 staff 9811~9814 · 회의 한 건(만들고 지운다).
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

d('강사 참석자의 회의 상세 — 알림 링크는 받는 사람이 열 수 있는 자리로 (N-32 후속 · 실제 HTTP)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const PW = 'mt-fixture-9811';
  const MGR = 9811;
  const MGR2 = 9812;
  const TEACHER = 9813;
  const TEACHER2 = 9814;
  const ids = [MGR, MGR2, TEACHER, TEACHER2];
  const tokens: Record<string, string> = {};
  let meetingId = 0;
  let taskMine = 0;
  let taskOther = 0;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const api = (m: 'get' | 'post' | 'patch', url: string, token: string) =>
    (request(app.getHttpServer()) as unknown as Record<string, (u: string) => request.Test>)[m](url)
      .timeout({ response: 8000, deadline: 15000 })
      .set('Authorization', `Bearer ${token}`);
  const login = async (loginId: string) =>
    (await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 })
      .send({ loginId, password: PW }).expect(201)).body.accessToken as string;
  const linksTo = async (id: number) =>
    (await q<{ link: string }>(`SELECT link FROM noti WHERE to_id = $1 ORDER BY id`, [id])).map((r) => r.link);

  const drop = async () => {
    const mts = await q<{ mt_id: string }>(`SELECT DISTINCT mt_id FROM mtattd WHERE staff_id = ANY($1)`, [ids]);
    const mtIds = mts.map((r) => Number(r.mt_id));
    await q(`DELETE FROM todo WHERE mt_id = ANY($1) OR to_id = ANY($2) OR from_id = ANY($2)`, [mtIds, ids]);
    await q(`DELETE FROM mtattd WHERE mt_id = ANY($1)`, [mtIds]);
    await q(`DELETE FROM mtrec WHERE id = ANY($1)`, [mtIds]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1) OR (entity = 'STAFF' AND entity_id = ANY($1))`, [ids]);
    await q(`DELETE FROM auth_code WHERE staff_id = ANY($1)`, [ids]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);
    await drop();
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'회의매니저','mt-mgr@t.kr','manager',$5,true),
         ($2,'회의매니저둘','mt-mgr2@t.kr','manager',$5,true),
         ($3,'회의강사','mt-t@t.kr','teacher',$5,true),
         ($4,'다른강사','mt-t2@t.kr','teacher',$5,true)`,
      [MGR, MGR2, TEACHER, TEACHER2, hash],
    );
    tokens.mgr = await login('mt-mgr@t.kr');
    tokens.teacher = await login('mt-t@t.kr');
    tokens.teacher2 = await login('mt-t2@t.kr');
    meetingId = Number((await q<{ id: string }>(
      `INSERT INTO mtrec (mt_type, title, on_date) VALUES ('general', '강사 참석 회의', '2026-12-01') RETURNING id`,
    ))[0].id);
    await q(`INSERT INTO mtattd (mt_id, staff_id, confirmed) VALUES ($1,$2,NULL), ($1,$3,NULL), ($1,$4,NULL)`, [meetingId, MGR, MGR2, TEACHER]);
    taskMine = Number((await q<{ id: string }>(
      `INSERT INTO todo (title, from_id, to_id, done, src, mt_id) VALUES ('교안 공유', $1, $2, false, 'meeting', $3) RETURNING id`,
      [MGR, TEACHER, meetingId],
    ))[0].id);
    taskOther = Number((await q<{ id: string }>(
      `INSERT INTO todo (title, from_id, to_id, done, src, mt_id) VALUES ('예산 정리', $1, $2, false, 'meeting', $3) RETURNING id`,
      [MGR, MGR2, meetingId],
    ))[0].id);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await drop();
    await app?.close();
  });

  it('① 안내 알림 링크 — 강사 참석자는 강사 홈의 회의 창 · 매니저 참석자는 운영 화면 · 보낸 사람에게는 없다', async () => {
    const sent = await api('post', `/ops/meetings/${meetingId}/notice`, tokens.mgr).expect(201);
    expect(sent.body.sent).toBe(2);
    expect(await linksTo(TEACHER)).toEqual([`/teacher?meeting=${meetingId}`]);
    expect(await linksTo(MGR2)).toEqual([`/ops?tab=meeting&meeting=${meetingId}`]);
    expect(await linksTo(MGR)).toEqual([]);
  });

  it('② 강사 참석자는 상세를 연다 — 쓰기 플래그는 꺼지고 응답만 · 할 일은 자기에게 온 것만 체크 칸', async () => {
    const res = await api('get', `/ops/meetings/${meetingId}`, tokens.teacher).expect(200);
    expect(res.body).toMatchObject({ canEdit: false, canSendNotice: false, canRespond: true });
    const tasks = res.body.tasks as Array<{ id: number; canToggle: boolean }>;
    expect(tasks.find((t) => t.id === taskMine)?.canToggle).toBe(true);
    expect(tasks.find((t) => t.id === taskOther)?.canToggle).toBe(false);
    // 운영 권한이 있는 사람에게는 전부 선다(같은 경로 · 같은 판정)
    const mgr = await api('get', `/ops/meetings/${meetingId}`, tokens.mgr).expect(200);
    expect((mgr.body.tasks as Array<{ canToggle: boolean }>).every((t) => t.canToggle)).toBe(true);
    // 체크 쓰기도 같은 판정 — 자기 것은 되고 남의 것은 없는 것과 같다(404)
    await api('patch', `/drawer/todos/${taskMine}`, tokens.teacher).send({ done: true }).expect(200);
    await api('patch', `/drawer/todos/${taskOther}`, tokens.teacher).send({ done: true }).expect(404);
  });

  it('③ 참석 응답은 된다 · 운영 쓰기는 403 · 참석자가 아닌 강사는 404', async () => {
    const res = await api('post', `/ops/meetings/${meetingId}/attend`, tokens.teacher).send({ confirmed: true }).expect(201);
    expect(res.body.myAttend).toMatchObject({ state: 'in' });
    await api('post', `/ops/meetings/${meetingId}/minutes`, tokens.teacher).send({ minutes: '[정한 것] 강사가 쓴다' }).expect(403);
    await api('post', `/ops/meetings/${meetingId}/notice`, tokens.teacher).expect(403);
    await api('post', `/ops/meetings/${meetingId}/todos`, tokens.teacher).send({ title: '몰래', toId: TEACHER }).expect(403);
    await api('get', `/ops/meetings/${meetingId}`, tokens.teacher2).expect(404);
    await api('post', `/ops/meetings/${meetingId}/attend`, tokens.teacher2).send({ confirmed: true }).expect(404);
  });

  it('④ 회의 할 일을 강사에게 배정하면 그 알림도 강사가 열 수 있는 자리로 간다 · 매니저는 운영 할 일로', async () => {
    await q(`DELETE FROM noti WHERE to_id = ANY($1)`, [[TEACHER, MGR2, TEACHER2]]);
    await api('post', `/ops/meetings/${meetingId}/todos`, tokens.mgr).send({ title: '자료 올리기', toId: TEACHER }).expect(201);
    await api('post', `/ops/meetings/${meetingId}/todos`, tokens.mgr).send({ title: '예산 확인', toId: MGR2 }).expect(201);
    expect(await linksTo(TEACHER)).toEqual([`/teacher?meeting=${meetingId}`]);
    expect(await linksTo(MGR2)).toEqual(['/ops?tab=todo']);
  });

  it('N-124 비참석 강사의 직접 배정은 403이며 TODO·NOTI가 그대로다', async () => {
    const before = await q(`SELECT id FROM todo WHERE mt_id=$1 ORDER BY id`, [meetingId]);
    const notices = await q(`SELECT id FROM noti WHERE to_id=$1 ORDER BY id`, [TEACHER2]);
    const rejected = await api('post', `/ops/meetings/${meetingId}/todos`, tokens.mgr)
      .send({ title: '교재 확인', toId: TEACHER2 }).expect(403);
    expect(rejected.body.code).toBe('MEETING_TASK_NOT_ATTENDEE');
    expect(await q(`SELECT id FROM todo WHERE mt_id=$1 ORDER BY id`, [meetingId])).toEqual(before);
    expect(await q(`SELECT id FROM noti WHERE to_id=$1 ORDER BY id`, [TEACHER2])).toEqual(notices);
  });

  it('N-124 매니저도 비참석자이면 직접 배정이 거절된다', async () => {
    await q(`DELETE FROM mtattd WHERE mt_id=$1 AND staff_id=$2`, [meetingId, MGR2]);
    try {
      const before = await q(`SELECT id FROM todo WHERE mt_id=$1 ORDER BY id`, [meetingId]);
      const notices = await q(`SELECT id FROM noti WHERE to_id=$1 ORDER BY id`, [MGR2]);
      const rejected = await api('post', `/ops/meetings/${meetingId}/todos`, tokens.mgr)
        .send({ title: '비참석 매니저', toId: MGR2 }).expect(403);
      expect(rejected.body.code).toBe('MEETING_TASK_NOT_ATTENDEE');
      expect(await q(`SELECT id FROM todo WHERE mt_id=$1 ORDER BY id`, [meetingId])).toEqual(before);
      expect(await q(`SELECT id FROM noti WHERE to_id=$1 ORDER BY id`, [MGR2])).toEqual(notices);
    } finally {
      await q(`INSERT INTO mtattd (mt_id,staff_id,confirmed) VALUES ($1,$2,NULL)`, [meetingId, MGR2]);
    }
  });

  it.each([null, false, true])('N-124 활성 참석자는 confirmed=%s여도 배정·다시 읽기가 된다', async (confirmed) => {
    await q(`UPDATE mtattd SET confirmed=$3 WHERE mt_id=$1 AND staff_id=$2`, [meetingId, TEACHER, confirmed]);
    const title = `참석 응답 ${String(confirmed)}`;
    const made = await api('post', `/ops/meetings/${meetingId}/todos`, tokens.mgr)
      .send({ title, toId: TEACHER, dueOn: '2026-12-02' }).expect(201);
    const task = (made.body.tasks as Array<{ id: number; title: string }>).find((t) => t.title === title)!;
    expect(task).toBeDefined();
    expect((await q(`SELECT to_id,due_on::text FROM todo WHERE id=$1`, [task.id]))[0])
      .toEqual({ to_id: String(TEACHER), due_on: '2026-12-02' });
    const readback = await api('get', `/ops/meetings/${meetingId}`, tokens.teacher).expect(200);
    expect(readback.body.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: task.id, title, canToggle: true })]));
  });

  it('N-124 비활성 참석자는 meta 후보에서 빠지고 직접 배정도 404·무변경이다', async () => {
    await q(`UPDATE staff SET active=false WHERE id=$1`, [TEACHER]);
    try {
      const meta = await api('get', '/meta', tokens.mgr).expect(200);
      expect((meta.body.staff as Array<{ id: number }>).some((s) => s.id === TEACHER)).toBe(false);
      const before = await q(`SELECT id FROM todo WHERE mt_id=$1 ORDER BY id`, [meetingId]);
      const notices = await q(`SELECT id FROM noti WHERE to_id=$1 ORDER BY id`, [TEACHER]);
      const rejected = await api('post', `/ops/meetings/${meetingId}/todos`, tokens.mgr)
        .send({ title: '비활성 참석자', toId: TEACHER }).expect(404);
      expect(rejected.body.code).toBe('STAFF_NOT_FOUND');
      expect(await q(`SELECT id FROM todo WHERE mt_id=$1 ORDER BY id`, [meetingId])).toEqual(before);
      expect(await q(`SELECT id FROM noti WHERE to_id=$1 ORDER BY id`, [TEACHER])).toEqual(notices);
    } finally {
      await q(`UPDATE staff SET active=true WHERE id=$1`, [TEACHER]);
    }
  });

  it.each(['deactivate', 'remove-attendee'] as const)(
    'N-124 %s가 먼저 잠그면 배정은 커밋을 기다린 뒤 거절하고 TODO·NOTI가 그대로다', async (change) => {
      const before = await q(`SELECT id FROM todo WHERE mt_id=$1 ORDER BY id`, [meetingId]);
      const notices = await q(`SELECT id FROM noti WHERE to_id=$1 ORDER BY id`, [TEACHER]);
      const blocker = ds.createQueryRunner();
      await blocker.connect();
      await blocker.startTransaction();
      const [{ pid }] = await blocker.query(`SELECT pg_backend_pid() AS pid`) as Array<{ pid: number }>;
      let pending: Promise<request.Response> | undefined;
      try {
        if (change === 'deactivate') await blocker.query(`UPDATE staff SET active=false WHERE id=$1`, [TEACHER]);
        else await blocker.query(`DELETE FROM mtattd WHERE mt_id=$1 AND staff_id=$2`, [meetingId, TEACHER]);
        let settled = false;
        pending = api('post', `/ops/meetings/${meetingId}/todos`, tokens.mgr)
          .send({ title: `경쟁 ${change}`, toId: TEACHER }).then((r) => { settled = true; return r; });
        let waiting = false;
        for (let i = 0; i < 100 && !waiting && !settled; i++) {
          [{ waiting }] = await q<{ waiting: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting`, [pid],
          );
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        expect(await q(`SELECT id FROM todo WHERE mt_id=$1 ORDER BY id`, [meetingId])).toEqual(before);
        await blocker.commitTransaction();
        const rejected = await pending;
        expect(rejected.status).toBe(change === 'deactivate' ? 404 : 403);
        expect(rejected.body.code).toBe(change === 'deactivate' ? 'STAFF_NOT_FOUND' : 'MEETING_TASK_NOT_ATTENDEE');
        expect(await q(`SELECT id FROM todo WHERE mt_id=$1 ORDER BY id`, [meetingId])).toEqual(before);
        expect(await q(`SELECT id FROM noti WHERE to_id=$1 ORDER BY id`, [TEACHER])).toEqual(notices);
      } finally {
        if (blocker.isTransactionActive) await blocker.rollbackTransaction();
        await blocker.release();
        await pending;
        await q(`UPDATE staff SET active=true WHERE id=$1`, [TEACHER]);
        await q(`INSERT INTO mtattd (mt_id,staff_id,confirmed) VALUES ($1,$2,NULL) ON CONFLICT DO NOTHING`, [meetingId, TEACHER]);
      }
    },
  );
});
