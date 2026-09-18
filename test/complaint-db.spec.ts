/** @file-guide
 * 목적: complaint-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 컴플레인 접수·처리 · 강사 교체 마법사 — C93 (테스트 시나리오 J-96 「수업 진도 불만 접수」 · J-98 「대응 기한을 넘김」 · J-101 「마무리 처리」 ·
 * J-97 「강사 교체 요구 — 6단계」 · D-46 「강사 퇴사 — 담당 전체 이관」 · F-62 「강사 교체 시 간이 안내」 · N-132 「강사가 당일 아침 못 나옴」 · D-45 「하루만 대강」).
 *
 * 증명하는 것 —
 *   ① 접수는 언제나 received · 담당에게 알림 · 기한이 지나면 열린 건에만 「N일 지남」 · 대응은 담당이, 마무리는 결과가 있어야 한다 · 강사 403.
 *   ② 컴플레인에서 온 교체(J-97)는 그 학생의 규칙만 그 날부터 가른다(D-R16) — 새 규칙은 새 강사 · 옛 규칙은 전날까지 · 회차·리포트가 따라가고
 *      학생마다 강사 교체 안내 초안(F-62)·학부모 안내 행 · 강사 둘과 관리자 알림 · cpl.teacher_changed + 대응. 미리보기는 아무것도 쓰지 않는다.
 *      퇴사(D-46)는 학생 없이 그 강사의 남은 규칙 전부 · 두 번째는 NOTHING_TO_CHANGE.
 *   ③ 그날만 대강(N-132)은 회차 예외 하나 — 다음 회차는 원래 강사 · 정산 시트에서 그날만 대강에게 간다(D-45) · 새 강사가 그 시각에 바쁘면 409 로 전부 되돌아간다.
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
import { payoutSheet } from '../src/lib/payout-sheet';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(120_000);

d('컴플레인 접수·처리 · 강사 교체 마법사 (C93 · J-96 · J-97 · J-98 · J-101 · D-45 · D-46 · F-62 · N-132)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  let teacherToken = '';
  const PW = 'cpl-1234';
  const CEO = 951;
  const T_A = 952; // 원래 강사
  const T_B = 953; // 새 강사
  const ADMIN = 954; // 관리자 — 담당 · 대강 후보
  const STU1 = 9951;
  const STU2 = 9952;
  const KIND = 'cp_kind';
  const SUB = 'cp-sub';
  const serIds: number[] = [];
  const cplIds: number[] = [];

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const firstDow = (from: string, want: number) => { let d0 = from; while (dow(d0) !== want) d0 = plus(d0, 1); return d0; };
  const TODAY = kst();
  /** 다음 달 1일부터 — 전부 앞으로의 회차 (마감 달·지난 회차와 섞이지 않게) */
  const START = `${plus(`${TODAY.slice(0, 7)}-01`, 32).slice(0, 7)}-01`;
  const MON1 = firstDow(START, 1);
  const MON2 = plus(MON1, 7);
  const THU1 = firstDow(START, 4);
  const THU2 = plus(THU1, 7);

  const api = (m: 'post' | 'patch' | 'get', p: string, t = ceoToken) =>
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
         ($1,'교체대표','cp-ceo@t.kr','ceo',$5,true,null),
         ($2,'교체A','cp-a@t.kr','teacher',$5,true,null),
         ($3,'교체B','cp-b@t.kr','teacher',$5,true,null),
         ($4,'교체관리자','cp-adm@t.kr','admin',$5,true,null)`,
      [CEO, T_A, T_B, ADMIN, hash],
    );
    await q(`INSERT INTO stu (id, name, grade, school) VALUES ($1,'교체학생1','10','테스트고'), ($2,'교체학생2','11','테스트고')`, [STU1, STU2]);
    await q(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'교체 수업','#333333',4,'lesson',true) ON CONFLICT (key) DO NOTHING`, [KIND]);
    await q(`INSERT INTO sub (key,name,color) VALUES ($1,'교체 과목','#444444') ON CONFLICT (key) DO NOTHING`, [SUB]);
    const login = async (email: string) => {
      const res = await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 }).send({ email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    ceoToken = await login('cp-ceo@t.kr');
    teacherToken = await login('cp-a@t.kr');
  });

  async function cleanup() {
    const sers = await q<{ id: string }>(
      `SELECT id FROM ser WHERE kind_key = $1 OR teacher_id = ANY($2) OR id IN (SELECT ser_id FROM ser_stu WHERE student_id = ANY($3))`,
      [KIND, [T_A, T_B, ADMIN], [STU1, STU2]],
    );
    const ids = sers.map((s) => Number(s.id));
    if (ids.length) {
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
    await q(`DELETE FROM guide WHERE student_id = ANY($1)`, [[STU1, STU2]]);
    await q(`DELETE FROM pnoti WHERE student_id = ANY($1)`, [[STU1, STU2]]);
    await q(`DELETE FROM cpl WHERE student_id = ANY($1) OR owner_id = ANY($2) OR body LIKE '교체 시험%'`, [[STU1, STU2], [CEO, T_A, T_B, ADMIN]]);
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU1, STU2]]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, T_A, T_B, ADMIN]]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, T_A, T_B, ADMIN]]);
    await q(`DELETE FROM sub WHERE key = $1`, [SUB]);
    await q(`DELETE FROM kind WHERE key = $1`, [KIND]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, T_A, T_B, ADMIN]]);
  }

  afterAll(async () => {
    try { if (ds?.isInitialized) await cleanup(); } finally { await app?.close(); }
  });

  /* ── ① J-96 · J-98 · J-101 ───────────────────────────────────────────── */
  it('접수는 received · 담당 알림 · 기한 지남은 열린 건에만 · 대응은 담당이 · 마무리는 결과가 있어야 한다 · 강사 403 (J-96 · J-98 · J-101)', async () => {
    await api('post', '/ops/complaints', teacherToken).send({ area: 'lesson', body: '교체 시험 x' }).expect(403);
    expect((await api('post', '/ops/complaints').send({ area: 'lesson', body: '교체 시험 x', severity: 'huge' }).expect(400)).body.code).toBe('BAD_REQUEST');
    expect((await api('post', '/ops/complaints').send({ area: 'lesson', body: '교체 시험 x' })).status).toBe(201); // 학생 없이도 접수된다(문의자)
    expect((await api('post', '/ops/complaints').send({ area: 'lesson', body: '교체 시험 x', studentId: 9999999 }).expect(404)).body.code).toBe('STUDENT_NOT_FOUND');

    // J-96 · J-98 — 담당·기한(어제)·심각도
    const made = (await api('post', '/ops/complaints').send({
      area: 'lesson', studentId: STU1, body: '교체 시험 — 진도가 느립니다', ownerId: ADMIN, dueOn: plus(TODAY, -2), severity: 'severe',
    }).expect(201)).body;
    cplIds.push(made.id);
    expect(made).toMatchObject({ area: 'lesson', areaLabel: '수업', studentId: STU1, studentName: '교체학생1', stage: 'received', ownerId: ADMIN, ownerName: '교체관리자', severity: 'severe', severityLabel: '심각', teacherChanged: false, overdueDays: 2 });
    const notis = await q<{ body: string; category: string }>(`SELECT body, category FROM noti WHERE to_id = $1 AND from_id = $2`, [ADMIN, CEO]);
    expect(notis).toHaveLength(1);
    expect(notis[0]!.body).toContain('컴플레인 담당 — 수업');
    // GET /ops 가 같은 줄과 낱말표를 준다
    const ops = (await api('get', '/ops').expect(200)).body;
    const row = ops.complaints.find((c: { id: number }) => c.id === made.id);
    expect(row).toMatchObject({ severityLabel: '심각', overdueDays: 2, dueOn: plus(TODAY, -2) });
    expect(ops.cplAreas.map((a: { key: string }) => a.key)).toEqual(['lesson', 'intake', 'book', 'schedule', 'teacher']);
    expect(ops.cplSeverities.map((a: { label: string }) => a.label)).toEqual(['가벼움', '보통', '심각']);

    // J-101 — 담당 없이 대응 409 · 결과 없이 마무리 409 · 빈 patch 409
    const bare = (await api('post', '/ops/complaints').send({ area: 'book', body: '교체 시험 — 담당 없음' }).expect(201)).body;
    cplIds.push(bare.id);
    expect((await api('patch', `/ops/complaints/${bare.id}`).send({}).expect(409)).body.code).toBe('EMPTY_PATCH');
    expect((await api('patch', `/ops/complaints/${bare.id}`).send({ stage: 'acting' }).expect(409)).body.code).toBe('CPL_OWNER_REQUIRED');
    const acting = (await api('patch', `/ops/complaints/${bare.id}`).send({ stage: 'acting', ownerId: ADMIN, action: '통화 완료' }).expect(200)).body;
    expect(acting).toMatchObject({ stage: 'acting', ownerName: '교체관리자', action: '통화 완료' });
    expect((await api('patch', `/ops/complaints/${bare.id}`).send({ stage: 'closed' }).expect(409)).body.code).toBe('CPL_RESULT_REQUIRED');
    const closed = (await api('patch', `/ops/complaints/${made.id}`).send({ stage: 'closed', ownerId: ADMIN, result: '재배치 완료' }).expect(200)).body;
    // 마무리한 건은 기한이 지났어도 「N일 지남」을 세지 않는다
    expect(closed).toMatchObject({ stage: 'closed', result: '재배치 완료', overdueDays: 0 });
    expect((await api('patch', `/ops/complaints/9999999`).send({ action: 'x' }).expect(404)).body.code).toBe('CPL_NOT_FOUND');
    const logs = await q<{ action: string }>(`SELECT action FROM log WHERE actor_id = $1 AND entity = 'CPL' ORDER BY id`, [CEO]);
    expect(logs.map((l) => l.action)).toEqual(['create', 'create', 'create', 'update', 'update']);
  });

  /* ── ② J-97 · F-62 · D-46 ─────────────────────────────────────────────── */
  it('컴플레인의 강사 교체는 그 학생의 규칙만 그 날부터 가른다 — 회차·리포트·안내 초안·학부모 안내·알림·cpl 도장이 한 트랜잭션 · 미리보기는 쓰기 0 · 퇴사는 나머지 전부 (J-97 · F-62 · D-46)', async () => {
    const s1 = await makeSeries('WEEKLY:MO,WE', 600, T_A, [STU1, STU2], '교체 S1');
    const s2 = await makeSeries('WEEKLY:FR', 600, T_A, [STU2], '교체 S2');
    const cpl = (await api('post', '/ops/complaints').send({ area: 'teacher', studentId: STU1, body: '교체 시험 — 강사를 바꿔 주세요' }).expect(201)).body;
    cplIds.push(cpl.id);

    await api('post', '/ops/teacher-change/preview', teacherToken).send({ fromTeacherId: T_A, toTeacherId: T_B, mode: 'from', date: MON2 }).expect(403);
    expect((await api('post', '/ops/teacher-change').send({ fromTeacherId: T_A, toTeacherId: T_A, mode: 'from', date: MON2 }).expect(400)).body.code).toBe('SAME_TEACHER');
    expect((await api('post', '/ops/teacher-change').send({ fromTeacherId: 999999, toTeacherId: T_B, mode: 'from', date: MON2 }).expect(404)).body.code).toBe('STAFF_NOT_FOUND');

    // 미리보기 — 컴플레인의 학생(STU1)이 있는 S1 만 · 아무것도 쓰지 않는다
    const pre = (await api('post', '/ops/teacher-change/preview').send({ fromTeacherId: T_A, toTeacherId: T_B, mode: 'from', date: MON2, cplId: cpl.id }).expect(201)).body;
    expect(pre.preview).toBe(true);
    expect(pre.series.map((s: { serId: number }) => s.serId)).toEqual([s1]);
    expect(pre.series[0]).toMatchObject({ students: ['교체학생1', '교체학생2'], firstOn: MON2, ruleLabel: '매주 월·수' });
    expect(pre.series[0].newSerId).toBeGreaterThan(0);
    expect(pre.guideDrafts).toBe(2);
    expect(pre.parentNotices).toBe(2);
    expect(pre.steps.map((s: { key: string }) => s.key)).toEqual(['schedule', 'guide', 'parent', 'book', 'payout', 'notify']);
    expect(pre.cpl).toMatchObject({ id: cpl.id, stage: 'acting', teacherChanged: true });
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM ser WHERE id = ANY($1)`, [serIds]))[0]!.n).toBe(2);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM guide WHERE student_id = ANY($1)`, [[STU1, STU2]]))[0]!.n).toBe(0);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM pnoti WHERE student_id = ANY($1)`, [[STU1, STU2]]))[0]!.n).toBe(0);
    expect((await q<{ t: boolean; stage: string }>(`SELECT teacher_changed AS t, stage FROM cpl WHERE id = $1`, [cpl.id]))[0]).toEqual({ t: false, stage: 'received' });
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM ser_occ WHERE ser_id = $1 AND teacher_id = $2`, [s1, T_B]))[0]!.n).toBe(0);

    // 실제 — 규칙이 갈린다 (D-R16): 옛 규칙은 전날까지 · 새 규칙은 새 강사
    const r = (await api('post', '/ops/teacher-change').send({ fromTeacherId: T_A, toTeacherId: T_B, mode: 'from', date: MON2, cplId: cpl.id, memo: '학부모 요청' }).expect(201)).body;
    expect(r.preview).toBe(false);
    const newId = Number(r.series[0].newSerId);
    serIds.push(newId);
    const [old] = await q<{ to_date: string; teacher_id: string }>(`SELECT to_char(to_date,'YYYY-MM-DD') AS to_date, teacher_id FROM ser WHERE id = $1`, [s1]);
    expect(old).toEqual({ to_date: plus(MON2, -1), teacher_id: String(T_A) });
    const [fresh] = await q<{ from_date: string; teacher_id: string }>(`SELECT to_char(from_date,'YYYY-MM-DD') AS from_date, teacher_id FROM ser WHERE id = $1`, [newId]);
    expect(fresh).toEqual({ from_date: MON2, teacher_id: String(T_B) });
    // 명단이 따라간다 · 첫 주(MON1)는 A 그대로, MON2 부터 B · 리포트(미작성)도 B
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM ser_stu WHERE ser_id = $1`, [newId]))[0]!.n).toBe(2);
    expect((await q<{ t: string }>(`SELECT teacher_id AS t FROM ser_occ WHERE ser_id = $1 AND on_date = $2::date`, [s1, MON1]))[0]!.t).toBe(String(T_A));
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM ser_occ WHERE ser_id = $1 AND teacher_id = $2 AND NOT canceled`, [newId, T_B]))[0]!.n).toBe(r.occurrences);
    expect((await q<{ t: string }>(`SELECT teacher_id AS t FROM rep WHERE ser_id = $1 AND on_date = $2::date`, [newId, MON2]))[0]!.t).toBe(String(T_B));
    // F-62 — 학생마다 강사 교체 초안 하나 · 학부모 안내 행 하나(보낼 것 · sent_at null)
    const guides = await q<{ student_id: string; reason: string; teacher_id: string; event_on: string }>(`SELECT student_id, reason, teacher_id, to_char(event_on,'YYYY-MM-DD') AS event_on FROM guide WHERE ser_id = $1 ORDER BY student_id`, [newId]);
    expect(guides).toEqual([
      { student_id: String(STU1), reason: 'teacher_change', teacher_id: String(T_B), event_on: MON2 },
      { student_id: String(STU2), reason: 'teacher_change', teacher_id: String(T_B), event_on: MON2 },
    ]);
    const pn = await q<{ body: string; sent_at: string | null; audience: string }>(`SELECT body, sent_at, audience FROM pnoti WHERE ser_id = $1 ORDER BY student_id`, [newId]);
    expect(pn).toHaveLength(2);
    expect(pn[0]!.body).toContain(`강사 교체 안내 — ${+MON2.slice(5, 7)}/${+MON2.slice(8, 10)}부터 교체 과목 수업은 교체B 선생님이 맡습니다 · 학부모 요청`);
    expect(pn[0]!).toMatchObject({ sent_at: null, audience: 'parent' });
    // §45 누락 판정 — 갈라진 새 규칙의 첫 회차가 「첫 수업」으로 잡히지 않는다 (강사 교체 안내가 그 자리를 채운다)
    const history = (await api('get', `/guides/history?span=week&anchor=${MON2}`).expect(200)).body;
    expect(history.missing.filter((x: { serId: number }) => x.serId === newId)).toEqual([]);
    // 알림 — 새 강사 · 원래 강사 · 관리자(본인·강사 둘 제외)
    expect(r.notifiedTeachers).toBe(2);
    const toB = await q<{ body: string; link: string }>(`SELECT body, link FROM noti WHERE to_id = $1 AND from_id = $2`, [T_B, CEO]);
    expect(toB).toHaveLength(1);
    expect(toB[0]!.body).toContain('강사 교체 — 교체 과목 (교체학생1 · 교체학생2)');
    expect(toB[0]!.link).toBe(`/schedule?date=${MON2}`);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM noti WHERE to_id = $1 AND from_id = $2 AND body LIKE '담당 이관%'`, [T_A, CEO]))[0]!.n).toBe(1);
    expect(r.notifiedStaff).toBeGreaterThanOrEqual(1);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM noti WHERE to_id = $1 AND from_id = $2 AND body LIKE '강사 교체 — 교체A → 교체B%'`, [ADMIN, CEO]))[0]!.n).toBe(1);
    // 컴플레인 도장 — teacher_changed · 접수 → 대응 · 담당은 돌린 사람
    expect((await q<{ t: boolean; stage: string; owner_id: string; action: string }>(`SELECT teacher_changed AS t, stage, owner_id, action FROM cpl WHERE id = $1`, [cpl.id]))[0]).toMatchObject({ t: true, stage: 'acting', owner_id: String(CEO) });
    expect(r.payout.map((p: { month: string }) => p.month)).toContain(MON2.slice(0, 7));
    expect(r.payout.every((p: { fromConfirmed: boolean; toConfirmed: boolean }) => !p.fromConfirmed && !p.toConfirmed)).toBe(true);
    expect(r.steps[0]).toMatchObject({ key: 'schedule', label: '스케줄', count: r.occurrences });
    expect(r.steps[1]).toMatchObject({ key: 'guide', count: 2 });
    expect(r.steps[5].note).toContain('새 강사 교체B · 원래 강사 교체A');

    // D-46 — 학생 없이 그 강사의 나머지 전부 (S2) · 두 번째는 바꿀 것이 없다
    const all = (await api('post', '/ops/teacher-change').send({ fromTeacherId: T_A, toTeacherId: T_B, mode: 'from', date: MON2 }).expect(201)).body;
    expect(all.series.map((s: { serId: number }) => s.serId)).toEqual([s2]);
    serIds.push(Number(all.series[0].newSerId));
    expect(all.cpl).toBeNull();
    expect((await api('post', '/ops/teacher-change').send({ fromTeacherId: T_A, toTeacherId: T_B, mode: 'from', date: MON2 }).expect(400)).body.code).toBe('NOTHING_TO_CHANGE');
  });

  /* ── ③ N-132 · D-45 ───────────────────────────────────────────────────── */
  it('그날만 대강은 회차 예외 하나다 — 다음 회차는 원래 강사 · 정산 시트에서 그날만 대강에게 간다 · 새 강사가 그 시각에 바쁘면 409 로 아무것도 남지 않는다 (N-132 · D-45)', async () => {
    const s3 = await makeSeries('WEEKLY:TH', 900, T_A, [STU1], '교체 S3');
    const s4 = await makeSeries('WEEKLY:TH', 900, T_B, [STU2], '교체 S4 (B 의 같은 시각)');
    expect(s4).toBeGreaterThan(0);

    // B 는 그 시각에 제 수업이 있다 → EXCLUDE 409 · 예외 0 · 안내 0
    const busy = await api('post', '/ops/teacher-change').send({ fromTeacherId: T_A, toTeacherId: T_B, mode: 'day', date: THU1, serIds: [s3] }).expect(409);
    expect(busy.body.code).toBe('RESOURCE_CONFLICT');
    expect(busy.body.message).toContain(`같은 시간에 강사·강의실·줌이 이미 잡혀 있습니다 — 교체 과목 · ${+THU1.slice(5, 7)}/${+THU1.slice(8, 10)} 15:00–16:00 · 교체B`);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM exc WHERE ser_id = $1`, [s3]))[0]!.n).toBe(0);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM pnoti WHERE ser_id = $1`, [s3]))[0]!.n).toBe(0);
    expect((await api('post', '/ops/teacher-change').send({ fromTeacherId: T_A, toTeacherId: ADMIN, mode: 'day', date: plus(THU1, 2) }).expect(400)).body.code).toBe('NOTHING_TO_CHANGE'); // 토요일 — A 의 수업이 없다

    // 관리자가 대강 — 그날 하나만
    const r = (await api('post', '/ops/teacher-change').send({ fromTeacherId: T_A, toTeacherId: ADMIN, mode: 'day', date: THU1 }).expect(201)).body;
    expect(r.series).toHaveLength(1);
    expect(r.series[0]).toMatchObject({ serId: s3, newSerId: null, occurrences: 1, firstOn: THU1 });
    expect(r.occurrences).toBe(1);
    const exc = await q<{ teacher_id: string; teacher_set: boolean }>(`SELECT teacher_id, teacher_set FROM exc WHERE ser_id = $1`, [s3]);
    expect(exc).toEqual([{ teacher_id: String(ADMIN), teacher_set: true }]);
    expect((await q<{ t: string }>(`SELECT teacher_id AS t FROM ser_occ WHERE ser_id = $1 AND on_date = $2::date`, [s3, THU1]))[0]!.t).toBe(String(ADMIN));
    expect((await q<{ t: string }>(`SELECT teacher_id AS t FROM ser_occ WHERE ser_id = $1 AND on_date = $2::date`, [s3, THU2]))[0]!.t).toBe(String(T_A));
    // 안내 초안 · 학부모 안내 — 그날 것 하나
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM guide WHERE ser_id = $1 AND reason = 'teacher_change' AND event_on = $2::date`, [s3, THU1]))[0]!.n).toBe(1);
    expect((await q<{ body: string }>(`SELECT body FROM pnoti WHERE ser_id = $1`, [s3]))[0]!.body).toContain('강사 대강 안내');
    // D-45 — 정산 시트: 그날은 대강에게, 원래 강사 시트에는 없다 (같은 함수 lib/payout-sheet)
    const month = THU1.slice(0, 7);
    const adminSheet = await payoutSheet(ds, ADMIN, month, TODAY, 0);
    const aSheet = await payoutSheet(ds, T_A, month, TODAY, 0);
    expect(adminSheet.lessons.some((l) => l.serId === s3 && l.onDate === THU1)).toBe(true);
    expect(aSheet.lessons.some((l) => l.serId === s3 && l.onDate === THU1)).toBe(false);
    expect(aSheet.lessons.some((l) => l.serId === s3 && l.onDate === THU2)).toBe(true);
    expect(r.payout).toEqual([{ month, occurrences: 1, fromConfirmed: false, toConfirmed: false }]);
    expect(r.steps[0].note).toContain('이날만 대강');
  });
});
