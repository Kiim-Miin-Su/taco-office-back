/**
 * 스케줄 쓰기 — **3범위가 실제로 갈리는가**, 그리고 **겹침을 DB 가 막는가**.
 *
 * 규칙 자체는 `recurrence.spec.ts` 85 어서션이 이미 지킨다. 여기서 보는 것은
 * 그 순수 함수가 **DB 에 제대로 내려앉는가**다 — 어댑터(state.repo · project)의 몫이다.
 *
 *   this   → EXC 한 줄이 생긴다        (원본 규칙은 그대로)
 *   future → 원본 to_date 가 끊기고 새 SER
 *   all    → SER 자체가 바뀐다
 *   겹침    → 409 RESOURCE_CONFLICT (500 이 아니다)
 *
 * ⚠ 이 파일은 **표를 비운다.** 스크래치 DB(`*_test`)에서만 돈다 (test/db.ts).
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

d('스케줄 쓰기 — 3범위와 겹침 (D-R16 · D-R43)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  const PW = 'sched-write-1234';
  /** 시드와 안 부딪히게 높은 번호대를 쓴다 */
  const CEO = 921;
  const ROSTER_STUDENT = 9921;
  const ROSTER_STUDENT_NAME = '명단결과학생';
  const ROOM = 1;
  /** 테스트가 날짜 이동으로 시드 강사 일정과 부딪치지 않게 이 스위트 전용 staff를 쓴다. */
  const T1 = CEO;
  const T2 = 12;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    ds = app.get(DataSource);

    await q(`DELETE FROM staff WHERE id = $1`, [CEO]);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES ($1,$2,$3,'ceo',$4,true)`,
      [CEO, '쓰기대표', 'sched-ceo@t.kr', await bcrypt.hash(PW, 4)],
    );
    await q(`DELETE FROM stu WHERE id = $1`, [ROSTER_STUDENT]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1, $2, '10')`, [ROSTER_STUDENT, ROSTER_STUDENT_NAME]);
    const res = await request(app.getHttpServer())
      .post('/auth/login').send({ email: 'sched-ceo@t.kr', password: PW }).expect(201);
    token = res.body.accessToken as string;
  });

  afterAll(async () => {
    await q(`DELETE FROM staff WHERE id = $1`, [CEO]);
    await q(`DELETE FROM stu WHERE id = $1`, [ROSTER_STUDENT]);
    await app?.close();
  });

  /** 만들어 둔 규칙을 매번 치운다 — 겹침 제약이 다음 테스트를 막지 않게 */
  const made: number[] = [];
  afterEach(async () => {
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

  const api = (m: 'post' | 'patch' | 'delete', p: string) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${token}`);

  /** 월·수 반복 하나를 만든다. 날짜는 오늘 기준이라 호라이즌 안에 확실히 든다. */
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  /** iso 이후로 처음 오는 월요일 */
  const nextMon = (iso: string) => {
    let d0 = iso;
    for (let i = 0; i < 7; i++) {
      if (new Date(`${d0}T00:00:00Z`).getUTCDay() === 1) return d0;
      d0 = plus(d0, 1);
    }
    return d0;
  };

  async function makeSer(over: Partial<Record<string, unknown>> = {}) {
    const from = nextMon(plus(kst(), 7));
    const res = await api('post', '/schedule')
      .send({
        kindKey: 'class', subKey: null, mode: 'offline',
        fromDate: from, rrule: 'WEEKLY:MO,WE',
        startMin: 600, endMin: 660, teacherId: T1, roomId: null,
        title: '쓰기 테스트', studentIds: [1, 2], ...over,
      })
      .expect(201);
    const id = res.body.serIds[0] as number;
    made.push(id);
    return { id, from, body: res.body };
  }

  it('만들면 회차가 펼쳐진다 — ser_occ 에 실제 행이 생긴다', async () => {
    const { id, body } = await makeSer();
    expect(body.projected).toBeGreaterThan(0);
    const n = await q<{ n: string }>(`SELECT count(*)::text n FROM ser_occ WHERE ser_id=$1`, [id]);
    expect(Number(n[0].n)).toBeGreaterThan(0);
    const stu = await q<{ n: string }>(`SELECT count(*)::text n FROM ser_stu WHERE ser_id=$1`, [id]);
    expect(Number(stu[0].n)).toBe(2);
    const rep = await q<{ reports: string; recipients: string }>(
      `SELECT count(DISTINCT r.id)::text AS reports, count(rs.student_id)::text AS recipients
         FROM rep r LEFT JOIN rep_stu rs ON rs.rep_id = r.id WHERE r.ser_id=$1`,
      [id],
    );
    expect(Number(rep[0].reports)).toBeGreaterThan(0);
    expect(Number(rep[0].recipients)).toBe(Number(rep[0].reports) * 2);
  });

  it('리포트 비대상 종류는 회차만 만들고 REP를 만들지 않는다', async () => {
    const { id } = await makeSer({ kindKey: 'study', subKey: 'study-room' });
    const rep = await q<{ n: string }>(`SELECT count(*)::text n FROM rep WHERE ser_id=$1`, [id]);
    expect(Number(rep[0].n)).toBe(0);
  });

  it("scope='this' — EXC 한 줄만 생기고 규칙은 그대로다", async () => {
    const { id, from } = await makeSer();
    const before = (await q<{ rrule: string }>(`SELECT rrule FROM ser WHERE id=$1`, [id]))[0].rrule;

    const r = await api('patch', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, teacherId: T2 }).expect(200);
    expect(r.body.effScope).toBe('this');

    const exc = await q<{ n: string }>(`SELECT count(*)::text n FROM exc WHERE ser_id=$1`, [id]);
    expect(Number(exc[0].n)).toBe(1);
    const after = (await q<{ rrule: string }>(`SELECT rrule FROM ser WHERE id=$1`, [id]))[0].rrule;
    expect(after).toBe(before);

    // 그날 회차만 강사가 바뀐다 — 나머지는 원래 강사다
    const rows = await q<{ on_date: string; teacher_id: string }>(
      `SELECT on_date::text, teacher_id::text FROM ser_occ WHERE ser_id=$1 ORDER BY on_date`, [id]);
    const that = rows.find((x) => x.on_date === from);
    expect(Number(that?.teacher_id)).toBe(T2);
    expect(rows.filter((x) => Number(x.teacher_id) === T1).length).toBeGreaterThan(0);
  });

  it('EXC 마이그레이션 호환 — 이전 서버가 FK만 쓰면 override 플래그를 보존한다', async () => {
    const { id, from } = await makeSer();
    await q(
      `INSERT INTO exc (ser_id, on_date, teacher_id, reason, by_id)
       VALUES ($1, $2::date, $3, '이전 서버 호환', $4)`,
      [id, from, T2, CEO],
    );
    const [row] = await q<{ teacher_set: boolean }>(
      `SELECT teacher_set FROM exc WHERE ser_id=$1 AND on_date=$2::date`,
      [id, from],
    );
    expect(row.teacher_set).toBe(true);
  });

  it("scope='this' null — 자원 미지정을 EXC와 투영에 보존한다", async () => {
    const { id, from } = await makeSer({ teacherId: T1, roomId: ROOM });
    await api('patch', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, teacherId: null, roomId: null })
      .expect(200);

    const exc = (await q<{
      teacher_set: boolean; teacher_id: string | null; room_set: boolean; room_id: string | null;
    }>(`SELECT teacher_set, teacher_id::text, room_set, room_id::text
          FROM exc WHERE ser_id=$1 AND on_date=$2::date`, [id, from]))[0];
    expect(exc).toEqual({ teacher_set: true, teacher_id: null, room_set: true, room_id: null });

    const projected = (await q<{ teacher_id: string | null; room_id: string | null }>(
      `SELECT teacher_id::text, room_id::text FROM ser_occ WHERE ser_id=$1 AND on_date=$2::date`,
      [id, from],
    ))[0];
    expect(projected).toEqual({ teacher_id: null, room_id: null });
  });

  it('PATCH 방어 — 빈 변경·잘못된 시간·규칙 범위의 null을 저장하지 않는다', async () => {
    const { id, from } = await makeSer();
    const empty = await api('patch', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from }).expect(400);
    expect(empty.body.code).toBe('EMPTY_PATCH');

    const badRange = await api('patch', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, startMin: 659 }).expect(400);
    expect(badRange.body.code).toBe('BAD_RANGE');

    const badNull = await api('patch', `/schedule/${id}`)
      .send({ scope: 'all', onDate: from, startMin: null }).expect(400);
    expect(badNull.body.code).toBe('BAD_NULL_SCOPE');

    const exc = await q<{ n: string }>(`SELECT count(*)::text n FROM exc WHERE ser_id=$1`, [id]);
    expect(Number(exc[0].n)).toBe(0);
  });

  it("scope='all' null — SER 자원을 비우고 기존 자원 EXC만 초기화한다", async () => {
    const { id, from } = await makeSer({ teacherId: T1, roomId: ROOM });
    await api('patch', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, teacherId: null, roomId: null }).expect(200);
    await api('patch', `/schedule/${id}`)
      .send({ scope: 'all', onDate: from, teacherId: null, roomId: null }).expect(200);

    const ser = (await q<{ teacher_id: string | null; room_id: string | null }>(
      `SELECT teacher_id::text, room_id::text FROM ser WHERE id=$1`, [id],
    ))[0];
    expect(ser).toEqual({ teacher_id: null, room_id: null });
    const exc = await q<{ n: string }>(`SELECT count(*)::text n FROM exc WHERE ser_id=$1`, [id]);
    expect(Number(exc[0].n)).toBe(0);
    const projected = await q<{ teacher_id: string | null; room_id: string | null }>(
      `SELECT DISTINCT teacher_id::text, room_id::text FROM ser_occ WHERE ser_id=$1`, [id],
    );
    expect(projected).toEqual([{ teacher_id: null, room_id: null }]);
  });

  it('다른 날로 옮긴 EXC는 date=표시 날짜, onDate=원래 키로 조회된다', async () => {
    const { id, from } = await makeSer({ startMin: 1140, endMin: 1200, roomId: 3 });
    const movedTo = plus(from, 1);
    await api('patch', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, date: movedTo }).expect(200);

    const r = await api('post', '/schedule/paste')
      .send({
        sources: [{ serId: id, date: movedTo, onDate: from }],
        scope: 'this', targetDate: plus(movedTo, 1), targetStartMin: 1200,
      })
      .expect(201);
    (r.body.serIds as number[]).forEach((x) => { if (!made.includes(x)) made.push(x); });

    const list = await request(app.getHttpServer())
      .get('/schedule/occurrences')
      .query({ from: movedTo, to: movedTo })
      .set('Authorization', `Bearer ${token}`).expect(200);
    const moved = (list.body.items as Array<{ serId: number; date: string; onDate: string }>)
      .find((x) => x.serId === id);
    expect(moved).toMatchObject({ date: movedTo, onDate: from });
  });

  it('다중 이동은 한 요청에서 상대 간격을 지키고 두 회차를 함께 옮긴다 (C-7)', async () => {
    const a = await makeSer({ startMin: 720, endMin: 780, teacherId: null, roomId: null });
    const b = await makeSer({ startMin: 900, endMin: 990, teacherId: null, roomId: null });
    const target = plus(a.from, 1);
    await api('post', '/schedule/move')
      .send({
        scope: 'this',
        items: [
          { source: { serId: a.id, date: a.from, onDate: a.from }, date: target, startMin: 735, endMin: 795 },
          { source: { serId: b.id, date: b.from, onDate: b.from }, date: target, startMin: 915, endMin: 1005 },
        ],
      })
      .expect(201);

    const rows = await q<{ ser_id: string; on_date: string; start_min: number }>(
      `SELECT ser_id::text, on_date::text,
              (EXTRACT(HOUR FROM lower(span) AT TIME ZONE 'Asia/Seoul') * 60
               + EXTRACT(MINUTE FROM lower(span) AT TIME ZONE 'Asia/Seoul'))::int AS start_min
         FROM ser_occ WHERE ser_id = ANY($1) AND on_date=$2::date ORDER BY ser_id`,
      [[a.id, b.id], a.from],
    );
    expect(rows.map((x) => x.start_min)).toEqual([735, 915]);
    const exc = await q<{ n: string }>(
      `SELECT count(*)::text n FROM exc WHERE ser_id = ANY($1) AND on_date=$2::date AND new_date=$3::date`,
      [[a.id, b.id], a.from, target],
    );
    expect(Number(exc[0].n)).toBe(2);
  });

  it("scope='future' — 원본이 끊기고 새 규칙이 생긴다", async () => {
    const { id, from } = await makeSer();
    const cut = plus(from, 14);

    const r = await api('patch', `/schedule/${id}`)
      .send({ scope: 'future', onDate: cut, startMin: 780, endMin: 840 }).expect(200);
    expect(r.body.effScope).toBe('future');
    expect(r.body.serIds.length).toBeGreaterThan(1);
    r.body.serIds.forEach((x: number) => { if (!made.includes(x)) made.push(x); });

    const orig = (await q<{ to_date: string }>(`SELECT to_date::text FROM ser WHERE id=$1`, [id]))[0];
    expect(orig.to_date).toBe(plus(cut, -1));

    const fresh = r.body.serIds.filter((x: number) => x !== id);
    expect(fresh.length).toBe(1);
    const ns = (await q<{ start_min: number; from_date: string }>(
      `SELECT start_min, from_date::text FROM ser WHERE id=$1`, [fresh[0]]))[0];
    expect(ns.start_min).toBe(780);
    expect(ns.from_date).toBe(cut);
  });

  it("scope='all' — 규칙 자체가 바뀐다", async () => {
    const { id, from } = await makeSer();
    const r = await api('patch', `/schedule/${id}`)
      .send({ scope: 'all', onDate: from, roomId: 2 }).expect(200);
    expect(r.body.effScope).toBe('all');

    const s = (await q<{ room_id: string }>(`SELECT room_id::text FROM ser WHERE id=$1`, [id]))[0];
    expect(Number(s.room_id)).toBe(2);
    const rooms = await q<{ room_id: string }>(`SELECT DISTINCT room_id::text FROM ser_occ WHERE ser_id=$1`, [id]);
    expect(rooms.map((x) => Number(x.room_id))).toEqual([2]);
  });

  it('붙여넣기 — 원본 참조만 받아 새 SER와 명단을 만들고 EXC는 복제하지 않는다', async () => {
    const { id, from } = await makeSer();
    await api('patch', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, teacherId: T2 }).expect(200);

    const target = plus(from, 1);
    const r = await api('post', '/schedule/paste')
      .send({
        sources: [{ serId: id, date: from, onDate: from }],
        scope: 'this', targetDate: target, targetStartMin: 840,
      })
      .expect(201);
    const copiedId = (r.body.serIds as number[]).find((x) => x !== id)!;
    made.push(copiedId);

    const copied = (await q<{ rrule: string; from_date: string; start_min: number; teacher_id: string }>(
      `SELECT rrule, from_date::text, start_min, teacher_id::text FROM ser WHERE id=$1`, [copiedId],
    ))[0];
    expect(copied).toMatchObject({ rrule: 'ONCE', from_date: target, start_min: 840 });
    // 화면에서 복사한 유효 강사값은 새 SER에 굳히되, EXC 행 자체는 따라오지 않는다.
    expect(Number(copied.teacher_id)).toBe(T2);
    const stus = await q<{ n: string }>(`SELECT count(*)::text n FROM ser_stu WHERE ser_id=$1`, [copiedId]);
    expect(Number(stus[0].n)).toBe(2);
    const excs = await q<{ n: string }>(`SELECT count(*)::text n FROM exc WHERE ser_id=$1`, [copiedId]);
    expect(Number(excs[0].n)).toBe(0);
  });

  it('잘라내기 붙여넣기는 원본 this 취소와 새 SER 생성을 한 트랜잭션에 넣는다', async () => {
    const { id, from } = await makeSer({ startMin: 720, endMin: 780 });
    const target = plus(from, 1);
    const r = await api('post', '/schedule/paste')
      .send({
        sources: [{ serId: id, date: from, onDate: from }],
        scope: 'this', targetDate: target, targetStartMin: 900, cut: true,
      })
      .expect(201);
    (r.body.serIds as number[]).forEach((x) => { if (!made.includes(x)) made.push(x); });

    const original = await q<{ canceled: boolean }>(
      `SELECT canceled FROM ser_occ WHERE ser_id=$1 AND on_date=$2::date`, [id, from],
    );
    expect(original[0]?.canceled).toBe(true);
    const created = await q<{ n: string }>(
      `SELECT count(*)::text n FROM ser WHERE id <> $1 AND from_date=$2::date AND start_min=900`, [id, target],
    );
    expect(Number(created[0].n)).toBeGreaterThan(0);
  });

  it('붙여넣기 방어 — 없는 회차와 자정을 넘는 배치는 저장하지 않는다', async () => {
    const { id, from } = await makeSer({ startMin: 720, endMin: 780 });
    await api('post', '/schedule/paste')
      .send({
        sources: [{ serId: id, date: plus(from, 1), onDate: from }],
        scope: 'this', targetDate: plus(from, 1), targetStartMin: 900,
      })
      .expect(404);

    const before = await q<{ n: string }>(`SELECT count(*)::text n FROM ser`);
    const bad = await api('post', '/schedule/paste')
      .send({
        sources: [{ serId: id, date: from, onDate: from }],
        scope: 'this', targetDate: plus(from, 1), targetStartMin: 1420,
      })
      .expect(400);
    expect(bad.body.code).toBe('BAD_PASTE');
    const after = await q<{ n: string }>(`SELECT count(*)::text n FROM ser`);
    expect(after[0].n).toBe(before[0].n);
  });

  it('겹치면 DB 가 막는다 — 409 이고 절반만 저장되지 않는다 (D-R43)', async () => {
    const { from } = await makeSer({ roomId: ROOM });
    const beforeSers = await q<{ n: string }>(`SELECT count(*)::text n FROM ser`);

    // 같은 방 · 같은 시간 · 같은 요일
    const res = await api('post', '/schedule')
      .send({
        kindKey: 'class', mode: 'offline', fromDate: from, rrule: 'WEEKLY:MO,WE',
        startMin: 630, endMin: 690, teacherId: T2, roomId: ROOM, title: '겹치는 수업',
      })
      .expect(409);
    expect(res.body.code).toBe('RESOURCE_CONFLICT');

    // 트랜잭션이 통째로 되돌아갔는가 — SER 이 늘지 않아야 한다
    const afterSers = await q<{ n: string }>(`SELECT count(*)::text n FROM ser`);
    expect(afterSers[0].n).toBe(beforeSers[0].n);
  });

  it('그날만 빼기 — 명단은 그대로고 그 회차에서만 빠진다 (D-R21)', async () => {
    const { id, from } = await makeSer({ subKey: 'ap-chem', studentIds: [1, ROSTER_STUDENT] });
    const r = await api('patch', `/schedule/${id}/roster`)
      .send({ op: 'dropOnce', onDate: from, studentId: 1 }).expect(200);
    expect(r.body.log.length).toBeGreaterThan(0);
    expect(r.body).toMatchObject({
      count: 1,
      cap: 4,
      needGuide: [ROSTER_STUDENT_NAME],
      needBook: [ROSTER_STUDENT_NAME],
    });

    const stu = await q<{ n: string }>(`SELECT count(*)::text n FROM ser_stu WHERE ser_id=$1`, [id]);
    expect(Number(stu[0].n)).toBe(2); // 정식 명단은 그대로

    const out = await q<{ n: string }>(
      `SELECT count(*)::text n FROM exc_stu_out o JOIN exc e ON e.id=o.exc_id
        WHERE e.ser_id=$1 AND e.on_date=$2::date AND o.student_id=1`, [id, from]);
    expect(Number(out[0].n)).toBe(1);
  });

  it('명단 방어 — 없는 학생·회차와 현재 상태에 맞지 않는 작업을 저장하지 않는다', async () => {
    const { id, from } = await makeSer();

    const missingStudent = await api('patch', `/schedule/${id}/roster`)
      .send({ op: 'add', onDate: from, studentId: 9_999_999 }).expect(404);
    expect(missingStudent.body.code).toBe('STUDENT_NOT_FOUND');

    const missingOccurrence = await api('patch', `/schedule/${id}/roster`)
      .send({ op: 'dropOnce', onDate: plus(from, 1), studentId: 1 }).expect(404);
    expect(missingOccurrence.body.code).toBe('OCCURRENCE_NOT_FOUND');

    const badOp = await api('patch', `/schedule/${id}/roster`)
      .send({ op: 'undoOnce', onDate: from, studentId: 1 }).expect(400);
    expect(badOp.body.code).toBe('BAD_ROSTER_OP');

    const stu = await q<{ n: string }>(`SELECT count(*)::text n FROM ser_stu WHERE ser_id=$1`, [id]);
    expect(Number(stu[0].n)).toBe(2);
  });

  it('아주 빼기 — 정식 명단에서 사라진다', async () => {
    const { id, from } = await makeSer();
    await api('patch', `/schedule/${id}/roster`)
      .send({ op: 'dropAll', onDate: from, studentId: 2 }).expect(200);
    const stu = await q<{ student_id: string }>(`SELECT student_id::text FROM ser_stu WHERE ser_id=$1`, [id]);
    expect(stu.map((x) => Number(x.student_id))).toEqual([1]);
  });

  it('읽을 수 없는 반복 규칙은 400 으로 막는다 — 조용히 빈 규칙이 되지 않게', async () => {
    const res = await api('post', '/schedule')
      .send({
        kindKey: 'class', mode: 'offline', fromDate: kst(),
        rrule: 'FREQ=WEEKLY;BYDAY=1,3', // 옛 형식 — parseRule 이 days:[] 를 낸다
        startMin: 600, endMin: 660, roomId: 3,
      })
      .expect(400);
    expect(res.body.code).toBe('BAD_RRULE');
  });

  it('취소하면 회차가 취소로 표시되고 겹침 제약에서 빠진다', async () => {
    const { id, from } = await makeSer();
    await api('delete', `/schedule/${id}`).send({ scope: 'this', onDate: from }).expect(200);
    const row = await q<{ canceled: boolean }>(
      `SELECT canceled FROM ser_occ WHERE ser_id=$1 AND on_date=$2::date`, [id, from]);
    expect(row[0]?.canceled).toBe(true);
  });
});
