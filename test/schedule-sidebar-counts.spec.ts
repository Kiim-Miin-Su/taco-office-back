/** @file-guide
 * 목적: schedule-sidebar-counts.spec.ts (test) — §07 사이드바 「일정 원본」 수 · §10 개인 머리 「교재 없음」
 * 책임/재사용: 실제 HTTP(권한 가드 · DTO 검증)와 격리 DB 로 돈다. 제품 규칙을 테스트에 다시 적지 않고 서버 응답만 견준다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 원문 §07 좌측 사이드바의 수(「수업 24 · 상담·진단 6 · 회의 5」 = v2 slide 05 「SER 일정 원본 35」)는
 * **보는 기간과 무관한 일정 원본(SER) 수**다 — §08·§09·§10·§11 컷도 같은 수를 적는다(D-R44 · w5-7 결정).
 * 지금까지는 화면이 그 기간의 회차를 세고 있었다(업무 수를 화면이 셌다). 서버가 센다.
 *
 * 「일정 원본」의 뜻: **오늘(KST) 이후에 놓일 날이 남은 SER** — 규칙상 날짜(ruleHits)가 남았거나,
 * 실제로 옮겨 놓인 회차가 오늘 이후인 것. 끝난 규칙·지난 단발·시작 전에 통째로 접힌 규칙은 세지 않는다.
 *
 * 이 스위트는 시드가 든 DB 에서 돈다 — 전체 수가 아니라 **이 스위트가 만든 줄만큼 늘었는가**를 본다.
 * 전용 staff 1051·1052 · stu 10051 · 교재 코드 `SIDEBAR-BOOK-%` 를 쓴다.
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

type Count = { key: string; count: number };
type Group = { grp: string; label: string; count: number; kinds: Count[] };
type Counts = { asOf: string; total: number; groups: Group[]; subs: Count[] };

d('§07 사이드바 일정 원본 수 · §10 「교재 없음」 (서버가 센다)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let teacherToken = '';
  const PW = 'sidebar-counts-1234';
  const CEO = 1051;
  const TEACHER = 1052;
  const STU = 10051;
  /** 시드에 SER 가 없는 종류·과목 — 늘어난 수가 곧 이 스위트의 줄이다 */
  const KIND = 'consult';
  const SUB = 'intake';

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const DOW = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const dowKey = (iso: string) => DOW[new Date(`${iso}T00:00:00Z`).getUTCDay()];

  const made: number[] = [];
  const get = (path: string, as = token) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${as}`)
      .timeout({ response: 5000, deadline: 10000 });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER]]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active)
       VALUES ($1,'사이드바대표','sidebar-ceo@t.kr','ceo',$3,true), ($2,'사이드바강사','sidebar-t@t.kr','teacher',$3,true)`,
      [CEO, TEACHER, hash],
    );
    await q(`DELETE FROM issue WHERE student_id = $1`, [STU]);
    await q(`DELETE FROM stu WHERE id = $1`, [STU]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1, '교재칩학생', 'K')`, [STU]);
    token = (await request(app.getHttpServer()).post('/auth/login')
      .send({ email: 'sidebar-ceo@t.kr', password: PW }).expect(201)).body.accessToken as string;
    teacherToken = (await request(app.getHttpServer()).post('/auth/login')
      .send({ email: 'sidebar-t@t.kr', password: PW }).expect(201)).body.accessToken as string;
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        if (made.length) {
          await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [made]);
          await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [made]);
          await q(`DELETE FROM ser WHERE id = ANY($1)`, [made]);
        }
        await q(`DELETE FROM log WHERE actor_id = $1`, [CEO]);
        await q(`DELETE FROM issue WHERE student_id = $1`, [STU]);
        await q(`DELETE FROM lib WHERE code LIKE 'SIDEBAR-BOOK-%'`);
        await q(`DELETE FROM stu WHERE id = $1`, [STU]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER]]);
      }
    } finally {
      await app?.close();
    }
  });

  /** 규칙 줄만 넣는다 — 수는 원본(SER)에서 나오므로 회차 투영이 없어도 된다 */
  async function ser(rrule: string, fromDate: string, toDate: string | null): Promise<number> {
    const [row] = await q<{ id: string }>(
      `INSERT INTO ser (kind_key, sub_key, teacher_id, room_id, mode, start_min, end_min, rrule, from_date, to_date, title)
       VALUES ($1, $2, NULL, NULL, 'offline', 600, 660, $3, $4::date, $5::date, '사이드바 수 시험') RETURNING id`,
      [KIND, SUB, rrule, fromDate, toDate],
    );
    made.push(Number(row.id));
    return Number(row.id);
  }
  const kindCount = (c: Counts, key: string) =>
    c.groups.flatMap((g) => g.kinds).find((k) => k.key === key)?.count ?? 0;
  const subCount = (c: Counts, key: string) => c.subs.find((s) => s.key === key)?.count ?? 0;
  const groupCount = (c: Counts, grp: string) => c.groups.find((g) => g.grp === grp)?.count ?? 0;

  it('보는 기간과 무관한 「일정 원본」 수 — 오늘 이후에 놓일 날이 남은 SER 만 센다', async () => {
    const today = kst();
    const before = (await get('/schedule/series-counts').expect(200)).body as Counts;

    await ser(`WEEKLY:MO,WE`, today, null); // ① 끝날 없는 반복 → 셈
    await ser(`WEEKLY:MO`, plus(today, -30), plus(today, -1)); // ② 어제 끝난 반복 → 안 셈
    await ser('ONCE', plus(today, -1), null); // ③ 어제 단발 → 안 셈
    await ser('ONCE', plus(today, 3), null); // ④ 사흘 뒤 단발 → 셈
    await ser(`WEEKLY:TU`, plus(today, 10), plus(today, 5)); // ⑤ 시작 전에 통째로 접힌 규칙 → 안 셈
    await ser(`WEEKLY:FR`, plus(today, 200), null); // ⑥ 투영 창 밖에서 시작하는 반복 → 셈(회차가 아직 없어도 원본이다)
    // ⑦ 끝날이 오늘인데 규칙 요일이 내일뿐 — 남은 날이 없다 → 안 셈 (요일 판정은 규칙 엔진이 한다)
    await ser(`WEEKLY:${dowKey(plus(today, 1))}`, plus(today, -14), today);
    // ⑧ 어제 단발을 「이번만」 내일로 옮겼다 — 실제 회차가 오늘 이후라 셈
    const moved = await ser('ONCE', plus(today, -1), null);
    await request(app.getHttpServer()).patch(`/schedule/${moved}`).set('Authorization', `Bearer ${token}`)
      .send({ scope: 'this', onDate: plus(today, -1), date: plus(today, 1) }).expect(200);

    const after = (await get('/schedule/series-counts').expect(200)).body as Counts;
    expect(after.asOf).toBe(today);
    expect(kindCount(after, KIND) - kindCount(before, KIND)).toBe(4);
    expect(subCount(after, SUB) - subCount(before, SUB)).toBe(4);
    expect(groupCount(after, 'intake') - groupCount(before, 'intake')).toBe(4);
    expect(after.total - before.total).toBe(4);
  });

  it('묶음·낱말·차례는 서버가 정한다 — 묶음 수 = 그 종류들의 합 · 합계 = 묶음의 합 · 과목은 1 이상만', async () => {
    const res = (await get('/schedule/series-counts').expect(200)).body as Counts;
    expect(res.groups.map((g) => [g.grp, g.label])).toEqual([['lesson', '수업'], ['intake', '상담·진단'], ['meeting', '회의']]);
    const kinds = await q<{ key: string; grp: string }>(`SELECT key, grp::text AS grp FROM kind ORDER BY sort, key`);
    for (const g of res.groups) {
      // 원문 §07 은 묶음 안의 종류를 전부 적는다(0 이어도 줄이 선다) — 코드표 차례 그대로
      expect(g.kinds.map((k) => k.key)).toEqual(kinds.filter((k) => k.grp === g.grp).map((k) => k.key));
      expect(g.count).toBe(g.kinds.reduce((n, k) => n + k.count, 0));
    }
    expect(res.total).toBe(res.groups.reduce((n, g) => n + g.count, 0));
    expect(res.subs.every((s) => s.count > 0)).toBe(true);
    const subOrder = await q<{ key: string }>(`SELECT key FROM sub WHERE active ORDER BY sort, key`);
    const order = subOrder.map((s) => s.key);
    expect(res.subs.map((s) => order.indexOf(s.key))).toEqual([...res.subs.map((s) => order.indexOf(s.key))].sort((a, b) => a - b));
  });

  it('강사는 이 사이드바가 없다 — 403', async () => {
    await get('/schedule/series-counts', teacherToken).expect(403);
  });

  it('§10 개인 머리 「교재 없음」 — 배부 완료(ISSUE ok) 교재가 없을 때만 서버가 낱말을 준다', async () => {
    const empty = await get(`/schedule/students/${STU}/books`).expect(200);
    expect(empty.body).toEqual({ studentId: STU, bookCount: 0, label: '교재 없음' });

    const [lib] = await q<{ id: string }>(
      `INSERT INTO lib (code, title, sub_key) VALUES ('SIDEBAR-BOOK-1', '교재칩 교재', 'writing') RETURNING id`,
    );
    // 승인 대기·전달 대기는 아직 학생 손에 없다 — §79 「교재 N」·§12 준비 「교재 배정」과 같은 판정
    await q(`INSERT INTO issue (lib_id, student_id, state, requested_by) VALUES ($1, $2, 'wait', $3)`, [Number(lib.id), STU, CEO]);
    expect((await get(`/schedule/students/${STU}/books`).expect(200)).body)
      .toEqual({ studentId: STU, bookCount: 0, label: '교재 없음' });

    // 같은 교재는 학생마다 하나만 살아 있다(issue_active_book_unique) — 다른 교재로 배부 완료 한 권
    const [lib2] = await q<{ id: string }>(
      `INSERT INTO lib (code, title, sub_key) VALUES ('SIDEBAR-BOOK-2', '교재칩 교재 2', 'writing') RETURNING id`,
    );
    await q(
      `INSERT INTO issue (lib_id, student_id, state, requested_by, issued_on) VALUES ($1, $2, 'ok', $3, $4::date)`,
      [Number(lib2.id), STU, CEO, kst()],
    );
    expect((await get(`/schedule/students/${STU}/books`).expect(200)).body)
      .toEqual({ studentId: STU, bookCount: 1, label: null });
  });

  it('없는 학생 404 · 잘못된 번호 400 · 강사 403', async () => {
    const missing = await get('/schedule/students/10059/books').expect(404);
    expect(missing.body.code).toBe('STUDENT_NOT_FOUND');
    await get('/schedule/students/0/books').expect(400);
    await get(`/schedule/students/${STU}/books`, teacherToken).expect(403);
  });
});
