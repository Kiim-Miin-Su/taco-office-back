/** @file-guide
 * 목적: ops-x5-http.spec.ts — 「+ 오늘 한 것」(POST /ops/marketing) 경로의 입력 방어·권한 (x5 · g6 59-3)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * `POST /ops/marketing` — HTTP 층에서만 보이는 것 셋:
 *   ① 강사는 `@Perm('canAdminPage','canCrudAll')` 에서 403 (서비스까지 안 간다 · 줄이 안 생긴다)
 *   ② DTO 가 막는다 — 모르는 채널 · `javascript:` 주소 · 로그인 정보가 든 주소 · 달력에 없는 날(2026-02-30) · 모르는 칸
 *   ③ 대표는 201 이고 응답이 `GET /ops` 의 marketing 줄과 같은 모양(낱말은 서버)
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

d('「+ 오늘 한 것」 HTTP (x5 · 59-3)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let teacherToken = '';
  const PW = 'x5-ops-1234';
  const CEO = 15591;
  const TEACHER = 15592;
  const TITLE = 'X5 HTTP 활동';

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;
  const post = (body: unknown, t = token) =>
    request(app.getHttpServer()).post('/ops/marketing').set('Authorization', `Bearer ${t}`).send(body as object);

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
         ($1,'X5대표','x5-http-ceo@t.kr','ceo',$3,true),
         ($2,'X5강사','x5-http-t@t.kr','teacher',$3,true)`,
      [CEO, TEACHER, hash],
    );
    const login = async (email: string) => (await request(app.getHttpServer())
      .post('/auth/login').send({ email, password: PW }).expect(201)).body.accessToken as string;
    token = await login('x5-http-ceo@t.kr');
    teacherToken = await login('x5-http-t@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, TEACHER]]);
        await q(`DELETE FROM mkt WHERE title LIKE 'X5 HTTP%'`);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER]]);
      }
    } finally {
      await app?.close();
    }
  });

  const count = async () => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM mkt WHERE title LIKE 'X5 HTTP%'`))[0].n);

  it('강사는 403 — 줄이 생기지 않는다', async () => {
    await post({ title: TITLE, channel: 'naver', item: 'blog' }, teacherToken).expect(403);
    expect(await count()).toBe(0);
  });

  it.each([
    ['모르는 채널', { title: TITLE, channel: 'tiktok', item: 'blog' }],
    ['모르는 항목', { title: TITLE, channel: 'naver', item: 'reels' }],
    ['javascript: 주소', { title: TITLE, channel: 'naver', item: 'blog', url: 'javascript:alert(1)' }],
    ['로그인 정보가 든 주소', { title: TITLE, channel: 'naver', item: 'blog', url: 'https://u:p@evil.test/x' }],
    ['달력에 없는 날', { title: TITLE, channel: 'naver', item: 'blog', onDate: '2026-02-30' }],
    ['담당 id 가 정수 아님', { title: TITLE, channel: 'naver', item: 'blog', byId: 'x' }],
    ['제목 없음', { channel: 'naver', item: 'blog' }],
    ['모르는 칸', { title: TITLE, channel: 'naver', item: 'blog', cost: 100 }],
  ])('DTO 가 막는다 — %s (400)', async (_name, body) => {
    await post(body).expect(400);
    expect(await count()).toBe(0);
  });

  it('대표는 201 — 응답은 목록과 같은 모양 · 날짜 기본 오늘 · 담당 기본 나', async () => {
    const res = await post({ title: `${TITLE} 1`, channel: 'instagram', item: 'video', url: 'https://instagram.com/p/x5' }).expect(201);
    expect(res.body).toMatchObject({
      title: `${TITLE} 1`, channelLabel: '인스타그램', itemLabel: '영상', byId: CEO, byName: 'X5대표',
      url: 'https://instagram.com/p/x5',
    });
    expect(res.body.onDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const list = await request(app.getHttpServer()).get('/ops').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.marketing.find((m: { id: number }) => m.id === res.body.id)).toEqual(res.body);
    expect(await count()).toBe(1);
  });
});
