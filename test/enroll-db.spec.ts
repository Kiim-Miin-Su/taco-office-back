/** @file-guide
 * 목적: enroll-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 등록 확정 — C91 (테스트 시나리오 A-05 「배치안을 만들고 등록을 확정함 — 한 번에 일곱 가지」 · A-06 「겹치는 시간에 배치안을 만들면」 ·
 * A-07 「강사 불가 시간과 겹치면」 · A-12 「보류했다가 등록」 · A-14 「등록 직후 첫 수업일」 · N-137 「같은 이름의 학생이 둘」).
 *
 * 증명하는 것 —
 *   ① 한 번에 일곱 — STU · ENR(줄마다) · SER+SER_STU(줄마다) · 첫 달 청구서(§53 그대로) · 교재 요청(wait)/배정 필요 알림 · 첫 수업 안내 초안 · 강사·관리자 알림
 *      + LEAD enrolled · 도달 기록 · LOG. 첫 수업일은 시작일 이후 첫 요일이다.
 *   ② 겹치면 시간표가 409 로 막고 **학생도 등록도 남지 않는다** · 미리보기는 같은 값을 주고 아무것도 쓰지 않으며 불가 시간을 알린다.
 *   ③ 동명이인 — 학년·학교가 같으면 409 · 다르면 allowSameName 으로 새 학생 · studentId 로 있는 학생에게 붙인다 · 단가 없으면 청구서만 건너뛴다.
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
jest.setTimeout(90_000);

d('등록 확정 — 한 트랜잭션에 일곱 가지 (C91 · A-05 · A-06 · A-07 · A-14 · N-137)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let adminToken = '';
  let teacherToken = '';
  const PW = 'enroll-1234';
  const CEO = 961;
  const TEACHER = 962;
  const ADMIN = 963; // 관리자 — 등록 확정을 하는 사람 (돈 권한 없음)
  const STU_EXISTING = 9961; // 이미 있는 「등록A · 10 · 테스트고」
  const LEADS = { hold: 8801, first: 8802, same: 8803, failed: 8804, norate: 8805 };
  const KIND = 'en_kind';
  const KIND_NORATE = 'en_norate';
  const SUB = 'en-sub';
  const RATE_SUB = 60000;
  const RATE_KIND = 50000;
  let LIB = 0;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const THIS = kst().slice(0, 7);
  /** 다음 달 1일 — 오늘이 언제든 전부 앞으로의 회차 */
  const START = `${plus(`${THIS}-01`, 32).slice(0, 7)}-01`;
  const NEXT = START.slice(0, 7);
  /** 시작일 이후 첫 월요일 — 「매주 월·수」의 첫 수업일 (A-14) */
  const firstDow = (from: string, want: number) => { let d0 = from; while (dow(d0) !== want) d0 = plus(d0, 1); return d0; };
  const FIRST_MON = firstDow(START, 1);
  const FIRST_WED = firstDow(START, 3);

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
         ($1,'등록대표','en-ceo@t.kr','ceo',$4,true,null),
         ($2,'등록강사','en-t@t.kr','teacher',$4,true,null),
         ($3,'등록관리자','en-a@t.kr','admin',$4,true,null)`,
      [CEO, TEACHER, ADMIN, hash],
    );
    await q(`INSERT INTO stu (id, name, grade, school) VALUES ($1,'등록A','10','테스트고')`, [STU_EXISTING]);
    await q(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'등록 시험','#333333',4,'lesson',true), ($2,'단가 없음','#333333',4,'lesson',true) ON CONFLICT (key) DO NOTHING`, [KIND, KIND_NORATE]);
    await q(`INSERT INTO sub (key,name,color) VALUES ($1,'등록 과목','#444444') ON CONFLICT (key) DO NOTHING`, [SUB]);
    await q(`INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES ($1, $2, $3, '2026-01-01', 1), ($1, NULL, $4, '2026-01-01', 1)`, [KIND, SUB, RATE_SUB, RATE_KIND]);
    const [lib] = await q<{ id: string }>(`INSERT INTO lib (code, title, sub_key, pages) VALUES ('EN-TEST', '등록 교재', $1, 100) RETURNING id`, [SUB]);
    LIB = Number(lib.id);
    await q(
      `INSERT INTO lead (id, name, school, stage, owner_id) VALUES
         ($1,'등록B','테스트고','hold',$6), ($2,'등록C',NULL,'first',$6), ($3,'등록A','테스트고','second',$6), ($4,'등록D',NULL,'failed',$6), ($5,'등록E',NULL,'second',$6)`,
      [LEADS.hold, LEADS.first, LEADS.same, LEADS.failed, LEADS.norate, ADMIN],
    );
    const login = async (email: string) => {
      const res = await request(app.getHttpServer())
        .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    adminToken = await login('en-a@t.kr');
    teacherToken = await login('en-t@t.kr');
  });

  async function cleanup() {
    const stus = await q<{ id: string }>(`SELECT id FROM stu WHERE id = $1 OR name IN ('등록A','등록B','등록C','등록E','등록F')`, [STU_EXISTING]);
    const ids = stus.map((s) => Number(s.id));
    const sers = await q<{ id: string }>(`SELECT DISTINCT ser_id AS id FROM ser_stu WHERE student_id = ANY($1) UNION SELECT id FROM ser WHERE kind_key = ANY($2)`, [ids, [KIND, KIND_NORATE]]);
    const serIds = sers.map((s) => Number(s.id));
    if (serIds.length) {
      await q(`DELETE FROM guide WHERE ser_id = ANY($1)`, [serIds]);
      await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [serIds]);
      await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [serIds]);
      await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [serIds]);
      await q(`DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id = ANY($1))`, [serIds]);
      await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [serIds]);
      await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [serIds]);
      await q(`DELETE FROM ser WHERE id = ANY($1)`, [serIds]);
    }
    if (ids.length) {
      await q(`DELETE FROM guide WHERE student_id = ANY($1)`, [ids]);
      await q(`DELETE FROM issue WHERE student_id = ANY($1)`, [ids]);
      await q(`DELETE FROM pay WHERE student_id = ANY($1) OR inv_id IN (SELECT id FROM inv WHERE student_id = ANY($1))`, [ids]);
      await q(`DELETE FROM inv_line WHERE inv_id IN (SELECT id FROM inv WHERE student_id = ANY($1))`, [ids]);
      await q(`DELETE FROM inv WHERE student_id = ANY($1)`, [ids]);
      await q(`DELETE FROM enr WHERE student_id = ANY($1)`, [ids]);
      await q(`UPDATE lead SET student_id = NULL WHERE student_id = ANY($1)`, [ids]);
      await q(`DELETE FROM stu WHERE id = ANY($1)`, [ids]);
    }
    await q(`DELETE FROM lead_stage_log WHERE lead_id = ANY($1)`, [Object.values(LEADS)]);
    await q(`DELETE FROM lead WHERE id = ANY($1)`, [Object.values(LEADS)]);
    await q(`DELETE FROM lib WHERE code = 'EN-TEST'`);
    await q(`DELETE FROM rate WHERE kind_key = ANY($1)`, [[KIND, KIND_NORATE]]);
    await q(`DELETE FROM unav WHERE staff_id = $1`, [TEACHER]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER, ADMIN]]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, TEACHER, ADMIN]]);
    await q(`DELETE FROM sub WHERE key = $1`, [SUB]);
    await q(`DELETE FROM kind WHERE key = ANY($1)`, [[KIND, KIND_NORATE]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER, ADMIN]]);
  }

  afterAll(async () => {
    try { if (ds?.isInitialized) await cleanup(); } finally { await app?.close(); }
  });

  const api = (m: 'post' | 'patch' | 'delete' | 'get', p: string, t = adminToken) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`)
      .timeout({ response: 8000, deadline: 15000 });

  const line = (over: Record<string, unknown> = {}) => ({
    kindKey: KIND, subKey: SUB, mode: 'offline', rrule: 'WEEKLY:MO,WE', startMin: 600, endMin: 660, teacherId: TEACHER, roomId: null, title: '등록 수업', ...over,
  });

  /* ── ① A-05 · A-12 · A-14 ────────────────────────────────────────────── */
  it('보류 건을 등록 확정하면 한 트랜잭션에 일곱 가지가 남는다 — 학생·등록·시간표·첫 달 청구서·교재 요청/배정 알림·안내 초안·알림 · 첫 수업일은 시작일 이후 첫 요일 (A-05 · A-12 · A-14)', async () => {
    const res = await api('post', `/ops/leads/${LEADS.hold}/enroll`).send({
      student: { grade: '11' }, startedOn: START, memo: '보류 뒤 등록',
      lines: [line({ libId: LIB, sessions: 8 }), line({ subKey: null, rrule: 'WEEKLY:FR', startMin: 840, endMin: 900, title: '등록 보충' })],
    }).expect(201);
    const r = res.body;
    expect(r).toMatchObject({ leadId: LEADS.hold, preview: false, studentName: '등록B', studentCreated: true, startedOn: START, stage: 'enrolled', guideDrafts: 2, notifiedTeachers: 1 });
    expect(r.notifiedStaff).toBeGreaterThanOrEqual(1);
    expect(r.enrollments).toHaveLength(2);
    expect(r.enrollments[0]).toMatchObject({ kindKey: KIND, subKey: SUB, sessions: 8, startedOn: START });
    // 첫 수업일 — 월·수 규칙은 시작일 이후 첫 월요일, 금 규칙은 첫 금요일 (A-14)
    expect(r.series).toHaveLength(2);
    expect(r.series[0]).toMatchObject({ kindKey: KIND, subKey: SUB, subName: '등록 과목', ruleLabel: '매주 월·수', teacherId: TEACHER, teacherName: '등록강사', firstLessonOn: FIRST_MON });
    expect(r.series[1]).toMatchObject({ subKey: null, ruleLabel: '매주 금', firstLessonOn: firstDow(START, 5) });
    expect(r.series[0].monthCount).toBeGreaterThan(0);
    // 첫 달 청구서 — §53 그대로: 과목 단가 60,000 × 월·수 회차 + 종류 단가 50,000 × 금 회차. 관리자는 금액을 못 본다(null) — 줄 수만
    expect(r.invoice).toMatchObject({ studentId: r.studentId, yearMonth: NEXT, state: 'draft', amount: null });
    expect(r.invoiceSkipped).toBeNull();
    const [inv] = await q<{ amount: number; n: number }>(`SELECT amount, (SELECT count(*) FROM inv_line l WHERE l.inv_id = i.id)::int AS n FROM inv i WHERE i.id = $1`, [r.invoice.id]);
    expect(Number(inv.amount)).toBe(RATE_SUB * r.series[0].monthCount + RATE_KIND * r.series[1].monthCount);
    expect(inv.n).toBe(2);
    // 교재 — 첫 줄은 요청(wait), 둘째 줄은 배정 필요
    expect(r.bookIssues).toEqual([expect.objectContaining({ libId: LIB, studentId: r.studentId, state: 'wait' })]);
    expect(r.booksMissing).toEqual([{ kindKey: KIND, subKey: null, label: '등록 시험' }]);
    expect(r.unavailable).toEqual([]);

    // DB — 학생 · 등록 · 명단 · 단계 · 도달 기록 · LOG
    const [stu] = await q<{ name: string; grade: string; school: string; started_on: string }>(`SELECT name, grade, school, to_char(started_on,'YYYY-MM-DD') AS started_on FROM stu WHERE id = $1`, [r.studentId]);
    expect(stu).toEqual({ name: '등록B', grade: '11', school: '테스트고', started_on: START });
    expect(await q(`SELECT 1 FROM enr WHERE student_id = $1 AND to_char(started_on,'YYYY-MM-DD') = $2`, [r.studentId, START])).toHaveLength(2);
    expect(await q(`SELECT 1 FROM ser_stu WHERE student_id = $1`, [r.studentId])).toHaveLength(2);
    const [lead] = await q<{ stage: string; student_id: string; reason: string }>(`SELECT stage, student_id, reason FROM lead WHERE id = $1`, [LEADS.hold]);
    expect(lead).toEqual({ stage: 'enrolled', student_id: String(r.studentId), reason: '보류 뒤 등록' });
    expect(await q(`SELECT 1 FROM lead_stage_log WHERE lead_id = $1 AND stage = 'enrolled' AND by_id = $2`, [LEADS.hold, ADMIN])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM guide WHERE student_id = $1 AND reason = 'new' AND state = 'draft'`, [r.studentId])).toHaveLength(2);
    expect(await q(`SELECT 1 FROM issue WHERE student_id = $1 AND state = 'wait' AND lib_id = $2 AND requested_by = $3`, [r.studentId, LIB, ADMIN])).toHaveLength(1);
    const [log] = await q<{ after: { serIds: number[]; invId: number; guideIds: number[] } }>(`SELECT after FROM log WHERE actor_id = $1 AND entity = 'LEAD' AND action = 'enroll'`, [ADMIN]);
    expect(log.after.serIds).toHaveLength(2);
    expect(log.after.invId).toBe(r.invoice.id);
    // 알림 — 강사에게 첫 수업일과 함께 · 대표(관리자)에게 등록 확정 · 교재 배정 필요
    const teacherNoti = await q<{ body: string; link: string }>(`SELECT body, link FROM noti WHERE to_id = $1 AND from_id = $2`, [TEACHER, ADMIN]);
    expect(teacherNoti).toHaveLength(1);
    expect(teacherNoti[0]!.body).toContain('등록B');
    // 강사에게는 그 강사의 두 규칙 중 **가장 이른** 첫 수업일 — 금 규칙이 월 규칙보다 이를 수 있다
    const earliest = [FIRST_MON, firstDow(START, 5)].sort()[0]!;
    expect(teacherNoti[0]!.body).toContain(`첫 수업 ${+earliest.slice(5, 7)}/${+earliest.slice(8, 10)}`);
    expect(teacherNoti[0]!.link).toBe(`/schedule?date=${earliest}`);
    const ceoNotis = await q<{ body: string; link: string }>(`SELECT body, link FROM noti WHERE to_id = $1 AND from_id = $2 ORDER BY id`, [CEO, ADMIN]);
    expect(ceoNotis.map((n) => n.link)).toEqual(['/ops', '/books']);
    expect(ceoNotis[0]!.body).toContain('등록 확정 — 등록B');
    expect(ceoNotis[1]!.body).toContain('교재 배정이 필요합니다 — 등록B · 등록 시험');
    // 시간표에서 보인다 — 첫 월요일 회차에 이 학생
    const occ = (await api('get', `/schedule/occurrences?from=${FIRST_MON}&to=${FIRST_MON}&studentId=${r.studentId}`).expect(200)).body.items;
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ serId: r.series[0].serId, startMin: 600 });

    // 두 번은 409 · 실패 건은 409 · 강사는 403
    expect((await api('post', `/ops/leads/${LEADS.hold}/enroll`).send({ startedOn: START, lines: [line()] }).expect(409)).body.code).toBe('ALREADY_ENROLLED');
    expect((await api('post', `/ops/leads/${LEADS.failed}/enroll`).send({ startedOn: START, lines: [line()] }).expect(409)).body.code).toBe('LEAD_FAILED');
    await api('post', `/ops/leads/${LEADS.first}/enroll`, teacherToken).send({ startedOn: START, lines: [line()] }).expect(403);
  });

  /* ── ② A-06 · A-07 · 미리보기 ───────────────────────────────────────── */
  it('겹치면 시간표가 409 로 막고 학생도 등록도 남지 않는다 · 미리보기는 같은 값을 주고 아무것도 쓰지 않으며 불가 시간을 알린다 (A-06 · A-07)', async () => {
    // 같은 강사의 같은 시각 — 첫 시험이 월·수 10:00 을 잡아 두었다 → 겹침
    const before = await q(`SELECT count(*)::int AS n FROM stu WHERE name = '등록C'`);
    const dup = await api('post', `/ops/leads/${LEADS.first}/enroll`).send({ startedOn: START, lines: [line({ rrule: 'WEEKLY:MO', startMin: 630, endMin: 690 })] }).expect(409);
    expect(dup.body.code).toBe('RESOURCE_CONFLICT');
    expect(await q(`SELECT count(*)::int AS n FROM stu WHERE name = '등록C'`)).toEqual(before);
    expect(await q(`SELECT 1 FROM lead WHERE id = $1 AND stage = 'first' AND student_id IS NULL`, [LEADS.first])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM enr e JOIN stu s ON s.id = e.student_id WHERE s.name = '등록C'`)).toEqual([]);

    // 강사 불가 시간 — 첫 수요일 11:00~12:00 에 걸치는 규칙을 미리 본다 → 막지 않고 알린다 (A-07)
    await q(`INSERT INTO unav (staff_id, on_date, dow, start_min, end_min, reason) VALUES ($1, $2::date, $3, 660, 720, '병원')`, [TEACHER, FIRST_WED, dow(FIRST_WED)]);
    const pre = await api('post', `/ops/leads/${LEADS.first}/enroll/preview`).send({ startedOn: START, lines: [line({ rrule: 'WEEKLY:WE', startMin: 690, endMin: 750 })] }).expect(201);
    expect(pre.body).toMatchObject({ preview: true, studentName: '등록C', studentCreated: true, stage: 'enrolled', guideDrafts: 1 });
    expect(pre.body.series[0]).toMatchObject({ firstLessonOn: FIRST_WED, ruleLabel: '매주 수' });
    expect(pre.body.unavailable).toEqual([expect.objectContaining({ date: FIRST_WED, teacherId: TEACHER, teacherName: '등록강사', startMin: 660, endMin: 720, reason: '병원' })]);
    expect(pre.body.invoice).toMatchObject({ yearMonth: NEXT, state: 'draft' });
    // 아무것도 쓰지 않았다
    expect(await q(`SELECT count(*)::int AS n FROM stu WHERE name = '등록C'`)).toEqual(before);
    expect(await q(`SELECT 1 FROM lead WHERE id = $1 AND stage = 'first' AND student_id IS NULL`, [LEADS.first])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM noti WHERE from_id = $1 AND body LIKE '%등록C%'`, [ADMIN])).toEqual([]);
    expect(await q(`SELECT 1 FROM lead_stage_log WHERE lead_id = $1`, [LEADS.first])).toEqual([]);
    expect(await q(`SELECT 1 FROM log WHERE entity = 'LEAD' AND entity_id = $1`, [LEADS.first])).toEqual([]);

    // 실제 등록 — 미리 본 것과 같은 첫 수업일·불가 시간 경고
    const real = await api('post', `/ops/leads/${LEADS.first}/enroll`).send({ startedOn: START, lines: [line({ rrule: 'WEEKLY:WE', startMin: 690, endMin: 750 })] }).expect(201);
    expect(real.body.series[0].firstLessonOn).toBe(FIRST_WED);
    expect(real.body.unavailable).toHaveLength(1);
    expect(real.body.preview).toBe(false);
  });

  /* ── ③ N-137 · 있는 학생에게 붙이기 · 단가 없음 ─────────────────────── */
  it('동명이인 — 학년·학교가 같으면 409 · 다르면 allowSameName 으로 새 학생 · studentId 로 있는 학생에게 붙인다 · 단가가 없으면 청구서만 건너뛴다 (N-137)', async () => {
    // 등록A · 10 · 테스트고 가 이미 있다 — 같은 학년·학교면 막는다
    const twin = await api('post', `/ops/leads/${LEADS.same}/enroll`).send({ student: { grade: '10' }, startedOn: START, lines: [line({ rrule: 'WEEKLY:TU', startMin: 600, endMin: 660 })] }).expect(409);
    expect(twin.body.code).toBe('STUDENT_DUPLICATE');
    expect(twin.body.message).toContain(`#${STU_EXISTING}`);
    // 학년이 다르면 — 그래도 한 번 묻는다
    const ask = await api('post', `/ops/leads/${LEADS.same}/enroll`).send({ student: { grade: '11' }, startedOn: START, lines: [line({ rrule: 'WEEKLY:TU', startMin: 600, endMin: 660 })] }).expect(409);
    expect(ask.body.code).toBe('STUDENT_SAME_NAME');
    expect(ask.body.message).toContain(`#${STU_EXISTING} 10 · 테스트고`);
    expect(await q(`SELECT 1 FROM lead WHERE id = $1 AND stage = 'second'`, [LEADS.same])).toHaveLength(1);
    // 있는 학생에게 붙인다(재등록·형제) — 새 학생 없이 등록·시간표·청구서만
    const attached = await api('post', `/ops/leads/${LEADS.same}/enroll`).send({ studentId: STU_EXISTING, startedOn: START, issueInvoice: false, lines: [line({ rrule: 'WEEKLY:TU', startMin: 600, endMin: 660 })] }).expect(201);
    expect(attached.body).toMatchObject({ studentId: STU_EXISTING, studentName: '등록A', studentCreated: false, invoice: null, invoiceSkipped: null });
    expect(await q(`SELECT 1 FROM enr WHERE student_id = $1`, [STU_EXISTING])).toHaveLength(1);
    expect(await q(`SELECT student_id::int AS sid FROM lead WHERE id = $1 AND stage = 'enrolled'`, [LEADS.same])).toEqual([{ sid: STU_EXISTING }]);

    // 단가 없는 종류 — 등록은 되고 청구서만 건너뛴다(이유와 함께)
    const norate = await api('post', `/ops/leads/${LEADS.norate}/enroll`).send({ startedOn: START, lines: [line({ kindKey: KIND_NORATE, subKey: null, rrule: 'WEEKLY:TH', startMin: 600, endMin: 660 })] }).expect(201);
    expect(norate.body.invoice).toBeNull();
    expect(norate.body.invoiceSkipped).toMatchObject({ code: 'INV_NO_RATE' });
    expect(norate.body.studentCreated).toBe(true);
    expect(await q(`SELECT 1 FROM inv WHERE student_id = $1`, [norate.body.studentId])).toEqual([]);
    expect(await q(`SELECT 1 FROM ser_stu WHERE student_id = $1`, [norate.body.studentId])).toHaveLength(1);
    // 대표 알림에 「청구서 없음(INV_NO_RATE)」
    const [n] = await q<{ body: string }>(`SELECT body FROM noti WHERE to_id = $1 AND from_id = $2 AND body LIKE '등록 확정 — 등록E%'`, [CEO, ADMIN]);
    expect(n.body).toContain('청구서 없음(INV_NO_RATE)');
  });
});
