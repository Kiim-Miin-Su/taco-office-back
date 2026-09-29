/** @file-guide
 * 목적: intake-plan-appt-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 1:1 대조 wave 3 — 상담 §23 카드가 담을 곳이 없던 셋(23-15 · 23-16 · 24-07)을 실제 앱(ValidationPipe · PermGuard) → DB 로 관통한다.
 *
 * 증명하는 것 —
 *   ① 배치안 초안(PUT plan) — 줄 낱말은 서버가 만들고, 단가는 **적은 날의 단가표**(과목 단가 · 1인 구간)를 읽는다. 금액 권한이 없으면 null(D-R39).
 *      줄 수·주 N회는 400, 모르는 종류·그만둔 강사는 404, 실패 건은 409. 통째로 바꾸고 LOG 에 before/after.
 *   ② 보류 재확인 — 들어온 날 + 2일이 기한이고 「연장 +2일」이 그 날짜에 이틀을 더한다. 보류가 아니면 409 · 단계가 바뀌면 비운다.
 *   ③ 2차 · 진단 일정 — 종류마다 한 줄(다시 보내면 고침) · 2차 대기 띠가 2차 일정을 기한으로 삼는다 · 온라인+강의실 409 · 시각 거꾸로 409.
 *   ④ 「스케줄에 N건 만들기」 — 시간표 회차(ONCE · 진단고사/상담 종류 · 강사 자리 = 담당)를 만들고 잇는다. 만든 줄은 PUT 이 409,
 *      두 번째 만들기는 409, 같은 강의실·시각이면 409 로 **전부 되돌린다**. 시간표에서 회차를 지우면 「미생성」으로 돌아간다.
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

type Lead = Record<string, unknown> & { id: number; stage: string };

d('상담 배치안 초안 · 보류 연장 · 2차/진단 일정 (23-15 · 23-16 · Front→DTO→Back→DB)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  let mgrToken = '';
  const PW = 'w3p-12345';
  const CEO = 9741;
  const MGR = 9742; // 상담 담당 · 금액 권한 없음(사람별 예외 can_money=false — 역할 기본값에 기대지 않는다)
  const GONE = 9743; // 그만둔 강사
  const SUB = 'w3p-sub';
  let ROOM = 0;
  /** 시험 안에서 직접 지운 회차 — 진단고사 종류는 리포트 한 장이 같이 투영되므로(시간표 규약) 치울 때 그 리포트도 지운다 */
  const droppedSers: number[] = [];

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const TODAY = kst();

  const api = (m: 'post' | 'patch' | 'put' | 'get' | 'delete', p: string, t = ceoToken) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`).timeout({ response: 10000, deadline: 20000 });
  const leadOf = async (id: number, t = ceoToken) =>
    ((await api('get', '/ops', t).expect(200)).body as { leads: Lead[] }).leads.find((l) => l.id === id)!;
  const newLead = async (name: string) =>
    (await api('post', '/ops/leads').send({ name, source: 'phone', ownerId: MGR }).expect(201)).body as Lead;

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
         ($1,'사차대표','w3p-ceo@t.kr','ceo',$4,true,null),
         ($2,'사차담당','w3p-mgr@t.kr','manager',$4,true,false),
         ($3,'사차퇴사','w3p-gone@t.kr','teacher',$4,false,null)`,
      [CEO, MGR, GONE, hash],
    );
    const [room] = await q<{ id: string }>(`INSERT INTO room (branch, name) VALUES ('테스트', 'W3P 상담실') RETURNING id`);
    ROOM = Number(room.id);
    // 스위트 전용 과목과 단가 셋 — 1인 77,000 · 2인 50,000(구간은 1인만 본다) · 내일부터 99,000(「당시」 단가가 아니다)
    await q(`INSERT INTO sub (key, name, color, active, sort) VALUES ($1, 'W3P Reading', '#445566', true, 999)`, [SUB]);
    await q(
      `INSERT INTO rate (kind_key, sub_key, heads, unit_price, from_date) VALUES
         ('class', $1, 1, 77000, '2020-01-01'), ('class', $1, 2, 50000, '2020-01-01'), ('class', $1, 1, 99000, $2::date)`,
      [SUB, plus(TODAY, 1)],
    );
    for (const [email, set] of [['w3p-ceo@t.kr', (t: string) => { ceoToken = t; }], ['w3p-mgr@t.kr', (t: string) => { mgrToken = t; }]] as const) {
      const res = await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ loginId: email, password: PW }).expect(201);
      set(res.body.accessToken as string);
    }
  });

  async function cleanup() {
    const leads = (await q<{ id: string }>(`SELECT id FROM lead WHERE name LIKE '사차%'`)).map((l) => Number(l.id));
    const sers = (await q<{ id: string }>(
      `SELECT id FROM ser WHERE teacher_id = ANY($1) OR id IN (SELECT ser_id FROM lead_appt WHERE lead_id = ANY($2))`, [[CEO, MGR], leads],
    )).map((s) => Number(s.id));
    if (leads.length) {
      await q(`DELETE FROM lead_appt WHERE lead_id = ANY($1)`, [leads]);
      await q(`DELETE FROM lead_plan WHERE lead_id = ANY($1)`, [leads]);
      await q(`DELETE FROM lead_touch WHERE lead_id = ANY($1)`, [leads]);
      await q(`DELETE FROM lead_stage_log WHERE lead_id = ANY($1)`, [leads]);
      await q(`DELETE FROM lead WHERE id = ANY($1)`, [leads]);
    }
    // 진단고사(리포트 대상 종류) 회차는 시간표가 리포트를 같이 만든다 — 학생이 없어 rep_stu 는 비어 있다
    const repSers = [...sers, ...droppedSers];
    if (repSers.length) {
      await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [repSers]);
      await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [repSers]);
    }
    if (sers.length) {
      await q(`DELETE FROM guide WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM pnoti WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM todo WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM zassign WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM ser WHERE id = ANY($1)`, [sers]);
    }
    await q(`DELETE FROM rate WHERE sub_key = $1`, [SUB]);
    await q(`DELETE FROM sub WHERE key = $1`, [SUB]);
    await q(`DELETE FROM room WHERE name = 'W3P 상담실'`);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, MGR, GONE]]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, MGR, GONE]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, MGR, GONE]]);
  }

  afterAll(async () => {
    if (ds) await cleanup();
    await app?.close();
  });

  it('① 배치안 — 줄 낱말은 서버 · 단가는 적은 날의 단가표(1인 구간) · 금액 권한 없으면 null · 거절 셋 · 통째로 바꾸고 LOG', async () => {
    const lead = await newLead('사차배치');
    const put = (lines: unknown[], t = ceoToken) => api('put', `/ops/leads/${lead.id}/plan`, t).send({ lines });

    const saved = (await put([
      { kindKey: 'class', subKey: SUB, perWeek: 2, teacherId: MGR },
      { kindKey: 'class', perWeek: 1 },
    ]).expect(200)).body as Lead & { plan: Array<Record<string, unknown>> };
    expect(saved.plan[0]).toMatchObject({ seq: 1, kindKey: 'class', subKey: SUB, subLabel: 'W3P Reading', perWeek: 2, teacherId: MGR, teacherName: '사차담당', label: 'W3P Reading 주2 · 사차담당', unitPrice: 77000 });
    expect(saved.plan[1]).toMatchObject({ seq: 2, subKey: null, perWeek: 1, teacherId: null, label: `${saved.plan[1].kindLabel} 주1` });

    // 같은 줄을 금액 권한 없는 담당이 읽으면 단가만 빠진다(D-R39) — 줄 낱말은 같다
    const asMgr = await leadOf(lead.id, mgrToken) as Lead & { plan: Array<Record<string, unknown>> };
    expect(asMgr.plan[0]).toMatchObject({ label: 'W3P Reading 주2 · 사차담당', unitPrice: null });
    expect((await put([{ kindKey: 'class', subKey: SUB, perWeek: 3 }], mgrToken).expect(200)).body.plan[0].unitPrice).toBeNull();

    // 거절 — 주 8회 · 9줄은 DTO(400), 모르는 종류 · 그만둔 강사는 404 — 표는 그대로다
    await put([{ kindKey: 'class', perWeek: 8 }]).expect(400);
    await put(Array.from({ length: 9 }, () => ({ kindKey: 'class', perWeek: 1 }))).expect(400);
    expect((await put([{ kindKey: 'nope-kind', perWeek: 1 }]).expect(404)).body.code).toBe('KIND_NOT_FOUND');
    expect((await put([{ kindKey: 'class', perWeek: 1, teacherId: GONE }]).expect(404)).body.code).toBe('STAFF_NOT_FOUND');
    expect(await q(`SELECT seq, per_week FROM lead_plan WHERE lead_id = $1 ORDER BY seq`, [lead.id])).toEqual([{ seq: 1, per_week: 3 }]);

    // 빈 배열 = 비우기 · LOG 는 쓸 때마다 before/after 한 줄
    expect((await put([]).expect(200)).body.plan).toEqual([]);
    const logs = await q<{ before: { lines: unknown[] }; after: { lines: unknown[] } }>(
      `SELECT before, after FROM log WHERE entity = 'LEAD' AND entity_id = $1 AND action = 'plan' ORDER BY id`, [lead.id]);
    expect(logs.map((l) => [l.before.lines.length, l.after.lines.length])).toEqual([[0, 2], [2, 1], [1, 0]]);

    // 실패 건의 배치안은 「당시」 기록이다 — 고치지 않는다
    await api('post', `/ops/leads/${lead.id}/fail`).send({}).expect(201);
    expect((await put([{ kindKey: 'class', perWeek: 1 }]).expect(409)).body.code).toBe('LEAD_PLAN_LOCKED');
  });

  it('② 보류 재확인 — 들어온 날 + 2일이 기한 · 「연장 +2일」은 그 날짜에 이틀 · 보류가 아니면 409 · 단계가 바뀌면 비운다', async () => {
    const lead = await newLead('사차보류');
    expect((await api('post', `/ops/leads/${lead.id}/hold/extend`).expect(409)).body.code).toBe('LEAD_NOT_HOLD');
    await api('patch', `/ops/leads/${lead.id}/stage`).send({ to: 'hold' }).expect(200);

    const held = await leadOf(lead.id) as Lead & { recheckOn: string; stageDue: Record<string, unknown> };
    expect(held.recheckOn).toBe(plus(TODAY, 2));
    expect(held.stageDue).toMatchObject({ task: '배치안 수락 여부 확인', dueOn: plus(TODAY, 2), dueLabel: 'D-2' });

    const ext = (await api('post', `/ops/leads/${lead.id}/hold/extend`).expect(200)).body as Lead & { recheckOn: string; stageDue: Record<string, unknown> };
    expect(ext.recheckOn).toBe(plus(TODAY, 4));
    expect(ext.stageDue).toMatchObject({ dueOn: plus(TODAY, 4), dueLabel: 'D-4' });
    const [log] = await q<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM log WHERE entity = 'LEAD' AND entity_id = $1 AND action = 'hold_extend'`, [lead.id]);
    expect(log).toEqual({ before: { recheckOn: plus(TODAY, 2) }, after: { recheckOn: plus(TODAY, 4) } });

    // 보류를 떠나면 그 보류의 재확인 날짜는 비운다 — 다시 보류에 들어오면 새로 +2일
    await api('patch', `/ops/leads/${lead.id}/stage`).send({ to: 'second' }).expect(200);
    expect(await q(`SELECT recheck_on FROM lead WHERE id = $1`, [lead.id])).toEqual([{ recheck_on: null }]);
    expect((await leadOf(lead.id)).recheckOn).toBeNull();
  });

  it('③ 2차 · 진단 일정 — 종류마다 한 줄 · 2차 대기 띠는 2차 일정 · 거절 셋 · ④ 스케줄에 만들기 → 잇기 · 다시 만들기/고치기 409 · 겹치면 전부 되돌림 · 회차를 지우면 미생성', async () => {
    const lead = await newLead('사차일정');
    await api('patch', `/ops/leads/${lead.id}/stage`).send({ to: 'wait2nd' }).expect(200);
    const put = (body: Record<string, unknown>, id = lead.id) => api('put', `/ops/leads/${id}/appts`).send(body);
    const day = plus(TODAY, 5);

    await put({ kind: 'second', onDate: day, startMin: 870, endMin: 930, mode: 'online' }).expect(200);
    const both = (await put({ kind: 'diag', onDate: plus(TODAY, 3), startMin: 600, endMin: 660, mode: 'offline', roomId: ROOM }).expect(200)).body as Lead & { appts: Array<Record<string, unknown>>; stageDue: Record<string, unknown> };
    expect(both.appts).toEqual([
      { kind: 'diag', kindLabel: '진단', onDate: plus(TODAY, 3), startMin: 600, endMin: 660, mode: 'offline', roomId: ROOM, placeLabel: 'W3P 상담실', serId: null, scheduled: false },
      { kind: 'second', kindLabel: '2차', onDate: day, startMin: 870, endMin: 930, mode: 'online', roomId: null, placeLabel: '온라인 줌', serId: null, scheduled: false },
    ]);
    // 폼의 낱말도 서버가 준다(D-R18)
    expect(((await api('get', '/ops').expect(200)).body as { intakeHead: { apptKinds: unknown } }).intakeHead.apptKinds)
      .toEqual([{ key: 'diag', label: '진단' }, { key: 'second', label: '2차' }]);
    // 원본 §23 「2차 상담 2026-08-26 14:30 · D-5」 — 2차 대기의 기한은 잡아 둔 2차 일정이다
    expect(both.stageDue).toMatchObject({ task: `2차 상담 ${day} 14:30`, dueOn: day, dueLabel: 'D-5' });

    // 같은 종류를 다시 보내면 고쳐 적는다(한 줄) · 거절 셋
    await put({ kind: 'second', onDate: day, startMin: 900, endMin: 960, mode: 'online' }).expect(200);
    expect(await q(`SELECT count(*)::int AS n FROM lead_appt WHERE lead_id = $1`, [lead.id])).toEqual([{ n: 2 }]);
    expect((await put({ kind: 'second', onDate: day, startMin: 900, endMin: 960, mode: 'online', roomId: ROOM }).expect(409)).body.code).toBe('LEAD_APPT_PLACE');
    expect((await put({ kind: 'second', onDate: day, startMin: 960, endMin: 900, mode: 'online' }).expect(409)).body.code).toBe('BAD_RANGE');
    await put({ kind: 'visit', onDate: day, startMin: 900, endMin: 960, mode: 'online' }).expect(400);

    // ④ 스케줄에 2건 — 진단고사/상담 종류 · 강사 자리 = 담당 · 잇는다
    const made = (await api('post', `/ops/leads/${lead.id}/appts/schedule`).expect(201)).body as { lead: Lead & { appts: Array<Record<string, unknown>> }; created: number };
    expect(made.created).toBe(2);
    expect(made.lead.appts.map((a) => [a.kind, a.scheduled])).toEqual([['diag', true], ['second', true]]);
    const sers = await q<{ kind_key: string; sub_key: string; teacher_id: string; title: string; rrule: string }>(
      `SELECT s.kind_key, s.sub_key, s.teacher_id, s.title, s.rrule FROM lead_appt a JOIN ser s ON s.id = a.ser_id WHERE a.lead_id = $1 ORDER BY a.kind`, [lead.id]);
    expect(sers).toEqual([
      { kind_key: 'diagx', sub_key: 'diag', teacher_id: String(MGR), title: '사차일정 진단고사', rrule: 'ONCE' },
      { kind_key: 'consult', sub_key: 'intake', teacher_id: String(MGR), title: '사차일정 2차 상담', rrule: 'ONCE' },
    ]);
    // 시간표에 만든 줄은 여기서 못 고치고 · 다시 만들 것도 없다
    expect((await put({ kind: 'diag', onDate: day, startMin: 600, endMin: 660, mode: 'offline' }).expect(409)).body.code).toBe('LEAD_APPT_SCHEDULED');
    expect((await api('post', `/ops/leads/${lead.id}/appts/schedule`).expect(409)).body.code).toBe('LEAD_APPT_NONE');

    // 겹침 — 다른 건의 진단을 같은 강의실 · 같은 시각에 잡고 만들면 시간표가 막는다 → 전부 되돌린다(회차 0 · 연결 0)
    const other = await newLead('사차겹침');
    await put({ kind: 'second', onDate: plus(TODAY, 6), startMin: 600, endMin: 660, mode: 'online' }, other.id).expect(200);
    await put({ kind: 'diag', onDate: plus(TODAY, 3), startMin: 610, endMin: 650, mode: 'offline', roomId: ROOM }, other.id).expect(200);
    const serCount = async () => Number((await q<{ n: number }>(`SELECT count(*)::int AS n FROM ser WHERE title LIKE '사차겹침%'`))[0].n);
    expect((await api('post', `/ops/leads/${other.id}/appts/schedule`).expect(409)).body.code).toBe('RESOURCE_CONFLICT');
    expect(await serCount()).toBe(0);
    expect(await q(`SELECT kind, ser_id FROM lead_appt WHERE lead_id = $1 ORDER BY kind`, [other.id])).toEqual([
      { kind: 'diag', ser_id: null }, { kind: 'second', ser_id: null },
    ]);

    // 시간표에서 회차를 지우면 연결만 풀린다 — 카드는 다시 「미생성」
    const [diag] = await q<{ ser_id: string }>(`SELECT ser_id FROM lead_appt WHERE lead_id = $1 AND kind = 'diag'`, [lead.id]);
    droppedSers.push(Number(diag.ser_id));
    await q(`DELETE FROM ser_occ WHERE ser_id = $1`, [diag.ser_id]);
    await q(`DELETE FROM ser WHERE id = $1`, [diag.ser_id]);
    const after = await leadOf(lead.id) as Lead & { appts: Array<Record<string, unknown>> };
    expect(after.appts.map((a) => [a.kind, a.scheduled])).toEqual([['diag', false], ['second', true]]);

    // 끝난 건(등록 실패)은 일정을 적지 않는다
    await api('post', `/ops/leads/${other.id}/fail`).send({}).expect(201);
    expect((await put({ kind: 'diag', onDate: day, startMin: 600, endMin: 660, mode: 'online' }, other.id).expect(409)).body.code).toBe('LEAD_APPT_LOCKED');
  });

  it('⑤ 일정 지우기 (23-15 · impl3-w8) — 아직 시간표에 없는 줄만 지운다 · 만든 줄은 409 로 시간표를 건드리지 않는다 · 없는 줄 404 · 종류 400 · 끝난 건 409 · LOG', async () => {
    const lead = await newLead('사차지우기');
    const put = (body: Record<string, unknown>) => api('put', `/ops/leads/${lead.id}/appts`).send(body);
    const del = (kind: string, id = lead.id) => api('delete', `/ops/leads/${id}/appts/${kind}`);
    await put({ kind: 'diag', onDate: plus(TODAY, 4), startMin: 600, endMin: 660, mode: 'offline', roomId: ROOM }).expect(200);
    await put({ kind: 'second', onDate: plus(TODAY, 8), startMin: 780, endMin: 840, mode: 'online' }).expect(200);

    // 미생성 줄 — 지우면 카드에서 빠지고 LOG 에 지운 값이 남는다
    const after = (await del('diag').expect(200)).body as Lead & { appts: Array<Record<string, unknown>> };
    expect(after.appts.map((a) => a.kind)).toEqual(['second']);
    expect(await q(`SELECT kind FROM lead_appt WHERE lead_id = $1`, [lead.id])).toEqual([{ kind: 'second' }]);
    const [log] = await q<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT before, after FROM log WHERE entity = 'LEAD' AND entity_id = $1 AND action = 'appt_delete'`, [lead.id]);
    expect(log.before).toMatchObject({ kind: 'diag', onDate: plus(TODAY, 4), startMin: 600, endMin: 660, mode: 'offline', roomId: ROOM });
    expect(log.after).toEqual({});

    // 없는 줄 · 모르는 종류
    expect((await del('diag').expect(404)).body.code).toBe('LEAD_APPT_NOT_FOUND');
    await del('visit').expect(400);

    // 시간표에 만든 줄 — 지우지 않는다(회차·리포트는 시간표가 정본) · 사람이 읽을 문장으로 막는다
    await api('post', `/ops/leads/${lead.id}/appts/schedule`).expect(201);
    const [linked] = await q<{ ser_id: string }>(`SELECT ser_id FROM lead_appt WHERE lead_id = $1 AND kind = 'second'`, [lead.id]);
    const refused = (await del('second').expect(409)).body as { code: string; message: string };
    expect(refused.code).toBe('LEAD_APPT_SCHEDULED');
    expect(refused.message).toContain('시간표');
    expect(refused.message).not.toMatch(/[A-Z_]{4,}/);
    expect(await q(`SELECT 1 FROM ser WHERE id = $1`, [linked.ser_id])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM lead_appt WHERE lead_id = $1 AND kind = 'second'`, [lead.id])).toHaveLength(1);

    // 끝난 건은 기록을 그대로 둔다
    const done = await newLead('사차지우기끝');
    await api('put', `/ops/leads/${done.id}/appts`).send({ kind: 'diag', onDate: plus(TODAY, 4), startMin: 900, endMin: 960, mode: 'online' }).expect(200);
    await api('post', `/ops/leads/${done.id}/fail`).send({}).expect(201);
    expect((await del('diag', done.id).expect(409)).body.code).toBe('LEAD_APPT_LOCKED');
  });

  it('⑥ 시간표에 만든 일정의 방식은 그 회차의 실제 방식이다 — 회차 예외가 그날만 방식을 바꾸면 카드도 따른다 (W11 A\' · N-56 · lib/sql.effectiveModeOf)', async () => {
    const lead = await newLead('사차방식');
    await api('put', `/ops/leads/${lead.id}/appts`)
      .send({ kind: 'second', onDate: plus(TODAY, 9), startMin: 600, endMin: 660, mode: 'online' }).expect(200);
    await api('post', `/ops/leads/${lead.id}/appts/schedule`).expect(201);
    const before = (await leadOf(lead.id)) as Lead & { appts: Array<Record<string, unknown>> };
    expect(before.appts.map((a) => [a.kind, a.mode, a.placeLabel, a.scheduled])).toEqual([['second', 'online', '온라인 줌', true]]);

    // 시간표가 그 회차 하나를 현장으로 바꿨다(회차 예외) — 규칙(SER)은 그대로 온라인이다
    const [occ] = await q<{ ser_id: string; on_date: string }>(
      `SELECT o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date FROM lead_appt a JOIN ser_occ o ON o.ser_id = a.ser_id WHERE a.lead_id = $1`, [lead.id]);
    await q(`INSERT INTO exc (ser_id, on_date, mode) VALUES ($1, $2::date, 'offline')`, [occ.ser_id, occ.on_date]);
    const after = (await leadOf(lead.id)) as Lead & { appts: Array<Record<string, unknown>> };
    expect(after.appts.map((a) => [a.kind, a.mode, a.placeLabel])).toEqual([['second', 'offline', '장소 미정']]);
    expect(await q(`SELECT mode::text AS mode FROM ser WHERE id = $1`, [occ.ser_id])).toEqual([{ mode: 'online' }]);
  });

  /* ── A-02 「전화 문의 후 상담 일정을 잡음」 — ① 카드 열기 → 상담 일정 잡기 ② 날짜 · 시각 ③ 담당 지정 · 방식 현장 ④ 저장 ──
     스케줄에 입학 상담이 생긴다 · 카드가 1차 → 2차 대기 · 담당의 시간표에도 같은 일정 · 「이러면 실패 — 스케줄에 안 생기거나 · 담당자 시간표에 안 보이거나 · 단계가 그대로」.
     전에는 적기(PUT appts)와 「스케줄에 N건 만들기」와 단계 이동이 세 번의 쓰기였고 담당은 카드 담당으로만 정해졌다. */
  it('⑦ A-02 상담 일정 잡기 — 한 트랜잭션에 시간표 회차(입학 상담 · 담당 자리) · 담당 지정 · 1차 → 2차 대기(도달 기록) · 상담 예약 접촉 · LOG', async () => {
    const lead = (await api('post', '/ops/leads').send({ name: '사차예약', source: 'phone' }).expect(201)).body as Lead;
    expect(lead.ownerId ?? null).toBeNull();
    const day = plus(TODAY, 11);
    const book = (body: Record<string, unknown>, id = lead.id, t = ceoToken) => api('post', `/ops/leads/${id}/appts/book`, t).send(body);

    const res = (await book({ kind: 'second', onDate: day, startMin: 960, endMin: 1020, mode: 'offline', roomId: ROOM, ownerId: MGR }).expect(201)).body as {
      lead: Lead & { appts: Array<Record<string, unknown>>; touches: Array<Record<string, unknown>> }; created: number; unavailable: unknown[];
    };
    expect(res.created).toBe(1);
    expect(res.lead).toMatchObject({ stage: 'wait2nd', ownerId: MGR, ownerName: '사차담당' });
    const serId = res.lead.appts[0]?.serId as number;
    expect(res.lead.appts).toEqual([{
      kind: 'second', kindLabel: '2차', onDate: day, startMin: 960, endMin: 1020, mode: 'offline', roomId: ROOM, placeLabel: 'W3P 상담실', serId: expect.any(Number), scheduled: true,
    }]);
    // 스케줄 — 입학 상담(상담 종류 · 입학 상담 과목) · 담당 자리 · 한 번(ONCE)
    expect(await q(`SELECT kind_key, sub_key, teacher_id, title, rrule, room_id FROM ser WHERE id = $1`, [serId])).toEqual([
      { kind_key: 'consult', sub_key: 'intake', teacher_id: String(MGR), title: '사차예약 2차 상담', rrule: 'ONCE', room_id: String(ROOM) },
    ]);
    // 담당의 시간표(선생님별) · 담당 본인의 시간표에도 같은 회차
    const occOf = async (path: string, t = ceoToken) =>
      ((await api('get', path, t).expect(200)).body as { items: Array<{ serId: number; startMin: number }> }).items.filter((o) => o.serId === serId);
    expect(await occOf(`/schedule/occurrences?from=${day}&to=${day}&teacherId=${MGR}`)).toEqual([expect.objectContaining({ serId, startMin: 960 })]);
    expect(await occOf(`/schedule/occurrences?from=${day}&to=${day}`, mgrToken)).toHaveLength(1);
    // 단계 — 도달 기록 [first, wait2nd] · 상담 예약 접촉(다음은 그날) → A-03 의 「상담 오늘 · 지남」이 이 날짜를 본다
    expect((await q<{ stage: string }>(`SELECT stage FROM lead_stage_log WHERE lead_id = $1 ORDER BY id`, [lead.id])).map((r) => r.stage)).toEqual(['first', 'wait2nd']);
    expect(await q(`SELECT kind, to_char(next_on,'YYYY-MM-DD') AS next_on, by_id FROM lead_touch WHERE lead_id = $1`, [lead.id])).toEqual([
      { kind: 'book', next_on: day, by_id: String(CEO) },
    ]);
    expect(res.lead.touches[0]).toMatchObject({ kind: 'book', nextOn: day });
    expect(String(res.lead.touches[0]?.note)).toContain('2차 상담');
    const [log] = await q<{ after: Record<string, unknown> }>(`SELECT after FROM log WHERE entity = 'LEAD' AND entity_id = $1 AND action = 'appt_book'`, [lead.id]);
    expect(log.after).toMatchObject({ kind: 'second', onDate: day, startMin: 960, endMin: 1020, mode: 'offline', roomId: ROOM, ownerId: MGR, serId, stage: 'wait2nd' });

    // 다시 잡으면 — 이미 시간표에 있는 종류는 시간표에서 옮긴다(409)
    expect((await book({ kind: 'second', onDate: day, startMin: 600, endMin: 660, mode: 'online', ownerId: MGR }).expect(409)).body.code).toBe('LEAD_APPT_SCHEDULED');
    // 2차 대기 건에 진단을 더 잡으면 — 단계는 그대로(앞으로만 · 1차일 때만 2차 대기로 옮긴다)
    await book({ kind: 'diag', onDate: plus(TODAY, 10), startMin: 600, endMin: 660, mode: 'online', ownerId: MGR }).expect(201);
    expect((await leadOf(lead.id)).stage).toBe('wait2nd');
    expect((await q<{ stage: string }>(`SELECT stage FROM lead_stage_log WHERE lead_id = $1 ORDER BY id`, [lead.id])).map((r) => r.stage)).toEqual(['first', 'wait2nd']);
  });

  it('⑧ A-02 실패는 전부 되돌린다 — 겹침 409(일정 · 단계 · 접촉 · 담당 모두 그대로) · 그만둔 담당 404 · 담당 빠짐 400 · 담당(관리자)도 잡는다 · 끝난 건 409', async () => {
    const first = (await api('post', '/ops/leads').send({ name: '사차예약겹침', source: 'kakao' }).expect(201)).body as Lead;
    const day = plus(TODAY, 12);
    const body = { kind: 'second', onDate: day, startMin: 840, endMin: 900, mode: 'offline', roomId: ROOM, ownerId: MGR };
    const book = (b: Record<string, unknown>, id = first.id, t = ceoToken) => api('post', `/ops/leads/${id}/appts/book`, t).send(b);
    const other = await newLead('사차예약앞');
    await book(body, other.id).expect(201);

    // 같은 강의실 · 같은 시각 — 시간표가 막는다. 적어 둔 일정도 단계도 접촉도 담당도 남지 않는다
    const refused = (await book(body).expect(409)).body as { code: string; message: string };
    expect(refused.code).toBe('RESOURCE_CONFLICT');
    expect(refused.message).toContain(`${day} 14:00`);
    expect(await q(`SELECT 1 FROM lead_appt WHERE lead_id = $1`, [first.id])).toEqual([]);
    expect(await q(`SELECT stage, owner_id FROM lead WHERE id = $1`, [first.id])).toEqual([{ stage: 'first', owner_id: null }]);
    expect(await q(`SELECT kind FROM lead_touch WHERE lead_id = $1`, [first.id])).toEqual([]);
    expect(await q(`SELECT count(*)::int AS n FROM ser WHERE title = '사차예약겹침 2차 상담'`)).toEqual([{ n: 0 }]);

    expect((await book({ ...body, startMin: 1080, endMin: 1140, ownerId: GONE }).expect(404)).body.code).toBe('STAFF_NOT_FOUND');
    const { ownerId: _o, ...noOwner } = body;
    void _o;
    await book({ ...noOwner, startMin: 1080, endMin: 1140 }).expect(400);
    await book({ ...body, startMin: 1080, endMin: 1140 }, first.id, mgrToken).expect(201);
    await api('post', `/ops/leads/${first.id}/fail`).send({}).expect(201);
    expect((await book({ ...body, kind: 'diag', startMin: 1150, endMin: 1200 }).expect(409)).body.code).toBe('LEAD_APPT_LOCKED');
  });
});
