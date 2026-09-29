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
 *   ③ 동명이인 — 학년·학교가 같으면 409 · 다르면 allowSameName 으로 새 학생 · studentId 로 기존 학생을 재등록한다 · 단가 없으면 청구서만 건너뛴다.
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
import { NOTI_TITLE } from '../src/lib/noti';
import { addMonths, leadMonthlyOn } from '../src/lib/intake-words';
import { DEV_URL } from './db';

/** 함께 내는 첫 달 청구서의 기한 — 기한 자체를 보지 않는 시험들이 쓰는 값 (S3) */
const DUE = '2026-12-31';

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
  /**
   * 관리자 — 등록 확정을 하는 사람. **금액 예외를 꺼 둔다**: 이 스위트가 보는 것은
   * 「금액을 못 보는 사람에게는 amount 가 null 로 간다」이고, 대표 결정 2026-09-21 로
   * 역할 파생 `canMoney` 가 관리자급까지 열려 역할만으로는 그 경계를 세울 수 없다.
   */
  const ADMIN = 963;
  const STU_EXISTING = 9961; // 이미 있는 「등록A · 10 · 테스트고」
  const LEADS = { hold: 8801, first: 8802, same: 8803, failed: 8804, norate: 8805, parent: 8806, parentDup: 8807, titleless: 8808 };
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
         ($3,'등록관리자','en-a@t.kr','admin',$4,true,false)`,
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
    // A-01 — 문의 때 적은 학부모 · 연락처가 있는 건(등록 확정이 보호자로 잇는다)
    await q(
      `INSERT INTO lead (id, name, school, stage, owner_id, parent_relation, parent_phone, want)
       VALUES ($1,'등록P','연락고','first',$3,'어머니','01055556666','MAP Reading 점수 올리기'),
              ($2,'등록A','테스트고','first',$3,'아버지','01077778888',NULL)`,
      [LEADS.parent, LEADS.parentDup, ADMIN],
    );
    const login = async (email: string) => {
      const res = await request(app.getHttpServer())
        .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ loginId: email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    adminToken = await login('en-a@t.kr');
    teacherToken = await login('en-t@t.kr');
  });

  async function cleanup() {
    const stus = await q<{ id: string }>(`SELECT id FROM stu WHERE id = $1 OR name IN ('등록A','등록B','등록C','등록D','등록E','등록F','등록P','등록T')`, [STU_EXISTING]);
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
      await q(`DELETE FROM guardian WHERE student_id = ANY($1)`, [ids]);
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
      student: { grade: '11' }, startedOn: START, dueOn: DUE, memo: '보류 뒤 등록',
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
    // 문의 때 연락처를 안 적은 건 — 보호자로 이을 것이 없다 (A-01)
    expect(r.guardianCarried).toBeNull();
    const [inv] = await q<{ amount: number; n: number }>(`SELECT amount, (SELECT count(*) FROM inv_line l WHERE l.inv_id = i.id)::int AS n FROM inv i WHERE i.id = $1`, [r.invoice.id]);
    expect(Number(inv.amount)).toBe(RATE_SUB * r.series[0].monthCount + RATE_KIND * r.series[1].monthCount);
    expect(inv.n).toBe(2);
    // 교재 — 첫 줄은 요청(wait), 둘째 줄은 배정 필요
    expect(r.bookIssues).toEqual([expect.objectContaining({ libId: LIB, studentId: r.studentId, state: 'wait' })]);
    expect(r.booksMissing).toEqual([{ kindKey: KIND, subKey: null, label: '등록 시험' }]);
    expect(r.unavailable).toEqual([]);
    // W11 · N-86 — 사후 관리: 해피콜(첫 실제 수업 + 7일) · 첫 월간(다음 달 같은 날)을 상담 담당의 할 일로 · 같은 트랜잭션
    const firstLesson = [FIRST_MON, FIRST_WED, firstDow(START, 5)].sort()[0]!;
    expect(r.aftercare).toEqual({
      firstLessonOn: firstLesson, happyCallOn: plus(firstLesson, 7),
      monthlyOn: leadMonthlyOn(firstLesson, addMonths(firstLesson.slice(0, 7), 1)), ownerId: ADMIN, ownerName: '등록관리자',
    });

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

    // 두 번은 409 · 강사는 403 (실패 건은 이제 막지 않는다 — 아래 「바로 수업 등록」 24-07)
    expect((await api('post', `/ops/leads/${LEADS.hold}/enroll`).send({ startedOn: START, dueOn: DUE, lines: [line()] }).expect(409)).body.code).toBe('ALREADY_ENROLLED');
    // 등록 재시도에 사후 관리 할 일이 겹쳐 서지 않는다 (S13 완료 기준)
    expect(await q(`SELECT care, to_id FROM todo WHERE lead_id = $1 ORDER BY id`, [LEADS.hold]))
      .toEqual([{ care: 'happycall', to_id: String(ADMIN) }, { care: 'monthly', to_id: String(ADMIN) }]);
    await api('post', `/ops/leads/${LEADS.first}/enroll`, teacherToken).send({ startedOn: START, dueOn: DUE, lines: [line()] }).expect(403);
  });

  /* ── 24-07 원본 §24 「바로 수업 등록」 — 되살리기 없이 등록 확정 · 실패 이력은 남는다 ─────────── */
  it('등록 실패 건도 되살리기 없이 바로 등록한다 — 실패 전 단계는 비우고(되살리기와 같다) 옛 중단 지점은 읽기 전용 기록으로 남긴다 · 도달 기록(failed → enrolled)과 LOG before 에 이력이 남는다 (24-07 · N-87)', async () => {
    await q(`UPDATE lead SET stop_at = 'after_second', fail_from = 'second', reason = '시간대 불일치' WHERE id = $1`, [LEADS.failed]);
    await q(`INSERT INTO lead_stage_log (lead_id, stage, by_id) VALUES ($1, 'failed', $2)`, [LEADS.failed, ADMIN]);
    const body = { startedOn: START, dueOn: DUE, lines: [line({ rrule: 'WEEKLY:SA', startMin: 1080, endMin: 1140 })] };
    // 미리보기 — 같은 값을 주고 아무것도 남기지 않는다
    const pre = await api('post', `/ops/leads/${LEADS.failed}/enroll/preview`).send(body).expect(201);
    expect(pre.body).toMatchObject({ preview: true, studentName: '등록D', stage: 'enrolled' });
    expect(await q(`SELECT stage, stop_at FROM lead WHERE id = $1`, [LEADS.failed])).toEqual([{ stage: 'failed', stop_at: 'after_second' }]);
    // 확정
    const r = (await api('post', `/ops/leads/${LEADS.failed}/enroll`).send(body).expect(201)).body;
    expect(r).toMatchObject({ preview: false, studentName: '등록D', studentCreated: true, stage: 'enrolled' });
    const [lead] = await q<{ stage: string; stop_at: string | null; fail_from: string | null; reason: string | null }>(
      `SELECT stage, stop_at, fail_from, reason FROM lead WHERE id = $1`, [LEADS.failed]);
    // 옛 중단 지점(stop_at)은 읽기 전용 기록이라 등록 확정도 지우지 않는다(N-87) · fail_from 은 「지금 실패 중인 건」의 판정 값이라 되살리기처럼 비운다
    expect(lead).toEqual({ stage: 'enrolled', stop_at: 'after_second', fail_from: null, reason: '시간대 불일치' });
    const logs = await q<{ stage: string }>(`SELECT stage FROM lead_stage_log WHERE lead_id = $1 ORDER BY id`, [LEADS.failed]);
    expect(logs.map((x) => x.stage)).toEqual(['failed', 'enrolled']);
    const [audit] = await q<{ before: Record<string, unknown> }>(`SELECT before FROM log WHERE entity = 'LEAD' AND entity_id = $1 AND action = 'enroll'`, [LEADS.failed]);
    expect(audit.before).toEqual({ stage: 'failed', stopAt: 'after_second', failFrom: 'second' });
  });

  /* ── ② A-06 · A-07 · 미리보기 ───────────────────────────────────────── */
  it('겹치면 시간표가 409 로 막고 학생도 등록도 남지 않는다 · 미리보기는 같은 값을 주고 아무것도 쓰지 않으며 불가 시간을 알린다 (A-06 · A-07)', async () => {
    // 같은 강사의 같은 시각 — 첫 시험이 월·수 10:00 을 잡아 두었다 → 겹침
    const before = await q(`SELECT count(*)::int AS n FROM stu WHERE name = '등록C'`);
    const dup = await api('post', `/ops/leads/${LEADS.first}/enroll`).send({ startedOn: START, dueOn: DUE, lines: [line({ rrule: 'WEEKLY:MO', startMin: 630, endMin: 690 })] }).expect(409);
    expect(dup.body.code).toBe('RESOURCE_CONFLICT');
    expect(await q(`SELECT count(*)::int AS n FROM stu WHERE name = '등록C'`)).toEqual(before);
    expect(await q(`SELECT 1 FROM lead WHERE id = $1 AND stage = 'first' AND student_id IS NULL`, [LEADS.first])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM enr e JOIN stu s ON s.id = e.student_id WHERE s.name = '등록C'`)).toEqual([]);

    // 강사 불가 시간 — 첫 수요일 11:00~12:00 에 걸치는 규칙을 미리 본다 → 막지 않고 알린다 (A-07)
    await q(`INSERT INTO unav (staff_id, on_date, dow, start_min, end_min, reason) VALUES ($1, $2::date, $3, 660, 720, '병원')`, [TEACHER, FIRST_WED, dow(FIRST_WED)]);
    const pre = await api('post', `/ops/leads/${LEADS.first}/enroll/preview`).send({ startedOn: START, dueOn: DUE, lines: [line({ rrule: 'WEEKLY:WE', startMin: 690, endMin: 750 })] }).expect(201);
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
    const real = await api('post', `/ops/leads/${LEADS.first}/enroll`).send({ startedOn: START, dueOn: DUE, lines: [line({ rrule: 'WEEKLY:WE', startMin: 690, endMin: 750 })] }).expect(201);
    expect(real.body.series[0].firstLessonOn).toBe(FIRST_WED);
    expect(real.body.unavailable).toHaveLength(1);
    expect(real.body.preview).toBe(false);
  });

  /* ── A-06 · 제목 없이 등록한 수업의 이름 (all160 실브라우저 QA 2026-09-29) ─────────────── */
  it('제목 없이 등록한 수업은 과목 이름으로 선다 — 그 수업과 겹친 배치안의 설명이 「새 일정」이 아니라 수업명을 말한다 (A-06 「무엇과 겹치는지(수업명)」)', async () => {
    await q(`INSERT INTO lead (id, name, stage, owner_id) VALUES ($1,'등록T','first',$2)`, [LEADS.titleless, ADMIN]);
    // 화면(등록 확정 창)은 제목 칸이 없어 title 을 보내지 않는다 — 그대로 재현한다
    const made = await api('post', `/ops/leads/${LEADS.titleless}/enroll`).send({
      startedOn: START, dueOn: DUE, lines: [line({ title: undefined, rrule: 'WEEKLY:TU', startMin: 1200, endMin: 1260 })],
    }).expect(201);
    const [s0] = made.body.series as Array<{ serId: number; firstLessonOn: string }>;
    expect((await q<{ title: string | null }>(`SELECT title FROM ser WHERE id = $1`, [s0.serId]))[0]!.title).toBe('등록 과목');
    // 같은 강사 · 같은 시각을 묻는 겹침 설명(409 뒤 「누구와」)이 그 수업을 과목 이름으로 부른다
    const probe = await api('get', `/schedule/conflicts?date=${s0.firstLessonOn}&startMin=1200&endMin=1260&teacherId=${TEACHER}`).expect(200);
    const hit = (probe.body.conflicts as Array<{ serId: number; title: string | null }>).find((c) => c.serId === s0.serId);
    expect(hit?.title).toBe('등록 과목');
  });

  /* ── ③ N-137 · 기존 학생 재등록 · 단가 없음 ───────────────────────── */
  it('동명이인 — 학년·학교가 같으면 409 · 다르면 allowSameName 으로 새 학생 · studentId 로 기존 학생을 재등록한다 · 단가가 없으면 청구서만 건너뛴다 (N-137)', async () => {
    // 등록A · 10 · 테스트고 가 이미 있다 — 같은 학년·학교면 막는다
    const twin = await api('post', `/ops/leads/${LEADS.same}/enroll`).send({ dueOn: DUE, student: { grade: '10' }, startedOn: START, lines: [line({ rrule: 'WEEKLY:TU', startMin: 600, endMin: 660 })] }).expect(409);
    expect(twin.body.code).toBe('STUDENT_DUPLICATE');
    expect(twin.body.message).toContain(`#${STU_EXISTING}`);
    // 학년이 다르면 — 그래도 한 번 묻는다
    const ask = await api('post', `/ops/leads/${LEADS.same}/enroll`).send({ dueOn: DUE, student: { grade: '11' }, startedOn: START, lines: [line({ rrule: 'WEEKLY:TU', startMin: 600, endMin: 660 })] }).expect(409);
    expect(ask.body.code).toBe('STUDENT_SAME_NAME');
    expect(ask.body.message).toContain(`#${STU_EXISTING} 10 · 테스트고`);
    expect(await q(`SELECT 1 FROM lead WHERE id = $1 AND stage = 'second'`, [LEADS.same])).toHaveLength(1);
    // 기존 학생 재등록 — 새 학생 없이 등록·시간표·청구서만. 형제 등록에는 이 경로를 쓰지 않는다.
    const reenrolled = await api('post', `/ops/leads/${LEADS.same}/enroll`).send({ studentId: STU_EXISTING, startedOn: START, issueInvoice: false, lines: [line({ rrule: 'WEEKLY:TU', startMin: 600, endMin: 660 })] }).expect(201);
    expect(reenrolled.body).toMatchObject({ studentId: STU_EXISTING, studentName: '등록A', studentCreated: false, invoice: null, invoiceSkipped: null });
    expect(await q(`SELECT 1 FROM enr WHERE student_id = $1`, [STU_EXISTING])).toHaveLength(1);
    expect(await q(`SELECT student_id::int AS sid FROM lead WHERE id = $1 AND stage = 'enrolled'`, [LEADS.same])).toEqual([{ sid: STU_EXISTING }]);

    // 단가 없는 종류 — 등록은 되고 청구서만 건너뛴다(이유와 함께)
    const norate = await api('post', `/ops/leads/${LEADS.norate}/enroll`).send({ startedOn: START, dueOn: DUE, lines: [line({ kindKey: KIND_NORATE, subKey: null, rrule: 'WEEKLY:TH', startMin: 600, endMin: 660 })] }).expect(201);
    expect(norate.body.invoice).toBeNull();
    expect(norate.body.invoiceSkipped).toMatchObject({ code: 'INV_NO_RATE' });
    expect(norate.body.studentCreated).toBe(true);
    expect(await q(`SELECT 1 FROM inv WHERE student_id = $1`, [norate.body.studentId])).toEqual([]);
    expect(await q(`SELECT 1 FROM ser_stu WHERE student_id = $1`, [norate.body.studentId])).toHaveLength(1);
    // 대표 알림에 「청구서 없음」과 **사람이 읽는 이유** — 코드값(INV_NO_RATE)은 알림 글에 싣지 않는다 (impl3-w8)
    const [n] = await q<{ title: string | null; body: string }>(`SELECT title, body FROM noti WHERE to_id = $1 AND from_id = $2 AND body LIKE '등록 확정 — 등록E%'`, [CEO, ADMIN]);
    expect(n.body).toContain('청구서 없음: 단가표에 없는 과목이 있습니다');
    expect(n.body).not.toContain('INV_NO_RATE');
    expect(n.title).toBe(NOTI_TITLE.enrollConfirmed);
  });
  /* ── A-01 → 등록 확정 — 문의 때 적은 학부모 · 연락처가 보호자(DQ3)로 이어진다 ─────────────────── */
  it('A-01 문의의 학부모 · 연락처는 등록 확정 때 그 학생의 대표 보호자로 이어진다(받는 채널은 꺼 둔 채) · 미리보기는 남기지 않는다', async () => {
    const body = { startedOn: START, dueOn: DUE, lines: [line({ rrule: 'WEEKLY:TH', startMin: 780, endMin: 840 })] };
    const pre = (await api('post', `/ops/leads/${LEADS.parent}/enroll/preview`).send(body).expect(201)).body;
    expect(pre.guardianCarried).toEqual({ name: '등록P 어머니', relation: '어머니', phoneDisplay: '010-5555-6666' });
    expect(await q(`SELECT 1 FROM guardian g JOIN stu s ON s.id = g.student_id WHERE s.name = '등록P'`)).toEqual([]);

    const r = (await api('post', `/ops/leads/${LEADS.parent}/enroll`).send(body).expect(201)).body;
    expect(r.guardianCarried).toEqual({ name: '등록P 어머니', relation: '어머니', phoneDisplay: '010-5555-6666' });
    const rows = await q(`SELECT name, relation, phone, email, receive_sms, receive_email, is_primary, active, created_by FROM guardian WHERE student_id = $1`, [r.studentId]);
    expect(rows).toEqual([{
      name: '등록P 어머니', relation: '어머니', phone: '01055556666', email: null,
      // 받는 채널은 「+ 보호자 추가」의 기본과 같다 — 문자 받기는 사람이 켠다(발송 대상이 조용히 늘지 않는다)
      receive_sms: false, receive_email: false, is_primary: true, active: true, created_by: String(ADMIN),
    }]);
    // 보호자 쓰기와 같은 함수 — GUARDIAN create LOG 도 가린 번호로 남는다
    const [glog] = await q<{ after: Record<string, unknown> }>(
      `SELECT after FROM log WHERE entity = 'GUARDIAN' AND action = 'create' AND entity_id = (SELECT id FROM guardian WHERE student_id = $1)`, [r.studentId],
    );
    expect(glog.after).toMatchObject({ name: '등록P 어머니', phone: '010-****-6666', isPrimary: true, receiveSms: false });
    // 보호자 관리 화면(GET /guardians)이 같은 줄을 읽는다
    const g = (await api('get', `/students/${r.studentId}/guardians`).expect(200)).body;
    expect(g.guardians ?? g).toEqual(expect.arrayContaining([expect.objectContaining({ name: '등록P 어머니', phoneDisplay: '010-5555-6666', isPrimary: true })]));
    // 감사 줄 — 등록 LOG after 에 가린 번호로 남는다
    const [log] = await q<{ after: Record<string, unknown> }>(`SELECT after FROM log WHERE entity = 'LEAD' AND entity_id = $1 AND action = 'enroll'`, [LEADS.parent]);
    expect(log.after.guardianCarried).toEqual({ name: '등록P 어머니', relation: '어머니', phone: '010-****-6666' });
    expect(JSON.stringify(log.after)).not.toContain('01055556666');
  });

  it('A-01 같은 번호의 보호자가 이미 있으면(사용 중지한 줄이어도) 잇지 않는다 — 기존 학생에 붙이는 등록', async () => {
    const [had] = await q<{ id: string }>(
      `INSERT INTO guardian (student_id, name, relation, phone, receive_email, receive_sms, is_primary, active, created_by)
       VALUES ($1,'등록A 아버지(옛)','아버지','01077778888',false,false,false,false,$2) RETURNING id`, [STU_EXISTING, ADMIN],
    );
    const body = { studentId: STU_EXISTING, startedOn: START, issueInvoice: false, lines: [line({ rrule: 'WEEKLY:SA', startMin: 900, endMin: 960 })] };
    const r = (await api('post', `/ops/leads/${LEADS.parentDup}/enroll`).send(body).expect(201)).body;
    expect(r).toMatchObject({ studentId: STU_EXISTING, studentCreated: false, guardianCarried: null });
    const rows = await q<{ id: string; active: boolean }>(`SELECT id, active FROM guardian WHERE student_id = $1 AND phone = '01077778888'`, [STU_EXISTING]);
    // 사람이 꺼 둔 줄을 되살리지도, 같은 번호를 하나 더 만들지도 않는다
    expect(rows).toEqual([{ id: had.id, active: false }]);
  });
});
