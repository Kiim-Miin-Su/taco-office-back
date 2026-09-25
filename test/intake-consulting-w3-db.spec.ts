/** @file-guide
 * 목적: intake-consulting-w3-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 1:1 대조 wave 3 — 상담 §23·§24 · 컨설팅 §27·§30·§31 의 **서버 몫**을 실제 앱(ValidationPipe · PermGuard) → DB 로 관통한다.
 *
 * 증명하는 것 —
 *   상담  ① 학년(23-10)은 적은 그대로 남고 11자는 400 · ② 단계 기한 띠(23-12)는 그 단계에 들어온 날 + SLA(1차 2 · 보류 2)로 서버가 만들고,
 *           들어온 날을 모르는 옛 건은 띠가 없다(N-25) · ③ 실패 사유 분류(24-05)는 다섯 낱말만 받고(DTO 400 · 표 CHECK) 머리 막대가 센다 ·
 *           ④ 실패한 날(24-04)은 도달 기록의 「등록 실패」 줄 · ⑤ 재연락(24-06)은 실패 뒤 접촉이 있으면 완료 · 옛 실패 건은 판정하지 않는다.
 *   컨설팅 ⑥ §27 회차 수(27-04)는 §26 목록과 같은 셈 — 앞으로 잡아 둔 날짜는 세지 않는다 · ⑦ 항목 처리 시각(31-04) ·
 *           ⑧ 회차 머리의 시각·담당·강의실(31-07)은 시간표 회차에서 읽는다 · ⑨ 「결과」·「다음까지」(31-08) — 다음까지는 담당의 할 일 한 줄 + 알림,
 *           고쳐 적으면 같은 할 일의 제목만 바뀐다 · ⑩ 상세의 공개 범위 뜻 · 계약 5단계 한 줄(30-06 · 30-07).
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

d('1:1 대조 wave 3 — 상담 §23·§24 · 컨설팅 §27·§30·§31 서버 몫 (Front→DTO→Back→DB)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  const PW = 'w3-12345';
  const CEO = 9731;
  const OWNER = 9732; // 컨설팅 담당 매니저
  const STU = 99731;
  const LEGACY_LEAD = 97301;
  const LEGACY_FAILED = 97302;
  let ROOM = 0;
  const leadIds: number[] = [LEGACY_LEAD, LEGACY_FAILED];
  const consIds: number[] = [];

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const TODAY = kst();

  const api = (m: 'post' | 'patch' | 'get', p: string, t = ceoToken) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`).timeout({ response: 10000, deadline: 20000 });
  const leadOf = async (id: number) => {
    const body = (await api('get', '/ops').expect(200)).body as { leads: Array<Record<string, unknown>>; intakeHead: Record<string, unknown> };
    return { lead: body.leads.find((l) => l.id === id)!, head: body.intakeHead };
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
         ($1,'삼차대표','w3-ceo@t.kr','ceo',$3,true,null),
         ($2,'삼차담당','w3-own@t.kr','manager',$3,true,null)`,
      [CEO, OWNER, hash],
    );
    await q(`INSERT INTO stu (id, name, grade, school) VALUES ($1,'삼차학생','11','테스트고')`, [STU]);
    const [room] = await q<{ id: string }>(`INSERT INTO room (branch, name) VALUES ('테스트', 'W3 4호') RETURNING id`);
    ROOM = Number(room.id);
    // 옛 건 둘 — 도달 기록 없이 박힌 행(시드 · 이관과 같은 모양). 기한·실패일·재연락을 **짓지 않아야** 한다 (N-25)
    await q(
      `INSERT INTO lead (id, name, stage, stop_at) VALUES ($1,'삼차옛건','second',NULL), ($2,'삼차옛실패','failed','after_first')`,
      [LEGACY_LEAD, LEGACY_FAILED],
    );
    const res = await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 })
      .send({ email: 'w3-ceo@t.kr', password: PW }).expect(201);
    ceoToken = res.body.accessToken as string;
  });

  async function cleanup() {
    const cons = (await q<{ id: string }>(`SELECT id FROM cons WHERE owner_id = ANY($1) OR id IN (SELECT cons_id FROM cons_stu WHERE student_id = $2)`, [[CEO, OWNER], STU])).map((c) => Number(c.id));
    if (cons.length) {
      await q(`DELETE FROM todo WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons_event WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons_sess WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons_item WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons_stu WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons WHERE id = ANY($1)`, [cons]);
    }
    const sers = (await q<{ id: string }>(`SELECT id FROM ser WHERE teacher_id = ANY($1) OR id IN (SELECT ser_id FROM ser_stu WHERE student_id = $2)`, [[CEO, OWNER], STU])).map((s) => Number(s.id));
    if (sers.length) {
      await q(`DELETE FROM guide WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM pnoti WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [sers]);
      await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM todo WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id = ANY($1))`, [sers]);
      await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [sers]);
      await q(`DELETE FROM ser WHERE id = ANY($1)`, [sers]);
    }
    const leads = (await q<{ id: string }>(`SELECT id FROM lead WHERE id = ANY($1) OR name LIKE '삼차%'`, [leadIds])).map((l) => Number(l.id));
    if (leads.length) {
      await q(`DELETE FROM lead_touch WHERE lead_id = ANY($1)`, [leads]);
      await q(`DELETE FROM lead_stage_log WHERE lead_id = ANY($1)`, [leads]);
      await q(`DELETE FROM lead WHERE id = ANY($1)`, [leads]);
    }
    await q(`DELETE FROM room WHERE name = 'W3 4호'`);
    await q(`DELETE FROM stu WHERE id = $1`, [STU]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, OWNER]]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, OWNER]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, OWNER]]);
  }

  afterAll(async () => {
    try { if (ds?.isInitialized) await cleanup(); } finally { await app?.close(); }
  });

  /* ══ 상담 ══════════════════════════════════════════════════════════════════════════ */

  it('학년은 적은 그대로 남고(23-10) · 1차 상담 띠는 접수일 + 2일이다 · 보류로 옮기면 그날부터 다시 센다 · 옛 건은 띠가 없다 (23-12)', async () => {
    // DTO 가 11자를 막는다 — 표의 varchar(10) 넘침 500 이 아니다
    expect((await api('post', '/ops/leads').send({ name: '삼차신규', source: 'kakao', grade: '12345678901' }).expect(400)).body.code).toBe('BAD_REQUEST');
    const made = (await api('post', '/ops/leads').send({ name: '삼차신규', source: 'kakao', grade: ' G8 ' }).expect(201)).body;
    leadIds.push(made.id);
    expect(made).toMatchObject({ grade: 'G8', stage: 'first' });
    expect((await q(`SELECT grade FROM lead WHERE id = $1`, [made.id]))[0]).toEqual({ grade: 'G8' });
    expect(made.stageDue).toEqual({ task: '2차 일정 + 진단고사 잡기', dueOn: plus(TODAY, 2), dueLabel: 'D-2', tone: 'neutral' });

    const held = (await api('patch', `/ops/leads/${made.id}/stage`).send({ to: 'hold' }).expect(200)).body;
    expect(held.stageDue).toEqual({ task: '배치안 수락 여부 확인', dueOn: plus(TODAY, 2), dueLabel: 'D-2', tone: 'neutral' });
    // 보류에 들어온 지 이틀 → 오늘(호박) · 사흘 → 1일 지남(빨강). 들어온 날은 도달 기록의 마지막 보류 줄이다
    await q(`UPDATE lead_stage_log SET at = at - interval '2 days' WHERE lead_id = $1 AND stage = 'hold'`, [made.id]);
    expect((await leadOf(made.id)).lead.stageDue).toMatchObject({ dueLabel: '오늘', tone: 'warning' });
    await q(`UPDATE lead_stage_log SET at = at - interval '1 day' WHERE lead_id = $1 AND stage = 'hold'`, [made.id]);
    expect((await leadOf(made.id)).lead.stageDue).toMatchObject({ dueLabel: '1일 지남', tone: 'danger' });

    // 옛 건 — 2차 상담에 언제 들어왔는지 기록이 없다. 접수일로 **대신하지 않는다** (N-25)
    expect((await leadOf(LEGACY_LEAD)).lead).toMatchObject({ stage: 'second', stageDue: null, grade: null });
  });

  it('실패 사유 분류는 다섯 낱말만 받고(DTO 400 · 표 CHECK) · 실패한 날과 재연락 대기/완료를 서버가 판정한다 · 머리 막대가 분류로 센다 (24-04 · 24-05 · 24-06)', async () => {
    const made = (await api('post', '/ops/leads').send({ name: '삼차실패', source: 'phone' }).expect(201)).body;
    leadIds.push(made.id);
    expect((await api('post', `/ops/leads/${made.id}/fail`).send({ stopAt: 'after_first', reasonKind: 'money' }).expect(400)).body.code).toBe('BAD_REQUEST');
    expect((await q(`SELECT stage FROM lead WHERE id = $1`, [made.id]))[0]).toEqual({ stage: 'first' });

    const failed = (await api('post', `/ops/leads/${made.id}/fail`).send({ stopAt: 'after_first', reason: '월 수업료가 예산을 넘음', reasonKind: 'cost' }).expect(201)).body;
    expect(failed).toMatchObject({
      stage: 'failed', reasonKind: 'cost', reasonKindLabel: '비용', reason: '월 수업료가 예산을 넘음', failedAt: TODAY,
      // 실패 뒤 접촉이 없다 — 대기. 첫 접촉은 실패 전에 적은 것이다(유입 한 줄이 없어서 비어 있다)
      recontact: { done: false, label: '재연락 대기', tone: 'warning', on: null, dueLabel: null },
      stageDue: null,
    });
    const [{ reason_kind }] = await q<{ reason_kind: string }>(`SELECT reason_kind FROM lead WHERE id = $1`, [made.id]);
    expect(reason_kind).toBe('cost');
    // 표가 마지막으로 막는다 — 다섯 밖의 낱말은 CHECK 가 거절한다
    await expect(q(`UPDATE lead SET reason_kind = 'money' WHERE id = $1`, [made.id])).rejects.toMatchObject({ driverError: { code: '23514' } });

    // 실패 뒤 접촉(다음 연락 28일 뒤) → 완료 · 날짜와 「D-28」. 같은 초에 겹치지 않게 실패 줄을 1분 당긴다
    await q(`UPDATE lead_stage_log SET at = at - interval '1 minute' WHERE lead_id = $1 AND stage = 'failed'`, [made.id]);
    const touched = (await api('post', `/ops/leads/${made.id}/touches`).send({ kind: 'call', note: '중간고사 끝나고 다시', nextOn: plus(TODAY, 28) }).expect(201)).body;
    expect(touched.recontact).toEqual({ done: true, label: '재연락 완료', tone: 'info', on: plus(TODAY, 28), dueLabel: 'D-28' });

    // 머리 막대 — 다섯은 0 이어도 서고, 분류 없는 옛 실패 건은 「분류 안 됨」 한 줄로 선다
    const { head } = await leadOf(made.id);
    const reasons = head.failReasons as Array<{ key: string; label: string; count: number; names: string[] }>;
    expect(reasons.slice(0, 5).map((r) => r.label)).toEqual(['연락 두절', '타 학원 등록', '일정 안 맞음', '비용', '시기 안 맞음']);
    expect(reasons.find((r) => r.key === 'cost')!.names).toContain('삼차실패');
    const unset = reasons.find((r) => r.key === 'none');
    expect(unset?.label).toBe('분류 안 됨');
    expect(unset!.names).toContain('삼차옛실패');

    // 옛 실패 건 — 실패 시각이 없어 실패일도 재연락 판정도 짓지 않는다 (N-25)
    expect((await leadOf(LEGACY_FAILED)).lead).toMatchObject({ failedAt: null, recontact: null, reasonKind: null, reasonKindLabel: null });
  });

  /* ══ 컨설팅 ════════════════════════════════════════════════════════════════════════ */

  it('§27 학생별 회차 수는 §26 목록과 같은 셈이다 — 앞으로 잡아 둔 날짜는 세지 않는다 · 회차 머리는 시간표 회차의 시각·담당·강의실 · 항목 처리 시각 (27-04 · 31-04 · 31-07)', async () => {
    const [c] = await q<{ id: string }>(
      `INSERT INTO cons (cons_type, stage, contract_step, amount, sessions, start_on, end_on, requester, owner_id, share)
       VALUES ('essay', 'running', 5, 900000, 6, $1::date, $2::date, 'mother', $3, 'all') RETURNING id`,
      [plus(TODAY, -30), plus(TODAY, 60), OWNER],
    );
    const consId = Number(c.id);
    consIds.push(consId);
    await q(`INSERT INTO cons_stu (cons_id, student_id) VALUES ($1, $2)`, [consId, STU]);
    await q(`INSERT INTO cons_item (cons_id, seq, label, required, done, source) VALUES ($1, 1, '지원서 작성', true, false, 'manual')`, [consId]);

    // 어제 · 일주일 뒤 — 둘 다 새 하루짜리 회차(16:00–17:00 · 담당 · 강의실)
    const booked = (await api('post', `/consulting/${consId}/sessions`).send({
      dates: [plus(TODAY, -1), plus(TODAY, 7)], startMin: 960, endMin: 1020, staffId: OWNER, roomId: ROOM,
    }).expect(201)).body;
    expect(booked).toMatchObject({ created: 2, sessionsDone: 1, sessionsPlanned: 1 });

    const list = (await api('get', '/consulting').expect(200)).body.items as Array<Record<string, unknown>>;
    const row = list.find((x) => x.id === consId)!;
    expect(row.sessionsDone).toBe(1);
    const log = row.sessionsLog as Array<Record<string, unknown>>;
    expect(log[0]).toMatchObject({ seq: 1, onDate: plus(TODAY, -1), startMin: 960, endMin: 1020, staffName: '삼차담당', roomName: 'W3 4호', recorded: false, result: null, nextUntil: null });

    const students = (await api('get', '/consulting/students').expect(200)).body.items as Array<{ studentId: number; cases: Array<Record<string, unknown>> }>;
    const mine = students.find((s) => s.studentId === STU)!.cases.find((x) => x.id === consId)!;
    // 기록 두 줄 · 한 회차는 하나 — §26 과 같은 수
    expect(mine).toMatchObject({ sessionsLogged: 2, sessionsDone: 1 });

    // 항목 처리 시각 — KST 오프셋이 붙은 시각이고 날짜는 처리일과 같다
    const itemId = Number((await q<{ id: string }>(`SELECT id FROM cons_item WHERE cons_id = $1`, [consId]))[0].id);
    const toggled = (await api('patch', `/consulting/${consId}/items/${itemId}`).send({ done: true }).expect(200)).body;
    expect(toggled.doneAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
    expect(toggled.doneOn).toBe(toggled.doneAt.slice(0, 10));
    expect(toggled.doneBy).toBe('삼차대표');
  });

  it('「결과」·「다음까지」 — 다음까지는 담당의 할 일 한 줄 + 알림, 고쳐 적으면 같은 할 일의 제목이 바뀐다 · 세 칸이 차면 「기록됨」 · 120자 넘으면 400 (31-08)', async () => {
    const consId = consIds[0]!;
    const sess = await q<{ id: string; seq: number }>(`SELECT id, seq FROM cons_sess WHERE cons_id = $1 ORDER BY seq`, [consId]);
    const first = Number(sess[0]!.id);
    expect((await api('patch', `/consulting/${consId}/sessions/${first}`).send({ nextUntil: 'ㄱ'.repeat(121) }).expect(400)).body.code).toBe('BAD_REQUEST');

    const written = (await api('patch', `/consulting/${consId}/sessions/${first}`).send({
      what: '학교 3곳 후보 정리', why: '지원 범위를 좁히기 위해', how: '성적표와 활동 목록을 함께 보며',
      result: 'BHA · KIS · Chadwick 3곳으로 좁혔습니다.', nextUntil: '각 학교 원서 항목 정리',
    }).expect(200)).body;
    expect(written).toMatchObject({ recorded: true, result: 'BHA · KIS · Chadwick 3곳으로 좁혔습니다.', nextUntil: '각 학교 원서 항목 정리', startMin: 960 });

    const todos = await q<{ title: string; to_id: string; due_on: string | null; done: boolean }>(
      `SELECT title, to_id, to_char(due_on,'YYYY-MM-DD') AS due_on, done FROM todo WHERE cons_id = $1 AND title LIKE '컨설팅 1회차 다음까지 — %'`, [consId]);
    // 받는 사람은 건의 담당 · 기한은 그 뒤 첫 회차 날짜(일주일 뒤)
    expect(todos).toEqual([{ title: '컨설팅 1회차 다음까지 — 각 학교 원서 항목 정리', to_id: String(OWNER), due_on: plus(TODAY, 7), done: false }]);
    const notis = await q<{ body: string }>(`SELECT body FROM noti WHERE to_id = $1 AND from_id = $2 AND body LIKE '컨설팅 1회차 다음까지%'`, [OWNER, CEO]);
    expect(notis).toHaveLength(1);
    // 세 칸이 차면 그 회차의 「기록」 할 일은 접힌다 — 「기록됨」과 같은 판정
    expect(await q(`SELECT done FROM todo WHERE cons_id = $1 AND title LIKE '컨설팅 1회차 기록 — %'`, [consId])).toEqual([{ done: true }]);

    // 고쳐 적으면 할 일이 쌓이지 않고 제목이 바뀐다 · 같은 말을 다시 보내면 아무것도 안 는다
    await api('patch', `/consulting/${consId}/sessions/${first}`).send({ nextUntil: '원서 항목 표로 정리' }).expect(200);
    await api('patch', `/consulting/${consId}/sessions/${first}`).send({ nextUntil: '원서 항목 표로 정리' }).expect(200);
    const after = await q<{ title: string }>(`SELECT title FROM todo WHERE cons_id = $1 AND title LIKE '컨설팅 1회차 다음까지 — %'`, [consId]);
    expect(after).toEqual([{ title: '컨설팅 1회차 다음까지 — 원서 항목 표로 정리' }]);
    expect(await q(`SELECT 1 FROM noti WHERE to_id = $1 AND from_id = $2 AND body LIKE '컨설팅 1회차 다음까지%'`, [OWNER, CEO])).toHaveLength(2);
  });

  it('상세는 공개 범위의 이름·뜻과 계약 5단계의 이름·한 줄을 서버 낱말로 준다 (30-06 · 30-07)', async () => {
    const detail = (await api('get', `/consulting/${consIds[0]}`).expect(200)).body;
    expect(detail).toMatchObject({ share: 'all', shareLabel: '전체 공개', shareMeaning: '관리자 누구나 봅니다' });
    expect(detail.contractSteps).toEqual([
      { step: 1, label: '계약서 준비', sub: '초안을 올립니다' },
      { step: 2, label: '피드백', sub: '누구나 의견을 답니다' },
      { step: 3, label: '전달', sub: '학부모께 보냅니다' },
      { step: 4, label: '서명', sub: '스캔본을 받습니다' },
      { step: 5, label: '수납', sub: '계약금을 받습니다' },
    ]);
  });
});
