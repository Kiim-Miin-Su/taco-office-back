/** @file-guide
 * 목적: teacher-lineage-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * P1 TEACHER-LINEAGE (2026-09-29) — 이전 강사 → 교체 강사 · 이전 교재 → 교체 교재 · GUIDE 수신·확인·이력 readback.
 *
 * 원문: §44 「연동 — 강사 교체 시 이전 안내에서 지도 방향·교재를 물려받습니다 · 가장 최근 안내가 현재 유효한 것」 ·
 *       §43 「안내 작성 → 강사 발송 → 강사 확인 · draft → ready → sent → read」 · §40 이력 칩 「강사 교체」 ·
 *       테스트 시나리오 F-62(간이 안내 자동 생성 · 이유 강사 교체 · 이전 안내를 물려받는다 — 못 물려받으면 실패) ·
 *       F-65(발송 → 읽음 · 발송부터 확인까지 걸린 시간) · D-46(수업 안내는 새 강사 기준 · 교재 담당 이관).
 *
 * 증명하는 것 —
 *   ① 마법사(이 날부터)가 만든 강사 교체 초안은 그 학생의 **가장 최근 안내의 지도 방향**을 물려받고(없는 학생은 null),
 *      `hist(guide · teacher_swap)` 이 초안마다 한 줄 남으며, 목록의 안내는 **이전 강사**(마법사 LOG 에서 되짚은 값)와
 *      자동 채움 여덟째 칸 「이전 강사」를 싣는다 — 첫 수업 안내는 이전 강사 없이 일곱 칸 그대로. 새 강사 알림에 「A → B」.
 *   ② 그날만 대강(EXC · 마법사 아님)을 §45 「안 한 것」에서 초안으로 만들면 이전 강사는 **같은 규칙의 직전 회차**에서 되짚고
 *      지도 방향도 물려받는다.
 *   ③ 작성 → 발송 → 새 강사의 「받은 안내」(이전 강사 표시) → 확인 → read · 걸린 시간 · 확인한 사람 · §45 이력 사건 셋.
 *   ④ 강사 수업 안내의 교재 — 상태 낱말 · 배부 전 줄의 배부일 null(전에는 "null" 글자) · 취소·반려 제외 ·
 *      회수 → 재배부(`reissued_from`)의 양쪽 링크(이전 배부 → 재배부).
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
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(120_000);

d('강사 계보 — 이전 강사 → 교체 강사 · 이전 교재 → 교체 교재 · 수신·확인·이력 (P1 TEACHER-LINEAGE · F-62 · F-65 · D-46)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  let newTeacherToken = '';
  const PW = 'tl-12345';
  const CEO = 961;
  const T_A = 962; // 이전 강사
  const T_B = 963; // 교체 강사
  const STU1 = 9961; // 이전 안내(지도 방향)가 있는 학생
  const STU2 = 9962; // 안내가 없던 학생
  const KIND = 'tl_kind';
  const SUB = 'tl-sub';
  const BOOK = 'TL-BOOK-A';
  const BOOK_WAIT = 'TL-BOOK-WAIT';
  const BOOK_CANCELED = 'TL-BOOK-CANCELED';
  const serIds: number[] = [];

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const firstDow = (from: string, want: number) => { let d0 = from; while (dow(d0) !== want) d0 = plus(d0, 1); return d0; };
  const TODAY = kst();
  /** 다음 달 1일부터 — 전부 앞으로의 회차 */
  const START = `${plus(`${TODAY.slice(0, 7)}-01`, 32).slice(0, 7)}-01`;
  const MON1 = firstDow(START, 1);
  const MON2 = plus(MON1, 7);
  const FRI1 = firstDow(START, 5);
  const FRI2 = plus(FRI1, 7);

  const api = (m: 'post' | 'patch' | 'put' | 'get', p: string, t = ceoToken) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`).timeout({ response: 10000, deadline: 20000 });

  const makeSeries = async (rrule: string, startMin: number, teacherId: number, students: number[], title: string) => {
    const res = await api('post', '/schedule').send({
      kindKey: KIND, subKey: SUB, mode: 'offline', fromDate: START, toDate: null, rrule, startMin, endMin: startMin + 60,
      teacherId, roomId: null, title, studentIds: students,
    }).expect(201);
    const id = Number(res.body.serIds[0]);
    serIds.push(id);
    return id;
  };

  let s1 = 0;
  let s2 = 0;
  let newS1 = 0;
  let libId = 0;
  let okIssueId = 0;
  let waitIssueId = 0;
  let guideStu1 = 0; // 마법사가 STU1 에게 만든 간이 안내
  let guideStu2 = 0;

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
         ($1,'계보대표','tl-ceo@t.kr','ceo',$4,true,null),
         ($2,'계보A','tl-a@t.kr','teacher',$4,true,null),
         ($3,'계보B','tl-b@t.kr','teacher',$4,true,null)`,
      [CEO, T_A, T_B, hash],
    );
    await q(`INSERT INTO stu (id, name, grade, school) VALUES ($1,'계보학생1','10','테스트고'), ($2,'계보학생2','11','테스트고')`, [STU1, STU2]);
    await q(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'계보 수업','#333333',4,'lesson',true) ON CONFLICT (key) DO NOTHING`, [KIND]);
    await q(`INSERT INTO sub (key,name,color) VALUES ($1,'계보 과목','#444444') ON CONFLICT (key) DO NOTHING`, [SUB]);
    const login = async (email: string) => {
      const res = await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 }).send({ loginId: email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    ceoToken = await login('tl-ceo@t.kr');
    newTeacherToken = await login('tl-b@t.kr');

    s1 = await makeSeries('WEEKLY:MO,WE', 600, T_A, [STU1, STU2], '계보 S1');
    s2 = await makeSeries('WEEKLY:FR', 600, T_A, [STU2], '계보 S2');
    // STU1 의 이전 안내(첫 수업 · 이미 읽음) — 지도 방향이 적혀 있다. §44 「가장 최근 안내가 현재 유효한 것」
    await q(
      `INSERT INTO guide (ser_id,student_id,teacher_id,reason,state,due_on,event_on,created_by,body,direction,admin_note,created_at)
       VALUES ($1,$2,$3,'new','read'::guide_state_t,$4::date,$4::date,$5,'첫 수업 안내입니다.','문법 위주 · 매주 단어 시험','강사만 보는 코멘트',now() - interval '10 days')`,
      [s1, STU1, T_A, MON1, CEO],
    );
    // 교재 — 사용 중 한 권 · 배부 전(승인 대기) 한 권 · 취소된 배부 한 권
    const [lib] = await q<{ id: string }>(`INSERT INTO lib (code, title, sub_key, pages) VALUES ($1, '계보 교재', $2, 120) RETURNING id`, [BOOK, SUB]);
    libId = Number(lib.id);
    const [libWait] = await q<{ id: string }>(`INSERT INTO lib (code, title, sub_key, pages) VALUES ($1, '계보 대기 교재', $2, 80) RETURNING id`, [BOOK_WAIT, SUB]);
    const [libCanceled] = await q<{ id: string }>(`INSERT INTO lib (code, title, sub_key, pages) VALUES ($1, '계보 취소 교재', $2, 80) RETURNING id`, [BOOK_CANCELED, SUB]);
    const [ok] = await q<{ id: string }>(`INSERT INTO issue (lib_id, student_id, issued_on, state) VALUES ($1, $2, $3::date, 'ok') RETURNING id`, [libId, STU1, TODAY]);
    okIssueId = Number(ok.id);
    const [wait] = await q<{ id: string }>(`INSERT INTO issue (lib_id, student_id, state) VALUES ($1, $2, 'wait') RETURNING id`, [libWait.id, STU1]);
    waitIssueId = Number(wait.id);
    await q(
      `INSERT INTO issue (lib_id, student_id, state, ended_reason, ended_by, ended_at) VALUES ($1, $2, 'canceled', '잘못 올림', $3, now())`,
      [libCanceled.id, STU1, CEO],
    );
  });

  async function cleanup() {
    const sers = await q<{ id: string }>(
      `SELECT id FROM ser WHERE kind_key = $1 OR teacher_id = ANY($2) OR id IN (SELECT ser_id FROM ser_stu WHERE student_id = ANY($3))`,
      [KIND, [T_A, T_B], [STU1, STU2]],
    );
    const ids = sers.map((s) => Number(s.id));
    if (ids.length) {
      await q(`DELETE FROM hist WHERE entity = 'guide' AND ref_id IN (SELECT id FROM guide WHERE ser_id = ANY($1))`, [ids]);
      await q(`DELETE FROM guide WHERE ser_id = ANY($1)`, [ids]);
      await q(`DELETE FROM pnoti WHERE ser_id = ANY($1)`, [ids]);
      await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [ids]);
      await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [ids]);
      await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [ids]);
      await q(`DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id = ANY($1))`, [ids]);
      await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [ids]);
      await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [ids]);
      await q(`DELETE FROM ser WHERE id = ANY($1)`, [ids]);
    }
    await q(`DELETE FROM hist WHERE by_id = ANY($1) OR (entity = 'guide' AND ref_id IN (SELECT id FROM guide WHERE student_id = ANY($2)))`, [[CEO, T_A, T_B], [STU1, STU2]]);
    await q(`DELETE FROM hist WHERE entity = 'issue' AND ref_id IN (SELECT id FROM issue WHERE student_id = ANY($1))`, [[STU1, STU2]]);
    await q(`DELETE FROM guide WHERE student_id = ANY($1)`, [[STU1, STU2]]);
    await q(`DELETE FROM pnoti WHERE student_id = ANY($1)`, [[STU1, STU2]]);
    await q(`DELETE FROM issue WHERE student_id = ANY($1) OR lib_id IN (SELECT id FROM lib WHERE code = ANY($2))`, [[STU1, STU2], [BOOK, BOOK_WAIT, BOOK_CANCELED]]);
    await q(`DELETE FROM lib WHERE code = ANY($1)`, [[BOOK, BOOK_WAIT, BOOK_CANCELED]]);
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU1, STU2]]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, T_A, T_B]]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, T_A, T_B]]);
    await q(`DELETE FROM sub WHERE key = $1`, [SUB]);
    await q(`DELETE FROM kind WHERE key = $1`, [KIND]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, T_A, T_B]]);
  }

  afterAll(async () => {
    try { if (ds?.isInitialized) await cleanup(); } finally { await app?.close(); }
  });

  /* ── ① 마법사 「이 날부터」 — 지도 방향 승계 · 이전 강사 · hist teacher_swap · 알림 (F-62 · §44 · D-46) ── */
  it('강사 교체 초안은 그 학생의 가장 최근 안내에서 지도 방향을 물려받고, 이전 강사는 마법사 LOG 에서 되짚으며, 초안마다 hist teacher_swap 이 남는다', async () => {
    const r = (await api('post', '/ops/teacher-change').send({ fromTeacherId: T_A, toTeacherId: T_B, mode: 'from', date: MON2, serIds: [s1], memo: '학부모 요청' }).expect(201)).body;
    newS1 = Number(r.series[0].newSerId);
    serIds.push(newS1);
    expect(r.guideDrafts).toBe(2);

    // 지도 방향 — STU1 은 이전 안내의 것을 그대로, STU2 는 이전 안내가 없어 null (관리자 코멘트는 물려주지 않는다)
    const drafts = await q<{ id: string; student_id: string; direction: string | null; admin_note: string | null; state: string }>(
      `SELECT id, student_id, direction, admin_note, state FROM guide WHERE ser_id = $1 AND reason = 'teacher_change' ORDER BY student_id`, [newS1],
    );
    expect(drafts.map((g) => [g.student_id, g.direction, g.admin_note, g.state])).toEqual([
      [String(STU1), '문법 위주 · 매주 단어 시험', null, 'draft'],
      [String(STU2), null, null, 'draft'],
    ]);
    guideStu1 = Number(drafts[0]!.id);
    guideStu2 = Number(drafts[1]!.id);

    // §40 「강사 교체」 칩의 생산자 — 초안마다 hist 한 줄 (마법사를 돌린 사람)
    const swaps = await q<{ ref_id: string; by_id: string }>(
      `SELECT ref_id, by_id FROM hist WHERE entity = 'guide' AND action = 'teacher_swap' AND ref_id = ANY($1) ORDER BY ref_id`, [[guideStu1, guideStu2]],
    );
    expect(swaps).toEqual([{ ref_id: String(guideStu1), by_id: String(CEO) }, { ref_id: String(guideStu2), by_id: String(CEO) }]);

    // 목록 — 이전 강사 → 받는 강사 · 간이 안내 · 자동 채움 여덟째 칸. 첫 수업 안내는 이전 강사 없이 일곱 칸
    const all = (await api('get', '/guides').expect(200)).body;
    const g1 = all.guides.find((g: { id: number }) => g.id === guideStu1);
    expect(g1).toMatchObject({
      reason: 'teacher_change', kindLabel: '간이 안내', teacherId: T_B, teacherName: '계보B',
      previousTeacherId: T_A, previousTeacherName: '계보A', direction: '문법 위주 · 매주 단어 시험', state: 'draft',
    });
    expect(g1.autoFill.facts.map((f: { key: string }) => f.key)).toEqual(['student', 'grade', 'teacher', 'subject', 'mode', 'startOn', 'books', 'previousTeacher']);
    expect(g1.autoFill.facts.at(-1)).toEqual({ key: 'previousTeacher', label: '이전 강사', value: '계보A', filled: true });
    expect(g1.autoFill.body).toContain('이전 강사 계보A');
    const g2 = all.guides.find((g: { id: number }) => g.id === guideStu2);
    expect(g2).toMatchObject({ previousTeacherId: T_A, previousTeacherName: '계보A', direction: null });
    const first = all.guides.find((g: { studentId: number; reason: string }) => g.studentId === STU1 && g.reason === 'new');
    expect(first).toMatchObject({ previousTeacherId: null, previousTeacherName: null });
    expect(first.autoFill ?? null).toBeNull(); // 이미 읽은 안내 — 자동 채움은 초안에만

    // §44 학생별 — 가장 최근 안내(= 간이 안내)가 같은 값을 싣는다
    const students = (await api('get', '/guides/students').expect(200)).body;
    const row = students.items.find((s: { studentId: number }) => s.studentId === STU1);
    expect(row.latestGuide).toMatchObject({ id: guideStu1, previousTeacherName: '계보A' });

    // 새 강사 알림에 「누구에게서」가 적힌다
    const [toB] = await q<{ body: string; title: string }>(`SELECT body, title FROM noti WHERE to_id = $1 AND from_id = $2`, [T_B, CEO]);
    expect(toB.title).toBe(NOTI_TITLE.teacherChange);
    expect(toB.body).toContain('강사 교체 — 계보A → 계보B · 계보 과목 (계보학생1 · 계보학생2)');
  });

  /* ── ② 그날만 대강(마법사 아님) → §45 「안 한 것」 → 초안 — 이전 강사는 같은 규칙의 직전 회차에서 ── */
  it('EXC 로 바뀐 회차의 강사 교체 초안(§45 클릭)은 이전 강사를 같은 규칙의 직전 회차에서 되짚고 지도 방향을 물려받는다', async () => {
    // STU2 의 가장 최근 안내(①의 간이 안내)에 지도 방향을 적어 둔다 — 다음 초안이 이것을 물려받아야 한다
    await api('put', `/guides/${guideStu2}/body`).send({ body: '강사 교체 안내입니다.', direction: '회화 중심' }).expect(200);
    // 그날만 대강 — 마법사가 아니라 일정 쓰기(회차 예외)
    await api('patch', `/schedule/${s2}`).send({ scope: 'this', onDate: FRI2, teacherId: T_B }).expect(200);
    const missing = (await api('get', `/guides/history?span=week&anchor=${FRI2}`).expect(200)).body.missing;
    const cand = missing.find((x: { serId: number; studentId: number; eventOn: string }) => x.serId === s2 && x.studentId === STU2 && x.eventOn === FRI2);
    expect(cand).toMatchObject({ reason: 'teacher_change', teacherId: T_B });
    const draft = (await api('post', '/guides/drafts').send({ sourceOccurrenceId: cand.sourceOccurrenceId, studentId: STU2 }).expect(201)).body;
    expect(draft).toMatchObject({
      reason: 'teacher_change', teacherId: T_B, previousTeacherId: T_A, previousTeacherName: '계보A', direction: '회화 중심',
    });
    expect(draft.autoFill.facts.at(-1)).toMatchObject({ key: 'previousTeacher', value: '계보A' });
    // 마법사 LOG 가 가리키지 않는 초안 — 직전 회차(FRI1 · 계보A) 길로 답했다
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM log WHERE entity = 'STAFF' AND action = 'teacher-change' AND after->'guideIds' @> to_jsonb($1::bigint)`, [draft.id]))[0]!.n).toBe(0);
  });

  /* ── ③ 작성 → 발송 → 새 강사 수신(이전 강사 표시) → 확인 → 이력 (F-65 · §43) ── */
  it('새 강사는 받은 안내에서 이전 강사를 보고 확인한다 — read · 걸린 시간 · 확인한 사람 · §45 이력에 작성·발송·확인 사건', async () => {
    await api('put', `/guides/${guideStu1}/body`).send({ body: '강사 교체 안내 — 진도는 그대로 이어집니다.' }).expect(200);
    const sent = (await api('post', `/guides/${guideStu1}/send`).expect(200)).body;
    expect(sent).toMatchObject({ state: 'sent', sentByName: '계보대표', previousTeacherName: '계보A' });
    // 새 강사 — 받은 안내에 이전 강사 → 교체 강사
    const received = (await api('get', '/teacher/guides/received', newTeacherToken).expect(200)).body;
    const mine = received.items.find((g: { id: number }) => g.id === guideStu1);
    expect(mine).toMatchObject({ teacherName: '계보B', previousTeacherName: '계보A', direction: '문법 위주 · 매주 단어 시험', canAck: true, state: 'sent' });
    const acked = (await api('post', `/teacher/guides/${guideStu1}/ack`, newTeacherToken).send({}).expect(200)).body;
    expect(acked).toMatchObject({ state: 'read', acknowledgedByName: '계보B', previousTeacherName: '계보A', canAck: false });
    expect(acked.acknowledgedAfterSeconds).toBeGreaterThanOrEqual(0);
    // §45 이력 — 사건 셋이 그 안내를 가리키고, 사건의 안내도 이전 강사를 싣는다
    const history = (await api('get', `/guides/history?span=week&anchor=${TODAY}`).expect(200)).body;
    const events = history.days.flatMap((day: { events: Array<{ action: string; byName: string; guide: { id: number; previousTeacherName: string | null } }> }) => day.events)
      .filter((e: { guide: { id: number } }) => e.guide.id === guideStu1);
    expect(events.map((e: { action: string; byName: string }) => [e.action, e.byName]).sort()).toEqual([['guide_ack', '계보B'], ['guide_send', '계보대표'], ['guide_write', '계보대표']]);
    expect(events[0]!.guide.previousTeacherName).toBe('계보A');
    // 걸린 시간은 이력 원장(hist)에서 — 확인 뒤 수신함에서도 같은 값
    const again = (await api('get', '/teacher/guides/received', newTeacherToken).expect(200)).body.items.find((g: { id: number }) => g.id === guideStu1);
    expect(again.acknowledgedAfterSeconds).toBe(acked.acknowledgedAfterSeconds);
  });

  /* ── ④ 강사 수업 안내의 교재 — 상태 · 배부 전 null · 취소 제외 · 회수 → 재배부 링크 ── */
  it('강사 수업 안내의 교재는 상태 낱말과 재배부 계보(이전 배부 → 재배부)를 싣고, 배부 전 줄의 배부일은 null 이며 취소·반려는 싣지 않는다', async () => {
    const week = async () => {
      const page = (await api('get', `/teacher/guides?week=${MON2}`, newTeacherToken).expect(200)).body;
      return page.students.find((s: { studentId: number }) => s.studentId === STU1).books as Array<Record<string, unknown>>;
    };
    const before = await week();
    expect(before.map((b) => [b.issueId, b.state, b.stateLabel, b.issuedOn, b.returnedOn, b.reissuedFrom, b.reissuedTo])).toEqual([
      [waitIssueId, 'wait', '승인 대기', null, null, null, null],
      [okIssueId, 'ok', '배부 완료', TODAY, null, null, null],
    ]);
    expect(before.find((b) => b.issueId === okIssueId)).toMatchObject({ changeRequestable: true, changePending: false });
    expect(before.find((b) => b.issueId === waitIssueId)).toMatchObject({ changeRequestable: false });

    // 회수(E-55) → 같은 학생·같은 교재 재배부(계보 잇기)
    await api('post', `/books/issues/${okIssueId}/return`).send({}).expect(200);
    expect((await api('post', '/books/issues').send({ studentId: STU1, libId, reason: '재배부' }).expect(409)).body.code).toBe('BOOK_REISSUE_SOURCE_REQUIRED');
    const reissued = (await api('post', '/books/issues').send({ studentId: STU1, libId, reissuedFrom: okIssueId, reason: '재배부' }).expect(201)).body;
    expect(reissued).toMatchObject({ state: 'ok', reissuedFrom: okIssueId });

    const after = await week();
    expect(after.map((b) => [b.issueId, b.state, b.issuedOn, b.returnedOn, b.reissuedFrom, b.reissuedTo])).toEqual([
      [waitIssueId, 'wait', null, null, null, null],
      [reissued.id, 'ok', TODAY, null, okIssueId, null],
      [okIssueId, 'returned', TODAY, TODAY, null, reissued.id],
    ]);
    expect(after.find((b) => b.issueId === okIssueId)).toMatchObject({ stateLabel: '회수 완료', changeRequestable: false });
    // §40 이력 — 배부 · 회수(제외) · 강사 교체가 한 흐름에 (원문 §40)
    const hist = (await api('get', '/books/history?span=all').expect(200)).body;
    const mineActions = hist.items
      .filter((h: { entity: string; refId: number }) => (h.entity === 'issue' && [okIssueId, reissued.id].includes(h.refId)) || (h.entity === 'guide' && [guideStu1, guideStu2].includes(h.refId)))
      .map((h: { action: string }) => h.action);
    expect(mineActions).toEqual(expect.arrayContaining(['book_issue', 'book_drop', 'teacher_swap']));
    expect(hist.actions.find((a: { key: string }) => a.key === 'teacher_swap').count).toBeGreaterThanOrEqual(2);
  });
});
