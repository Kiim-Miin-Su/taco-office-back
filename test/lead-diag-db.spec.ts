/** @file-guide
 * 목적: lead-diag-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 상담 단계 진단 점수 — DQ1 대표 답변(2026-09-25) 「점수만 저장 + 담당자가 선택」 · 테스트 시나리오 A-04 · v2 §23 · N-53.
 *
 * 증명하는 것 —
 *   ① 점수 셋 · 본 날 · 담당자가 고른 레벨·교재 · 메모가 append-only 한 줄로 쌓이고(보낸 칸만), LOG 가 같은 트랜잭션에 남으며
 *      `GET /ops` 카드는 따로 묻지 않고 최신 줄(latestDiag)을 싣는다. 만점을 지어내지 않는다(100 을 넘어도 받는다).
 *   ② DTO 가 400(음수·소수·문자·없는 레벨·없는 날짜·모르는 칸·빈 줄)으로, 없는 교재·상담 건은 404 로, 강사는 403 으로 막고 아무것도 남지 않는다.
 *      DB CHECK 셋이 서비스를 건너뛴 SQL 도 막는다.
 *   ③ 등록 확정 — 교재를 적지 않은 줄에 담당자가 고른 교재가 기본으로 요청되고(null 은 덮지 않는다), 등록 뒤에는 lead.student_id 를 따라
 *      그 학생의 진단으로 읽힌다. 강사 진단 리포트(DIAG)에 값을 옮겨 적지 않는다.
 *
 * ⚠ 이 파일은 **표를 비우지 않는다.** 스위트 전용 번호대로 만들고 스스로 치운다(enroll-db 와 같은 규약).
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

d('상담 진단 점수 — 점수만 저장 · 레벨·교재는 담당자가 고른다 (DQ1 · A-04 · N-53)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let adminToken = '';
  let teacherToken = '';
  const PW = 'leaddiag-1234';
  const ADMIN = 981;
  const TEACHER = 982;
  const LEADS = { second: 8821, hold: 8822, other: 8823 };
  const KIND = 'ld_kind';
  let LIB_A = 0;
  let LIB_B = 0;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  /** 다음 달 1일 — 오늘이 언제든 앞으로의 회차 */
  const START = `${plus(`${kst().slice(0, 7)}-01`, 32).slice(0, 7)}-01`;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    // 제품 앱과 같은 파이프 — 모르는 칸도 400 이어야 한다 (app.factory)
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await cleanup();
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'진단관리자','ld-a@t.kr','admin',$3,true), ($2,'진단강사','ld-t@t.kr','teacher',$3,true)`,
      [ADMIN, TEACHER, hash],
    );
    await q(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'진단 시험 수업','#333333',4,'lesson',true) ON CONFLICT (key) DO NOTHING`, [KIND]);
    const libs = await q<{ id: string }>(
      `INSERT INTO lib (code, title, pages) VALUES ('LD-TEST-A','진단 교재 A',100), ('LD-TEST-B','진단 교재 B',120) RETURNING id`,
    );
    LIB_A = Number(libs[0]!.id); LIB_B = Number(libs[1]!.id);
    await q(
      `INSERT INTO lead (id, name, school, stage, owner_id) VALUES ($1,'진단A','시험고','second',$4), ($2,'진단B','시험고','hold',$4), ($3,'진단C',NULL,'second',$4)`,
      [LEADS.second, LEADS.hold, LEADS.other, ADMIN],
    );
    const login = async (email: string) => {
      const res = await request(app.getHttpServer())
        .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ loginId: email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    adminToken = await login('ld-a@t.kr');
    teacherToken = await login('ld-t@t.kr');
  });

  async function cleanup() {
    const leadIds = Object.values(LEADS);
    await q(`DELETE FROM lead_diag WHERE lead_id = ANY($1) OR created_by = ANY($2)`, [leadIds, [ADMIN, TEACHER]]);
    const stus = await q<{ id: string }>(`SELECT id FROM stu WHERE name IN ('진단A','진단B','진단C')`);
    const ids = stus.map((s) => Number(s.id));
    const sers = await q<{ id: string }>(`SELECT DISTINCT ser_id AS id FROM ser_stu WHERE student_id = ANY($1) UNION SELECT id FROM ser WHERE kind_key = $2`, [ids, KIND]);
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
      await q(`DELETE FROM enr WHERE student_id = ANY($1)`, [ids]);
      await q(`UPDATE lead SET student_id = NULL WHERE student_id = ANY($1)`, [ids]);
      await q(`DELETE FROM stu WHERE id = ANY($1)`, [ids]);
    }
    await q(`DELETE FROM lead_stage_log WHERE lead_id = ANY($1)`, [leadIds]);
    await q(`DELETE FROM lead WHERE id = ANY($1)`, [leadIds]);
    await q(`DELETE FROM lib WHERE code IN ('LD-TEST-A','LD-TEST-B')`);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[ADMIN, TEACHER]]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[ADMIN, TEACHER]]);
    await q(`DELETE FROM kind WHERE key = $1`, [KIND]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[ADMIN, TEACHER]]);
  }

  afterAll(async () => {
    try { if (ds?.isInitialized) await cleanup(); } finally { await app?.close(); }
  });

  const api = (m: 'post' | 'get', p: string, t = adminToken) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`)
      .timeout({ response: 8000, deadline: 15000 });
  const count = async (leadId: number) =>
    Number((await q<{ n: number }>(`SELECT count(*)::int AS n FROM lead_diag WHERE lead_id = $1`, [leadId]))[0]!.n);

  /* ── ① 적기 · 이력 · LOG · 카드 ─────────────────────────────────────── */
  it('점수 셋 · 본 날 · 담당자가 고른 레벨·교재를 한 줄로 쌓고(보낸 칸만) · LOG 는 같은 트랜잭션 · 카드는 따로 묻지 않고 최신 줄을 싣는다', async () => {
    const empty = (await api('get', `/ops/leads/${LEADS.second}/diag`).expect(200)).body;
    expect(empty).toEqual({
      leadId: LEADS.second, studentId: null, items: [],
      // 레벨 낱말은 서버가 준다 — PDF A-04 의 세 낱말 그대로 · 점수로 고른 추천값은 없다
      levels: [{ key: 'foundation', label: 'Foundation' }, { key: 'practice', label: 'Practice' }, { key: 'master', label: 'Master' }],
    });

    const first = (await api('post', `/ops/leads/${LEADS.second}/diag`).send({
      english: 62, math: 71, interview: 58, takenOn: '2026-09-20', level: 'practice', bookId: LIB_A, note: '  어머니 동석 · 010-1234-5678  ',
    }).expect(201)).body;
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      leadId: LEADS.second, english: 62, math: 71, interview: 58, takenOn: '2026-09-20',
      level: 'practice', levelLabel: 'Practice', bookId: LIB_A, bookTitle: '진단 교재 A',
      note: '어머니 동석 · 010-1234-5678', byId: ADMIN, byName: '진단관리자', at: expect.stringMatching(/\+09:00$/),
    });

    // 둘째 줄 — 보낸 칸만 들어간다(레벨·교재를 이어받지 않는다). 지난 줄은 그대로 · 최근 것이 앞 · 만점을 지어내지 않는다(100 을 넘어도 받는다)
    const second = (await api('post', `/ops/leads/${LEADS.second}/diag`).send({ english: 1000 }).expect(201)).body;
    expect(second.items.map((x: { english: number }) => x.english)).toEqual([1000, 62]);
    expect(second.items[0]).toMatchObject({ math: null, interview: null, takenOn: null, level: null, levelLabel: null, bookId: null, bookTitle: null, note: null });
    expect(second.items[1]).toEqual(first.items[0]);
    expect(await count(LEADS.second)).toBe(2);

    // LOG — 같은 트랜잭션 · 메모(연락처가 섞일 수 있다)는 싣지 않고 적었는지만
    const logs = await q<{ action: string; after: Record<string, unknown> }>(
      `SELECT action, after FROM log WHERE actor_id = $1 AND entity = 'LEAD' AND entity_id = $2 ORDER BY id`, [ADMIN, LEADS.second]);
    expect(logs.map((l) => l.action)).toEqual(['diag', 'diag']);
    expect(logs[0]!.after).toMatchObject({ diagId: first.items[0].id, english: 62, level: 'practice', bookId: LIB_A, hasNote: true });
    expect(JSON.stringify(logs)).not.toContain('010-1234-5678');

    // 카드 — GET /ops 한 번에 최신 줄이 실린다 (이력과 같은 모양)
    const ops = (await api('get', '/ops').expect(200)).body;
    const card = ops.leads.find((l: { id: number }) => l.id === LEADS.second);
    expect(card.latestDiag).toEqual(second.items[0]);
    expect(ops.leads.find((l: { id: number }) => l.id === LEADS.other).latestDiag).toBeNull();
  });

  /* ── ② 방어 — 400 · 404 · 403 · DB CHECK ───────────────────────────── */
  it('DTO 가 음수·소수·문자·없는 레벨·없는 날짜·모르는 칸·빈 줄을 400 으로, 없는 교재·상담 건을 404 로, 강사를 403 으로 막고 아무것도 남기지 않는다', async () => {
    const before = await count(LEADS.other);
    const bad = async (body: Record<string, unknown>, text: string | RegExp) => {
      const res = await api('post', `/ops/leads/${LEADS.other}/diag`).send(body).expect(400);
      expect(res.body.message).toEqual(expect.stringMatching(text));
    };
    await bad({ english: -1 }, '영어 점수는 0 이상의 정수입니다');
    await bad({ math: 71.5 }, '수학 점수는 0 이상의 정수입니다');
    await bad({ interview: '58' }, '인터뷰 점수는 0 이상의 정수입니다');
    await bad({ english: 3_000_000_000 }, '영어 점수가 너무 큽니다');
    await bad({ english: 50, level: 'expert' }, '레벨은 Foundation · Practice · Master 중 하나입니다');
    await bad({ english: 50, takenOn: '2026-02-30' }, '본 날은 실제 YYYY-MM-DD 날짜여야 합니다');
    await bad({ bookId: 0 }, '교재 번호가 올바르지 않습니다');
    await bad({ english: 50, score: 1 }, /score/);
    const blank = await api('post', `/ops/leads/${LEADS.other}/diag`).send({ note: '메모만' }).expect(400);
    expect(blank.body).toEqual({ code: 'LEAD_DIAG_EMPTY', message: '영어·수학·인터뷰 점수나 레벨·교재 중 하나는 적어 주세요' });
    await api('post', `/ops/leads/${LEADS.other}/diag`).send({}).expect(400);

    const noBook = await api('post', `/ops/leads/${LEADS.other}/diag`).send({ english: 50, bookId: 987654321 }).expect(404);
    expect(noBook.body.code).toBe('BOOK_NOT_FOUND');
    expect((await api('post', '/ops/leads/99999999/diag').send({ english: 50 }).expect(404)).body.code).toBe('LEAD_NOT_FOUND');
    expect((await api('get', '/ops/leads/99999999/diag').expect(404)).body.code).toBe('LEAD_NOT_FOUND');

    // 강사는 운영 화면 권한이 없다 — 읽기도 쓰기도 403 (서버 플래그로만 가른다)
    await api('get', `/ops/leads/${LEADS.other}/diag`, teacherToken).expect(403);
    await api('post', `/ops/leads/${LEADS.other}/diag`, teacherToken).send({ english: 50 }).expect(403);
    expect(await count(LEADS.other)).toBe(before);

    // 표가 마지막에 막는다 — 서비스를 건너뛴 SQL 도 CHECK 셋이 거절한다
    const blocked = async (sql: string, params: unknown[], constraint: string) =>
      expect(q(sql, params)).rejects.toMatchObject({ constraint });
    await blocked(`INSERT INTO lead_diag (lead_id, english, created_by) VALUES ($1, -1, $2)`, [LEADS.other, ADMIN], 'lead_diag_score_nonneg');
    await blocked(`INSERT INTO lead_diag (lead_id, level, created_by) VALUES ($1, 'expert', $2)`, [LEADS.other, ADMIN], 'lead_diag_level_words');
    await blocked(`INSERT INTO lead_diag (lead_id, note, created_by) VALUES ($1, '메모만', $2)`, [LEADS.other, ADMIN], 'lead_diag_not_empty');
    expect(await count(LEADS.other)).toBe(before);
  });

  /* ── ③ 등록 확정 — 담당자가 고른 교재가 기본 · 등록 뒤 학생의 진단 ──── */
  it('등록 확정 — 교재를 적지 않은 첫 줄에 담당자가 고른 교재가 기본으로 요청되고(null·직접 고른 교재는 그대로), 등록 뒤에는 lead.student_id 를 따라 그 학생의 진단이다', async () => {
    await api('post', `/ops/leads/${LEADS.hold}/diag`).send({ english: 40, level: 'master', bookId: LIB_A }).expect(201);
    await api('post', `/ops/leads/${LEADS.hold}/diag`).send({ english: 55, math: 60, interview: 70, level: 'foundation', bookId: LIB_B }).expect(201);
    const line = (over: Record<string, unknown> = {}) => ({
      kindKey: KIND, subKey: null, mode: 'offline', rrule: 'WEEKLY:TU', startMin: 600, endMin: 660, teacherId: null, roomId: null, title: '진단 수업', ...over,
    });
    const body = (lines: unknown[]) => ({ startedOn: START, issueInvoice: false, lines });

    // 키를 빼면 최신 줄의 교재(B) — 지난 줄의 교재(A)를 끌어오지 않는다. 두 줄이 비어도 첫 줄에만 한 번
    const pre = (await api('post', `/ops/leads/${LEADS.hold}/enroll/preview`)
      .send(body([line(), line({ rrule: 'WEEKLY:TH' })])).expect(201)).body;
    expect(pre).toMatchObject({ preview: true, diagBookApplied: true });
    expect(pre.bookIssues).toEqual([expect.objectContaining({ libId: LIB_B, state: 'wait' })]);
    expect(pre.booksMissing).toHaveLength(1);
    expect(pre.latestDiag).toMatchObject({ leadId: LEADS.hold, english: 55, level: 'foundation', levelLabel: 'Foundation', bookId: LIB_B, bookTitle: '진단 교재 B' });
    // null 은 「교재 미정」이라는 명시 — 기본값으로 덮지 않는다 · 직접 고른 교재는 그대로
    const none = (await api('post', `/ops/leads/${LEADS.hold}/enroll/preview`).send(body([line({ libId: null })])).expect(201)).body;
    expect(none).toMatchObject({ diagBookApplied: false, bookIssues: [] });
    expect(none.booksMissing).toHaveLength(1);
    const own = (await api('post', `/ops/leads/${LEADS.hold}/enroll/preview`).send(body([line({ libId: LIB_A })])).expect(201)).body;
    expect(own.diagBookApplied).toBe(false);
    expect(own.bookIssues).toEqual([expect.objectContaining({ libId: LIB_A })]);
    // 미리보기는 아무것도 쓰지 않았다
    expect(await q(`SELECT 1 FROM lead WHERE id = $1 AND stage = 'hold' AND student_id IS NULL`, [LEADS.hold])).toHaveLength(1);

    // 실제 등록 — 학생에게 붙는다
    const done = (await api('post', `/ops/leads/${LEADS.hold}/enroll`).send(body([line()])).expect(201)).body;
    expect(done).toMatchObject({ preview: false, diagBookApplied: true, studentName: '진단B' });
    expect(done.latestDiag).toMatchObject({ leadId: LEADS.hold, english: 55, math: 60, interview: 70, level: 'foundation', bookId: LIB_B });
    expect(await q(`SELECT 1 FROM issue WHERE student_id = $1 AND lib_id = $2 AND state = 'wait'`, [done.studentId, LIB_B])).toHaveLength(1);

    // 한 곳의 사실 — 진단 줄은 그대로 두 줄이고 학생 칸을 새로 채우지 않는다. 연결은 lead.student_id 하나다
    expect(await count(LEADS.hold)).toBe(2);
    const viaStudent = await q<{ english: number }>(
      `SELECT d.english FROM lead_diag d JOIN lead l ON l.id = d.lead_id WHERE l.student_id = $1 ORDER BY d.id DESC`, [done.studentId]);
    expect(viaStudent.map((r) => r.english)).toEqual([55, 40]);
    // 강사 진단 리포트(DIAG)로 옮겨 적지 않는다
    expect(await q(`SELECT 1 FROM diag WHERE student_id = $1`, [done.studentId])).toEqual([]);
    // 이력에도 학생이 선다 · 등록 뒤에도 적을 수 있고 카드가 따라온다
    expect((await api('get', `/ops/leads/${LEADS.hold}/diag`).expect(200)).body.studentId).toBe(done.studentId);
    const after = (await api('post', `/ops/leads/${LEADS.hold}/diag`).send({ interview: 75 }).expect(201)).body;
    expect(after.studentId).toBe(done.studentId);
    const ops = (await api('get', '/ops').expect(200)).body;
    expect(ops.leads.find((l: { id: number }) => l.id === LEADS.hold).latestDiag).toMatchObject({ interview: 75, english: null });
  });
});
