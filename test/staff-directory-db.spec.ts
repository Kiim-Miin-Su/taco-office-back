/** @file-guide
 * 목적: staff-directory-db.spec.ts — 강사 탭 조회의 실제 HTTP 권한·정렬·가림·감사 readback.
 * 책임/재사용: 격리 DB에 sdir-fixture- 계정과 관련 WAGE/PAYOUT/LOG만 만들고 정확한 ID로 정리한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { previousMonthKst, todayKst } from '../src/lib/kst';
import { assertScratch, DEV_URL, TEST_URL, markSetupDone } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('관리자 강사 탭 — HTTP→DTO→DB', () => {
  let app: INestApplication;
  let db: DataSource;
  let managerId: number;
  let limitedId: number;
  let teacherId: number;
  let olderId: number;
  let managerToken: string;
  let limitedToken: string;
  let teacherToken: string;
  const password = 'sdir-fixture-pass';
  const ids: number[] = [];
  const logIds: number[] = [];
  const wageIds: number[] = [];
  const payoutIds: number[] = [];
  const serIds: number[] = [];
  const studentIds: number[] = [];
  const reqIds: number[] = [];
  const unavIds: number[] = [];
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => db.query(sql, params) as Promise<T[]>;

  beforeAll(async () => {
    // 고정 QA 클러스터(50358)와 release.zsh가 매번 새 포트에 만드는 격리 클러스터만 허용한다.
    // 출시 게이트의 포트가 달라져도 이 테스트가 스킵/실패로 위장되지 않아야 한다.
    if (!DEV_URL || !TEST_URL) throw new Error('강사 조회 fixture에는 격리 개발/시험 DB가 모두 필요합니다');
    const dev = new URL(DEV_URL);
    const scratch = new URL(assertScratch(TEST_URL));
    const allowed = (dev.port === '50358' && dev.pathname === '/taco_dev') || dev.pathname === '/taco_release';
    if (!allowed || dev.hostname !== '127.0.0.1' || scratch.hostname !== dev.hostname || scratch.port !== dev.port
      || scratch.pathname !== `${dev.pathname}_test`) {
      throw new Error('강사 조회 fixture는 isolated PG50358 또는 release.zsh의 임시 DB 두 개에서만 실행합니다');
    }
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    db = app.get(DataSource);
    const hash = await bcrypt.hash(password, 4);
    const addStaff = async (suffix: string, role: 'manager' | 'teacher', active = true, canWage: boolean | null = null, createdAt = '2026-09-28T00:00:00Z') => {
      const [r] = await q<{ id: string }>(
        `INSERT INTO staff (name, login_id, role, password_hash, active, can_wage, created_at)
         VALUES ($1, $2, $3::role_t, $4, $5, $6, $7::timestamptz) RETURNING id`,
        [`sdir-fixture-${suffix}`, `sdir-fixture-${suffix}`, role, hash, active, canWage, createdAt],
      );
      const id = Number(r.id);
      ids.push(id);
      // AUTH-INIT-02: 업무 시험의 픽스처는 「첫 설정을 마친 직원」이다 — 필수 설정 판정은 auth-initial-setup.spec 이 본다
      await markSetupDone(q, [id]);
      return id;
    };
    managerId = await addStaff('manager', 'manager');
    limitedId = await addStaff('limited', 'manager', true, false);
    olderId = await addStaff('old', 'teacher', false, null, '2026-09-27T00:00:00Z');
    teacherId = await addStaff('new', 'teacher', true, null, '2026-09-29T00:00:00Z');
    const [wage] = await q<{ id: string }>(
      `INSERT INTO wage (staff_id, rate, from_date, reason, approved_by) VALUES ($1, 45000, '2026-09-29', 'fixture', $2) RETURNING id`,
      [teacherId, managerId],
    );
    wageIds.push(Number(wage.id));
    const [payout] = await q<{ id: string }>(
      `INSERT INTO payout (staff_id, year_month, hours, gross, net, state)
       VALUES ($1, '2026-08', 10, 450000, 450000, 'draft') RETURNING id`, [teacherId],
    );
    payoutIds.push(Number(payout.id));
    const [log] = await q<{ id: string }>(
      `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
       VALUES ($1, 'STAFF', $2, 'update', $3::jsonb, $4::jsonb) RETURNING id`,
      [managerId, teacherId,
        JSON.stringify({ name: '이전', email: 'old-private@example.test', wageRate: 123456, unexpectedSecret: 'SECRET_BEFORE' }),
        JSON.stringify({ name: '신규', email: 'new-private@example.test', wageRate: 45000, unexpectedSecret: 'SECRET_AFTER' })],
    );
    logIds.push(Number(log.id));
    const [backfill] = await q<{ id: string }>(
      `INSERT INTO log (actor_id, entity, entity_id, action, before, after, at)
       VALUES ($1, 'STAFF', $2, 'deactivate', '{}'::jsonb, '{"active":false}'::jsonb, '2026-09-01T00:00:00Z') RETURNING id`,
      [managerId, teacherId],
    );
    logIds.push(Number(backfill.id));
    const login = async (id: number) => {
      const [staff] = await q<{ login_id: string }>(`SELECT login_id FROM staff WHERE id = $1`, [id]);
      const response = await request(app.getHttpServer()).post('/auth/login').send({ loginId: staff.login_id, password }).expect(201);
      return response.body.accessToken as string;
    };
    managerToken = await login(managerId);
    limitedToken = await login(limitedId);
    teacherToken = await login(teacherId);
    const [wageRequest] = await q<{ id: string }>(
      `INSERT INTO req (staff_id, req_type, payload)
       VALUES ($1, 'wage_change', '{"from":45000,"to":50000,"reason":"sdir-fixture-private"}'::jsonb)
       RETURNING id`,
      [teacherId],
    );
    const [retiredGpaRequest] = await q<{ id: string }>(
      `INSERT INTO req (staff_id, req_type, payload)
       VALUES ($1, 'gpa_request', '{"message":"sdir-fixture-retired"}'::jsonb)
       RETURNING id`,
      [teacherId],
    );
    reqIds.push(Number(wageRequest.id), Number(retiredGpaRequest.id));
    const [unavailable] = await q<{ id: string }>(
      `INSERT INTO unav (staff_id, cycle, dow, on_date, start_min, end_min, reason)
       VALUES ($1, 0, 1, (current_date + 20), 600, 660, 'sdir-fixture-unavailable') RETURNING id`,
      [teacherId],
    );
    unavIds.push(Number(unavailable.id));
  });

  afterAll(async () => {
    if (db) {
      if (unavIds.length) await q(`DELETE FROM unav WHERE id = ANY($1::bigint[])`, [unavIds]);
      if (reqIds.length) await q(`DELETE FROM req WHERE id = ANY($1::bigint[])`, [reqIds]);
      if (serIds.length) await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1::bigint[])`, [serIds]);
      if (serIds.length) await q(`DELETE FROM ser WHERE id = ANY($1::bigint[])`, [serIds]);
      if (studentIds.length) await q(`DELETE FROM stu WHERE id = ANY($1::bigint[])`, [studentIds]);
      if (logIds.length) await q(`DELETE FROM log WHERE id = ANY($1::bigint[])`, [logIds]);
      if (payoutIds.length) await q(`DELETE FROM payout WHERE id = ANY($1::bigint[])`, [payoutIds]);
      if (wageIds.length) await q(`DELETE FROM wage WHERE id = ANY($1::bigint[])`, [wageIds]);
      if (ids.length) await q(`DELETE FROM staff WHERE id = ANY($1::bigint[])`, [ids]);
      const [left] = await q<{ n: string }>(`SELECT count(*)::text AS n FROM staff WHERE login_id LIKE 'sdir-fixture-%'`);
      expect(Number(left.n)).toBe(0);
    }
    if (app) await app.close();
  });

  it('권한·최신 등록 순·상태 검색·페이지가 HTTP에서 맞다', async () => {
    await request(app.getHttpServer()).get('/drawer/staff-directory').set('Authorization', `Bearer ${teacherToken}`).expect(403);
    const list = await request(app.getHttpServer())
      .get('/drawer/staff-directory?search=sdir-fixture-&state=all').set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items.map((r: { id: number }) => r.id)).toEqual([teacherId, olderId]);
    expect(list.body.items[0]).toMatchObject({ englishName: null, active: true });
    const active = await request(app.getHttpServer())
      .get('/drawer/staff-directory?search=sdir-fixture-&state=active').set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(active.body.items.map((r: { id: number }) => r.id)).toEqual([teacherId]);
    await request(app.getHttpServer()).get('/drawer/staff-directory?page=0').set('Authorization', `Bearer ${managerToken}`).expect(400);
  });

  it('상세에서 급여 권한과 감사 JSON 원문을 가린다', async () => {
    await request(app.getHttpServer()).get(`/drawer/staff-directory/${teacherId}`)
      .set('Authorization', `Bearer ${teacherToken}`).expect(403);
    const full = await request(app.getHttpServer()).get(`/drawer/staff-directory/${teacherId}`)
      .set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(full.body.profile.id).toBe(teacherId);
    expect(full.body.wages).toMatchObject([{ rate: 45000 }]);
    expect(full.body.payouts).toMatchObject([{ net: 450000 }]);
    expect(full.body.audit[0]).toMatchObject({
      actorName: 'sdir-fixture-manager',
      changes: [{ field: '이름', before: '이전', after: '신규' }],
      privateFields: expect.arrayContaining(['이메일', '급여', '기타 변경']),
    });
    expect(full.body.audit[1]).toMatchObject({ id: Number(logIds[1]), actionLabel: '사용 중지' });
    for (const value of ['old-private@example.test', 'new-private@example.test', 'SECRET_BEFORE', 'SECRET_AFTER', '123456']) {
      expect(JSON.stringify(full.body.audit)).not.toContain(value);
    }
    const hidden = await request(app.getHttpServer()).get(`/drawer/staff-directory/${teacherId}`)
      .set('Authorization', `Bearer ${limitedToken}`).expect(200);
    expect(hidden.body.wageAccess).toBe(false);
    expect(hidden.body.wages).toEqual([]);
    expect(hidden.body.payouts).toEqual([]);
  });

  it('전월 히스토리와 들어온 것 8종을 targetStaff로 읽고 실제 actor 권한으로 금액을 가린다', async () => {
    const fullHistory = await request(app.getHttpServer()).get(`/drawer/staff-directory/${teacherId}/history`)
      .set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(fullHistory.body).toMatchObject({ month: previousMonthKst(), wageAccess: true, wageRate: 45000 });
    expect(fullHistory.body.settlement).not.toBeNull();

    const hiddenHistory = await request(app.getHttpServer()).get(`/drawer/staff-directory/${teacherId}/history`)
      .set('Authorization', `Bearer ${limitedToken}`).expect(200);
    expect(hiddenHistory.body).toMatchObject({ month: previousMonthKst(), wageAccess: false, wageRate: null, wageFrom: null, settlement: null });
    expect(hiddenHistory.body.lessons.every((lesson: Record<string, unknown>) =>
      lesson.pay === null && lesson.lateCut === null && lesson.penaltyIfNow === null && lesson.bonus === null)).toBe(true);

    const inbox = await request(app.getHttpServer()).get(`/drawer/staff-directory/${teacherId}/inbox`)
      .set('Authorization', `Bearer ${limitedToken}`).expect(200);
    expect(inbox.body.categories.map((row: { key: string }) => row.key)).toEqual([
      'report', 'schedule_change', 'book_change', 'unavailable',
      'material_request', 'tz_change', 'wage_change', 'suggestion',
    ]);
    expect(inbox.body.items).toHaveLength(2);
    expect(inbox.body.items.every((row: { byId: number }) => row.byId === teacherId)).toBe(true);
    expect(inbox.body.items.find((row: { category: string }) => row.category === 'wage_change')).toMatchObject({
      sub: null, asked: null, reason: null, canAct: false, actBlockedReason: '시급 조회 권한이 없습니다',
    });
    expect(inbox.body.items.find((row: { category: string }) => row.category === 'unavailable')).toMatchObject({
      sourceKind: 'unav', canAct: false,
    });
    expect(JSON.stringify(inbox.body)).not.toContain('sdir-fixture-private');
    expect(JSON.stringify(inbox.body)).not.toContain('sdir-fixture-retired');
  });

  it('현재 배정에는 시작 전·종료 후 규칙을 빼고 종료 당일 규칙·오늘 명단만 남긴다', async () => {
    const today = todayKst();
    const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400_000).toISOString().slice(0, 10);
    const [{ key }] = await q<{ key: string }>(`SELECT key FROM kind WHERE key = 'class'`);
    expect(key).toBe('class');
    const series = await q<{ id: string; title: string }>(
       `INSERT INTO ser (kind_key, teacher_id, mode, start_min, end_min, rrule, from_date, to_date, title)
       VALUES ($1,$2,'offline',600,660,'WEEKLY:MO',$3::date,$4::date,'sdir-fixture-ended'),
              ($1,$2,'offline',660,720,'WEEKLY:TU',$3::date,$5::date,'sdir-fixture-today'),
              ($1,$2,'offline',720,780,'WEEKLY:WE',$3::date,NULL,'sdir-fixture-open'),
              ($1,$2,'offline',780,840,'WEEKLY:TH',$6::date,NULL,'sdir-fixture-future')
       RETURNING id, title`, [key, teacherId, day(-30), day(-1), today, day(1)],
    );
    const idOf = (title: string) => Number(series.find((row) => row.title === `sdir-fixture-${title}`)!.id);
    const ended = idOf('ended');
    const endingToday = idOf('today');
    const ongoing = idOf('open');
    const futureSeries = idOf('future');
    serIds.push(ended, endingToday, ongoing, futureSeries);
    const students = await q<{ id: string; name: string }>(
      `INSERT INTO stu (name, grade) VALUES ('sdir-fixture-current','10'), ('sdir-fixture-past','10'), ('sdir-fixture-future','10') RETURNING id, name`,
    );
    const studentIdOf = (name: string) => Number(students.find((row) => row.name === `sdir-fixture-${name}`)!.id);
    const current = studentIdOf('current');
    const past = studentIdOf('past');
    const future = studentIdOf('future');
    studentIds.push(current, past, future);
    await q(
      `INSERT INTO ser_stu (ser_id, student_id, from_date, to_date)
       VALUES ($1,$2,NULL,NULL), ($1,$3,NULL,$5::date), ($1,$4,$6::date,NULL)`,
      [ongoing, current, past, future, day(-1), day(1)],
    );
    const result = await request(app.getHttpServer()).get(`/drawer/staff-directory/${teacherId}`)
      .set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(result.body.assignments.map((row: { id: number }) => row.id)).toEqual([ongoing, endingToday]);
    expect(result.body.assignments[0].studentNames).toEqual(['sdir-fixture-current']);
    expect(result.body.assignments[1].toDate).toBe(today);
  });
});
