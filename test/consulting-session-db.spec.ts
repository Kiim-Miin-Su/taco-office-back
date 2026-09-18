/** @file-guide
 * 목적: consulting-session-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 컨설팅 회차 기록 · 종료 + GPA 사이클 마감 — C95 (테스트 시나리오 I-91 「회차 기록 — 날짜 3개 고르기」 · I-95 「컨설팅 종료」 · O-150 「4주마다 — GPA 사이클 마감」).
 *
 * 증명하는 것 —
 *   ① 날짜 셋을 한 번에 잡으면 날짜마다 cons_sess(순번은 서버 · 「누가」는 담당 · 학생) · 담당의 할 일 · 시간표 회차가 선다 — 그날 담당의 컨설팅 회차가 이미 있으면
 *      **그 회차에 연결**하고 없으면 하루짜리 회차를 새로 만든다(원본 §2 「CONS.sess → SER → TODO」). 미리보기는 쓰기 0 · 계약 단계는 409 · 시각 없이 새 회차는 400 ·
 *      겹치면 409 로 **전부** 되돌아간다 · 강사 403.
 *   ② 육하원칙은 보낸 칸만 · 다 적으면 그 회차의 할 일이 접힌다 · 앞으로 잡아 둔 날짜는 「한 회차」가 아니다(기록 ≠ 완료 · N-18).
 *   ③ 종료는 N-18 채택 「필수 항목 + 약정 회차 후 명시 종료」 — 필수 항목이 남으면 409 · 회차가 모자라면 409 · 앞으로 잡아 둔 회차가 있으면 409 ·
 *      되면 stage=done · 종료일 · 학생마다 학부모 안내 행 · cons_event closed · 담당 알림 · 그 뒤 회차·기록은 잠긴다.
 *   ④ GPA 사이클 마감은 끝난 사이클만 · 승인 대기가 남으면 409 · 도장(누가·언제) · 잔여는 소멸 포인트 · 두 번은 409.
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
jest.setTimeout(120_000);

d('컨설팅 회차 기록 · 종료 + GPA 사이클 마감 (C95 · I-91 · I-95 · O-150)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  let teacherToken = '';
  const PW = 'cs-12345';
  const CEO = 961;
  const OWNER = 962; // 담당 매니저
  const TEACHER = 963;
  const STU1 = 9961;
  const STU2 = 9962;
  const consIds: number[] = [];
  const serIds: number[] = [];
  const cycleIds: number[] = [];

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const TODAY = kst();
  /** 오늘보다 앞선 가장 가까운 수요일 — 시간표에 이미 있는 회차(연결 표본) */
  let WED = plus(TODAY, -1);
  while (dow(WED) !== 3) WED = plus(WED, -1);
  const MON = plus(WED, -2);
  const TUE = plus(WED, -1);
  const md = (iso: string) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;

  const api = (m: 'post' | 'patch' | 'get', p: string, t = ceoToken) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`).timeout({ response: 10000, deadline: 20000 });

  const makeCons = async (opts: { stage: string; step: number; sessions: number | null; students: number[]; items?: Array<{ label: string; required: boolean; done?: boolean }> }) => {
    const [c] = await q<{ id: string }>(
      `INSERT INTO cons (cons_type, stage, contract_step, amount, sessions, start_on, end_on, requester, owner_id, share)
       VALUES ('essay', $1, $2, 1200000, $3, $4::date, $5::date, 'mother', $6, 'all') RETURNING id`,
      [opts.stage, opts.step, opts.sessions, plus(TODAY, -40), plus(TODAY, 60), OWNER],
    );
    const id = Number(c.id);
    consIds.push(id);
    await q(`INSERT INTO cons_stu (cons_id, student_id) SELECT $1, unnest($2::bigint[])`, [id, opts.students]);
    let seq = 1;
    for (const it of opts.items ?? []) {
      await q(
        `INSERT INTO cons_item (cons_id, seq, label, required, done, done_by, done_at, source) VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual')`,
        [id, seq++, it.label, it.required, it.done === true, it.done ? OWNER : null, it.done ? new Date() : null],
      );
    }
    return id;
  };

  const makeSeries = async (rrule: string, fromDate: string, toDate: string | null, startMin: number, teacherId: number, students: number[], title: string, kindKey = 'consulting') => {
    const res = await api('post', '/schedule').send({
      kindKey, subKey: null, mode: 'offline', fromDate, toDate, rrule, startMin, endMin: startMin + 60,
      teacherId, roomId: null, title, studentIds: students,
    }).expect(201);
    const id = Number(res.body.serIds[0]);
    serIds.push(id);
    return id;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await cleanup();
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active, can_money) VALUES
         ($1,'회차대표','cs-ceo@t.kr','ceo',$4,true,null),
         ($2,'회차담당','cs-own@t.kr','manager',$4,true,null),
         ($3,'회차강사','cs-t@t.kr','teacher',$4,true,null)`,
      [CEO, OWNER, TEACHER, hash],
    );
    await q(`INSERT INTO stu (id, name, grade, school) VALUES ($1,'회차학생1','11','테스트고'), ($2,'회차학생2','10','테스트고')`, [STU1, STU2]);
    const login = async (email: string) => {
      const res = await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 }).send({ email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    ceoToken = await login('cs-ceo@t.kr');
    teacherToken = await login('cs-t@t.kr');
  });

  async function cleanup() {
    const sers = await q<{ id: string }>(
      `SELECT id FROM ser WHERE teacher_id = ANY($1) OR id IN (SELECT ser_id FROM ser_stu WHERE student_id = ANY($2))`,
      [[CEO, OWNER, TEACHER], [STU1, STU2]],
    );
    const ids = sers.map((s) => Number(s.id));
    const cons = (await q<{ id: string }>(`SELECT id FROM cons WHERE owner_id = ANY($1) OR id IN (SELECT cons_id FROM cons_stu WHERE student_id = ANY($2))`, [[CEO, OWNER], [STU1, STU2]])).map((c) => Number(c.id));
    if (cons.length) {
      await q(`DELETE FROM todo WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons_event WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons_sess WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons_item WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons_stu WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons WHERE id = ANY($1)`, [cons]);
    }
    if (ids.length) {
      await q(`DELETE FROM guide WHERE ser_id = ANY($1)`, [ids]);
      await q(`DELETE FROM pnoti WHERE ser_id = ANY($1)`, [ids]);
      await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [ids]);
      await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [ids]);
      await q(`DELETE FROM todo WHERE ser_id = ANY($1)`, [ids]);
      await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [ids]);
      await q(`DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id = ANY($1))`, [ids]);
      await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [ids]);
      await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [ids]);
      await q(`DELETE FROM ser WHERE id = ANY($1)`, [ids]);
    }
    await q(`DELETE FROM pnoti WHERE student_id = ANY($1)`, [[STU1, STU2]]);
    await q(`DELETE FROM gpa_use WHERE student_id = ANY($1)`, [[STU1, STU2]]);
    await q(`DELETE FROM gpa_alloc WHERE student_id = ANY($1)`, [[STU1, STU2]]);
    await q(`DELETE FROM gpa_cycle WHERE no >= 900 OR closed_by = ANY($1)`, [[CEO, OWNER]]);
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU1, STU2]]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, OWNER, TEACHER]]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, OWNER, TEACHER]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, OWNER, TEACHER]]);
  }

  afterAll(async () => {
    try { if (ds?.isInitialized) await cleanup(); } finally { await app?.close(); }
  });

  const count = async (sql: string, p: unknown[] = []) => Number((await q<{ n: number }>(sql, p))[0]!.n);

  /* ── ① I-91 · ② 육하원칙 · ③ I-95 — 한 건의 이야기 ───────────────────────────────── */
  it('날짜 셋을 잡으면 회차·할 일·시간표가 함께 선다(있으면 연결) · 미리보기 쓰기 0 · 육하원칙이 할 일을 접는다 · 종료는 필수 항목과 약정 회차 뒤에만 (I-91 · I-95 · N-18)', async () => {
    const consA = await makeCons({
      stage: 'running', step: 5, sessions: 3, students: [STU1],
      items: [{ label: '초안 확정', required: true }, { label: '참고 자료', required: false }],
    });
    // 담당의 컨설팅 회차가 매주 수요일 시간표에 이미 있다 — 그 수요일은 새로 만들지 않고 연결한다
    const weekly = await makeSeries('WEEKLY:WE', plus(WED, -21), null, 17 * 60, OWNER, [STU1], '컨설팅 · 회차 시험');

    await api('post', `/consulting/${consA}/sessions`, teacherToken).send({ dates: [MON] }).expect(403);
    expect((await api('post', `/consulting/${consA}/sessions`).send({ dates: [MON, MON], startMin: 600, endMin: 660 }).expect(400)).body.code).toBe('BAD_REQUEST');
    // 시간표에 없는 날짜인데 시각이 없다 — 400 · 아무것도 남지 않는다
    expect((await api('post', `/consulting/${consA}/sessions`).send({ dates: [MON] }).expect(400)).body.code).toBe('CONS_SESSION_TIME_REQUIRED');
    expect(await count(`SELECT count(*)::int AS n FROM cons_sess WHERE cons_id = $1`, [consA])).toBe(0);

    // 미리보기 — 셋 다 보이고 아무것도 쓰지 않는다
    const pre = (await api('post', `/consulting/${consA}/sessions/preview`).send({ dates: [WED, MON, TUE], startMin: 600, endMin: 660, what: '에세이 첨삭' }).expect(201)).body;
    expect(pre.preview).toBe(true);
    expect(pre.rows.map((r: { date: string; seq: number; linked: boolean; done: boolean }) => [r.date, r.seq, r.linked, r.done])).toEqual([[MON, 1, false, true], [TUE, 2, false, true], [WED, 3, true, true]]);
    expect(pre.rows[2]).toMatchObject({ serId: weekly, startMin: 17 * 60, endMin: 18 * 60 });
    expect(pre).toMatchObject({ created: 2, linked: 1, sessionsDone: 3, sessionsPlanned: 0, sessions: 3, overContract: false, staffName: '회차담당', studentNames: ['회차학생1'], notified: true });
    expect(await count(`SELECT count(*)::int AS n FROM cons_sess WHERE cons_id = $1`, [consA])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM todo WHERE cons_id = $1`, [consA])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM ser WHERE teacher_id = $1`, [OWNER])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM noti WHERE to_id = $1`, [OWNER])).toBe(0);

    // 실제 — 회차 3 · 할 일 3(담당에게) · 새 회차 2(하루짜리) · 연결 1 · 알림 1 · 감사 행 3
    const r = (await api('post', `/consulting/${consA}/sessions`).send({ dates: [WED, MON, TUE], startMin: 600, endMin: 660, what: '에세이 첨삭' }).expect(201)).body;
    expect(r.preview).toBe(false);
    const sess = await q<{ seq: number; on_date: string; who: string; what: string; ser_id: string }>(
      `SELECT seq, to_char(on_date,'YYYY-MM-DD') AS on_date, who, what, ser_id FROM cons_sess WHERE cons_id = $1 ORDER BY seq`, [consA]);
    expect(sess.map((s) => [s.seq, s.on_date, s.who, s.what])).toEqual([[1, MON, '회차담당 · 회차학생1', '에세이 첨삭'], [2, TUE, '회차담당 · 회차학생1', '에세이 첨삭'], [3, WED, '회차담당 · 회차학생1', '에세이 첨삭']]);
    expect(sess[2]!.ser_id).toBe(String(weekly));
    serIds.push(...r.rows.filter((x: { linked: boolean }) => !x.linked).map((x: { serId: number }) => x.serId));
    const created = await q<{ id: string; title: string; rrule: string; teacher_id: string; from_date: string }>(
      `SELECT id, title, rrule, teacher_id, to_char(from_date,'YYYY-MM-DD') AS from_date FROM ser WHERE id = ANY($1) ORDER BY from_date`, [r.rows.slice(0, 2).map((x: { serId: number }) => x.serId)]);
    expect(created.map((s) => [s.title, s.rrule, s.teacher_id, s.from_date])).toEqual([['컨설팅 1회차', 'ONCE', String(OWNER), MON], ['컨설팅 2회차', 'ONCE', String(OWNER), TUE]]);
    expect(await count(`SELECT count(*)::int AS n FROM ser_stu WHERE ser_id = ANY($1) AND student_id = $2`, [created.map((s) => Number(s.id)), STU1])).toBe(2);
    const todos = await q<{ title: string; to_id: string; due_on: string; done: boolean; src: string }>(
      `SELECT title, to_id, to_char(due_on,'YYYY-MM-DD') AS due_on, done, src FROM todo WHERE cons_id = $1 ORDER BY due_on`, [consA]);
    expect(todos.map((t) => [t.title, t.to_id, t.due_on, t.done, t.src])).toEqual([
      ['컨설팅 1회차 기록 — 회차학생1', String(OWNER), MON, false, 'consulting'],
      ['컨설팅 2회차 기록 — 회차학생1', String(OWNER), TUE, false, 'consulting'],
      ['컨설팅 3회차 기록 — 회차학생1', String(OWNER), WED, false, 'consulting'],
    ]);
    expect(await count(`SELECT count(*)::int AS n FROM cons_event WHERE cons_id = $1 AND event_type = 'session_added'`, [consA])).toBe(3);
    const notis = await q<{ body: string; link: string }>(`SELECT body, link FROM noti WHERE to_id = $1 AND from_id = $2`, [OWNER, CEO]);
    expect(notis).toHaveLength(1);
    expect(notis[0]!.body).toBe(`컨설팅 회차 3건 잡힘 — 회차학생1 · ${md(MON)} ~ ${md(WED)}`);
    expect(notis[0]!.link).toBe(`/schedule?date=${MON}`);

    // 목록·상세가 같은 수를 센다 — 오늘까지 한 회차 3 · 앞으로 0 · 필수 남음 1
    const list = (await api('get', '/consulting').expect(200)).body;
    const row = list.items.find((x: { id: number }) => x.id === consA);
    expect(row.sessionsDone).toBe(3);
    expect(row.sessionsLog.map((s: { seq: number; done: boolean }) => [s.seq, s.done])).toEqual([[1, true], [2, true], [3, true]]);
    let detail = (await api('get', `/consulting/${consA}`).expect(200)).body;
    expect(detail).toMatchObject({ sessionsDone: 3, sessionsPlanned: 0, requiredLeft: 1, closedAt: null, closedByName: null });
    expect(detail.capabilities).toMatchObject({ canAddSession: true, canClose: false });
    expect(detail.capabilities.closeBlockedReason).toContain('필수 항목 1개');

    // ② 육하원칙 — 보낸 칸만 · 다 적으면 그 회차의 할 일만 접힌다
    const sessId = Number((await q<{ id: string }>(`SELECT id FROM cons_sess WHERE cons_id = $1 AND seq = 1`, [consA]))[0]!.id);
    expect((await api('patch', `/consulting/${consA}/sessions/${sessId}`).send({}).expect(409)).body.code).toBe('EMPTY_PATCH');
    expect((await api('patch', `/consulting/${consA}/sessions/9999999`).send({ why: 'x' }).expect(404)).body.code).toBe('CONS_SESSION_NOT_FOUND');
    const half = (await api('patch', `/consulting/${consA}/sessions/${sessId}`).send({ why: ' 마감이 9월 ' }).expect(200)).body;
    expect(half).toMatchObject({ seq: 1, what: '에세이 첨삭', why: '마감이 9월', how: null, done: true });
    expect(await count(`SELECT count(*)::int AS n FROM todo WHERE cons_id = $1 AND done`, [consA])).toBe(0);
    const full = (await api('patch', `/consulting/${consA}/sessions/${sessId}`).send({ how: '문단 단위 지적', who: '회차담당 · 회차학생1 · 어머니' }).expect(200)).body;
    expect(full).toMatchObject({ who: '회차담당 · 회차학생1 · 어머니', what: '에세이 첨삭', why: '마감이 9월', how: '문단 단위 지적' });
    expect((await q<{ title: string }>(`SELECT title FROM todo WHERE cons_id = $1 AND done`, [consA])).map((t) => t.title)).toEqual(['컨설팅 1회차 기록 — 회차학생1']);
    expect(await count(`SELECT count(*)::int AS n FROM cons_event WHERE cons_id = $1 AND event_type = 'session_written'`, [consA])).toBe(2);

    // ③ 종료 — 필수 항목이 남았다 409 → 끝내면 회차 3/3 이라 열린다 · 미리보기는 쓰기 0
    expect((await api('post', `/consulting/${consA}/close/preview`).send({}).expect(409)).body.code).toBe('CONS_ITEMS_LEFT');
    const itemId = Number((await q<{ id: string }>(`SELECT id FROM cons_item WHERE cons_id = $1 AND required`, [consA]))[0]!.id);
    await api('patch', `/consulting/${consA}/items/${itemId}`).send({ done: true }).expect(200);
    detail = (await api('get', `/consulting/${consA}`).expect(200)).body;
    expect(detail.capabilities).toMatchObject({ canClose: true, closeBlockedReason: null });
    expect((await api('post', `/consulting/${consA}/close`).send({ templateId: 9999999 }).expect(404)).body.code).toBe('GTPL_NOT_FOUND');
    const cpre = (await api('post', `/consulting/${consA}/close/preview`).send({ memo: '수고 많으셨습니다' }).expect(201)).body;
    expect(cpre).toMatchObject({ preview: true, stage: 'done', parentNotices: 1, sessionsDone: 3, sessions: 3, endOn: TODAY, notified: true, studentNames: ['회차학생1'] });
    expect(cpre.noticeBody).toBe('컨설팅 종료 안내 — 에세이 지도 컨설팅(3회)이 마무리되었습니다. 그동안 함께해 주셔서 감사합니다. · 수고 많으셨습니다');
    expect((await q<{ stage: string }>(`SELECT stage FROM cons WHERE id = $1`, [consA]))[0]!.stage).toBe('running');
    expect(await count(`SELECT count(*)::int AS n FROM pnoti WHERE student_id = $1`, [STU1])).toBe(0);

    const closed = (await api('post', `/consulting/${consA}/close`).send({ memo: '수고 많으셨습니다' }).expect(201)).body;
    expect(closed.preview).toBe(false);
    expect((await q<{ stage: string; end_on: string }>(`SELECT stage, to_char(end_on,'YYYY-MM-DD') AS end_on FROM cons WHERE id = $1`, [consA]))[0]).toEqual({ stage: 'done', end_on: TODAY });
    const pn = await q<{ audience: string; channel: string; body: string; sent_at: string | null; on_date: string }>(
      `SELECT audience, channel, body, sent_at, to_char(on_date,'YYYY-MM-DD') AS on_date FROM pnoti WHERE student_id = $1`, [STU1]);
    expect(pn).toEqual([{ audience: 'parent', channel: 'app', body: closed.noticeBody, sent_at: null, on_date: TODAY }]);
    expect(await count(`SELECT count(*)::int AS n FROM cons_event WHERE cons_id = $1 AND event_type = 'closed'`, [consA])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM noti WHERE to_id = $1 AND body LIKE '컨설팅 종료 —%'`, [OWNER])).toBe(1);
    detail = (await api('get', `/consulting/${consA}`).expect(200)).body;
    expect(detail).toMatchObject({ stage: 'done', closedByName: '회차대표', endOn: TODAY });
    expect(detail.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(detail.capabilities).toMatchObject({ canAddSession: false, canClose: false, closeBlockedReason: '이미 종료된 컨설팅입니다' });
    // 종료 뒤에는 회차도 기록도 잠긴다 · 두 번 종료 409
    expect((await api('post', `/consulting/${consA}/sessions`).send({ dates: [plus(TODAY, 3)], startMin: 600, endMin: 660 }).expect(409)).body.code).toBe('CONS_LOCKED');
    expect((await api('patch', `/consulting/${consA}/sessions/${sessId}`).send({ how: 'x' }).expect(409)).body.code).toBe('CONS_LOCKED');
    expect((await api('post', `/consulting/${consA}/close`).send({}).expect(409)).body.code).toBe('CONS_ALREADY_DONE');
  });

  it('계약 단계는 회차를 못 잡고 · 앞으로 잡아 둔 날짜는 한 회차가 아니며 종료를 막고 · 겹치면 전부 되돌아간다 (I-91 · I-95)', async () => {
    const consB = await makeCons({ stage: 'contract', step: 3, sessions: 4, students: [STU2] });
    expect((await api('post', `/consulting/${consB}/sessions`).send({ dates: [plus(TODAY, 3)], startMin: 600, endMin: 660 }).expect(409)).body.code).toBe('CONS_NOT_RUNNING');
    expect((await api('post', `/consulting/${consB}/close`).send({}).expect(409)).body.code).toBe('CONS_NOT_RUNNING');

    const consC = await makeCons({ stage: 'running', step: 5, sessions: null, students: [STU2] });
    const F1 = plus(TODAY, 3);
    const F2 = plus(TODAY, 5);
    const r = (await api('post', `/consulting/${consC}/sessions`).send({ dates: [F2, F1], startMin: 900, endMin: 960, mode: 'online' }).expect(201)).body;
    expect(r.rows.map((x: { date: string; seq: number; done: boolean; linked: boolean }) => [x.date, x.seq, x.done, x.linked])).toEqual([[F1, 1, false, false], [F2, 2, false, false]]);
    expect(r).toMatchObject({ sessionsDone: 0, sessionsPlanned: 2, sessions: null, overContract: false });
    serIds.push(...r.rows.map((x: { serId: number }) => x.serId));
    expect((await q<{ mode: string }>(`SELECT mode FROM ser WHERE id = $1`, [r.rows[0].serId]))[0]!.mode).toBe('online');
    const detail = (await api('get', `/consulting/${consC}`).expect(200)).body;
    expect(detail).toMatchObject({ sessionsDone: 0, sessionsPlanned: 2, requiredLeft: 0 });
    expect(detail.capabilities.canClose).toBe(true); // 약정·필수 항목이 없다 — 회차 조건이 없어 종료 판정 자체는 열린다
    // 그러나 잡아 둔 날짜가 남아 있으면 종료는 막는다 — 접는 정책을 여기서 지어내지 않는다
    expect((await api('post', `/consulting/${consC}/close`).send({}).expect(409)).body.code).toBe('CONS_SESSIONS_PLANNED');
    expect((await q<{ stage: string }>(`SELECT stage FROM cons WHERE id = $1`, [consC]))[0]!.stage).toBe('running');

    // 겹침 — 담당이 그 시각에 다른 수업이 있다 → 409 · 어느 날짜인지 문장에 · 회차·할 일 모두 되돌아간다
    const F3 = plus(TODAY, 7);
    await makeSeries('ONCE', F3, F3, 900, OWNER, [STU1], '겹침 표본', 'class');
    const before = await count(`SELECT count(*)::int AS n FROM cons_sess WHERE cons_id = $1`, [consC]);
    const conflict = (await api('post', `/consulting/${consC}/sessions`).send({ dates: [plus(TODAY, 9), F3], startMin: 900, endMin: 960 }).expect(409)).body;
    expect(conflict.code).toBe('RESOURCE_CONFLICT');
    expect(conflict.message).toContain(`컨설팅 · ${md(F3)} 15:00–16:00 · 회차담당`);
    expect(await count(`SELECT count(*)::int AS n FROM cons_sess WHERE cons_id = $1`, [consC])).toBe(before);
    expect(await count(`SELECT count(*)::int AS n FROM todo WHERE cons_id = $1`, [consC])).toBe(2);
    expect(await count(`SELECT count(*)::int AS n FROM ser WHERE teacher_id = $1 AND from_date = $2::date`, [OWNER, plus(TODAY, 9)])).toBe(0);
    // 담당을 남으로 — 활동 중이 아닌 사람은 400 · 없는 사람 404
    await q(`UPDATE staff SET active = false WHERE id = $1`, [TEACHER]);
    expect((await api('post', `/consulting/${consC}/sessions`).send({ dates: [plus(TODAY, 11)], startMin: 900, endMin: 960, staffId: TEACHER }).expect(400)).body.code).toBe('STAFF_INACTIVE');
    await q(`UPDATE staff SET active = true WHERE id = $1`, [TEACHER]);
    expect((await api('post', `/consulting/${consC}/sessions`).send({ dates: [plus(TODAY, 11)], startMin: 900, endMin: 960, staffId: 9999999 }).expect(404)).body.code).toBe('STAFF_NOT_FOUND');
  });

  /* ── ④ O-150 ─────────────────────────────────────────────────────────────── */
  it('GPA 사이클 마감은 끝난 사이클만 · 승인 대기가 남으면 409 · 도장과 소멸 포인트 · 두 번은 409 (O-150 · D-R29)', async () => {
    const [ended] = await q<{ id: string }>(`INSERT INTO gpa_cycle (no, from_date, to_date) VALUES (900, $1::date, $2::date) RETURNING id`, [plus(TODAY, -80), plus(TODAY, -53)]);
    const [open] = await q<{ id: string }>(`INSERT INTO gpa_cycle (no, from_date, to_date) VALUES (901, $1::date, $2::date) RETURNING id`, [plus(TODAY, 100), plus(TODAY, 127)]);
    const endedId = Number(ended.id); const openId = Number(open.id);
    cycleIds.push(endedId, openId);
    await q(`INSERT INTO gpa_alloc (cycle_id, student_id, coord_id, points) VALUES ($1, $2, $3, 10), ($1, $4, $3, 2)`, [endedId, STU1, OWNER, STU2]);
    await q(`INSERT INTO gpa_use (cycle_id, student_id, svc_key, points, on_date, coord_id, state)
             VALUES ($1, $2, 'test', 4, $3::date, $4, 'ok'), ($1, $2, 'hw', 1, $5::date, $4, 'wait'), ($1, $6, 'test', 4, $3::date, $4, 'ok')`,
      [endedId, STU1, plus(TODAY, -70), OWNER, plus(TODAY, -65), STU2]);

    await api('post', `/gpa/cycles/${endedId}/close`, teacherToken).expect(403);
    expect((await api('post', `/gpa/cycles/9999999/close`).expect(404)).status).toBe(404);
    // 끝나지 않은 사이클은 막는다 — 남은 날의 기록을 적을 자리가 없어진다
    expect((await api('post', `/gpa/cycles/${openId}/close`).expect(409)).body.code).toBe('CYCLE_NOT_ENDED');
    // 승인 대기가 남았다
    const blocked = (await api('post', `/gpa/cycles/${endedId}/close`).expect(409)).body;
    expect(blocked.code).toBe('CYCLE_HAS_WAIT');
    expect(blocked.message).toContain('승인 대기 1건');
    const board = (await api('get', `/gpa?anchor=${plus(TODAY, -70)}`).expect(200)).body;
    expect(board.cycle).toMatchObject({ id: endedId, closed: false, closedAt: null, closedByName: null, canClose: false });
    expect(board.cycle.closeBlockedReason).toContain('승인 대기 1건');
    const waitId = Number((await q<{ id: string }>(`SELECT id FROM gpa_use WHERE cycle_id = $1 AND state = 'wait'`, [endedId]))[0]!.id);
    await api('patch', `/gpa/uses/${waitId}`).send({ state: 'ok' }).expect(200);
    expect((await api('get', `/gpa?anchor=${plus(TODAY, -70)}`).expect(200)).body.cycle).toMatchObject({ canClose: true, closeBlockedReason: null });

    const r = (await api('post', `/gpa/cycles/${endedId}/close`).expect(201)).body;
    expect(r.cycle).toMatchObject({ id: endedId, closed: true, closedByName: '회차대표', canClose: false, closeBlockedReason: '이미 마감된 사이클입니다' });
    expect(r.cycle.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.opened).toBeNull(); // 뒤에 사이클이 이미 있다
    // 잔여 = 배정 − 승인 사용 — 학생1 10 − 5 = 5 · 학생2 2 − 4 = −2(초과 · 소멸 아님)
    expect(r.students).toEqual([{ studentId: STU2, name: '회차학생2', remain: -2 }, { studentId: STU1, name: '회차학생1', remain: 5 }]);
    expect(r.expiredPoints).toBe(5);
    const [row] = await q<{ closed: boolean; closed_by: string }>(`SELECT closed, closed_by FROM gpa_cycle WHERE id = $1`, [endedId]);
    expect(row).toEqual({ closed: true, closed_by: String(CEO) });
    expect(await count(`SELECT count(*)::int AS n FROM log WHERE actor_id = $1 AND entity = 'GPA_CYCLE' AND action = 'close'`, [CEO])).toBe(1);
    expect((await api('post', `/gpa/cycles/${endedId}/close`).expect(409)).body.code).toBe('CYCLE_CLOSED');
    // 닫힌 사이클은 기록도 잠긴다 (C34 그대로)
    expect((await api('post', '/gpa/uses').send({ cycleId: endedId, studentId: STU1, svcKey: 'hw', onDate: plus(TODAY, -70) }).expect(409)).body.code).toBe('CYCLE_CLOSED');
  });
});
