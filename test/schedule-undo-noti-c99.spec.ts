/** @file-guide
 * 목적: schedule-undo-noti-c99.spec.ts — 명단 추가 알림 3건(M-124)과 삭제 되돌리기(N-138)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * C99 — **알림은 남고, 지운 일정은 번호까지 돌아온다.**
 *
 *   M-124  명단에 학생을 넣으면 수신함에 세 줄이 남는다 (스케줄 · 안내 · 교재)
 *          — 「담당자가 기억해야 한다면 시스템이 아닙니다」(원문 M 머리글)
 *   N-138  삭제·휴강을 되돌린다. **연결된 데이터도 함께**이고, 되살아난 규칙은 **같은 번호**다
 *
 * 여기서 보는 것은 규칙이 아니라 **DB 에 내려앉은 결과**다 — 토큰의 서명·만료·actor 결속은
 * `schedule-undo.spec.ts` 가 이미 지킨다.
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

d('C99 — 명단 알림 3건과 삭제 되돌리기 (M-124 · N-138)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  const PW = 'c99-undo-1234';
  /** 시드와 안 부딪히게 높은 번호대를 쓴다 (schedule-write.spec 과도 겹치지 않는다) */
  const CEO = 1991;
  const TEACHER = 1992;
  const MANAGER = 1993;
  const STU_A = 19911;
  const STU_B = 19912;
  const NAME_A = 'C99넣는학생';
  const NAME_B = 'C99준비된학생';
  const LIB = -1991;
  /**
   * 스위트가 **제 수업 종류를 직접 만든다.**
   * ① 시드의 `class`·`meeting` 이 남아 있는지는 다른 스위트의 TRUNCATE 순서에 달려 있다 (C74 의 교훈).
   * ② `rep=false` 여야 한다 — 리포트 대상 종류는 만들 때 REP 가 함께 생기고, 그러면
   *    「참조가 있으면 지우지 않는다」 갈래로 빠져 **삭제 되돌리기의 본 갈래를 못 본다**.
   */
  const KIND = 'c99_test';

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    const hash = await bcrypt.hash(PW, 4);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER, MANAGER]]);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'C99대표','c99-ceo@t.kr','ceo',$4,true),
         ($2,'C99강사','c99-t@t.kr','teacher',$4,true),
         ($3,'C99매니저','c99-m@t.kr','manager',$4,true)`,
      [CEO, TEACHER, MANAGER, hash],
    );
    await q(`INSERT INTO kind (key, name, color, cap, grp, rep, extra)
             VALUES ($1,'C99 수업','#123456',8,'lesson',false,false)
             ON CONFLICT (key) DO UPDATE SET cap = EXCLUDED.cap, rep = EXCLUDED.rep`, [KIND]);
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B]]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,$3,'10'), ($2,$4,'10')`,
      [STU_A, STU_B, NAME_A, NAME_B]);
    // B 는 「이미 준비된 학생」이다 — 교재가 있으면 ⓒ 가 가지 않아야 한다
    await q(`DELETE FROM issue WHERE lib_id = $1`, [LIB]);
    await q(`DELETE FROM lib WHERE id = $1`, [LIB]);
    await q(`INSERT INTO lib (id, code, title, sub_key) VALUES ($1,'C99-LIB','C99 교재', NULL)`, [LIB]);
    await q(`INSERT INTO issue (student_id, lib_id, state, issued_on) VALUES ($1,$2,'ok',now())`, [STU_B, LIB]);

    const res = await request(app.getHttpServer())
      .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
      .send({ email: 'c99-ceo@t.kr', password: PW }).expect(201);
    token = res.body.accessToken as string;
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await q(`DELETE FROM noti WHERE from_id = ANY($1) OR to_id = ANY($1)`, [[CEO, TEACHER, MANAGER]]);
        await q(`DELETE FROM issue WHERE student_id = ANY($1)`, [[STU_A, STU_B]]);
        await q(`DELETE FROM lib WHERE id = $1`, [LIB]);
        await q(`INSERT INTO kind (key, name, color, cap, grp, rep, extra)
             VALUES ($1,'C99 수업','#123456',8,'lesson',false,false)
             ON CONFLICT (key) DO UPDATE SET cap = EXCLUDED.cap, rep = EXCLUDED.rep`, [KIND]);
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B]]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER, MANAGER]]);
        await q(`DELETE FROM kind WHERE key = $1`, [KIND]);
      }
    } finally {
      await app?.close();
    }
  });

  const made: number[] = [];
  beforeEach(async () => { await q(`DELETE FROM noti WHERE from_id = $1`, [CEO]); });
  afterEach(async () => {
    if (!made.length) return;
    await q(`DELETE FROM att WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM log WHERE entity='ATT' AND actor_id = $1`, [CEO]);
    await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [made]);
    await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id = ANY($1))`, [made]);
    await q(`UPDATE exc SET makeup_ser_id = NULL WHERE makeup_ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser WHERE id = ANY($1)`, [made]);
    made.length = 0;
  });

  const api = (m: 'post' | 'patch' | 'delete', p: string) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${token}`)
      .timeout({ response: 5000, deadline: 10000 });

  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const nextDow = (iso: string, dow: number) => {
    let d0 = iso;
    for (let i = 0; i < 7; i++) {
      if (new Date(`${d0}T00:00:00Z`).getUTCDay() === dow) return d0;
      d0 = plus(d0, 1);
    }
    return d0;
  };

  /** 화요일 반복 하나 — 시드 강사와 안 부딪히게 전용 강사·늦은 시각을 쓴다 */
  async function makeSer(over: Record<string, unknown> = {}) {
    const from = nextDow(plus(kst(), 10), 2);
    const res = await api('post', '/schedule')
      .send({
        kindKey: KIND, subKey: null, mode: 'offline',
        fromDate: from, rrule: 'WEEKLY:TU',
        startMin: 1260, endMin: 1320, teacherId: TEACHER, roomId: null,
        title: 'C99 테스트', studentIds: [], ...over,
      })
      .expect(201);
    const id = res.body.serIds[0] as number;
    made.push(id);
    return { id, from, body: res.body };
  }

  const notis = () => q<{ to_id: string; body: string; link: string; category: string }>(
    `SELECT to_id::text, body, link, category FROM noti WHERE from_id = $1 ORDER BY id`, [CEO],
  );

  /* ── M-124 학생을 넣으면 알림 3건 ────────────────────────────────── */

  it('M-124 · 명단에 학생을 넣으면 수신함에 세 줄이 남는다 — 넣은 사람에게도 간다', async () => {
    const { id, from } = await makeSer();
    await api('patch', `/schedule/${id}/roster`).send({ op: 'add', onDate: from, studentId: STU_A }).expect(200);

    const rows = await notis();
    const mine = rows.filter((r) => r.to_id === String(CEO));
    // 원문 M-124 의 세 줄 — 몸통·링크·분류가 그대로이고 **넣은 사람 수신함에 셋 다** 있다
    expect(mine.map((r) => r.body)).toEqual([
      `${NAME_A} 학생이 C99 수업 수업에 들어왔습니다`,
      `${NAME_A} 수업 안내가 필요합니다`,
      `${NAME_A} 교재 배정이 필요합니다`,
    ]);
    expect(mine.map((r) => r.link)).toEqual([`/schedule?date=${from}`, '/guides', '/books']);
    // 「각각 열기 › 버튼이 붙는다」 — 링크가 빈 줄이 하나도 없어야 그 단추가 선다
    expect(mine.every((r) => r.link.length > 0)).toBe(true);
    expect(mine.map((r) => r.category)).toEqual(['schedule', 'request', 'request']);
    // 그 수업 강사에게는 「들어왔습니다」 한 줄만 간다 — 안내·교재는 관리자가 쓰는 일이다
    expect(rows.filter((r) => r.to_id === String(TEACHER)).map((r) => r.category)).toEqual(['schedule']);
    // 매니저도 관리자급이라 셋 다 받는다
    expect(rows.filter((r) => r.to_id === String(MANAGER))).toHaveLength(3);
  });

  it('M-124 · 이미 교재가 있는 학생에게는 「교재 배정이 필요합니다」가 가지 않는다', async () => {
    const { id, from } = await makeSer();
    await api('patch', `/schedule/${id}/roster`).send({ op: 'add', onDate: from, studentId: STU_B }).expect(200);

    const mine = (await notis()).filter((r) => r.to_id === String(CEO));
    // 세 줄이 아니라 두 줄이다 — 없는 일을 「필요합니다」라 적으면 거짓말이다
    expect(mine.map((r) => r.body)).toEqual([
      `${NAME_B} 학생이 C99 수업 수업에 들어왔습니다`,
      `${NAME_B} 수업 안내가 필요합니다`,
    ]);
  });

  it('M-124 · 빼기와 되돌리기는 알림을 만들지 않는다 — 준비할 일이 생기지 않는다', async () => {
    const { id, from } = await makeSer();
    await api('patch', `/schedule/${id}/roster`).send({ op: 'add', onDate: from, studentId: STU_A }).expect(200);
    await q(`DELETE FROM noti WHERE from_id = $1`, [CEO]);

    await api('patch', `/schedule/${id}/roster`).send({ op: 'dropOnce', onDate: from, studentId: STU_A }).expect(200);
    await api('patch', `/schedule/${id}/roster`).send({ op: 'undoOnce', onDate: from, studentId: STU_A }).expect(200);
    await api('patch', `/schedule/${id}/roster`).send({ op: 'dropAll', onDate: from, studentId: STU_A }).expect(200);
    expect(await notis()).toHaveLength(0);
  });

  /* ── N-138 실수로 지운 일정 되돌리기 ─────────────────────────────── */

  it('N-138 · 「모두」 삭제를 되돌리면 같은 번호로 명단까지 돌아온다', async () => {
    const { id, from } = await makeSer({ studentIds: [STU_A, STU_B] });
    const before = await q<{ rrule: string; from_date: string }>(
      `SELECT rrule, from_date::text AS from_date FROM ser WHERE id=$1`, [id],
    );

    const del = await api('delete', `/schedule/${id}`).send({ scope: 'all', onDate: from }).expect(200);
    // C87 이 닫아 둔 문이 열렸다 — 삭제도 토큰을 준다
    expect(typeof del.body.undoToken).toBe('string');
    expect(await q(`SELECT id FROM ser WHERE id=$1`, [id])).toEqual([]);

    await api('post', '/schedule/undo').send({ token: del.body.undoToken }).expect(201);
    // **같은 번호**다 — 새 번호면 되살아난 것이 아니라 닮은 규칙이 하나 생긴 것이다
    expect(await q<{ rrule: string; from_date: string }>(
      `SELECT rrule, from_date::text AS from_date FROM ser WHERE id=$1`, [id],
    )).toEqual(before);
    // 「연결된 데이터도 함께」 — 명단과 투영이 같이 돌아온다
    expect(await q<{ c: string }>(`SELECT count(*)::text AS c FROM ser_stu WHERE ser_id=$1`, [id]))
      .toEqual([{ c: '2' }]);
    expect(Number((await q<{ c: string }>(
      `SELECT count(*)::text AS c FROM ser_occ WHERE ser_id=$1`, [id],
    ))[0].c)).toBeGreaterThan(0);
  });

  it('N-138 · 「향후」 삭제를 되돌리면 to_date 와 그 뒤 예외가 함께 돌아온다', async () => {
    const { id, from } = await makeSer();
    const second = plus(from, 7);
    await api('patch', `/schedule/${id}`)
      .send({ scope: 'this', onDate: second, startMin: 1290, endMin: 1350 }).expect(200);

    const del = await api('delete', `/schedule/${id}`).send({ scope: 'future', onDate: second }).expect(200);
    expect(await q<{ to_date: string }>(`SELECT to_date::text AS to_date FROM ser WHERE id=$1`, [id]))
      .toEqual([{ to_date: plus(second, -1) }]);
    expect(await q(`SELECT id FROM exc WHERE ser_id=$1 AND on_date >= $2::date`, [id, second])).toEqual([]);

    await api('post', '/schedule/undo').send({ token: del.body.undoToken }).expect(201);
    expect(await q<{ to_date: string | null }>(`SELECT to_date::text AS to_date FROM ser WHERE id=$1`, [id]))
      .toEqual([{ to_date: null }]);
    expect(await q<{ start_min: number }>(
      `SELECT start_min FROM exc WHERE ser_id=$1 AND on_date=$2::date`, [id, second],
    )).toEqual([{ start_min: 1290 }]);
  });

  it('N-138 · 휴강을 되돌리면 예외가 사라지고 이미 간 알림은 남는다 (C38)', async () => {
    const { id, from } = await makeSer({ studentIds: [STU_A] });
    const del = await api('delete', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, cancelKind: 'academy', cancelTreat: 'carry' }).expect(200);
    expect(await q<{ canceled: boolean }>(
      `SELECT canceled FROM exc WHERE ser_id=$1 AND on_date=$2::date`, [id, from],
    )).toEqual([{ canceled: true }]);
    const sent = (await notis()).length;
    expect(sent).toBeGreaterThan(0);

    await api('post', '/schedule/undo').send({ token: del.body.undoToken }).expect(201);
    expect(await q(`SELECT id FROM exc WHERE ser_id=$1 AND on_date=$2::date`, [id, from])).toEqual([]);
    // NOTI 는 지우지 않는다 — 30일은 조회 범위이지 삭제 규칙이 아니다 (C38 · N-7 · D-16).
    // 그래서 수신함에는 되돌린 휴강의 결강 줄이 남는다 — 그 판단 자체는 N-55 로 올렸다.
    expect((await notis()).length).toBe(sent);
  });

  it('N-138 · 보강 이관을 되돌리면 보강 회차가 사라진다 — 출결이 붙었으면 409 로 막힌다', async () => {
    const first = await makeSer({ studentIds: [STU_A] });
    const makeupDate = plus(first.from, 2);
    const del = await api('delete', `/schedule/${first.id}`)
      .send({
        scope: 'this', onDate: first.from, cancelKind: 'academy', cancelTreat: 'makeup',
        makeup: { date: makeupDate, startMin: 1260, endMin: 1320 },
      }).expect(200);
    const madeSer = (await q<{ makeup_ser_id: string }>(
      `SELECT makeup_ser_id::text FROM exc WHERE ser_id=$1 AND on_date=$2::date`, [first.id, first.from],
    ))[0];
    const makeupId = Number(madeSer.makeup_ser_id);
    made.push(makeupId);
    expect(makeupId).toBeGreaterThan(0);

    // 그 사이 누가 보강 회차의 출결을 적었다 — 지우면 그 사실이 사라진다
    await q(`INSERT INTO att (ser_id, on_date, result, confirmed_by) VALUES ($1,$2::date,'completed',$3)`,
      [makeupId, makeupDate, CEO]);
    const blocked = await api('post', '/schedule/undo').send({ token: del.body.undoToken }).expect(409);
    // 500(FK) 이 아니라 **문장**이다 — 막는 것은 DB 이고 이건 설명이다
    expect(blocked.body.code).toBe('UNDO_HAS_REFS');
    expect(await q(`SELECT id FROM ser WHERE id=$1`, [makeupId])).toHaveLength(1);

    await q(`DELETE FROM att WHERE ser_id=$1`, [makeupId]);
    await q(`DELETE FROM log WHERE entity='ATT' AND actor_id=$1`, [CEO]);
    await api('post', '/schedule/undo').send({ token: del.body.undoToken }).expect(201);
    expect(await q(`SELECT id FROM ser WHERE id=$1`, [makeupId])).toEqual([]);
    expect(await q(`SELECT id FROM exc WHERE ser_id=$1 AND on_date=$2::date`, [first.id, first.from])).toEqual([]);
  });

  it('N-138 · 그날 전체 휴강은 한 토큰으로 그날이 통째로 돌아온다', async () => {
    const a = await makeSer();
    const b = await makeSer({ startMin: 1330, endMin: 1380 });
    const day = a.from;

    const res = await api('post', '/schedule/day-cancel')
      .send({ date: day, cancelKind: 'academy', cancelTreat: 'carry' }).expect(201);
    expect(typeof res.body.undoToken).toBe('string');
    const canceled = await q<{ c: string }>(
      `SELECT count(*)::text AS c FROM exc WHERE ser_id = ANY($1) AND on_date = $2::date AND canceled`,
      [[a.id, b.id], day],
    );
    expect(canceled).toEqual([{ c: '2' }]);

    await api('post', '/schedule/undo').send({ token: res.body.undoToken }).expect(201);
    expect(await q(`SELECT id FROM exc WHERE ser_id = ANY($1) AND on_date = $2::date`, [[a.id, b.id], day]))
      .toEqual([]);
  });
});
