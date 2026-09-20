/** @file-guide
 * 목적: month-close-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 월 마감 — C92-d (테스트 시나리오 C-39 「월 마감」 · L-123 「마감 후 과거 수정」 · N-140 「마감 후 잘못 발견」).
 *
 * 증명하는 것 —
 *   ① 대표가 지난달을 마감하면 §54 가 `close` 를 주고 단추 판정(`canClose/canReopen`)이 뒤집힌다. 두 번은 409, 미래 달은 400.
 *   ② **마감 달의 회차·휴강·출결·청구서·이월·휴원 쓰기가 전부 409 `MONTH_CLOSED`** — 새 규칙 · 이번만 고치기 · 휴강 ·
 *      그날 전체 · 그날만 빼기 · 규칙 전체 시각 변경(투영이 지난 달을 다시 쓴다) · 출결 · 청구서 발행 · 이월 처리 · 휴원.
 *   ③ 같은 규칙이라도 **열린 달의 회차**만 바뀌는 쓰기는 통과한다 — 마감은 달을 잠그지 규칙을 잠그지 않는다.
 *   ④ 해제는 대표 전용 · 사유 필수 · 행이 남는다(`reopened_*`) · 해제 뒤 같은 쓰기가 통과한다 · 다시 마감하면 새 행.
 *   ⑤ 금액 예외로 회계를 열어 준 매니저도 마감·해제는 못 한다 (`canCeoCloseMonth`).
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

/** 기한 자체를 보지 않는 시험들이 쓰는 값 — 「기한을 매번 고른다」는 S3 회귀가 따로 본다 (대표 결정 2026-09-20) */
const DUE = '2026-12-31';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('월 마감 (C92-d · C-39 · L-123 · N-140)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let managerToken = '';
  let teacherToken = '';
  let noMoneyToken = '';
  const PW = 'month-close-1234';
  const CEO = 951;
  const TEACHER = 952;
  const MANAGER = 953;
  const NOMONEY = 954;   // 매니저인데 can_money=false 예외 — 회계 자체가 닫힌다
  const STU_A = 9951;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;

  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const monthOf = (iso: string) => iso.slice(0, 7);
  /** 지난달 첫 월요일 — 투영 지평선(90일 뒤)이 지난달을 덮으므로 회차가 실제로 선다 */
  const prevMonthMonday = () => {
    const first = `${plus(`${monthOf(kst())}-01`, -1).slice(0, 7)}-01`;
    let d0 = first;
    for (let i = 0; i < 7; i++) {
      if (new Date(`${d0}T00:00:00Z`).getUTCDay() === 1) return d0;
      d0 = plus(d0, 1);
    }
    return d0;
  };
  const PREV_MON = prevMonthMonday();
  const PREV = monthOf(PREV_MON);
  const THIS = monthOf(kst());

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await q(`DELETE FROM month_close WHERE closed_by = ANY($1)`, [[CEO, MANAGER, NOMONEY]]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER, MANAGER, NOMONEY]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER, MANAGER, NOMONEY]]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active, can_money) VALUES
         ($1,'마감대표','close-ceo@t.kr','ceo',$5,true,null),
         ($2,'마감강사','close-t@t.kr','teacher',$5,true,null),
         ($3,'마감매니저','close-m@t.kr','manager',$5,true,true),
         ($4,'금액없는매니저','close-nm@t.kr','manager',$5,true,false)`,
      [CEO, TEACHER, MANAGER, NOMONEY, hash],
    );
    await q(`DELETE FROM stu WHERE id = $1`, [STU_A]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'마감학생','10')`, [STU_A]);
    const login = async (email: string) => {
      const res = await request(app.getHttpServer())
        .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    token = await login('close-ceo@t.kr');
    managerToken = await login('close-m@t.kr');
    teacherToken = await login('close-t@t.kr');
    noMoneyToken = await login('close-nm@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await q(`DELETE FROM month_close WHERE closed_by = ANY($1)`, [[CEO, MANAGER, NOMONEY]]);
        await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, MANAGER, NOMONEY]]);
        await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, TEACHER, MANAGER, NOMONEY]]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER, MANAGER, NOMONEY]]);
        await q(`DELETE FROM stu WHERE id = $1`, [STU_A]);
      }
    } finally {
      await app?.close();
    }
  });

  const made: number[] = [];
  afterEach(async () => {
    await q(`DELETE FROM month_close WHERE closed_by = ANY($1)`, [[CEO, MANAGER, NOMONEY]]);
    await q(`DELETE FROM stu_pause WHERE student_id = $1`, [STU_A]);
    await q(`DELETE FROM carry WHERE student_id = $1`, [STU_A]);
    await q(`DELETE FROM pay WHERE inv_id IN (SELECT id FROM inv WHERE student_id = $1)`, [STU_A]);
    await q(`DELETE FROM inv_line WHERE inv_id IN (SELECT id FROM inv WHERE student_id = $1)`, [STU_A]);
    await q(`DELETE FROM inv WHERE student_id = $1`, [STU_A]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, MANAGER, NOMONEY]]);
    if (!made.length) return;
    await q(`DELETE FROM noti WHERE from_id = $1`, [CEO]);
    await q(`DELETE FROM att WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [made]);
    await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id = ANY($1))`, [made]);
    await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [made]);
    await q(`DELETE FROM ser WHERE id = ANY($1)`, [made]);
    made.length = 0;
  });

  const api = (m: 'post' | 'patch' | 'delete' | 'get' | 'put', p: string, t = token) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`)
      .timeout({ response: 8000, deadline: 15000 });

  /** 지난달 첫 월요일부터 주간 — 지난달과 이번 달 양쪽에 회차가 선다. 시간대를 갈라 겹침 제약을 피한다 */
  async function makeWeekly(startMin: number, rrule = 'WEEKLY:MO') {
    const res = await api('post', '/schedule')
      .send({
        kindKey: 'class', subKey: null, mode: 'offline',
        fromDate: PREV_MON, rrule,
        startMin, endMin: startMin + 60, teacherId: TEACHER, roomId: null,
        title: '마감 테스트', studentIds: [STU_A],
      })
      .expect(201);
    const id = res.body.serIds[0] as number;
    made.push(id);
    const occ = await q<{ on_date: string }>(
      `SELECT to_char(on_date,'YYYY-MM-DD') AS on_date FROM ser_occ WHERE ser_id = $1 ORDER BY on_date`, [id],
    );
    const inPrev = occ.map((o) => o.on_date).filter((x) => x.startsWith(PREV));
    /**
     * **이번 달 회차는 지난 날짜도 센다** — 이 스위트가 묻는 것은 「그 달이 열려 있는가」이지
     * 「그 날이 아직 안 왔는가」가 아니다. 앞으로 올 날만 세면 **달 말일에 가까울수록 회차가 줄어**
     * 21일에는 남은 월요일이 하나뿐이라 시험이 달력 때문에 깨진다(2026-09-21 실측).
     */
    const inThis = occ.map((o) => o.on_date).filter((x) => x.startsWith(THIS));
    return { id, inPrev, inThis };
  }
  const close = (month: string, t = token) => api('post', '/accounting/tuition/close', t).send({ month });
  const reopen = (month: string, reason: string, t = token) => api('post', '/accounting/tuition/reopen', t).send({ month, reason });
  const tuition = async (month: string) => (await api('get', `/accounting/tuition?month=${month}`).expect(200)).body;

  /* ── ① 마감 · 단추 판정 ───────────────────────────────────────────────── */
  it('대표가 지난달을 마감하면 §54 가 close 를 주고 단추 판정이 뒤집힌다 — 두 번은 409 · 미래 달은 400', async () => {
    const before = await tuition(PREV);
    expect(before.close).toBeNull();
    expect(before.canClose).toBe(true);
    expect(before.canReopen).toBe(false);

    const res = await close(PREV).expect(201);
    expect(res.body).toMatchObject({ month: PREV, closedBy: '마감대표', reopenedAt: null, reopenReason: null });
    const after = await tuition(PREV);
    expect(after.close).toMatchObject({ id: res.body.id, month: PREV, closedBy: '마감대표' });
    expect(after.canClose).toBe(false);
    expect(after.canReopen).toBe(true);

    const twice = await close(PREV).expect(409);
    expect(twice.body.code).toBe('MONTH_ALREADY_CLOSED');
    const future = await close(monthOf(plus(kst(), 62))).expect(400);
    expect(future.body.code).toBe('MONTH_NOT_STARTED');
    // 이번 달은 열려 있다 — 마감은 달 하나만 잠근다
    const thisMonth = await tuition(THIS);
    expect(thisMonth.close).toBeNull();
    expect(thisMonth.canClose).toBe(true);
    await close('2026-13').expect(400);
  });

  /* ── ② 마감 달의 쓰기는 전부 409 ───────────────────────────────────────── */
  it('마감 달의 회차·휴강·그날 전체·그날만 빼기·규칙 전체 시각 변경·출결·청구서·이월·휴원이 409 MONTH_CLOSED 다 (L-123)', async () => {
    const ser = await makeWeekly(540);
    expect(ser.inPrev.length).toBeGreaterThan(0);
    const prevDate = ser.inPrev[0]!;
    // 마감 전 — 지난달 회차 하나를 휴강해 두고, 출결도 하나 남긴다 (마감 뒤 되돌리기가 막히는지 본다)
    await api('delete', `/schedule/${ser.id}`).send({ scope: 'this', onDate: ser.inPrev[1] ?? prevDate, cancelKind: 'student_absent', cancelTreat: 'carry' }).expect(200);
    await api('put', `/schedule/${ser.id}/${prevDate}/attendance`).send({ result: 'completed' }).expect(200);
    await close(PREV).expect(201);

    const expectClosed = async (res: request.Response, what: string) => {
      expect({ what, status: res.status, code: res.body?.code }).toEqual({ what, status: 409, code: 'MONTH_CLOSED' });
      expect(String(res.body.message)).toContain('마감');
    };
    // 새 규칙 — 마감 달에 회차가 생긴다
    await expectClosed(await api('post', '/schedule').send({
      kindKey: 'class', subKey: null, mode: 'offline', fromDate: prevDate, rrule: 'ONCE',
      startMin: 720, endMin: 780, teacherId: TEACHER, roomId: null, title: '마감 달 새 수업', studentIds: [STU_A],
    }), 'create');
    // 이번만 고치기
    await expectClosed(await api('patch', `/schedule/${ser.id}`).send({ scope: 'this', onDate: prevDate, startMin: 600, endMin: 660 }), 'patch this');
    // 휴강
    await expectClosed(await api('delete', `/schedule/${ser.id}`).send({ scope: 'this', onDate: prevDate, cancelKind: 'holiday', cancelTreat: 'carry' }), 'cancel');
    // 그날 전체
    await expectClosed(await api('post', '/schedule/day-cancel').send({ date: prevDate, cancelKind: 'holiday', cancelTreat: 'carry' }), 'day-cancel');
    // 그날만 빼기
    await expectClosed(await api('patch', `/schedule/${ser.id}/roster`).send({ op: 'dropOnce', onDate: prevDate, studentId: STU_A }), 'dropOnce');
    // 규칙 전체 시각 변경 — 투영이 지난 달 회차를 다시 쓴다
    await expectClosed(await api('patch', `/schedule/${ser.id}`).send({ scope: 'all', onDate: ser.inThis[0]!, startMin: 600, endMin: 660 }), 'patch all');
    // 반복 끝내기 — 마감 달 회차부터 끝내면 그 회차들이 사라진다
    await expectClosed(await api('delete', `/schedule/${ser.id}`).send({ scope: 'all', onDate: prevDate }), 'delete all');
    await expectClosed(await api('delete', `/schedule/${ser.id}`).send({ scope: 'future', onDate: ser.inPrev[ser.inPrev.length - 1]! }), 'delete future');
    // 출결 — 고치기도 지우기도
    await expectClosed(await api('put', `/schedule/${ser.id}/${prevDate}/attendance`).send({ result: 'canceled', reason: 'student_absent' }), 'attendance');
    await expectClosed(await api('delete', `/schedule/${ser.id}/${prevDate}/attendance`), 'attendance clear');
    // 청구서 발행 · 이월 처리
    await expectClosed(await api('post', '/accounting/invoices').send({ studentId: STU_A, yearMonth: PREV, invType: 'tuition', dueOn: DUE }), 'invoice');
    await expectClosed(await api('post', '/accounting/tuition/carry').send({ studentId: STU_A, month: PREV }), 'carry');
    // 휴원 — 기간이 마감 달에 걸친다
    await expectClosed(await api('post', `/schedule/students/${STU_A}/pause`).send({ fromDate: prevDate }), 'pause');
    await expectClosed(await api('post', `/schedule/students/${STU_A}/pause`).send({ fromDate: plus(`${PREV}-01`, -10), toDate: prevDate }), 'pause range');

    // 아무것도 안 바뀌었다 — 회차·예외·출결이 그대로다
    const [{ n }] = await q<{ n: string }>(`SELECT count(*) AS n FROM exc WHERE ser_id = $1`, [ser.id]);
    expect(Number(n)).toBe(1);
    const [att] = await q<{ result: string }>(`SELECT result FROM att WHERE ser_id = $1 AND on_date = $2::date`, [ser.id, prevDate]);
    expect(att.result).toBe('completed');
    const [{ m }] = await q<{ m: string }>(`SELECT count(*) AS m FROM stu_pause WHERE student_id = $1`, [STU_A]);
    expect(Number(m)).toBe(0);
  });

  /* ── ③ 열린 달만 바꾸는 쓰기는 통과 ────────────────────────────────────── */
  it('마감은 달을 잠그지 규칙을 잠그지 않는다 — 같은 규칙의 이번 달 회차는 고칠 수 있다', async () => {
    const ser = await makeWeekly(600);
    await close(PREV).expect(201);
    const thisDate = ser.inThis[0]!;
    // 이번만 고치기 · 휴강 · 그날만 빼기 — 전부 이번 달 회차
    await api('patch', `/schedule/${ser.id}`).send({ scope: 'this', onDate: thisDate, startMin: 660, endMin: 720 }).expect(200);
    await api('patch', `/schedule/${ser.id}/roster`).send({ op: 'dropOnce', onDate: ser.inThis[1]!, studentId: STU_A }).expect(200);
    await api('delete', `/schedule/${ser.id}`).send({ scope: 'this', onDate: ser.inThis[2] ?? thisDate, cancelKind: 'student_absent', cancelTreat: 'carry' }).expect(200);
    // 향후 종료 — 이번 달부터 끝내는 것은 지난 달 회차를 건드리지 않는다
    await api('delete', `/schedule/${ser.id}`).send({ scope: 'future', onDate: thisDate }).expect(200);
    // 새 규칙도 이번 달이면 된다
    const res = await api('post', '/schedule').send({
      kindKey: 'class', subKey: null, mode: 'offline', fromDate: plus(kst(), 3), rrule: 'ONCE',
      startMin: 780, endMin: 840, teacherId: TEACHER, roomId: null, title: '이번 달 수업', studentIds: [STU_A],
    }).expect(201);
    made.push(res.body.serIds[0]);
    // 이번 달 휴원 · 이번 달 청구서
    await api('post', `/schedule/students/${STU_A}/pause`).send({ fromDate: `${THIS}-01`, toDate: `${THIS}-02` }).expect(201);
    // 지난달 회차는 그대로다
    const prevRows = await q<{ n: string }>(
      `SELECT count(*) AS n FROM ser_occ WHERE ser_id = $1 AND to_char(on_date,'YYYY-MM') = $2`, [ser.id, PREV],
    );
    expect(Number(prevRows[0]!.n)).toBe(ser.inPrev.length);
  });

  /* ── ④ 해제 — 대표 · 사유 · 흔적 ──────────────────────────────────────── */
  it('해제는 사유가 필수이고 행이 남는다 — 해제 뒤 같은 쓰기가 통과하고 다시 마감하면 새 행이 선다 (N-140)', async () => {
    const ser = await makeWeekly(660);
    const prevDate = ser.inPrev[0]!;
    const first = await close(PREV).expect(201);
    await expect(api('delete', `/schedule/${ser.id}`).send({ scope: 'this', onDate: prevDate, cancelKind: 'holiday', cancelTreat: 'carry' })).resolves.toMatchObject({ status: 409 });

    await reopen(PREV, '   ').expect(400);
    await reopen(THIS, '마감 안 된 달').expect(409);
    const r = await reopen(PREV, '8월 휴강 하나를 빠뜨렸다').expect(201);
    expect(r.body).toMatchObject({ id: first.body.id, month: PREV, reopenedBy: '마감대표', reopenReason: '8월 휴강 하나를 빠뜨렸다' });
    expect(typeof r.body.reopenedAt).toBe('string');
    const t = await tuition(PREV);
    expect(t.close).toBeNull();
    expect(t.canClose).toBe(true);
    // 해제 뒤 같은 쓰기가 된다
    await api('delete', `/schedule/${ser.id}`).send({ scope: 'this', onDate: prevDate, cancelKind: 'holiday', cancelTreat: 'carry' }).expect(200);
    // 다시 마감 — 새 행. 옛 행은 해제 기록으로 남는다
    const second = await close(PREV).expect(201);
    expect(second.body.id).not.toBe(first.body.id);
    const rows = await q<{ id: string; reopened_at: Date | null; reopen_reason: string | null }>(
      `SELECT id, reopened_at, reopen_reason FROM month_close WHERE year_month = $1 AND closed_by = $2 ORDER BY id`, [PREV, CEO],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.reopen_reason).toBe('8월 휴강 하나를 빠뜨렸다');
    expect(rows[0]!.reopened_at).not.toBeNull();
    expect(rows[1]!.reopened_at).toBeNull();
    const logs = await q<{ action: string }>(`SELECT action FROM log WHERE entity = 'MONTH_CLOSE' AND actor_id = $1 ORDER BY id`, [CEO]);
    expect(logs.map((l) => l.action)).toEqual(['close', 'reopen', 'close']);
  });

  /* ── ⑤ 권한 ───────────────────────────────────────────────────────────── */
  /**
   * ⭐ **대표 결정 2026-09-21 「우선은 매니저에게도 모든 권한」으로 이 자리의 역할 경계가 사라졌다.**
   * 원문 §76 은 「마감은 대표만」이라 적고 C92-d 가 그대로 새겼는데(`canCeoCloseMonth`), 지금은 그 판정이
   * `ceoGate`(= 강사가 아닌 사람)를 부른다. **막는 쪽이 옮겨 갔을 뿐 판정은 여전히 한 곳이다** —
   * 그래서 시험도 「누가 막히는가」만 바꾸고 「단추와 서버가 같은 답을 하는가」는 그대로 본다.
   * 되돌리려면 `perm.ts` 의 `ceoGate` 한 줄이고, 그때 이 시험은 다시 빨개진다.
   */
  it('⭐ 마감·해제는 이제 매니저도 한다 — 단추와 서버가 같은 답이다 (대표 결정 2026-09-21 · 원문은 「대표만」)', async () => {
    const t = await (await api('get', `/accounting/tuition?month=${PREV}`, managerToken).expect(200)).body;
    expect(t.canClose).toBe(true);
    const made = await close(PREV, managerToken).expect(201);
    expect(made.body).toMatchObject({ month: PREV, closedBy: '마감매니저' });

    const t2 = await (await api('get', `/accounting/tuition?month=${PREV}`, managerToken).expect(200)).body;
    expect(t2.canClose).toBe(false);
    expect(t2.canReopen).toBe(true);
    await reopen(PREV, '매니저가 해제한다', managerToken).expect(201);
  });

  it('남은 경계 둘 — 강사는 회계 자체가 닫히고, 금액 예외를 끈 매니저도 그대로 막힌다', async () => {
    // 강사 — 역할이 가른다 (`ceoGate` 의 `r !== \'teacher\'` · @Perm(canMoney) 가 먼저 잡는다)
    await api('get', `/accounting/tuition?month=${PREV}`, teacherToken).expect(403);
    await close(PREV, teacherToken).expect(403);
    // 사람별 예외 — 역할이 열려도 이 칸이 닫으면 못 한다
    await api('get', `/accounting/tuition?month=${PREV}`, noMoneyToken).expect(403);
    await close(PREV, noMoneyToken).expect(403);
    await reopen(PREV, '예외 매니저 시도', noMoneyToken).expect(403);
    // 아무것도 안 남았다
    const [{ n }] = await q<{ n: string }>(`SELECT count(*) AS n FROM month_close WHERE year_month = $1`, [PREV]);
    expect(Number(n)).toBe(0);
  });
});
