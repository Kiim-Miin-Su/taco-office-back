/** @file-guide
 * 목적: staff-wage-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * C97 — §17 「+ 구성원」 · 시급 직접 수정 (테스트 시나리오 D-41 「신규 강사 등록」 · D-48 「시급 변경」 · I-8 「과거 정산 불변」).
 * 실제 HTTP(권한 가드 · DTO 검증)와 격리 DB 로 돈다. 이 스위트 전용 staff 981~984 · stu 9981 을 쓴다.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Lead } from '../src/entities';
import { DrawerService } from '../src/modules/drawer/drawer.service';
import { wageRateAt } from '../src/lib/wage';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('C97 구성원 추가 · 시급 직접 수정 (D-41 · D-48 · I-8)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  let managerToken = '';
  let teacherToken = '';
  const PW = 'staff-wage-1234';
  const CEO = 981;
  const MANAGER = 982;
  const TEACHER = 983; // 시급 40,000 (2026-01-01 부터)
  const RETIRED = 984; // 비활성
  const STU = 9981;
  const NEW_EMAIL = 'new-teacher-c97@t.kr';

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const monthOf = (iso: string) => iso.slice(0, 7);
  const prevMonthMonday = () => {
    const first = `${plus(`${monthOf(kst())}-01`, -1).slice(0, 7)}-01`;
    let d0 = first;
    for (let i = 0; i < 7; i++) {
      if (new Date(`${d0}T00:00:00Z`).getUTCDay() === 1) return d0;
      d0 = plus(d0, 1);
    }
    return d0;
  };
  const TODAY = kst();
  const PREV_MON = prevMonthMonday();
  const PREV = monthOf(PREV_MON);
  const ids = [CEO, MANAGER, TEACHER, RETIRED];
  const made: number[] = [];

  const cleanupNewStaff = async () => {
    const rows = await q<{ id: string }>(`SELECT id FROM staff WHERE lower(email) = $1`, [NEW_EMAIL]);
    for (const r of rows) {
      await q(`DELETE FROM wage WHERE staff_id = $1`, [r.id]);
      await q(`DELETE FROM noti WHERE to_id = $1 OR from_id = $1`, [r.id]);
      await q(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = $1`, [r.id]);
      await q(`DELETE FROM staff WHERE id = $1`, [r.id]);
    }
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);
    await cleanupNewStaff();
    await q(`DELETE FROM payout WHERE staff_id = ANY($1)`, [ids]);
    await q(`DELETE FROM req WHERE staff_id = ANY($1)`, [ids]);
    await q(`DELETE FROM wage WHERE staff_id = ANY($1)`, [ids]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [ids]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'시급대표','sw-ceo@t.kr','ceo',$5,true),
         ($2,'시급매니저','sw-m@t.kr','manager',$5,true),
         ($3,'시급강사','sw-t@t.kr','teacher',$5,true),
         ($4,'그만둔강사','sw-r@t.kr','teacher',$5,false)`,
      [CEO, MANAGER, TEACHER, RETIRED, hash],
    );
    await q(`INSERT INTO wage (staff_id, rate, from_date, reason) VALUES ($1, 40000, '2026-01-01', '기준')`, [TEACHER]);
    await q(`DELETE FROM stu WHERE id = $1`, [STU]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'시급학생','10')`, [STU]);
    await q(`INSERT INTO tzg (id, name, tz) VALUES (1,'한국 (KST)','Asia/Seoul'), (2,'미국 동부','America/New_York') ON CONFLICT (id) DO NOTHING`);
    const login = async (email: string, pw = PW) => {
      const res = await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 }).send({ email, password: pw }).expect(201);
      return res.body.accessToken as string;
    };
    ceoToken = await login('sw-ceo@t.kr');
    managerToken = await login('sw-m@t.kr');
    teacherToken = await login('sw-t@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await cleanupNewStaff();
        if (made.length) {
          await q(`DELETE FROM att WHERE ser_id = ANY($1)`, [made]);
          await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [made]);
          await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [made]);
          await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [made]);
          await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [made]);
          await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [made]);
          await q(`DELETE FROM ser WHERE id = ANY($1)`, [made]);
        }
        await q(`DELETE FROM payout WHERE staff_id = ANY($1)`, [ids]);
        await q(`DELETE FROM req WHERE staff_id = ANY($1)`, [ids]);
        await q(`DELETE FROM wage WHERE staff_id = ANY($1)`, [ids]);
        await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
        await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [ids]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
        await q(`DELETE FROM stu WHERE id = $1`, [STU]);
      }
    } finally {
      await app?.close();
    }
  });

  const api = (m: 'post' | 'get' | 'patch', p: string, t = managerToken) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`).timeout({ response: 8000, deadline: 15000 });

  /* ── D-41 ─────────────────────────────────────────────────────────────── */
  it('D-41 「+ 구성원」 — 강사 계정이 서고 바로 로그인되며, 비밀번호는 해시로만 남고 응답에 없다 · 시급을 적으면 같은 트랜잭션에 WAGE 한 줄(입사일이 지났으면 오늘부터)', async () => {
    const res = await api('post', '/drawer/staff').send({
      name: ' 박수진 ', email: NEW_EMAIL.toUpperCase(), password: 'first-pw-1234', role: 'teacher', title: '영어', tz: 'America/New_York',
      hiredOn: plus(TODAY, -30), wageRate: 42000,
    }).expect(201);
    expect(res.body).toMatchObject({ name: '박수진', email: NEW_EMAIL, role: 'teacher', title: '영어', tz: 'America/New_York', active: true, wageRate: 42000, wageFrom: TODAY });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|first-pw/i);
    const [row] = await q<{ password_hash: string; hired_on: string }>(`SELECT password_hash, to_char(hired_on,'YYYY-MM-DD') AS hired_on FROM staff WHERE id = $1`, [res.body.id]);
    expect(row.password_hash).not.toContain('first-pw');
    expect(await bcrypt.compare('first-pw-1234', row.password_hash)).toBe(true);
    expect(row.hired_on).toBe(plus(TODAY, -30));
    // 그 계정으로 바로 들어온다 — 강사 화면
    const login = await request(app.getHttpServer()).post('/auth/login').send({ email: NEW_EMAIL, password: 'first-pw-1234' }).expect(201);
    expect(login.body.me?.role ?? login.body.user?.role ?? login.body.role).toBe('teacher');
    const wages = await q<{ rate: string; from_date: string; reason: string; approved_by: string }>(
      `SELECT rate, to_char(from_date,'YYYY-MM-DD') AS from_date, reason, approved_by FROM wage WHERE staff_id = $1`, [res.body.id]);
    expect(wages).toEqual([expect.objectContaining({ from_date: TODAY, reason: '입사' })]);
    expect(Number(wages[0].rate)).toBe(42000);
    expect(Number(wages[0].approved_by)).toBe(MANAGER);
    const [log] = await q<{ after: Record<string, unknown> }>(`SELECT after FROM log WHERE entity = 'STAFF' AND entity_id = $1 AND action = 'create'`, [res.body.id]);
    expect(log.after).toMatchObject({ role: 'teacher', wageRate: 42000, wageFrom: TODAY });
    // 서랍 §17 — 볼 수 있는 사람(canWage)에게만 시급이 실린다
    const drawer = (await api('get', '/drawer').expect(200)).body;
    expect(drawer).toMatchObject({ canAddMember: true, canWage: true });
    const me = drawer.members.find((m: { id: number }) => m.id === res.body.id);
    expect(me).toMatchObject({ name: '박수진', wageRate: 42000, wageFrom: TODAY, wageable: true });
    // 「시급 수정」이 서는 줄은 표가 가른다 — 매니저·비활성 강사에는 서지 않고, 강사가 보면 아무 줄에도 서지 않는다 (D-R39)
    expect(drawer.members.find((m: { id: number }) => m.id === MANAGER)).toMatchObject({ wageable: false, wageRate: null });
    expect(drawer.members.find((m: { id: number }) => m.id === RETIRED)).toMatchObject({ wageable: false });
    const asTeacher = (await api('get', '/drawer', teacherToken).expect(200)).body;
    expect(asTeacher).toMatchObject({ canAddMember: false, canWage: false });
    expect(asTeacher.members.every((m: { wageable?: boolean; wageRate?: number | null }) => m.wageable === false && m.wageRate === null)).toBe(true);
  });

  it('구성원 추가의 거절 — 같은 이메일 409 · 모르는 시간대 409 · 대표·관리자 역할은 DTO 가 400 · 짧은 비밀번호 400 · 강사 403', async () => {
    await api('post', '/drawer/staff').send({ name: '중복', email: NEW_EMAIL, password: 'another-pw-1', role: 'manager' }).expect(409)
      .expect((r) => expect(r.body.code).toBe('STAFF_EMAIL_TAKEN'));
    await api('post', '/drawer/staff').send({ name: '화성', email: 'mars-c97@t.kr', password: 'another-pw-1', role: 'teacher', tz: 'Mars/Olympus' }).expect(409)
      .expect((r) => expect(r.body.code).toBe('TZ_UNKNOWN'));
    await api('post', '/drawer/staff').send({ name: '대표', email: 'ceo2-c97@t.kr', password: 'another-pw-1', role: 'ceo' }).expect(400);
    await api('post', '/drawer/staff').send({ name: '관리', email: 'adm2-c97@t.kr', password: 'another-pw-1', role: 'admin' }).expect(400);
    await api('post', '/drawer/staff').send({ name: '짧음', email: 'short-c97@t.kr', password: '1234567', role: 'teacher' }).expect(400);
    await api('post', '/drawer/staff', teacherToken).send({ name: '강사가', email: 't-c97@t.kr', password: 'another-pw-1', role: 'teacher' }).expect(403);
    // 거절은 아무것도 남기지 않는다
    expect(await q(`SELECT id FROM staff WHERE email IN ('mars-c97@t.kr','ceo2-c97@t.kr','adm2-c97@t.kr','short-c97@t.kr','t-c97@t.kr')`)).toEqual([]);
    // 서비스로 곧장 불러도 역할 밖은 DTO 가 아니라 표(role_t)가 막는다 — 값이 enum 밖이면 22P02
    const svc = new DrawerService(ds.getRepository(Lead));
    await expect(svc.createStaff(MANAGER, true, { name: 'x', email: 'x-c97@t.kr', password: 'another-pw-1', role: 'nope' })).rejects.toBeTruthy();
    expect(await q(`SELECT id FROM staff WHERE email = 'x-c97@t.kr'`)).toEqual([]);
  });

  /* ── D-48 · I-8 ───────────────────────────────────────────────────────── */
  it('D-48 시급 직접 수정 — 오늘부터 새 줄 · 같은 날 두 번 409 · 과거 409 · 미래는 예약 · 이력은 내림차순이고 「지금」은 오늘 이하의 마지막 줄 · 강사에게 알림', async () => {
    const before = (await api('get', `/accounting/wages?staffId=${TEACHER}`).expect(200)).body;
    expect(before.rows.map((r: { rate: number; current: boolean }) => [r.rate, r.current])).toEqual([[40000, true]]);

    const res = await api('post', '/accounting/wages').send({ staffId: TEACHER, rate: 45000, reason: ' 3년차 ' }).expect(201);
    expect(res.body).toMatchObject({ staffId: TEACHER, staffName: '시급강사', rate: 45000, fromDate: TODAY, reason: '3년차', approvedByName: '시급매니저', current: true });
    await api('post', '/accounting/wages').send({ staffId: TEACHER, rate: 46000 }).expect(409).expect((r) => expect(r.body.code).toBe('WAGE_SAME_DAY'));
    await api('post', '/accounting/wages').send({ staffId: TEACHER, rate: 46000, fromDate: plus(TODAY, -1) }).expect(409).expect((r) => expect(r.body.code).toBe('WAGE_RETROACTIVE'));
    const future = await api('post', '/accounting/wages').send({ staffId: TEACHER, rate: 47000, fromDate: plus(TODAY, 7) }).expect(201);
    expect(future.body).toMatchObject({ rate: 47000, fromDate: plus(TODAY, 7), current: false });
    await api('post', '/accounting/wages').send({ staffId: RETIRED, rate: 30000 }).expect(409).expect((r) => expect(r.body.code).toBe('STAFF_INACTIVE'));
    await api('post', '/accounting/wages').send({ staffId: 999999, rate: 30000 }).expect(404);
    await api('post', '/accounting/wages', teacherToken).send({ staffId: TEACHER, rate: 99000 }).expect(403);
    await api('get', `/accounting/wages?staffId=${TEACHER}`, teacherToken).expect(403);

    const after = (await api('get', `/accounting/wages?staffId=${TEACHER}`, ceoToken).expect(200)).body;
    expect(after.rows.map((r: { rate: number; fromDate: string; current: boolean }) => [r.rate, r.fromDate, r.current]))
      .toEqual([[47000, plus(TODAY, 7), false], [45000, TODAY, true], [40000, '2026-01-01', false]]);
    // 회차의 시급과 같은 정의 — 지난 날짜는 옛 줄, 오늘은 새 줄, 예약일 뒤는 예약 줄
    expect(await wageRateAt(ds, TEACHER, PREV_MON)).toBe(40000);
    expect(await wageRateAt(ds, TEACHER, TODAY)).toBe(45000);
    expect(await wageRateAt(ds, TEACHER, plus(TODAY, 7))).toBe(47000);
    const notis = await q<{ body: string; category: string }>(`SELECT body, category FROM noti WHERE to_id = $1 ORDER BY id`, [TEACHER]);
    expect(notis.map((n) => n.body)).toEqual([
      expect.stringContaining(`45,000원 로 바뀝니다 — ${TODAY} 수업부터 · 3년차`),
      expect.stringContaining(`47,000원 로 바뀝니다 — ${plus(TODAY, 7)} 수업부터`),
    ]);
    // 서랍 §17 의 「지금 시급」도 같은 판정 — 예약 줄이 아니라 오늘 줄
    const drawer = (await api('get', '/drawer').expect(200)).body;
    expect(drawer.members.find((m: { id: number }) => m.id === TEACHER)).toMatchObject({ wageRate: 45000, wageFrom: TODAY });
  });

  it('I-8 과거 정산 불변 — 지난달 시트는 그때 시급으로 그대로이고, 승인 경로(C41)도 같은 함수라 같은 날 두 번은 409 다', async () => {
    // 지난달 ONCE 수업 + 리포트 → 시트 gross 는 그때 시급 40,000
    const res = await api('post', '/schedule', ceoToken).send({
      kindKey: 'class', subKey: null, mode: 'offline', fromDate: PREV_MON, rrule: 'ONCE',
      startMin: 540, endMin: 600, teacherId: TEACHER, roomId: null, title: '시급 수업', studentIds: [STU],
    }).expect(201);
    const serId = res.body.serIds[0] as number;
    made.push(serId);
    await api('post', `/reports/${serId}/${PREV_MON}/submit`, teacherToken)
      .send({ content: '이번 수업에서 다룬 내용을 사실대로 적는다', progress: '교재 12쪽까지', homework: '13~14쪽 풀어 오기' }).expect(201);
    const sheet = async () => (await api('get', `/accounting/payouts?month=${PREV}`, ceoToken).expect(200)).body.rows.find((r: { staffId: number }) => r.staffId === TEACHER);
    const row = await sheet();
    // 앞 시험이 오늘 45,000 · 예약 47,000 을 적어 둔 뒤에도 지난달 회차는 40,000 이다
    expect(row).toMatchObject({ writtenCount: 1, gross: 40000 });
    // 오늘 한 번 더 바꾸려는 승인(C41 경로) — 직접 수정과 같은 함수라 같은 날 409 · 시트도 그대로
    const [req] = await q<{ id: string }>(`INSERT INTO req (staff_id, req_type, payload) VALUES ($1,'wage_change',$2::jsonb) RETURNING id`, [TEACHER, JSON.stringify({ from: 45000, to: 48000 })]);
    await api('post', `/drawer/requests/${req.id}/review`, ceoToken).send({ decision: 'approve' }).expect(409).expect((r) => expect(r.body.code).toBe('WAGE_SAME_DAY'));
    expect(await sheet()).toMatchObject({ gross: 40000 });
    expect(await wageRateAt(ds, TEACHER, TODAY)).toBe(45000);
  });
});
