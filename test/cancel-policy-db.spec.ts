/** @file-guide
 * 목적: cancel-policy-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 휴강의 사유·처리 — C92-a (테스트 시나리오 C-30 ~ C-33 · M-125).
 *
 * 증명하는 것 —
 *   ① 사유·처리·메모가 EXC 에 내려앉고 목록이 그 낱말을 돌려준다 (D-R18).
 *   ② **차감은 학생 결석에만** — 학원 사정·강사 결강은 400 이고 DB CHECK 도 같은 말을 한다 (이중 방어).
 *   ③ 처리만 보내고 사유를 빼면 400 — 반쪽 기록은 나중에 못 읽는다.
 *   ④ 향후·모두에는 사유·처리를 붙일 수 없다 — 그것은 수업 종료다.
 *   ⑤ 알림 두 건이 **같은 트랜잭션**에 남는다 — 결강은 강사·관리자에게, 이월은 대표에게 (M-125).
 *   ⑥ 「그날 전체 휴강」은 한 트랜잭션이고 이미 휴강인 회차는 건너뛰어 센다 (C-33).
 *   ⑦ 강사(canCrudAll 없음)는 그날 전체 휴강을 못 한다 (D-R39).
 *   ⑧ 학원 사정 휴강은 강사 정산에서 빠진다 — 취소 회차는 리포트가 없고 정산은 리포트를 쓴 수업만 센다 (C-32).
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
import { ATTENDANCE_CANCEL_REASON_LABEL, CANCEL_TREAT_LABEL } from '../src/lib/rules';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('휴강 사유·처리 (C92-a · C-30~C-33 · M-125)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let teacherToken = '';
  const PW = 'cancel-policy-1234';
  /** 시드·다른 스위트와 안 부딪히게 높은 번호대를 쓴다 */
  const CEO = 931;
  const TEACHER = 932;
  const MANAGER = 933;
  const STU_A = 9931;
  const STU_B = 9932;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER, MANAGER]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER, MANAGER]]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'휴강대표','cancel-ceo@t.kr','ceo',$4,true),
         ($2,'휴강강사','cancel-t@t.kr','teacher',$4,true),
         ($3,'휴강매니저','cancel-m@t.kr','manager',$4,true)`,
      [CEO, TEACHER, MANAGER, hash],
    );
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B]]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'휴강학생A','10'), ($2,'휴강학생B','10')`, [STU_A, STU_B]);
    const login = async (email: string) => {
      const res = await request(app.getHttpServer())
        .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    token = await login('cancel-ceo@t.kr');
    teacherToken = await login('cancel-t@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER, MANAGER]]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER, MANAGER]]);
        await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B]]);
      }
    } finally {
      await app?.close();
    }
  });

  const made: number[] = [];
  afterEach(async () => {
    if (!made.length) return;
    await q(`DELETE FROM noti WHERE link LIKE '/schedule?date=%' AND from_id = $1`, [CEO]);
    await q(`DELETE FROM noti WHERE link LIKE '/accounting?tab=tuition%' AND from_id = $1`, [CEO]);
    await q(`DELETE FROM log WHERE actor_id = $1`, [CEO]);
    // class 종류는 투영이 리포트 초안을 함께 만든다 — 규칙을 지우면 초안도 치운다 (schedule-write.spec 과 같다)
    await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [made]);
    await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id = ANY($1))`, [made]);
    await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser WHERE id = ANY($1)`, [made]);
    made.length = 0;
  });

  const api = (m: 'post' | 'patch' | 'delete' | 'get', p: string, t = token) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`)
      .timeout({ response: 5000, deadline: 10000 });

  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const nextMon = (iso: string) => {
    let d0 = iso;
    for (let i = 0; i < 7; i++) {
      if (new Date(`${d0}T00:00:00Z`).getUTCDay() === 1) return d0;
      d0 = plus(d0, 1);
    }
    return d0;
  };

  /** 이 스위트의 강사가 맡는 월요일 수업 하나. 시간대를 갈라 겹침 제약을 피한다 */
  async function makeSer(startMin: number, over: Partial<Record<string, unknown>> = {}) {
    const from = nextMon(plus(kst(), 7));
    const res = await api('post', '/schedule')
      .send({
        kindKey: 'class', subKey: null, mode: 'offline',
        fromDate: from, rrule: 'WEEKLY:MO',
        startMin, endMin: startMin + 60, teacherId: TEACHER, roomId: null,
        title: '휴강 테스트', studentIds: [STU_A], ...over,
      })
      .expect(201);
    const id = res.body.serIds[0] as number;
    made.push(id);
    return { id, from };
  }

  const excOf = (id: number) =>
    q<{ canceled: boolean; cancel_kind: string | null; cancel_treat: string | null; reason: string | null }>(
      `SELECT canceled, cancel_kind, cancel_treat, reason FROM exc WHERE ser_id = $1 ORDER BY on_date`, [id],
    );

  const notisTo = (staffId: number, likeLink: string) =>
    q<{ body: string; link: string; category: string }>(
      `SELECT body, link, category FROM noti WHERE to_id = $1 AND from_id = $2 AND link LIKE $3 ORDER BY id`,
      [staffId, CEO, likeLink],
    );

  /* ── ① 저장과 낱말 ─────────────────────────────────────────────────── */

  it('사유·처리·메모가 EXC 에 내려앉고 목록이 낱말을 돌려준다 (C-30 · D-R18)', async () => {
    const { id, from } = await makeSer(600);
    await api('delete', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, cancelKind: 'student_absent', cancelTreat: 'carry', memo: '  아침에 발열로 연락  ' })
      .expect(200);
    expect(await excOf(id)).toEqual([
      { canceled: true, cancel_kind: 'student_absent', cancel_treat: 'carry', reason: '아침에 발열로 연락' },
    ]);
    const list = await api('get', '/schedule/occurrences').query({ from, to: from }).expect(200);
    const row = (list.body.items as Array<Record<string, unknown>>).find((x) => x.serId === id);
    expect(row).toMatchObject({
      canceled: true,
      cancelKind: 'student_absent', cancelKindLabel: ATTENDANCE_CANCEL_REASON_LABEL.student_absent,
      cancelTreat: 'carry', cancelTreatLabel: CANCEL_TREAT_LABEL.carry,
    });
  });

  it('처리를 비우면 이월이 기본이다 — 사유만 보내도 「이월」로 적힌다', async () => {
    const { id, from } = await makeSer(600);
    await api('delete', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, cancelKind: 'holiday' })
      .expect(200);
    expect(await excOf(id)).toEqual([{ canceled: true, cancel_kind: 'holiday', cancel_treat: 'carry', reason: null }]);
  });

  it('둘 다 비우면 옛 방식 그대로다 — 취소만 되고 사유·처리는 null (기존 행 보정 0 · N-25)', async () => {
    const { id, from } = await makeSer(600);
    await api('delete', `/schedule/${id}`).send({ scope: 'this', onDate: from }).expect(200);
    expect(await excOf(id)).toEqual([{ canceled: true, cancel_kind: null, cancel_treat: null, reason: null }]);
  });

  /* ── ② · ③ · ④ 거절 ────────────────────────────────────────────────── */

  it('**차감은 학생 결석에만** — 학원 사정·강사 결강·공휴일·기타를 차감하면 400 이고 저장 0 (C-32)', async () => {
    const { id, from } = await makeSer(600);
    for (const kind of ['academy', 'teacher_absent', 'holiday', 'other']) {
      const res = await api('delete', `/schedule/${id}`)
        .send({ scope: 'this', onDate: from, cancelKind: kind, cancelTreat: 'deduct' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CANCEL_DEDUCT_FORBIDDEN');
    }
    expect(await excOf(id)).toEqual([]);
  });

  it('DB CHECK 가 같은 말을 한다 — 우회 INSERT 로 학원 사정 차감을 넣으면 exc_cancel_policy 가 막는다', async () => {
    const { id, from } = await makeSer(600);
    await expect(q(
      `INSERT INTO exc (ser_id, on_date, canceled, cancel_kind, cancel_treat, at)
       VALUES ($1, $2::date, true, 'academy', 'deduct', now())`, [id, from],
    )).rejects.toThrow(/exc_cancel_policy/);
    // 취소가 아닌 회차에 처리를 붙이는 것도 막는다 — 이월인지 차감인지는 휴강에만 있는 물음이다
    await expect(q(
      `INSERT INTO exc (ser_id, on_date, canceled, cancel_kind, cancel_treat, at)
       VALUES ($1, $2::date, false, 'student_absent', 'carry', now())`, [id, from],
    )).rejects.toThrow(/exc_cancel_policy/);
    // 낱말 밖의 값도 막는다
    await expect(q(
      `INSERT INTO exc (ser_id, on_date, canceled, cancel_kind, cancel_treat, at)
       VALUES ($1, $2::date, true, 'weather', 'carry', now())`, [id, from],
    )).rejects.toThrow(/exc_cancel_policy/);
  });

  it('처리만 보내고 사유를 빼면 400 CANCEL_REASON_REQUIRED', async () => {
    const { id, from } = await makeSer(600);
    const res = await api('delete', `/schedule/${id}`).send({ scope: 'this', onDate: from, cancelTreat: 'carry' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANCEL_REASON_REQUIRED');
    expect(await excOf(id)).toEqual([]);
  });

  it('낱말 밖의 사유·처리는 DTO 에서 400 이다', async () => {
    const { id, from } = await makeSer(600);
    await api('delete', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, cancelKind: 'weather', cancelTreat: 'carry' }).expect(400);
    await api('delete', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, cancelKind: 'holiday', cancelTreat: 'refund' }).expect(400);
    expect(await excOf(id)).toEqual([]);
  });

  it('향후·모두에는 사유·처리를 붙일 수 없다 — 그것은 수업 종료다 (CANCEL_SCOPE)', async () => {
    const { id, from } = await makeSer(600);
    for (const scope of ['future', 'all']) {
      const res = await api('delete', `/schedule/${id}`)
        .send({ scope, onDate: from, cancelKind: 'holiday', cancelTreat: 'carry' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CANCEL_SCOPE');
    }
    expect(await q(`SELECT id FROM ser WHERE id = $1`, [id])).toHaveLength(1);
  });

  /* ── ⑤ 알림 두 건 (M-125) ───────────────────────────────────────────── */

  it('이월이면 알림 두 건 — 결강은 강사·관리자에게, 이월은 대표에게 (M-125 · 같은 트랜잭션)', async () => {
    const { id, from } = await makeSer(600);
    await api('delete', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, cancelKind: 'student_absent', cancelTreat: 'carry' })
      .expect(200);
    // 강사에게 결강 통보 — 본인 수업이다
    const toTeacher = await notisTo(TEACHER, '/schedule?date=%');
    expect(toTeacher).toHaveLength(1);
    expect(toTeacher[0]).toMatchObject({ link: `/schedule?date=${from}`, category: 'schedule' });
    expect(toTeacher[0].body).toContain('휴강학생A');
    expect(toTeacher[0].body).toContain(CANCEL_TREAT_LABEL.carry);
    // 관리자(매니저)에게도 결강 통보 — 강사가 아닌 활성 직원 전원
    expect(await notisTo(MANAGER, '/schedule?date=%')).toHaveLength(1);
    // 이월은 대표에게만 — 회계 링크로. 매니저·강사에게는 안 간다
    const carryToCeo = await q<{ body: string; link: string }>(
      `SELECT body, link FROM noti WHERE to_id = $1 AND link LIKE '/accounting?tab=tuition%'`, [CEO],
    );
    // 행위자 본인(대표)이 처리했으므로 본인에게는 가지 않는다 — 다른 대표가 없으면 0 이 맞다
    expect(carryToCeo).toHaveLength(0);
    expect(await notisTo(MANAGER, '/accounting?tab=tuition%')).toHaveLength(0);
    expect(await notisTo(TEACHER, '/accounting?tab=tuition%')).toHaveLength(0);
  });

  it('차감이면 이월 알림은 없다 — 결강 통보만 (C-31 「이월이 생기면 실패」)', async () => {
    const { id, from } = await makeSer(600);
    await api('delete', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, cancelKind: 'student_absent', cancelTreat: 'deduct' })
      .expect(200);
    expect(await excOf(id)).toEqual([{ canceled: true, cancel_kind: 'student_absent', cancel_treat: 'deduct', reason: null }]);
    const toTeacher = await notisTo(TEACHER, '/schedule?date=%');
    expect(toTeacher).toHaveLength(1);
    expect(toTeacher[0].body).toContain(CANCEL_TREAT_LABEL.deduct);
    expect(await q(`SELECT 1 FROM noti WHERE link LIKE '/accounting?tab=tuition%' AND from_id = $1`, [CEO])).toHaveLength(0);
  });

  it('이월 알림은 대표에게 간다 — 매니저가 처리하면 대표가 받는다', async () => {
    const { id, from } = await makeSer(600);
    const managerToken = (await request(app.getHttpServer())
      .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
      .send({ email: 'cancel-m@t.kr', password: PW }).expect(201)).body.accessToken as string;
    await api('delete', `/schedule/${id}`, managerToken)
      .send({ scope: 'this', onDate: from, cancelKind: 'student_absent', cancelTreat: 'carry' })
      .expect(200);
    const toCeo = await q<{ body: string; link: string }>(
      `SELECT body, link FROM noti WHERE to_id = $1 AND from_id = $2 AND link LIKE '/accounting?tab=tuition%'`,
      [CEO, MANAGER],
    );
    expect(toCeo).toHaveLength(1);
    expect(toCeo[0].link).toBe(`/accounting?tab=tuition&month=${from.slice(0, 7)}`);
    expect(toCeo[0].body).toContain('이월 1회 발생');
    await q(`DELETE FROM noti WHERE from_id = $1`, [MANAGER]);
  });

  /* ── ⑥ · ⑦ 그날 전체 휴강 (C-33) ──────────────────────────────────── */

  it('그날 전체 휴강 — 모든 회차가 한 트랜잭션에 접히고 이미 휴강인 회차는 건너뛰어 센다 (C-33)', async () => {
    const a = await makeSer(600);
    const b = await makeSer(720);
    const c = await makeSer(840, { studentIds: [STU_B] });
    // 하나는 미리 휴강해 둔다
    await api('delete', `/schedule/${a.id}`).send({ scope: 'this', onDate: a.from, cancelKind: 'holiday' }).expect(200);

    const res = await api('post', '/schedule/day-cancel')
      .send({ date: a.from, cancelKind: 'holiday', cancelTreat: 'carry', memo: '추석' })
      .expect(201);
    expect(res.body).toMatchObject({ count: 2, skipped: 1 });
    // serIds 는 「화면이 다시 읽을 범위」라 건너뛴 규칙도 든다 — 접힌 둘은 반드시 든다
    expect(res.body.serIds).toEqual(expect.arrayContaining([b.id, c.id]));

    for (const s of [b, c]) {
      expect(await excOf(s.id)).toEqual([{ canceled: true, cancel_kind: 'holiday', cancel_treat: 'carry', reason: '추석' }]);
    }
    // 미리 접어 둔 것은 두 번 접히지 않는다 — 메모도 그대로 null
    expect(await excOf(a.id)).toEqual([{ canceled: true, cancel_kind: 'holiday', cancel_treat: 'carry', reason: null }]);
    // 투영도 셋 다 취소다 — 「일부만 처리되면 실패」
    const occ = await q<{ ser_id: string; canceled: boolean }>(
      `SELECT ser_id, canceled FROM ser_occ WHERE ser_id = ANY($1) AND on_date = $2::date ORDER BY ser_id`,
      [[a.id, b.id, c.id], a.from],
    );
    expect(occ.map((o) => o.canceled)).toEqual([true, true, true]);
  });

  it('그날 전체 휴강에 회차가 없으면 404 이고, 차감으로는 접을 수 없다 (전체 결석은 학생 결석이 아니다)', async () => {
    const { from } = await makeSer(600);
    // 투영 호라이즌(+180일) 밖 — 시드 수업이 어느 요일에 있든 회차가 없는 날이다
    const empty = plus(kst(), 200);
    const none = await api('post', '/schedule/day-cancel').send({ date: empty, cancelKind: 'holiday' });
    expect(none.status).toBe(404);
    expect(none.body.code).toBe('NO_OCCURRENCES');
    const deduct = await api('post', '/schedule/day-cancel').send({ date: from, cancelKind: 'academy', cancelTreat: 'deduct' });
    expect(deduct.status).toBe(400);
    expect(deduct.body.code).toBe('CANCEL_DEDUCT_FORBIDDEN');
  });

  it('강사는 그날 전체 휴강을 못 한다 — 403 (D-R39)', async () => {
    const { from } = await makeSer(600);
    await api('post', '/schedule/day-cancel', teacherToken)
      .send({ date: from, cancelKind: 'holiday', cancelTreat: 'carry' }).expect(403);
  });

  /* ── ⑧ 강사 정산 (C-32) ───────────────────────────────────────────── */

  it('학원 사정 휴강은 강사 정산에서 빠진다 — 취소 회차는 「한 수업」이 아니다 (C-32)', async () => {
    const { id, from } = await makeSer(600);
    await api('delete', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, cancelKind: 'academy', cancelTreat: 'carry' })
      .expect(200);
    const hist = await api('get', '/teacher/history', teacherToken).query({ month: from.slice(0, 7) }).expect(200);
    const row = (hist.body.lessons as Array<{ serId: number; onDate: string; canceled: boolean; pay: number | null }>)
      .find((r) => r.serId === id && r.onDate === from);
    expect(row).toBeDefined();
    expect(row!.canceled).toBe(true);
    expect(row!.pay ?? 0).toBe(0);
  });
});
