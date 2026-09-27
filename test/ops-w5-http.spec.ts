/** @file-guide
 * 목적: ops-w5-http.spec.ts — 「+ 대표 지시」 경로의 입력 방어·권한 (w5 · g6 65-4)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * `POST /ops/plans/:id/tasks` — HTTP 층에서만 보이는 것 셋:
 *   ① 강사는 `@Perm('canAdminPage','canCrudAll')` 에서 403 (서비스까지 안 간다)
 *   ② DTO 가 막는다 — 제목 없음 · 담당 id 가 정수 아님 · 달력에 없는 날(2026-02-30) · 모르는 칸(whitelist)
 *   ③ 대표는 201 이고 응답이 보고서 전체(`PlanDetailDto`)라 과제 수·「과제 N/M」이 곧바로 맞는다
 *
 * ⚠ 제 픽스처만 만들고 지운다 (개발 DB 는 읽기 전용처럼 다룬다 — test/db.ts).
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
jest.setTimeout(60_000);

d('「+ 대표 지시」 HTTP (w5 · 65-4)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let teacherToken = '';
  let planId = 0;
  const PW = 'w5-ops-1234';
  const CEO = 1581;
  const TEACHER = 1582;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;
  const post = (body: unknown, t = token, id = planId) =>
    request(app.getHttpServer()).post(`/ops/plans/${id}/tasks`).set('Authorization', `Bearer ${t}`).send(body as object);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    const hash = await bcrypt.hash(PW, 4);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER]]);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'W5대표','w5-http-ceo@t.kr','ceo',$3,true),
         ($2,'W5강사','w5-http-t@t.kr','teacher',$3,true)`,
      [CEO, TEACHER, hash],
    );
    const [p] = await q<{ id: string }>(
      `INSERT INTO plan (title, stage, owner_id) VALUES ('W5 HTTP 기획','draft',$1) RETURNING id`, [TEACHER],
    );
    planId = Number(p.id);
    const login = async (email: string) => (await request(app.getHttpServer())
      .post('/auth/login').send({ loginId: email, password: PW }).expect(201)).body.accessToken as string;
    token = await login('w5-http-ceo@t.kr');
    teacherToken = await login('w5-http-t@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await q(`DELETE FROM todo WHERE plan_id = $1`, [planId]);
        await q(`DELETE FROM noti WHERE from_id = ANY($1) OR to_id = ANY($1)`, [[CEO, TEACHER]]);
        await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, TEACHER]]);
        await q(`DELETE FROM plan WHERE id = $1`, [planId]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER]]);
      }
    } finally {
      await app?.close();
    }
  });

  it('강사는 경로 자체가 403 이고 과제가 생기지 않는다', async () => {
    await post({ title: '강사가 적은 지시', toId: TEACHER }, teacherToken).expect(403);
    expect(await q(`SELECT 1 FROM todo WHERE plan_id = $1`, [planId])).toHaveLength(0);
  });

  it.each([
    ['제목 없음', { toId: TEACHER }],
    ['담당 id 가 정수가 아님', { title: '지시', toId: 'x' }],
    ['담당 id 0', { title: '지시', toId: 0 }],
    ['달력에 없는 날', { title: '지시', toId: TEACHER, dueOn: '2026-02-30' }],
    ['모르는 칸', { title: '지시', toId: TEACHER, planId: 1 }],
  ])('DTO 가 막는다 — %s → 400', async (_why, body) => {
    await post(body).expect(400);
  });

  it('대표는 201 — 응답이 보고서 전체라 「과제 N/M」이 곧바로 맞고 담당에게 알림이 간다', async () => {
    const res = await post({ title: 'W5 검색광고 재조정', toId: TEACHER, dueOn: '2026-10-02' }).expect(201);
    expect(res.body).toMatchObject({ id: planId, taskDone: 0, canAddTask: true, addTaskBlockedReason: null });
    expect(res.body.tasks).toEqual([expect.objectContaining({ title: 'W5 검색광고 재조정', toName: 'W5강사', dueOn: '2026-10-02' })]);
    expect(await q(`SELECT 1 FROM noti WHERE to_id = $1 AND link = $2`, [TEACHER, `/ops?tab=plan&plan=${planId}`])).toHaveLength(1);
    await request(app.getHttpServer()).post(`/ops/plans/999999999/tasks`).set('Authorization', `Bearer ${token}`)
      .send({ title: '없는 기획', toId: TEACHER }).expect(404);
  });
});
