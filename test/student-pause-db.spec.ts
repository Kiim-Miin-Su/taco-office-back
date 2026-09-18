/** @file-guide
 * 목적: student-pause-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 휴원 · 복귀 — C92-c (테스트 시나리오 C-36 「장기 휴원」 · C-37 「복귀」).
 *
 * 증명하는 것 —
 *   ① 휴원 기간 안의 회차는 **시간표(학생별)에서 빠지고** 명단에는 「휴원」으로 남는다. 회차는 지워지지 않는다.
 *   ② 「빠지는 회차 수」는 서버가 센다 — 그날만 빠진 회차는 두 번 세지 않는다 (D-R37).
 *   ③ 같은 학생의 기간이 겹치면 409 PAUSE_OVERLAP — DB EXCLUDE 가 막고 필터가 번역한다.
 *   ④ 복귀는 종료일을 복귀 전날로 당기고 누가·언제를 남긴다 — 복귀일부터 회차가 돌아오고 기간은 이력이다.
 *   ⑤ 거절 — 종료일 < 시작일 · 복귀일 ≤ 시작일 · 원래 종료일 뒤 복귀 · 두 번 복귀 · 남의 휴원 id · 없는 학생.
 *   ⑥ 강사(canCrudAll 없음)는 휴원을 못 잡는다 (D-R39).
 *   ⑦ LOG 에 STU_PAUSE create/resume 이 같은 트랜잭션으로 남는다.
 *
 * ⚠ 이 파일은 **표를 비우지 않는다.** 스위트 전용 번호대로 만들고 스스로 치운다.
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

d('휴원 · 복귀 (C92-c · C-36 · C-37)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let teacherToken = '';
  const PW = 'student-pause-1234';
  const CEO = 941;
  const TEACHER = 942;
  const STU_A = 9941;
  const STU_B = 9942;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER]]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'휴원대표','pause-ceo@t.kr','ceo',$3,true),
         ($2,'휴원강사','pause-t@t.kr','teacher',$3,true)`,
      [CEO, TEACHER, hash],
    );
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B]]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'휴원학생A','10'), ($2,'휴원학생B','10')`, [STU_A, STU_B]);
    const login = async (email: string) => {
      const res = await request(app.getHttpServer())
        .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    token = await login('pause-ceo@t.kr');
    teacherToken = await login('pause-t@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER]]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER]]);
        await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B]]);
      }
    } finally {
      await app?.close();
    }
  });

  const made: number[] = [];
  afterEach(async () => {
    // stu_pause 는 stu ON DELETE CASCADE 지만 학생은 스위트 끝에만 지우므로 기록은 여기서 치운다
    await q(`DELETE FROM stu_pause WHERE student_id = ANY($1)`, [[STU_A, STU_B]]);
    await q(`DELETE FROM log WHERE actor_id = $1`, [CEO]);
    if (!made.length) return;
    await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [made]);
    await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id = ANY($1))`, [made]);
    await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser WHERE id = ANY($1)`, [made]);
    made.length = 0;
  });

  const api = (m: 'post' | 'patch' | 'delete' | 'get', p: string, t = token) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`)
      .timeout({ response: 5000, deadline: 10000 });

  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const nextMon = (iso: string) => {
    let d0 = iso;
    for (let i = 0; i < 7; i++) {
      if (new Date(`${d0}T00:00:00Z`).getUTCDay() === 1) return d0;
      d0 = plus(d0, 1);
    }
    return d0;
  };

  /** 이 스위트 강사의 월요일 주간 수업 — 다음 주 월요일부터. 학생 A(+B) */
  async function makeSer(startMin: number, studentIds: number[] = [STU_A]) {
    const from = nextMon(plus(kst(), 7));
    const res = await api('post', '/schedule')
      .send({
        kindKey: 'class', subKey: null, mode: 'offline',
        fromDate: from, rrule: 'WEEKLY:MO',
        startMin, endMin: startMin + 60, teacherId: TEACHER, roomId: null,
        title: '휴원 테스트', studentIds,
      })
      .expect(201);
    const id = res.body.serIds[0] as number;
    made.push(id);
    return { id, from };
  }

  const pause = (studentId: number, body: Record<string, unknown>, t = token) =>
    api('post', `/schedule/students/${studentId}/pause`, t).send(body);
  const resume = (studentId: number, pauseId: number, body: Record<string, unknown>) =>
    api('post', `/schedule/students/${studentId}/pause/${pauseId}/resume`).send(body);
  const occurrences = async (from: string, to: string, extra = '') => {
    const res = await api('get', `/schedule/occurrences?from=${from}&to=${to}${extra}`).expect(200);
    return res.body.items as Array<{ serId: number; onDate: string; students: Array<{ id: number; paused: boolean }> }>;
  };

  /* ── ① 휴원 기간의 회차는 시간표에서 빠지고 명단에 「휴원」으로 남는다 ────── */
  it('휴원 기간 안의 회차는 학생별 시간표에서 빠지고 명단은 paused 로 남는다 — 회차는 그대로다 (C-36)', async () => {
    const { id, from } = await makeSer(600);
    const second = plus(from, 7);
    const third = plus(from, 14);
    const res = await pause(STU_A, { fromDate: second, toDate: second, reason: '가족 여행' }).expect(201);
    expect(res.body).toMatchObject({ studentId: STU_A, fromDate: second, toDate: second, reason: '가족 여행', resumed: false, resumedAt: null });
    // 그 주 하나만 빠진다 — 첫째·셋째 주는 그대로
    expect(res.body.affected).toBe(1);

    // 회차는 지워지지 않았다 — 전체 시간표에는 셋 다 있고 둘째 주 명단만 휴원
    const all = (await occurrences(from, third)).filter((o) => o.serId === id);
    expect(all.map((o) => o.onDate)).toEqual([from, second, third]);
    expect(all.map((o) => o.students.find((s) => s.id === STU_A)?.paused)).toEqual([false, true, false]);

    // 학생별 시간표에서는 둘째 주가 빠진다 — 「그 기간 일정이 시간표에서 빠진다」
    const mine = (await occurrences(from, third, `&studentId=${STU_A}`)).filter((o) => o.serId === id);
    expect(mine.map((o) => o.onDate)).toEqual([from, third]);

    // DB 에 그 세 회차가 그대로다 (투영은 지평선까지 더 있다)
    const [{ n }] = await q<{ n: string }>(
      `SELECT count(*) AS n FROM ser_occ WHERE ser_id = $1 AND on_date BETWEEN $2::date AND $3::date`, [id, from, third],
    );
    expect(Number(n)).toBe(3);
  });

  it('학생 트래킹은 「휴원」과 기간을 함께 준다 — 정원·단가는 휴원 학생을 빼고 센다', async () => {
    const { id, from } = await makeSer(660, [STU_A, STU_B]);
    const second = plus(from, 7);
    const p = await pause(STU_A, { fromDate: second, toDate: null }).expect(201);
    expect(p.body.toDate).toBeNull();

    const onPaused = await api('get', `/schedule/tracking?serId=${id}&onDate=${second}`).expect(200);
    const a = onPaused.body.students.find((s: { id: number }) => s.id === STU_A);
    const b = onPaused.body.students.find((s: { id: number }) => s.id === STU_B);
    expect(a.paused).toBe(true);
    expect(a.pause).toMatchObject({ id: p.body.id, fromDate: second, toDate: null, resumed: false });
    expect(b.paused).toBe(false);
    expect(b.pause).toBeNull();
    // 그날 인원은 B 하나 — 휴원 학생은 명단에 있어도 그날 인원이 아니다
    expect(onPaused.body.count).toBe(1);

    // 휴원 전 회차에서는 둘 다 서지만, 카드에는 앞으로 잡힌 휴원이 보인다 (「휴원 9/1~」)
    const before = await api('get', `/schedule/tracking?serId=${id}&onDate=${from}`).expect(200);
    const a0 = before.body.students.find((s: { id: number }) => s.id === STU_A);
    expect(a0.paused).toBe(false);
    expect(a0.pause?.id).toBe(p.body.id);
    expect(before.body.count).toBe(2);
  });

  /* ── ② 서버가 센다 ────────────────────────────────────────────────────── */
  it('빠지는 회차 수는 서버가 센다 — 무기한이면 투영 끝까지, 그날만 빠진 회차는 두 번 세지 않는다 (D-R37)', async () => {
    const { id, from } = await makeSer(720);
    const second = plus(from, 7);
    // 둘째 주는 이미 「그날만 빠짐」
    await api('patch', `/schedule/${id}/roster`).send({ op: 'dropOnce', onDate: second, studentId: STU_A }).expect(200);
    const [{ n }] = await q<{ n: string }>(
      `SELECT count(*) AS n FROM ser_occ WHERE ser_id = $1 AND on_date >= $2::date`, [id, from],
    );
    const res = await pause(STU_A, { fromDate: from }).expect(201);
    expect(res.body.affected).toBe(Number(n) - 1);
  });

  /* ── ③ 겹침은 DB 가 막는다 ────────────────────────────────────────────── */
  it('같은 학생의 기간이 겹치면 409 PAUSE_OVERLAP — 무기한 휴원 뒤에는 아무 기간도 못 잡는다', async () => {
    const today = kst();
    await pause(STU_A, { fromDate: plus(today, 10), toDate: plus(today, 20) }).expect(201);
    const res = await pause(STU_A, { fromDate: plus(today, 20), toDate: plus(today, 30) }).expect(409);
    expect(res.body.code).toBe('PAUSE_OVERLAP');
    // 안 겹치면 된다 — 다른 학생도 상관없다
    await pause(STU_A, { fromDate: plus(today, 21), toDate: plus(today, 30) }).expect(201);
    await pause(STU_B, { fromDate: plus(today, 10), toDate: plus(today, 20) }).expect(201);
    // 무기한 뒤
    await pause(STU_B, { fromDate: plus(today, 40) }).expect(201);
    const after = await pause(STU_B, { fromDate: plus(today, 400), toDate: plus(today, 401) }).expect(409);
    expect(after.body.code).toBe('PAUSE_OVERLAP');
    const [{ n }] = await q<{ n: string }>(`SELECT count(*) AS n FROM stu_pause WHERE student_id = ANY($1)`, [[STU_A, STU_B]]);
    expect(Number(n)).toBe(4);
  });

  /* ── ④ 복귀 ───────────────────────────────────────────────────────────── */
  it('복귀는 종료일을 복귀 전날로 당기고 누가·언제를 남긴다 — 복귀일부터 회차가 돌아온다 (C-37)', async () => {
    const { id, from } = await makeSer(780);
    const second = plus(from, 7);
    const third = plus(from, 14);
    const p = await pause(STU_A, { fromDate: from, reason: '장기 휴원' }).expect(201);
    expect(p.body.affected).toBeGreaterThanOrEqual(3);

    const r = await resume(STU_A, p.body.id, { resumeOn: third }).expect(201);
    expect(r.body).toMatchObject({ id: p.body.id, studentId: STU_A, fromDate: from, toDate: plus(third, -1), resumed: true });
    expect(typeof r.body.resumedAt).toBe('string');
    // 돌아오는 회차 — 셋째 주부터 투영 끝까지
    const [{ n }] = await q<{ n: string }>(
      `SELECT count(*) AS n FROM ser_occ WHERE ser_id = $1 AND on_date >= $2::date`, [id, third],
    );
    expect(r.body.affected).toBe(Number(n));

    const mine = (await occurrences(from, plus(third, 7), `&studentId=${STU_A}`)).filter((o) => o.serId === id);
    expect(mine.map((o) => o.onDate)).toEqual([third, plus(third, 7)]);
    const all = (await occurrences(from, third)).filter((o) => o.serId === id);
    expect(all.map((o) => o.students[0]?.paused)).toEqual([true, true, false]);
    expect(second).toBeDefined();

    // 기간은 이력으로 남는다 — 지워지지 않고 누가·언제가 같은 행에 있다
    const [row] = await q<{ to_date: string; resumed_by: string; resumed_at: Date | null; by_id: string }>(
      `SELECT to_date::text, resumed_by, resumed_at, by_id FROM stu_pause WHERE id = $1`, [p.body.id],
    );
    expect(row).toMatchObject({ to_date: plus(third, -1), resumed_by: String(CEO), by_id: String(CEO) });
    expect(row.resumed_at).not.toBeNull();

    // 복귀 뒤 트래킹 카드 — 기간은 보이되 복귀 단추의 근거(resumed)가 참
    const t = await api('get', `/schedule/tracking?serId=${id}&onDate=${second}`).expect(200);
    const a = t.body.students.find((s: { id: number }) => s.id === STU_A);
    expect(a.paused).toBe(true);
    expect(a.pause).toMatchObject({ id: p.body.id, resumed: true, toDate: plus(third, -1) });
  });

  it('복귀한 뒤에는 그 뒤 기간을 새로 잡을 수 있다 — 겹침이 풀린다', async () => {
    const today = kst();
    const p = await pause(STU_A, { fromDate: plus(today, 1) }).expect(201);
    await pause(STU_A, { fromDate: plus(today, 30), toDate: plus(today, 40) }).expect(409);
    await resume(STU_A, p.body.id, { resumeOn: plus(today, 10) }).expect(201);
    await pause(STU_A, { fromDate: plus(today, 30), toDate: plus(today, 40) }).expect(201);
  });

  /* ── ⑤ 거절 ───────────────────────────────────────────────────────────── */
  it('거절 — 종료일 < 시작일 · 복귀일 ≤ 시작일 · 원래 종료일 뒤 복귀 · 두 번 복귀 · 남의 휴원 · 없는 학생', async () => {
    const today = kst();
    const bad = await pause(STU_A, { fromDate: plus(today, 5), toDate: plus(today, 4) }).expect(400);
    expect(bad.body.code).toBe('BAD_RANGE');
    const none = await pause(99999999, { fromDate: plus(today, 5) }).expect(404);
    expect(none.body.code).toBe('STUDENT_NOT_FOUND');
    await pause(STU_A, { fromDate: 'not-a-date' }).expect(400);
    await pause(STU_A, { fromDate: plus(today, 5), reason: 'x'.repeat(201) }).expect(400);

    const p = await pause(STU_A, { fromDate: plus(today, 5), toDate: plus(today, 15) }).expect(201);
    const early = await resume(STU_A, p.body.id, { resumeOn: plus(today, 5) }).expect(400);
    expect(early.body.code).toBe('BAD_RANGE');
    const late = await resume(STU_A, p.body.id, { resumeOn: plus(today, 17) }).expect(400);
    expect(late.body.code).toBe('BAD_RANGE');
    const other = await resume(STU_B, p.body.id, { resumeOn: plus(today, 10) }).expect(404);
    expect(other.body.code).toBe('PAUSE_NOT_FOUND');
    // 종료일 당일까지의 복귀(= 종료일 + 1)는 된다 — 기간을 늘리지 않는다
    await resume(STU_A, p.body.id, { resumeOn: plus(today, 16) }).expect(201);
    const twice = await resume(STU_A, p.body.id, { resumeOn: plus(today, 10) }).expect(409);
    expect(twice.body.code).toBe('PAUSE_ALREADY_RESUMED');
    // 거절된 쓰기는 아무것도 안 남긴다
    const [row] = await q<{ to_date: string }>(`SELECT to_date::text FROM stu_pause WHERE id = $1`, [p.body.id]);
    expect(row.to_date).toBe(plus(today, 15));
  });

  /* ── ⑥ 권한 ───────────────────────────────────────────────────────────── */
  it('강사는 휴원을 못 잡는다 — canCrudAll (D-R39)', async () => {
    await pause(STU_A, { fromDate: plus(kst(), 5) }, teacherToken).expect(403);
    const [{ n }] = await q<{ n: string }>(`SELECT count(*) AS n FROM stu_pause WHERE student_id = $1`, [STU_A]);
    expect(Number(n)).toBe(0);
  });

  /* ── ⑦ LOG ────────────────────────────────────────────────────────────── */
  it('LOG 에 STU_PAUSE create · resume 이 남는다 — before/after 가 기간을 말한다', async () => {
    const today = kst();
    const p = await pause(STU_A, { fromDate: plus(today, 1), reason: '이사' }).expect(201);
    await resume(STU_A, p.body.id, { resumeOn: plus(today, 8) }).expect(201);
    const logs = await q<{ action: string; before: Record<string, unknown> | null; after: Record<string, unknown> }>(
      `SELECT action, before, after FROM log WHERE entity = 'STU_PAUSE' AND entity_id = $1 AND actor_id = $2 ORDER BY id`,
      [p.body.id, CEO],
    );
    expect(logs.map((l) => l.action)).toEqual(['create', 'resume']);
    expect(logs[0].before).toBeNull();
    expect(logs[0].after).toMatchObject({ studentId: STU_A, fromDate: plus(today, 1), toDate: null, reason: '이사' });
    expect(logs[1].before).toMatchObject({ toDate: null });
    expect(logs[1].after).toMatchObject({ toDate: plus(today, 7) });
  });
});
