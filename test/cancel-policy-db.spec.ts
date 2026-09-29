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
 *   ⑩ 학원 사정 휴강 한 회차는 **학부모 안내 준비행**을 그 회차 명단 학생마다 같은 트랜잭션에 남긴다 (C-32 「학부모 안내가 생성된다」).
 *      다른 사유는 남기지 않는다 · 되돌리기는 안 보낸 준비행을 걷고 보낸 뒤에는 409 다 · 안내 이름은 서버가 준다.
 *
 * ⚠ 이 파일은 **표를 비우지 않는다.** 스위트 전용 번호대로 만들고 스스로 치운다.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource, QueryRunner } from 'typeorm';
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
  const madeNotices: number[] = [];

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
        .send({ loginId: email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    token = await login('cancel-ceo@t.kr');
    teacherToken = await login('cancel-t@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        if (madeNotices.length) await q(`DELETE FROM guardian_send WHERE pnoti_id = ANY($1::bigint[])`, [madeNotices]);
        if (madeNotices.length) await q(`DELETE FROM pnoti WHERE id = ANY($1::bigint[])`, [madeNotices]);
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
    if (madeNotices.length) {
      await q(`DELETE FROM guardian_send WHERE pnoti_id = ANY($1::bigint[])`, [madeNotices]);
      await q(`DELETE FROM pnoti WHERE id = ANY($1::bigint[])`, [madeNotices]);
      madeNotices.length = 0;
    }
    if (!made.length) return;
    await q(`DELETE FROM noti WHERE link LIKE '/schedule?date=%' AND from_id = $1`, [CEO]);
    await q(`DELETE FROM noti WHERE link LIKE '/accounting?tab=tuition%' AND from_id = $1`, [CEO]);
    await q(`DELETE FROM log WHERE actor_id = $1`, [CEO]);
    // 학원 사정 휴강은 그 회차에 학부모 안내 준비행을 남긴다(C-32) — 규칙을 지우기 전에 이 스위트 규칙의 안내를 치운다
    await q(`DELETE FROM guardian_send WHERE pnoti_id IN (SELECT id FROM pnoti WHERE ser_id = ANY($1))`, [made]);
    await q(`DELETE FROM pnoti WHERE ser_id = ANY($1)`, [made]);
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
      .send({ loginId: 'cancel-m@t.kr', password: PW }).expect(201)).body.accessToken as string;
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

    /**
     * **그날 전체 휴강은 학원 전체를 센다** — 이 스위트가 만든 셋만 세는 것이 아니다.
     * 그래서 기대값을 숫자로 박으면 **시드에 그날 휴강이 있는 주**에 깨진다(2026-09-21 실측:
     * 대상일 2026-09-28 에 시드 휴강 여섯 · `skipped` 가 1 이 아니라 7 이었다).
     * 그날의 실제 상태를 먼저 세어 견준다 — 보는 것은 「전부 접히고 이미 접힌 것은 건너뛴다」이지 숫자가 아니다.
     */
    const dayCount = async (where: string) => Number((await q<{ n: string }>(
      `SELECT count(*)::int AS n FROM ser_occ WHERE on_date = $1::date${where}`, [a.from],
    ))[0]!.n);
    const already = await dayCount(' AND canceled');
    const open = await dayCount(' AND NOT canceled');
    expect(open).toBeGreaterThanOrEqual(2); // b·c 는 아직 열려 있다

    const res = await api('post', '/schedule/day-cancel')
      .send({ date: a.from, cancelKind: 'holiday', cancelTreat: 'carry', memo: '추석' })
      .expect(201);
    madeNotices.push(...(res.body.parentNotices as Array<{ id: number }>).map((notice) => notice.id));
    expect(res.body).toMatchObject({ count: open, skipped: already });
    expect(res.body.parentNotices).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentId: STU_A, studentName: '휴강학생A', sentAt: null }),
      expect.objectContaining({ studentId: STU_B, studentName: '휴강학생B', sentAt: null }),
    ]));
    expect((res.body.parentNotices as Array<{ body: string }>).every((notice) => (
      notice.body.includes('[학원 전체 휴원]')
      && notice.body.includes(a.from)
      && notice.body.includes('공휴일')
      && notice.body.includes('차감하지 않고 이월')
    ))).toBe(true);

    // 응답을 잃고 같은 요청을 다시 보내도 안내 준비행을 새로 만들지 않고 기존 행을 복구해 돌려준다.
    const retried = await api('post', '/schedule/day-cancel')
      .send({ date: a.from, cancelKind: 'holiday', cancelTreat: 'carry', memo: '추석' })
      .expect(201);
    expect(retried.body).toMatchObject({ count: 0, skipped: open + already });
    expect((retried.body.parentNotices as Array<{ id: number }>).map((notice) => notice.id).sort())
      .toEqual([...madeNotices].sort());
    expect(await q<{ n: string }>(
      `SELECT count(*)::int AS n FROM pnoti WHERE id = ANY($1::bigint[])`, [madeNotices],
    )).toEqual([{ n: madeNotices.length }]);
    const resumed = await api('get', '/schedule/day-cancel/notices').query({ date: a.from }).expect(200);
    expect(resumed.body).toMatchObject({ date: a.from });
    expect((resumed.body.items as Array<{ id: number }>).map((notice) => notice.id).sort())
      .toEqual([...madeNotices].sort());
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

    // 그날 전체 휴강은 **시드 수업도** 접는다(학원 전체) — afterEach 는 이 스위트의 규칙만 치운다.
    // 시드가 투영 기간 전체에 회차를 두므로(N-49) 되돌리지 않으면 개발 DB 에 그날의 시드 휴강이 남는다 — 한 토큰으로 통째로 되돌린다(N-138)
    await api('post', '/schedule/undo').send({ token: res.body.undoToken }).expect(201);
    expect(await q(`SELECT id FROM pnoti WHERE id = ANY($1::bigint[])`, [madeNotices])).toEqual([]);
    madeNotices.length = 0;
  });

  it('그날 전체 휴강의 대상 조회와 취소 쓰기는 같은 트랜잭션·같은 연결이다 (N-133)', async () => {
    const { from } = await makeSer(660);
    const createRunner = ds.createQueryRunner.bind(ds);
    let targetRunner: QueryRunner | undefined;
    let writeRunner: QueryRunner | undefined;
    let tableLocked = false;
    const spy = jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
      const runner = createRunner(...args);
      const query = runner.query.bind(runner);
      jest.spyOn(runner, 'query').mockImplementation(async (sql: string, parameters?: unknown[], structured?: boolean) => {
        if (sql.startsWith('LOCK TABLE ser,')) {
          expect(runner.isTransactionActive).toBe(true);
          tableLocked = true;
        }
        if (sql.includes('SELECT DISTINCT ser_id FROM ser_occ')) {
          targetRunner = runner;
          expect(runner.isTransactionActive).toBe(true);
          expect(tableLocked).toBe(true);
        }
        if (sql.includes('INSERT INTO exc ') || sql.includes('UPDATE exc SET')) writeRunner ??= runner;
        return structured ? query(sql, parameters, true) : query(sql, parameters);
      });
      return runner;
    });
    try {
      const res = await api('post', '/schedule/day-cancel')
        .send({ date: from, cancelKind: 'academy', cancelTreat: 'carry' })
        .expect(201);
      expect(targetRunner).toBeDefined();
      expect(writeRunner).toBe(targetRunner);
      expect(tableLocked).toBe(true);
      await api('post', '/schedule/undo').send({ token: res.body.undoToken }).expect(201);
    } finally {
      spy.mockRestore();
    }
  });

  it('전일 휴원 안내 준비 뒤 오류가 나면 일정·직원 알림·학부모 안내를 모두 rollback 한다 (N-133)', async () => {
    const { id, from } = await makeSer(690);
    const beforeNoti = Number((await q<{ n: string }>(
      `SELECT count(*)::int AS n FROM noti WHERE link=$1`, [`/schedule?date=${from}`],
    ))[0]!.n);
    const createRunner = ds.createQueryRunner.bind(ds);
    const spy = jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
      const runner = createRunner(...args);
      const query = runner.query.bind(runner);
      jest.spyOn(runner, 'query').mockImplementation(async (sql: string, parameters?: unknown[], structured?: boolean) => {
        if (sql.includes('SELECT DISTINCT ON (p.student_id)')) throw new Error('forced day-cancel notice failure');
        return structured ? query(sql, parameters, true) : query(sql, parameters);
      });
      return runner;
    });
    try {
      await api('post', '/schedule/day-cancel')
        .send({ date: from, cancelKind: 'academy', cancelTreat: 'carry', memo: 'rollback' })
        .expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await excOf(id)).toEqual([]);
    expect(Number((await q<{ n: string }>(
      `SELECT count(*)::int AS n FROM noti WHERE link=$1`, [`/schedule?date=${from}`],
    ))[0]!.n)).toBe(beforeNoti);
    expect(await q(
      `SELECT id FROM pnoti WHERE on_date=$1::date AND body LIKE '[학원 전체 휴원]%'`, [from],
    )).toEqual([]);
  });

  it('전일 휴원 안내가 이미 전달됐으면 일정을 조용히 되살리지 않는다 (N-133)', async () => {
    const { from } = await makeSer(705);
    const res = await api('post', '/schedule/day-cancel')
      .send({ date: from, cancelKind: 'academy', cancelTreat: 'carry', memo: '발송 뒤 되돌리기' })
      .expect(201);
    const noticeIds = (res.body.parentNotices as Array<{ id: number }>).map((notice) => notice.id);
    madeNotices.push(...noticeIds);
    expect(noticeIds.length).toBeGreaterThan(0);
    await q(`UPDATE pnoti SET sent_at=now() WHERE id=$1`, [noticeIds[0]]);

    const blocked = await api('post', '/schedule/undo').send({ token: res.body.undoToken });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('UNDO_HAS_DELIVERY');

    // 테스트 격리: 미발송으로 되돌린 뒤 같은 토큰으로 정상 undo 한다.
    await q(`UPDATE pnoti SET sent_at=NULL WHERE id=$1`, [noticeIds[0]]);
    await api('post', '/schedule/undo').send({ token: res.body.undoToken }).expect(201);
    madeNotices.length = 0;
  });

  it('그날 전체 휴강에 회차가 없으면 404 이고, 차감으로는 접을 수 없다 (전체 결석은 학생 결석이 아니다)', async () => {
    const { id, from } = await makeSer(600);
    // 투영 호라이즌(+180일) 밖 — 시드 수업이 어느 요일에 있든 회차가 없는 날이다
    const empty = plus(kst(), 200);
    const none = await api('post', '/schedule/day-cancel').send({ date: empty, cancelKind: 'holiday' });
    expect(none.status).toBe(404);
    expect(none.body.code).toBe('NO_OCCURRENCES');
    const deduct = await api('post', '/schedule/day-cancel').send({ date: from, cancelKind: 'academy', cancelTreat: 'deduct' });
    expect(deduct.status).toBe(400);
    expect(deduct.body.code).toBe('CANCEL_DEDUCT_FORBIDDEN');
    // 단일 회차에서는 유효한 학생 결석+차감도 「학원 전체 휴원」에서는 절대 허용하지 않는다 (N-133 무차감).
    const disguised = await api('post', '/schedule/day-cancel')
      .send({ date: from, cancelKind: 'student_absent', cancelTreat: 'deduct' });
    expect(disguised.status).toBe(400);
    expect(disguised.body.code).toBe('DAY_CANCEL_DEDUCT_FORBIDDEN');
    expect(await excOf(id)).toEqual([]);
  });

  it('강사는 그날 전체 휴강을 못 한다 — 403 (D-R39)', async () => {
    const { from } = await makeSer(600);
    await api('post', '/schedule/day-cancel', teacherToken)
      .send({ date: from, cancelKind: 'holiday', cancelTreat: 'carry' }).expect(403);
    await api('get', '/schedule/day-cancel/notices', teacherToken).query({ date: from }).expect(403);
  });

  /* ── ⑨ 보강 이관 (C-34 · C92-b) ────────────────────────────────────── */

  it('보강 이관은 보강 회차(ONCE)를 같은 명단·강사로 만들고 원래 회차가 그것을 가리킨다 — 알림에 보강 날짜가 든다 (C-34)', async () => {
    const { id, from } = await makeSer(600);
    const makeupDate = plus(from, 3); // 목요일 — 이 스위트의 규칙은 월요일뿐이라 겹치지 않는다
    const res = await api('delete', `/schedule/${id}`)
      .send({
        scope: 'this', onDate: from, cancelKind: 'teacher_absent', cancelTreat: 'makeup',
        makeup: { date: makeupDate, startMin: 960, endMin: 1020 },
      })
      .expect(200);
    const madeId = (res.body.serIds as number[]).find((x) => x !== id)!;
    expect(madeId).toBeDefined();
    made.push(madeId);
    // 원래 회차 — 접혔고 보강을 가리킨다
    const exc = await q<{ canceled: boolean; cancel_treat: string; makeup_ser_id: string }>(
      `SELECT canceled, cancel_treat, makeup_ser_id FROM exc WHERE ser_id = $1`, [id],
    );
    expect(exc).toEqual([{ canceled: true, cancel_treat: 'makeup', makeup_ser_id: String(madeId) }]);
    // 보강 회차 — ONCE · 그 날짜 · 그 시각 · 같은 명단 · 같은 강사
    const [ser] = await q<Record<string, unknown>>(
      `SELECT rrule, to_char(from_date,'YYYY-MM-DD') AS from_date, to_char(to_date,'YYYY-MM-DD') AS to_date, start_min, end_min, teacher_id, kind_key
         FROM ser WHERE id = $1`, [madeId],
    );
    expect(ser).toMatchObject({ rrule: 'ONCE', from_date: makeupDate, to_date: makeupDate, start_min: 960, end_min: 1020, teacher_id: String(TEACHER), kind_key: 'class' });
    expect(await q(`SELECT student_id FROM ser_stu WHERE ser_id = $1`, [madeId])).toEqual([{ student_id: String(STU_A) }]);
    // 투영 — 원래 날짜에는 취소 행, 보강 날짜에는 산 행 하나
    const occs = await q<{ ser_id: string; on_date: string; canceled: boolean }>(
      `SELECT ser_id, to_char(on_date,'YYYY-MM-DD') AS on_date, canceled FROM ser_occ WHERE ser_id = ANY($1) AND on_date IN ($2::date, $3::date) ORDER BY on_date`,
      [[id, madeId], from, makeupDate],
    );
    expect(occs).toEqual([{ ser_id: String(id), on_date: from, canceled: true }, { ser_id: String(madeId), on_date: makeupDate, canceled: false }]);
    // 목록 — 원래 회차는 「보강 → 언제」, 보강 회차는 「어느 회차의 보강」
    const list = await api('get', '/schedule/occurrences').query({ from, to: makeupDate }).expect(200);
    const items = list.body.items as Array<Record<string, unknown>>;
    expect(items.find((x) => x.serId === id && x.onDate === from)).toMatchObject({
      canceled: true, cancelTreat: 'makeup', makeupSerId: madeId, makeupDate, makeupStartMin: 960,
    });
    expect(items.find((x) => x.serId === madeId)).toMatchObject({ canceled: false, makeupOfDate: from, recurring: false });
    // 알림 — 결강 통보에 보강 날짜·시각이 든다 · 이월 알림은 없다
    const toTeacher = await notisTo(TEACHER, '/schedule?date=%');
    expect(toTeacher).toHaveLength(1);
    expect(toTeacher[0].body).toContain(`보강 이관 → ${makeupDate} 16:00`);
    expect(await q(`SELECT 1 FROM noti WHERE link LIKE '/accounting?tab=tuition%' AND from_id = $1`, [CEO])).toHaveLength(0);
  });

  it('보강 이관에 보강 날짜가 없으면 400 · 같은 날이면 400 · 보강 날짜만 오고 처리가 다르면 400 · 그날 전체에는 못 쓴다', async () => {
    const { id, from } = await makeSer(600);
    const missing = await api('delete', `/schedule/${id}`).send({ scope: 'this', onDate: from, cancelKind: 'holiday', cancelTreat: 'makeup' });
    expect(missing.status).toBe(400); expect(missing.body.code).toBe('MAKEUP_REQUIRED');
    const sameDay = await api('delete', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, cancelKind: 'holiday', cancelTreat: 'makeup', makeup: { date: from, startMin: 900, endMin: 960 } });
    expect(sameDay.status).toBe(400); expect(sameDay.body.code).toBe('MAKEUP_SAME_DAY');
    const notMakeup = await api('delete', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, cancelKind: 'holiday', cancelTreat: 'carry', makeup: { date: plus(from, 1), startMin: 900, endMin: 960 } });
    expect(notMakeup.status).toBe(400); expect(notMakeup.body.code).toBe('MAKEUP_NOT_MAKEUP');
    const bulk = await api('post', '/schedule/day-cancel').send({ date: from, cancelKind: 'holiday', cancelTreat: 'makeup' });
    expect(bulk.status).toBe(400); expect(bulk.body.code).toBe('MAKEUP_NOT_BULK');
    expect(await excOf(id)).toEqual([]);
    expect(await q(`SELECT id FROM ser WHERE rrule = 'ONCE' AND title = '휴강 테스트'`)).toEqual([]);
  });

  it('보강 회차가 겹치면 통째로 되돌아간다 — 원래 회차도 접히지 않는다 (D-R43)', async () => {
    const a = await makeSer(600);
    const b = await makeSer(720);
    // b 의 다음 주 월요일 자리(12:00)에 a 의 보강을 놓는다 — 같은 강사라 EXCLUDE 가 막는다
    const res = await api('delete', `/schedule/${a.id}`)
      .send({ scope: 'this', onDate: a.from, cancelKind: 'teacher_absent', cancelTreat: 'makeup', makeup: { date: plus(b.from, 7), startMin: 720, endMin: 780 } });
    expect(res.status).toBe(409);
    expect(await excOf(a.id)).toEqual([]);
    expect(await q(`SELECT id FROM ser WHERE rrule = 'ONCE' AND title = '휴강 테스트'`)).toEqual([]);
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
  /* ── ⑩ 학원 사정 휴강의 학부모 안내 (C-32 · 운영 전 마감 4) ─────────────── */

  type Notice = { id: number; studentId: number; studentName: string; body: string; title: string; sentAt: string | null };
  const noticesOf = async (from: string) =>
    ((await api('get', '/schedule/day-cancel/notices').query({ date: from }).expect(200)).body.items as Notice[]);
  const pnotiOf = (id: number, from: string) =>
    q<{ id: string; student_id: string; body: string; sent_at: string | null }>(
      `SELECT id, student_id, body, sent_at FROM pnoti WHERE ser_id=$1 AND on_date=$2::date AND audience='parent' ORDER BY student_id`,
      [id, from],
    );

  it('학원 사정 휴강 한 회차 → 그 회차 명단 학생마다 학부모 안내 준비행 하나 · 이월 문장 · 보내지 않았다 (C-32)', async () => {
    const { id, from } = await makeSer(750, { studentIds: [STU_A, STU_B] });
    const res = await api('delete', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, cancelKind: 'academy', cancelTreat: 'carry', memo: '강의실 공사' })
      .expect(200);
    const rows = await pnotiOf(id, from);
    madeNotices.push(...rows.map((r) => Number(r.id)));
    expect(rows.map((r) => Number(r.student_id))).toEqual([STU_A, STU_B]);
    for (const r of rows) {
      expect(r.sent_at).toBeNull();
      expect(r.body.startsWith('[학원 사정 휴강]')).toBe(true);
      expect(r.body).toContain(from);
      expect(r.body).toContain('12:30');
      expect(r.body).toContain('차감하지 않고 이월');
      expect(r.body).toContain('강의실 공사');
    }
    // 화면이 읽는 자리 — 그날의 학부모 안내 목록에 이름과 함께 선다 (안내 이름은 서버 낱말)
    const listed = (await noticesOf(from)).filter((n) => rows.some((r) => Number(r.id) === n.id));
    expect(listed).toHaveLength(2);
    expect(listed.every((n) => n.title === '휴강 안내' && n.sentAt === null)).toBe(true);
    expect(listed.map((n) => n.studentName).sort()).toEqual(['휴강학생A', '휴강학생B']);

    // 되돌리기는 휴강과 **안 보낸** 준비행을 함께 걷는다
    await api('post', '/schedule/undo').send({ token: res.body.undoToken }).expect(201);
    expect(await pnotiOf(id, from)).toEqual([]);
    expect(await excOf(id)).toEqual([]);
    madeNotices.length = 0;
  });

  it('보강 이관이면 안내에 보강 날짜·시각이 든다 (C-32 · C-34)', async () => {
    const { id, from } = await makeSer(780);
    const makeupDate = plus(from, 2);
    const res = await api('delete', `/schedule/${id}`)
      .send({
        scope: 'this', onDate: from, cancelKind: 'academy', cancelTreat: 'makeup',
        makeup: { date: makeupDate, startMin: 1020, endMin: 1080 },
      })
      .expect(200);
    made.push(...(res.body.serIds as number[]).filter((x) => x !== id));
    const rows = await pnotiOf(id, from);
    madeNotices.push(...rows.map((r) => Number(r.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain(`보강 ${makeupDate} 17:00`);
    expect(rows[0].body).not.toContain('이월');
  });

  it('휴강 창이 읽는 코드표가 「안내를 남기는 사유」를 말한다 — 학원 사정만 true (C-32 · D-R39)', async () => {
    const meta = await api('get', '/meta').expect(200);
    const rows = meta.body.cancelReasons as Array<{ key: string; parentNotice: boolean }>;
    expect(rows.filter((r) => r.parentNotice).map((r) => r.key)).toEqual(['academy']);
  });

  it('학원 사정이 아닌 휴강은 학부모 안내를 만들지 않는다 — 원문은 학원 사정만 말한다 (D-R44)', async () => {
    for (const [i, kind] of (['student_absent', 'teacher_absent', 'holiday', 'other'] as const).entries()) {
      const { id, from } = await makeSer(800 + i * 70);
      await api('delete', `/schedule/${id}`)
        .send({ scope: 'this', onDate: from, cancelKind: kind, cancelTreat: 'carry' })
        .expect(200);
      expect(await pnotiOf(id, from)).toEqual([]);
    }
  });

  it('같은 휴강을 다시 보내도 준비행이 늘지 않는다 · 보낸 뒤에는 되돌리기가 409 다 (C-32)', async () => {
    const { id, from } = await makeSer(1110);
    const res = await api('delete', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, cancelKind: 'academy', cancelTreat: 'carry' })
      .expect(200);
    const again = await api('delete', `/schedule/${id}`)
      .send({ scope: 'this', onDate: from, cancelKind: 'academy', cancelTreat: 'carry' });
    expect([200, 404, 409]).toContain(again.status);
    const rows = await pnotiOf(id, from);
    madeNotices.push(...rows.map((r) => Number(r.id)));
    expect(rows).toHaveLength(1);
    await q(`UPDATE pnoti SET sent_at=now() WHERE id=$1`, [rows[0].id]);
    const blocked = await api('post', '/schedule/undo').send({ token: res.body.undoToken });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('UNDO_HAS_DELIVERY');
    await q(`UPDATE pnoti SET sent_at=NULL WHERE id=$1`, [rows[0].id]);
  });

  it('전일 휴원 안내의 이름은 「전일 휴원 안내」다 — 같은 목록이 두 갈래를 서버 낱말로 가른다 (N-133 · C-32)', async () => {
    const { from } = await makeSer(1170);
    const res = await api('post', '/schedule/day-cancel')
      .send({ date: from, cancelKind: 'holiday', cancelTreat: 'carry' })
      .expect(201);
    const mine = res.body.parentNotices as Notice[];
    madeNotices.push(...mine.map((n) => n.id));
    // 그날 전체 휴강은 시드 수업도 접는다 — 단언이 실패해도 되돌린다(안 그러면 그날의 시드가 휴강으로 남아 다른 스위트를 오염시킨다)
    try {
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((n) => n.title === '전일 휴원 안내')).toBe(true);
      const listed = (await noticesOf(from)).filter((n) => mine.some((m) => m.id === n.id));
      expect(listed.every((n) => n.title === '전일 휴원 안내')).toBe(true);
    } finally {
      await api('post', '/schedule/undo').send({ token: res.body.undoToken }).expect(201);
      madeNotices.length = 0;
    }
  });
});
