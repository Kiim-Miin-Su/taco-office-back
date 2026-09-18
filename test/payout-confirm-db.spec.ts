/** @file-guide
 * 목적: payout-confirm-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 강사료 시트 · 지급 확정 — C94-b (테스트 시나리오 H-82 「강사 정산 시트 · 미작성분이 포함되면 실패 · 휴강이 잡히면 실패」 ·
 * O-148 「지급 확정은 대표만 · 누가 언제」 · D-43 「미작성 리포트가 정산에서 빠지고 얼마가 빠지는지 보인다」).
 *
 * 증명하는 것 —
 *   ① 시트는 **리포트를 쓴 회차만** 센다 — 미작성은 빠지고 빠진 금액이 따로 서며, 휴강은 시수에도 금액에도 안 든다.
 *      리포트 대상이 아닌 종류(자습)는 쓴 것도 안 쓴 것도 아니다(`na`) — 정산에 안 들고 「미작성」으로 재촉되지도 않는다.
 *   ② 강사 화면(§57 `GET /teacher/history`)과 대표 시트가 **같은 수**를 말한다 — `lib/payout-sheet` 한 곳.
 *   ③ 확정은 대표만(금액 예외 매니저 403) · 끝나지 않은 달 400 · 시급 없는 수업 409 · 쓴 수업 0 이면 409 · 없는 강사 404.
 *   ④ 확정은 payout 행을 굳히고(초안이 있으면 덮는다) 누가·언제를 남긴다 · LOG · 두 번은 409 · 강사 화면이 「확정」으로 읽는다.
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
import type { PayoutSheetDto, PayoutSheetRowDto } from '../src/modules/accounting/accounting.dto';
import { withholding } from '../src/lib/rules';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('강사료 시트 · 지급 확정 (C94-b · H-82 · O-148 · D-43)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let managerToken = '';
  let teacherToken = '';
  let teacher2Token = '';
  const PW = 'payout-confirm-1234';
  const CEO = 971;
  const TEACHER = 972; // 시급 40,000
  const MANAGER = 973; // can_money 예외 — 시트는 보지만 확정은 못 한다
  const TEACHER2 = 974; // 시급 없음 → 확정 불가
  const STU = 9971;
  const RATE = 40000;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const monthOf = (iso: string) => iso.slice(0, 7);
  /** 지난달 첫 월요일 — 투영 지평선(90일 뒤로)이 지난달을 덮으므로 회차가 실제로 선다 */
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

    const ids = [CEO, TEACHER, MANAGER, TEACHER2];
    await q(`DELETE FROM payout WHERE staff_id = ANY($1)`, [ids]);
    await q(`DELETE FROM wage WHERE staff_id = ANY($1)`, [ids]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active, can_money) VALUES
         ($1,'정산대표','po-ceo@t.kr','ceo',$5,true,null),
         ($2,'정산강사','po-t@t.kr','teacher',$5,true,null),
         ($3,'정산매니저','po-m@t.kr','manager',$5,true,true),
         ($4,'무시급강사','po-t2@t.kr','teacher',$5,true,null)`,
      [CEO, TEACHER, MANAGER, TEACHER2, hash],
    );
    await q(`INSERT INTO wage (staff_id, rate, from_date, reason) VALUES ($1, $2, '2026-01-01', '정산 테스트')`, [TEACHER, RATE]);
    await q(`DELETE FROM stu WHERE id = $1`, [STU]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'정산학생','10')`, [STU]);
    const login = async (email: string) => {
      const res = await request(app.getHttpServer())
        .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    token = await login('po-ceo@t.kr');
    managerToken = await login('po-m@t.kr');
    teacherToken = await login('po-t@t.kr');
    teacher2Token = await login('po-t2@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        const ids = [CEO, TEACHER, MANAGER, TEACHER2];
        await q(`DELETE FROM payout WHERE staff_id = ANY($1)`, [ids]);
        await q(`DELETE FROM wage WHERE staff_id = ANY($1)`, [ids]);
        await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
        await q(`DELETE FROM stu WHERE id = $1`, [STU]);
      }
    } finally {
      await app?.close();
    }
  });

  const made: number[] = [];
  afterEach(async () => {
    await q(`DELETE FROM payout WHERE staff_id = ANY($1)`, [[TEACHER, TEACHER2, MANAGER]]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, MANAGER, TEACHER, TEACHER2]]);
    if (!made.length) return;
    await q(`DELETE FROM noti WHERE from_id = ANY($1)`, [[CEO, TEACHER, TEACHER2]]);
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

  /** 지난달 ONCE 수업 60분 — 시각을 갈라 같은 강사의 겹침을 피한다 */
  async function lesson(teacherId: number, startMin: number, onDate = PREV_MON, kindKey = 'class') {
    const res = await api('post', '/schedule').send({
      kindKey, subKey: null, mode: 'offline', fromDate: onDate, rrule: 'ONCE',
      startMin, endMin: startMin + 60, teacherId, roomId: null, title: '정산 수업', studentIds: [STU],
    }).expect(201);
    const id = res.body.serIds[0] as number;
    made.push(id);
    return id;
  }
  const BODY = { content: '이번 수업에서 다룬 내용을 사실대로 적는다', progress: '교재 12쪽까지', homework: '13~14쪽 풀어 오기' };
  const submit = (serId: number, t: string, onDate = PREV_MON) => api('post', `/reports/${serId}/${onDate}/submit`, t).send(BODY);
  const sheet = async (month: string, t = token): Promise<PayoutSheetDto> =>
    (await api('get', `/accounting/payouts?month=${month}`, t).expect(200)).body as PayoutSheetDto;
  const rowOf = (s: PayoutSheetDto, staffId: number): PayoutSheetRowDto | undefined => s.rows.find((r) => r.staffId === staffId);
  const confirm = (month: string, staffId: number, t = token) => api('post', `/accounting/payouts/${month}/confirm`, t).send({ staffId });

  /** 지난달 한 강사의 네 갈래 — 쓴 것 · 안 쓴 것 · 휴강 · 리포트 대상 아닌 자습(시드 KIND `study` 는 rep=false) */
  async function threeLessons() {
    const written = await lesson(TEACHER, 540);
    const unwritten = await lesson(TEACHER, 660);
    const canceled = await lesson(TEACHER, 780);
    const study = await lesson(TEACHER, 900, PREV_MON, 'study');
    await submit(written, teacherToken).expect(201);
    await api('delete', `/schedule/${canceled}`).send({ scope: 'this', onDate: PREV_MON, cancelKind: 'holiday', cancelTreat: 'carry' }).expect(200);
    return { written, unwritten, canceled, study };
  }

  /* ── ① ② 시트 ─────────────────────────────────────────────────────────── */
  it('시트는 리포트를 쓴 회차만 센다 — 미작성은 빠지고 빠진 금액이 서며, 휴강은 시수에도 금액에도 없다 · 강사 화면과 같은 수 (H-82 · D-43)', async () => {
    await threeLessons();
    const s = await sheet(PREV);
    expect(s).toMatchObject({ month: PREV, monthEnded: true, canSeeAmounts: true });
    const row = rowOf(s, TEACHER)!;
    expect(row).toMatchObject({
      staffName: '정산강사', yearMonth: PREV,
      writtenCount: 1, writtenMinutes: 60,
      unwrittenCount: 1, unwrittenMinutes: 60,
      canceledCount: 1, naCount: 1, noRateCount: 0,
      gross: RATE, unwrittenAmount: RATE,
      saved: false, savedDiffers: false, savedNet: null, confirmed: false, confirmedAt: null, confirmedBy: null,
      canConfirm: true,
    });
    // 지난달 수업의 리포트를 오늘 냈다 — 4시간 넘게 늦어 최고 구간 차감. 세금은 `withholding` 한 곳
    expect(row.lateCut).toBeGreaterThan(0);
    const base = row.gross! - row.lateCut!;
    const tax = withholding(base);
    expect(row).toMatchObject({ incomeTax: tax.income, localTax: tax.local, net: base - tax.total });
    // 머리 — 미작성 합은 줄의 합
    expect(s.unwrittenCount).toBe(s.rows.reduce((n, r) => n + r.unwrittenCount, 0));
    expect(s.netTotal).toBe(s.rows.reduce((n, r) => n + (r.net ?? 0), 0));

    // 강사 화면이 같은 수를 말한다 — 세는 곳이 하나다
    const h = (await api('get', `/teacher/history?month=${PREV}`, teacherToken).expect(200)).body;
    expect(h.stats).toMatchObject({ writtenCount: 1, writtenMinutes: 60, unwrittenCount: 1, unwrittenMinutes: 60 });
    expect(h.settlement).toMatchObject({ saved: false, confirmed: false, gross: row.gross, lateCut: row.lateCut, net: row.net, unwrittenAmount: RATE });
    expect(h.lessons.filter((l: { canceled: boolean }) => l.canceled)).toHaveLength(1);
    // 자습은 `na` — 미작성 재촉(penaltyIfNow)도 금액도 없다
    const study = h.lessons.find((l: { kindKey: string }) => l.kindKey === 'study');
    expect(study).toMatchObject({ repState: 'na', pay: null, penaltyIfNow: null });

    // 금액 예외 매니저 — 시트는 보지만 확정 단추는 서지 않는다
    const asManager = await sheet(PREV, managerToken);
    expect(asManager.canSeeAmounts).toBe(true);
    expect(rowOf(asManager, TEACHER)).toMatchObject({ net: row.net, canConfirm: false });

    // 이번 달은 아직 끝나지 않았다 — 단추가 서지 않는다
    const cur = await sheet(THIS);
    expect(cur.monthEnded).toBe(false);
    expect(cur.rows.every((r) => r.canConfirm === false)).toBe(true);
    await api('get', '/accounting/payouts?month=2026-13').expect(400);
  });

  /* ── ③ 거절 ───────────────────────────────────────────────────────────── */
  it('확정은 대표만 · 끝나지 않은 달 400 · 시급 없는 수업 409 · 쓴 수업 0 이면 409 · 없는 강사 404 (O-148)', async () => {
    await threeLessons();
    const t2 = await lesson(TEACHER2, 540);
    await submit(t2, teacher2Token).expect(201);

    await confirm(PREV, TEACHER, managerToken).expect(403);
    const open = await confirm(THIS, TEACHER).expect(400);
    expect(open.body.code).toBe('PAYOUT_MONTH_OPEN');
    const noRate = await confirm(PREV, TEACHER2).expect(409);
    expect(noRate.body.code).toBe('PAYOUT_NO_RATE');
    expect(rowOf(await sheet(PREV), TEACHER2)).toMatchObject({ writtenCount: 1, noRateCount: 1, gross: 0, canConfirm: false });
    const nothing = await confirm(PREV, MANAGER).expect(409);
    expect(nothing.body.code).toBe('PAYOUT_NOTHING');
    await confirm(PREV, 99999999).expect(404);
    await confirm('2026-13', TEACHER).expect(400);
    await api('post', `/accounting/payouts/${PREV}/confirm`).send({ staffId: 'x' }).expect(400);
    // 아무것도 굳지 않았다
    expect(await q(`SELECT id FROM payout WHERE staff_id = ANY($1)`, [[TEACHER, TEACHER2, MANAGER]])).toEqual([]);
    expect(await q(`SELECT id FROM log WHERE entity = 'PAYOUT' AND actor_id = $1`, [CEO])).toEqual([]);
  });

  /* ── ④ 확정 ───────────────────────────────────────────────────────────── */
  it('확정은 시트를 payout 행으로 굳히고(초안은 덮는다) 누가·언제·LOG 를 남긴다 — 두 번은 409 · 강사 화면이 「확정」으로 읽는다 (O-148)', async () => {
    await threeLessons();
    // 손으로 남긴 초안이 있다 — 시트가 「저장값 다름」을 말하고, 확정이 그것을 덮는다
    await q(`INSERT INTO payout (staff_id, year_month, hours, gross, net, state) VALUES ($1, $2, 9.99, 1, 1, 'draft')`, [TEACHER, PREV]);
    const before = rowOf(await sheet(PREV), TEACHER)!;
    expect(before).toMatchObject({ saved: true, savedDiffers: true, savedNet: 1, confirmed: false, canConfirm: true });

    const res = await confirm(PREV, TEACHER).expect(201);
    expect(res.body).toMatchObject({
      staffId: TEACHER, yearMonth: PREV, writtenCount: 1, unwrittenCount: 1, canceledCount: 1,
      gross: before.gross, lateCut: before.lateCut, net: before.net,
      saved: true, savedDiffers: false, savedNet: before.net, confirmed: true, confirmedBy: '정산대표', canConfirm: false,
    });
    expect(typeof res.body.confirmedAt).toBe('string');

    const [po] = await q<{ hours: string; gross: number; late_rep_cut: number; net: number; state: string; confirmed_by: string }>(
      `SELECT hours, gross, late_rep_cut, net, state, confirmed_by FROM payout WHERE staff_id = $1 AND year_month = $2`, [TEACHER, PREV],
    );
    expect(po).toMatchObject({ hours: '1.00', gross: before.gross, late_rep_cut: before.lateCut, net: before.net, state: 'confirmed' });
    expect(Number(po!.confirmed_by)).toBe(CEO);
    const logs = await q<{ action: string; before: { net: number } | null; after: { written: number; unwritten: number; canceled: number; net: number } }>(
      `SELECT action, before, after FROM log WHERE entity = 'PAYOUT' AND actor_id = $1 ORDER BY id`, [CEO],
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'confirm', before: { net: 1 }, after: { written: 1, unwritten: 1, canceled: 1, na: 1, net: before.net } });

    const twice = await confirm(PREV, TEACHER).expect(409);
    expect(twice.body.code).toBe('PAYOUT_ALREADY_CONFIRMED');
    expect(rowOf(await sheet(PREV), TEACHER)).toMatchObject({ confirmed: true, canConfirm: false });

    // 강사 화면 — 저장값이 정본이고 「확정」으로 읽는다
    const h = (await api('get', `/teacher/history?month=${PREV}`, teacherToken).expect(200)).body;
    expect(h.settlement).toMatchObject({ saved: true, confirmed: true, net: before.net, writtenMinutes: 60 });
  });
});
