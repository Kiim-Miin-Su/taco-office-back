/** @file-guide
 * 목적: accounting-payout-w11-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * W11 M2 — 강사료 정산의 근거 줄 · 다음 달 보정 · 가산 · 회계 비공개 · 인수인계 메모 · 지출 감사/영수증 (HTTP + DB).
 *
 * 증명하는 것 —
 *   ① (N-36 ①) 지급 확정이 **회차마다 근거 줄**(시급 스냅숏 · 시수 · 금액 · 가산 · 차감)을 남기고, 확정된 달은 그 뒤 시급이
 *      바뀌어도 **굳은 값**을 읽는다(시트 · 상세 · 강사 히스토리 셋 다). 한 회차는 표에 한 번만 든다.
 *   ② (N-51) 확정된 달의 회차를 확정 뒤에 쓰면 그 달은 그대로 두고 **다음 미확정 달**에 「보정 · M월 회차」 줄로 얹힌다 —
 *      확정하면 보정 줄이 근거 줄(correction)로 남고 감사 `payout.correction` · 보정 승인 판정을 지난다.
 *      근거 줄이 없는 옛 확정 달은 **제출 시각 > 확정 시각**인 회차만 보정 대상이다.
 *   ③ (N-93) 가산 규칙은 새 줄로만 · 소급 없음 · 같은 날 409 — 그 규칙을 시트 · 상세 · 강사 히스토리 · 확정이 **한 함수**로 더한다.
 *   ④ (N-94) 비공개 스위치는 대표 판정 · 켜면 줄 금액은 비공개 열람(canHide) · 본인만 · 합계는 그대로.
 *   ⑤ (N-36 ②) 인수인계 메모 — 관리자 · 매니저만 더하고(고치기 · 지우기 없음) §79 카드와 그 학생을 맡은 강사의 안내 카드가 읽는다.
 *   ⑥ (N-73 · PB-12-5 · PB-26) 지출 심사 감사 줄 · 남의 영수증 403 · 같은 영수증 동시 등록은 하나만.
 *
 * ⚠ 이 파일은 표를 비우지 않는다 — 스위트 전용 번호로 만들고 스스로 치운다. 전역 설정(비공개 스위치 · 가산 규칙)은
 *   **한 시험 안에서만** 켜고 끝에 되돌린다(이웃 스위트가 같은 개발 DB 를 쓴다). 가산은 이 스위트 전용 수업 종류에만 건다.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AccountingService } from '../src/modules/accounting/accounting.service';
import type { PayoutDetailDto, PayoutSheetDto, PayoutSheetRowDto } from '../src/modules/accounting/accounting.dto';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(120_000);

d('W11 M2 강사료 정산 · 보정 · 가산 · 비공개 · 인수인계 (N-36 · N-51 · N-93 · N-94)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const tokens: Record<string, string> = {};
  const PW = 'w11-payout-1234';
  const CEO = 9261;
  const TEACHER = 9262; // 시급 40,000
  const MGR = 9263; // 매니저 · 비공개 열람 예외 끔(can_hide=false)
  const TMONEY = 9264; // 강사 · 금액 예외 켬(can_money=true) — 회계는 보지만 비공개 지정은 못 한다
  const TEACHER_B = 9265; // 시급 40,000 · 옛 확정 · 안내 격리
  const STU = 92611;
  const STU_B = 92612;
  const KIND = 'w11po'; // 이 스위트 전용 수업 종류 — 가산 규칙이 이웃 스위트의 시트에 닿지 않게
  const RATE = 40000;
  const STAFF = [CEO, TEACHER, MGR, TMONEY, TEACHER_B];

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const monthOf = (iso: string) => iso.slice(0, 7);
  const firstMonday = (month: string) => {
    let d0 = `${month}-01`;
    for (let i = 0; i < 7; i++) {
      if (new Date(`${d0}T00:00:00Z`).getUTCDay() === 1) return d0;
      d0 = plus(d0, 1);
    }
    return d0;
  };
  const THIS = monthOf(kst());
  const M2 = monthOf(plus(`${THIS}-01`, -1)); // 지난달
  const M1 = monthOf(plus(`${M2}-01`, -1)); // 지지난달
  const M2_MON = firstMonday(M2);
  const M1_MON = firstMonday(M1);
  const monthWord = (ym: string) => `${Number(ym.slice(5, 7))}월`;

  const api = (m: 'post' | 'patch' | 'delete' | 'get', p: string, t = tokens.ceo) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`).timeout({ response: 10000, deadline: 20000 });

  const made: number[] = [];
  async function lesson(teacherId: number, startMin: number, onDate: string, studentIds = [STU], kindKey = 'class') {
    const res = await api('post', '/schedule').send({
      kindKey, subKey: null, mode: 'offline', fromDate: onDate, rrule: 'ONCE',
      startMin, endMin: startMin + 60, teacherId, roomId: null, title: 'W11 정산 수업', studentIds,
    }).expect(201);
    const id = res.body.serIds[0] as number;
    made.push(id);
    return id;
  }
  const BODY = { content: '이번 수업에서 다룬 내용을 사실대로 적는다', progress: '교재 12쪽까지', homework: '13~14쪽 풀어 오기' };
  const submit = (serId: number, t: string, onDate: string) => api('post', `/reports/${serId}/${onDate}/submit`, t).send(BODY);
  const sheet = async (month: string, t = tokens.ceo): Promise<PayoutSheetDto> =>
    (await api('get', `/accounting/payouts?month=${month}`, t).expect(200)).body as PayoutSheetDto;
  const rowOf = (s: PayoutSheetDto, staffId: number): PayoutSheetRowDto => s.rows.find((r) => r.staffId === staffId)!;
  const detail = async (staffId: number, month: string, t = tokens.ceo): Promise<PayoutDetailDto> =>
    (await api('get', `/accounting/payouts/${staffId}?month=${month}`, t).expect(200)).body as PayoutDetailDto;
  const confirm = (month: string, staffId: number, t = tokens.ceo) => api('post', `/accounting/payouts/${month}/confirm`, t).send({ staffId });
  const history = async (month: string, t = tokens.teacher) => (await api('get', `/teacher/history?month=${month}`, t).expect(200)).body;

  async function cleanupWork() {
    // 스위치를 켠 사람 칸이 이 스위트의 계정을 가리키면 비운다(계정을 지울 수 있게) — 스위치 자체는 꺼 둔다
    await q(`UPDATE acct_privacy SET private = false, set_by = NULL, set_at = NULL WHERE set_by = ANY($1)`, [STAFF]);
    await q(`DELETE FROM payout_line WHERE payout_id IN (SELECT id FROM payout WHERE staff_id = ANY($1))`, [STAFF]);
    await q(`DELETE FROM payout WHERE staff_id = ANY($1)`, [STAFF]);
    await q(`DELETE FROM payout_bonus_rule WHERE set_by = ANY($1)`, [STAFF]);
    await q(`DELETE FROM note WHERE author_id = ANY($1)`, [STAFF]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [STAFF]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [STAFF]);
    if (made.length) {
      await q(`DELETE FROM att WHERE ser_id = ANY($1)`, [made]);
      await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [made]);
      await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [made]);
      await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [made]);
      await q(`DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id = ANY($1))`, [made]);
      await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [made]);
      await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [made]);
      await q(`DELETE FROM ser WHERE id = ANY($1)`, [made]);
      made.length = 0;
    }
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await cleanupWork();
    await q(`DELETE FROM expense WHERE requester_id = ANY($1) OR filed_by = ANY($1)`, [STAFF]);
    await q(`DELETE FROM file WHERE uploaded_by = ANY($1)`, [STAFF]);
    await q(`DELETE FROM wage WHERE staff_id = ANY($1)`, [STAFF]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [STAFF]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active, can_money, can_hide) VALUES
         ($1,'정산W11대표','w11po-ceo@t.kr','ceo',$6,true,null,null),
         ($2,'정산W11강사','w11po-t@t.kr','teacher',$6,true,null,null),
         ($3,'정산W11매니저','w11po-m@t.kr','manager',$6,true,null,false),
         ($4,'금액예외강사','w11po-tm@t.kr','teacher',$6,true,true,null),
         ($5,'옛확정강사','w11po-tb@t.kr','teacher',$6,true,null,null)`,
      [CEO, TEACHER, MGR, TMONEY, TEACHER_B, hash],
    );
    await q(`INSERT INTO wage (staff_id, rate, from_date, reason) VALUES ($1, $3, '2026-01-01', 'W11 정산'), ($2, $3, '2026-01-01', 'W11 정산')`, [TEACHER, TEACHER_B, RATE]);
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU, STU_B]]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'정산W11학생','10'), ($2,'정산W11둘째','10')`, [STU, STU_B]);
    await q(`INSERT INTO kind (key, name, color, cap, grp, rep) VALUES ($1, '정산 가산 시험', '#335577', 4, 'lesson', true) ON CONFLICT (key) DO NOTHING`, [KIND]);
    const login = async (email: string) => {
      const res = await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ loginId: email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    tokens.ceo = await login('w11po-ceo@t.kr');
    tokens.teacher = await login('w11po-t@t.kr');
    tokens.mgr = await login('w11po-m@t.kr');
    tokens.tmoney = await login('w11po-tm@t.kr');
    tokens.teacherB = await login('w11po-tb@t.kr');
  });

  afterEach(async () => {
    // 전역 스위치는 시험마다 꺼 둔다 — 이웃 스위트가 같은 DB 를 읽는다
    await q(`UPDATE acct_privacy SET private = false`);
    await cleanupWork();
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await cleanupWork();
        await q(`DELETE FROM expense WHERE requester_id = ANY($1) OR filed_by = ANY($1)`, [STAFF]);
        await q(`DELETE FROM file WHERE uploaded_by = ANY($1)`, [STAFF]);
        await q(`DELETE FROM wage WHERE staff_id = ANY($1)`, [STAFF]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [STAFF]);
        await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU, STU_B]]);
        await q(`DELETE FROM kind WHERE key = $1 AND NOT EXISTS (SELECT 1 FROM ser WHERE kind_key = $1)`, [KIND]);
      }
    } finally {
      await app?.close();
    }
  });

  /* ── ⓪ 수업 방식은 그날의 것 (W11 잔여 ② · lib/sql.effectiveModeOf) ─────── */
  it('⓪ 정산 시트의 수업 방식은 회차 예외(EXC.mode)가 있으면 그것이다 — 규칙의 방식을 그대로 옮기지 않는다', async () => {
    const s = await lesson(TEACHER, 540, M2_MON);
    await q(`INSERT INTO exc (ser_id, on_date, mode) VALUES ($1, $2::date, 'online') ON CONFLICT (ser_id, on_date) DO UPDATE SET mode = 'online'`, [s, M2_MON]);
    const h = await history(M2);
    expect(h.lessons.find((l: { serId: number }) => l.serId === s)).toMatchObject({ mode: 'online' });
  });

  /* ── ① 근거 줄 · 굳은 달 (N-36 ①) ─────────────────────────────────────── */
  it('① 지급 확정이 회차마다 근거 줄을 남기고, 확정된 달은 시급이 바뀌어도 굳은 값을 읽는다 — 시트 · 상세 · 강사 히스토리 셋 다', async () => {
    const written = await lesson(TEACHER, 540, M2_MON);
    await lesson(TEACHER, 660, M2_MON); // 미작성
    await submit(written, tokens.teacher, M2_MON).expect(201);
    const before = rowOf(await sheet(M2), TEACHER);
    expect(before).toMatchObject({ writtenCount: 1, unwrittenCount: 1, gross: RATE, correctionCount: 0, lateCount: 0, bonus: 0, canConfirm: true });

    const res = await confirm(M2, TEACHER).expect(201);
    expect(res.body).toMatchObject({ confirmed: true, net: before.net, gross: RATE });
    const lines = await q<{ ser_id: string; on_date: string; hours: string; unit_rate: number; amount: number; cut: number; bonus: number; correction: boolean }>(
      `SELECT l.ser_id, to_char(l.on_date,'YYYY-MM-DD') AS on_date, l.hours, l.unit_rate, l.amount, l.cut, l.bonus, l.correction
         FROM payout_line l JOIN payout p ON p.id = l.payout_id WHERE p.staff_id = $1 AND p.year_month = $2`, [TEACHER, M2],
    );
    expect(lines).toEqual([{ ser_id: String(written), on_date: M2_MON, hours: '1.00', unit_rate: RATE, amount: RATE, cut: before.lateCut, bonus: 0, correction: false }]);
    const [log] = await q<{ after: { lines: number; corrections: number } }>(`SELECT after FROM log WHERE entity = 'PAYOUT' AND action = 'confirm' AND actor_id = $1`, [CEO]);
    expect(log.after).toMatchObject({ lines: 1, corrections: 0 });

    // 시급 줄이 (직접 SQL 로) 바뀌어도 확정된 달은 굳은 값이다 — 지금 시급으로 다시 세지 않는다
    await q(`UPDATE wage SET rate = 99000 WHERE staff_id = $1`, [TEACHER]);
    try {
      const after = rowOf(await sheet(M2), TEACHER);
      expect(after).toMatchObject({ confirmed: true, gross: RATE, net: before.net, savedDiffers: false, canConfirm: false });
      const det = await detail(TEACHER, M2);
      expect(det.lessons.find((l) => l.serId === written)).toMatchObject({ settle: 'written', pay: RATE, unitRate: RATE, frozen: true });
      const h = await history(M2);
      expect(h.settlement).toMatchObject({ confirmed: true, gross: RATE, net: before.net });
      expect(h.lessons.find((l: { serId: number }) => l.serId === written)).toMatchObject({ pay: RATE, frozen: true, settle: 'written', settleLabel: '리포트 씀' });
    } finally {
      await q(`UPDATE wage SET rate = $2 WHERE staff_id = $1`, [TEACHER, RATE]);
    }

    // 한 회차는 표에 한 번만 — 두 번째 줄은 표가 막는다
    const [po] = await q<{ id: string }>(`SELECT id FROM payout WHERE staff_id = $1 AND year_month = $2`, [TEACHER, M2]);
    await expect(q(
      `INSERT INTO payout_line (payout_id, ser_id, on_date, kind_key, hours, unit_rate, amount) VALUES ($1, $2, $3::date, 'class', 1, 1, 1)`,
      [Number(po.id), written, M2_MON],
    )).rejects.toMatchObject({ constraint: 'payout_line_ser_on_uniq' });
  });

  /* ── ② 다음 달 보정 (N-51) ─────────────────────────────────────────────── */
  it('② 확정 뒤에 쓴 회차는 그 달을 바꾸지 않고 다음 미확정 달에 보정 줄로 얹힌다 — 확정하면 보정 근거 줄 · 감사 · 보정 승인 판정', async () => {
    const a = await lesson(TEACHER, 540, M1_MON);
    const b = await lesson(TEACHER, 660, M1_MON);
    await submit(a, tokens.teacher, M1_MON).expect(201);
    await confirm(M1, TEACHER).expect(201);
    const m1Before = rowOf(await sheet(M1), TEACHER);

    // 확정 뒤에 쓴다 — 최고 지각 구간(D-R32)
    await submit(b, tokens.teacher, M1_MON).expect(201);
    const m1After = rowOf(await sheet(M1), TEACHER);
    expect(m1After).toMatchObject({ confirmed: true, gross: m1Before.gross, net: m1Before.net, lateCount: 1, writtenCount: 1 });
    const d1 = await detail(TEACHER, M1);
    expect(d1.lessons.find((l) => l.serId === b)).toMatchObject({ settle: 'late', settleLabel: '확정된 달 — 다음 달 보정', pay: null, paidIn: null });

    const m2 = rowOf(await sheet(M2), TEACHER);
    expect(m2).toMatchObject({ confirmed: false, writtenCount: 0, correctionCount: 1, correctionMinutes: 60, canConfirm: true });
    const d2 = await detail(TEACHER, M2);
    const corr = d2.lessons.find((l) => l.serId === b)!;
    expect(corr).toMatchObject({ settle: 'correction', settleLabel: `보정 · ${monthWord(M1)} 회차`, correctionOf: M1, pay: RATE, lateCut: 10000, frozen: false });
    expect(m2.gross).toBe(RATE);
    expect(m2.lateCut).toBe(10000);

    // 강사 히스토리 — 확정된 달은 문장으로, 보정 달은 줄로
    const h1 = await history(M1);
    expect(h1.settlement.note).toContain('다음 달 정산에 보정으로');
    expect(h1.lessons.find((l: { serId: number }) => l.serId === b)).toMatchObject({ settle: 'late', settleLabel: '확정된 달 — 다음 달 보정' });
    const h2 = await history(M2);
    expect(h2.settlement).toMatchObject({ correctionCount: 1, gross: RATE });
    expect(h2.lessons.find((l: { serId: number }) => l.serId === b)).toMatchObject({ settle: 'correction', correctionOf: M1 });

    // 보정 승인 판정 — 없으면 확정이 막히고 아무것도 굳지 않는다(판정은 대표 줄 · 여기서는 서비스에 직접 준다)
    const svc = app.get(AccountingService);
    await expect(svc.confirmPayout(CEO, true, M2, { staffId: TEACHER }, true, false)).rejects.toMatchObject({ status: 403 });
    expect(await q(`SELECT id FROM payout WHERE staff_id = $1 AND year_month = $2`, [TEACHER, M2])).toEqual([]);

    await confirm(M2, TEACHER).expect(201);
    const [corrLine] = await q<{ correction: boolean; amount: number; cut: number; year_month: string }>(
      `SELECT l.correction, l.amount, l.cut, p.year_month FROM payout_line l JOIN payout p ON p.id = l.payout_id WHERE l.ser_id = $1`, [b],
    );
    expect(corrLine).toEqual({ correction: true, amount: RATE, cut: 10000, year_month: M2 });
    const [audited] = await q<{ action: string; after: { items: Array<{ serId: number; fromMonth: string }> } }>(
      `SELECT action, after FROM log WHERE entity = 'PAYOUT' AND action = 'approve' AND actor_id = $1`, [CEO],
    );
    expect(audited.after.items).toEqual([expect.objectContaining({ serId: b, fromMonth: M1 })]);
    // 지난 확정 달은 여전히 그대로이고, 넘어간 회차가 어느 달에 지급됐는지 말한다
    const d1b = await detail(TEACHER, M1);
    expect(d1b.lessons.find((l) => l.serId === b)).toMatchObject({ settle: 'late', paidIn: M2, settleLabel: `확정된 달 — ${monthWord(M2)} 보정 지급` });
    expect(rowOf(await sheet(M1), TEACHER)).toMatchObject({ gross: m1Before.gross, net: m1Before.net });
    // 이미 보정으로 지급된 회차는 다시 보정 후보가 아니다
    expect(rowOf(await sheet(THIS), TEACHER).correctionCount).toBe(0);
  });

  it('② 근거 줄이 없는 옛 확정 달 — 확정 시각보다 **먼저** 낸 회차는 그 달에 든 것으로, **나중에** 낸 회차만 보정 대상으로 본다', async () => {
    const early = await lesson(TEACHER_B, 540, M1_MON);
    const late = await lesson(TEACHER_B, 660, M1_MON);
    await submit(early, tokens.teacherB, M1_MON).expect(201);
    // 옛 방식 확정 — 근거 줄 없이 금액만 저장(이 migration 전의 확정과 같은 모양)
    await q(
      `INSERT INTO payout (staff_id, year_month, hours, gross, late_rep_cut, income_tax, local_tax, net, state, confirmed_by, confirmed_at)
       VALUES ($1, $2, 1.00, 40000, 10000, 900, 90, 29010, 'confirmed', $3, now())`, [TEACHER_B, M1, CEO],
    );
    await submit(late, tokens.teacherB, M1_MON).expect(201);

    const d1 = await detail(TEACHER_B, M1);
    expect(d1.lessons.find((l) => l.serId === early)).toMatchObject({ settle: 'written', frozen: false });
    expect(d1.lessons.find((l) => l.serId === late)).toMatchObject({ settle: 'late' });
    expect(rowOf(await sheet(M1), TEACHER_B)).toMatchObject({ confirmed: true, gross: 40000, net: 29010, lateCount: 1 });
    const m2 = rowOf(await sheet(M2), TEACHER_B);
    expect(m2).toMatchObject({ correctionCount: 1, gross: RATE });
    const d2 = await detail(TEACHER_B, M2);
    expect(d2.lessons.filter((l) => l.settle === 'correction').map((l) => l.serId)).toEqual([late]);
  });

  /* ── ③ 가산 규칙 (N-93) ────────────────────────────────────────────────── */
  it('③ 가산 규칙 — 새 줄로만 · 소급 없음 · 같은 날 409 · 종류 방어 · canWage · 감사', async () => {
    const book = (await api('get', '/accounting/bonus-rules').expect(200)).body;
    expect(book.slots.map((s: { label: string; hint: string; d1Amount: number }) => [s.label, s.hint, s.d1Amount])).toEqual([
      ['모의수업', '한 번에 얼마', 15000], ['진단고사', '한 번에 얼마', 15000],
      ['Kinder 수업', '시급에 더함', 10000], ['그룹 학생 한 명 늘 때', '한 명당', 5000],
    ]);
    expect(book.slots.find((s: { kind: string }) => s.kind === 'kinder_hourly')).toMatchObject({ applied: false });
    expect(book.slots.find((s: { kind: string }) => s.kind === 'kinder_hourly').note).toContain('Kinder');

    const today = kst();
    const post = (body: Record<string, unknown>, t = tokens.ceo) => api('post', '/accounting/bonus-rules', t).send(body);
    expect((await post({ kind: 'per_session', kindKey: KIND, amount: 15000, fromDate: plus(today, -1) }).expect(409)).body.code).toBe('BONUS_RETROACTIVE');
    expect((await post({ kind: 'per_session', amount: 15000 }).expect(400)).body.code).toBe('BONUS_KIND_KEY');
    expect((await post({ kind: 'group_per_student', kindKey: KIND, amount: 5000 }).expect(400)).body.code).toBe('BONUS_KIND_KEY');
    expect((await post({ kind: 'per_session', kindKey: 'nope-kind', amount: 1 }).expect(404)).body.code).toBe('KIND_NOT_FOUND');
    await post({ kind: 'per_session', kindKey: KIND, amount: -1 }).expect(400);
    await post({ kind: 'per_session', kindKey: KIND, amount: 1 }, tokens.teacher).expect(403);
    const made1 = (await post({ kind: 'per_session', kindKey: KIND, amount: 15000, reason: 'D1' }).expect(201)).body;
    expect(made1).toMatchObject({ kind: 'per_session', kindKey: KIND, amount: 15000, fromDate: today, current: true, setByName: '정산W11대표' });
    expect((await post({ kind: 'per_session', kindKey: KIND, amount: 20000 }).expect(409)).body.code).toBe('BONUS_SAME_DAY');
    // 다음 줄(예약)은 적용일로 — 지난 줄은 그대로 남는다
    await post({ kind: 'per_session', kindKey: KIND, amount: 0, fromDate: plus(today, 3) }).expect(201);
    const rows = await q<{ amount: number }>(`SELECT amount FROM payout_bonus_rule WHERE kind_key = $1 ORDER BY from_date`, [KIND]);
    expect(rows.map((r) => r.amount)).toEqual([15000, 0]);
    const audits = await q<{ entity: string; after: { amount: number } }>(`SELECT entity, after FROM log WHERE entity = 'PAYOUT_BONUS' AND actor_id = $1 ORDER BY id`, [CEO]);
    expect(audits.map((a) => a.after.amount)).toEqual([15000, 0]);
  });

  it('③ 가산은 한 함수가 시트 · 상세 · 강사 히스토리 · 확정에 같이 더한다 — 확정하면 근거 줄에 가산과 내역이 남는다', async () => {
    // 지난달 수업에 걸리는 줄 — API 는 소급을 막으므로 표에 직접 넣는다(이 스위트 전용 종류에만 건다)
    await q(`INSERT INTO payout_bonus_rule (kind, kind_key, amount, from_date, set_by) VALUES ('per_session', $1, 15000, $2::date, $3)`, [KIND, `${M1}-01`, CEO]);
    const s = await lesson(TEACHER, 540, M2_MON, [STU], KIND);
    await submit(s, tokens.teacher, M2_MON).expect(201);
    const row = rowOf(await sheet(M2), TEACHER);
    expect(row).toMatchObject({ bonus: 15000, gross: RATE + 15000 });
    const det = await detail(TEACHER, M2);
    const l = det.lessons.find((x) => x.serId === s)!;
    expect(l).toMatchObject({ pay: RATE, bonus: 15000 });
    // 수업 줄의 (시급×시간 + 가산) 합이 줄의 총액이다
    expect(det.lessons.reduce((n, x) => n + (x.pay ?? 0) + (x.bonus ?? 0), 0)).toBe(row.gross);
    const h = await history(M2);
    expect(h.settlement).toMatchObject({ bonus: 15000, gross: RATE + 15000 });
    expect(h.lessons.find((x: { serId: number }) => x.serId === s)).toMatchObject({ bonus: 15000 });

    await confirm(M2, TEACHER).expect(201);
    const [line] = await q<{ bonus: number; bonus_detail: Array<{ kind: string; amount: number }> }>(`SELECT bonus, bonus_detail FROM payout_line WHERE ser_id = $1`, [s]);
    expect(line).toEqual({ bonus: 15000, bonus_detail: [{ kind: 'per_session', amount: 15000 }] });
    const [po] = await q<{ gross: number }>(`SELECT gross FROM payout WHERE staff_id = $1 AND year_month = $2`, [TEACHER, M2]);
    expect(po.gross).toBe(RATE + 15000);
  });

  /* ── ④ 회계 비공개 (N-94) ─────────────────────────────────────────────── */
  it('④ 비공개 스위치는 대표 판정 · 켜면 줄 금액은 비공개 열람 · 본인만 · 합계는 그대로 · 감사', async () => {
    const off = (await api('get', '/accounting/privacy').expect(200)).body;
    expect(off).toMatchObject({ canSet: true, canSeeHidden: true });
    expect(off.switches.map((x: { key: string; label: string; private: boolean }) => [x.key, x.label, x.private]))
      .toEqual([['wage', '시급 비공개', false], ['consulting', '컨설팅 비공개', false]]);
    // 금액 예외 강사는 회계를 보지만 지정은 못 한다 · 금액 권한 없는 강사는 회계 자체가 닫힌다
    expect((await api('patch', '/accounting/privacy', tokens.tmoney).send({ key: 'wage', private: true }).expect(403)).body.code).toBe('ACCT_PRIVACY_FORBIDDEN');
    await api('patch', '/accounting/privacy', tokens.teacher).send({ key: 'wage', private: true }).expect(403);
    await api('patch', '/accounting/privacy').send({ key: 'nope', private: true }).expect(400);

    const s = await lesson(TEACHER, 540, M2_MON);
    await submit(s, tokens.teacher, M2_MON).expect(201);
    const ceoOff = await sheet(M2);
    const on = (await api('patch', '/accounting/privacy').send({ key: 'wage', private: true }).expect(200)).body;
    expect(on.switches[0]).toMatchObject({ key: 'wage', private: true, setByName: '정산W11대표' });
    const [a] = await q<{ action: string; entity_id: string; after: { private: boolean } }>(`SELECT action, entity_id, after FROM log WHERE entity = 'ACCT_PRIVACY' AND actor_id = $1`, [CEO]);
    expect(a).toMatchObject({ action: 'on', entity_id: '1', after: { private: true } });

    // 비공개 열람 예외를 끈 매니저는 스위치도 못 만진다 — 끄면 자기에게 가려진 금액이 드러나는 우회가 된다(W11 QA W11-M-13 · 리드 통합)
    expect((await api('get', '/accounting/privacy', tokens.mgr).expect(200)).body).toMatchObject({ canSet: false, canSeeHidden: false });
    expect((await api('patch', '/accounting/privacy', tokens.mgr).send({ key: 'wage', private: false }).expect(403)).body.code).toBe('ACCT_PRIVACY_FORBIDDEN');

    // 비공개 열람 예외를 끈 매니저 — 줄 금액은 null, 합계는 대표가 보는 합계와 같다
    const asMgr = await sheet(M2, tokens.mgr);
    const mgrRow = rowOf(asMgr, TEACHER);
    expect(mgrRow).toMatchObject({ amountsHidden: true, gross: null, net: null, lateCut: null, bonus: null, writtenCount: 1 });
    expect(asMgr.amountsHidden).toBe(true);
    expect(asMgr.grossTotal).toBe(ceoOff.grossTotal);
    expect(asMgr.netTotal).toBe(ceoOff.netTotal);
    const det = await detail(TEACHER, M2, tokens.mgr);
    expect(det.row.amountsHidden).toBe(true);
    expect(det.lessons.every((l) => l.pay === null && l.unitRate === null)).toBe(true);
    expect(det.rates.every((r) => r.rate === null)).toBe(true);
    expect((await api('get', `/accounting/wages?staffId=${TEACHER}`, tokens.mgr).expect(200)).body.rows.every((r: { rate: number | null }) => r.rate === null)).toBe(true);
    // 서랍 §17 · 회계 「시급」 탭의 지금 시급도 같은 판정이다 — 시급 줄을 다루는 매니저(canWage)라도 비공개 열람이 없으면 가려진다
    const memberRate = async (t: string) => ((await api('get', '/drawer', t).expect(200)).body.members as Array<{ id: number; wageRate: number | null; wageFrom: string | null }>)
      .find((m) => m.id === TEACHER);
    expect(await memberRate(tokens.mgr)).toMatchObject({ wageRate: null, wageFrom: '2026-01-01' });
    // 대표(비공개 열람) — 그대로 보인다
    expect(rowOf(await sheet(M2), TEACHER)).toMatchObject({ amountsHidden: false, gross: ceoOff.rows.find((r) => r.staffId === TEACHER)!.gross });
    expect((await api('get', `/accounting/wages?staffId=${TEACHER}`).expect(200)).body.rows[0].rate).toBe(RATE);
    expect((await memberRate(tokens.ceo))?.wageRate).toBe(RATE);
    // 강사 본인의 정산은 늘 본인에게 — 금액 예외 강사는 남의 줄은 가려지고 제 줄은 보인다
    const asTm = await sheet(M2, tokens.tmoney);
    expect(rowOf(asTm, TEACHER).amountsHidden).toBe(true);
    expect(rowOf(asTm, TMONEY).amountsHidden).toBe(false);
    // 강사 화면은 가리지 않는다(본인 것)
    expect((await history(M2)).settlement.gross).toBe(RATE);

    await api('patch', '/accounting/privacy').send({ key: 'wage', private: false }).expect(200);
    expect(rowOf(await sheet(M2, tokens.mgr), TEACHER)).toMatchObject({ amountsHidden: false, gross: RATE });
    expect((await memberRate(tokens.mgr))?.wageRate).toBe(RATE);
  });

  it('④ 컨설팅 비공개 — 컨설팅 청구서 · 그 밖의 수입 · §28 줄 금액을 가리고 합계는 그대로다', async () => {
    const [inv] = await q<{ id: string }>(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, paid_amount, state, due_on, issued_on)
       VALUES ($1, $2, 'consulting', 'W11 컨설팅비', 800000, 0, 'sent', $3::date, $3::date) RETURNING id`, [STU, THIS, kst()],
    );
    try {
      const otherOff = (await api('get', '/accounting/other-income', tokens.mgr).expect(200)).body;
      const consOff = (await api('get', '/consulting/accounting', tokens.mgr).expect(200)).body;
      await api('patch', '/accounting/privacy').send({ key: 'consulting', private: true }).expect(200);

      const all = (await api('get', '/accounting', tokens.mgr).expect(200)).body;
      expect(all.invoices.find((i: { id: number }) => i.id === Number(inv.id))).toMatchObject({ amount: null, paidAmount: null });
      expect(all.invoices.find((i: { invType: string; amount: number | null }) => i.invType === 'tuition' && i.amount !== null)).toBeDefined();
      const asCeo = (await api('get', '/accounting').expect(200)).body;
      expect(asCeo.invoices.find((i: { id: number }) => i.id === Number(inv.id)).amount).toBe(800000);
      expect(all.summary).toEqual(asCeo.summary);

      const other = (await api('get', '/accounting/other-income', tokens.mgr).expect(200)).body;
      const consRow = other.rows.find((r: { key: string }) => r.key === 'consulting');
      expect(consRow.amount).toBe(otherOff.rows.find((r: { key: string }) => r.key === 'consulting').amount);
      const items = consRow.groups.flatMap((g: { items: Array<{ amount: number | null }> }) => g.items);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i: { amount: number | null }) => i.amount === null)).toBe(true);

      const consOn = (await api('get', '/consulting/accounting', tokens.mgr).expect(200)).body;
      expect({ a: consOn.totalAmount, p: consOn.totalPaid, d: consOn.totalDue }).toEqual({ a: consOff.totalAmount, p: consOff.totalPaid, d: consOff.totalDue });
      expect(consOn.items.every((i: { amount: number | null }) => i.amount === null)).toBe(true);
    } finally {
      await q(`UPDATE acct_privacy SET private = false`);
      await q(`DELETE FROM inv WHERE id = $1`, [Number(inv.id)]);
    }
  });

  /* ── ⑤ 인수인계 메모 (N-36 ②) ─────────────────────────────────────────── */
  it('⑤ 인수인계 메모 — 관리자 · 매니저가 한 줄 더하고 §79 카드와 그 학생을 맡은 강사의 안내 카드가 읽는다 (학부모 · 남의 강사 X)', async () => {
    const s = await lesson(TEACHER, 540, M2_MON, [STU]);
    const note = (body: Record<string, unknown>, t = tokens.mgr) => api('post', '/schedule/tracking/notes', t).send(body);
    const made1 = (await note({ studentId: STU, serId: s, body: '  집중 시간이 짧아 20분마다 쉬게 해 주세요  ' }).expect(201)).body;
    expect(made1).toMatchObject({ body: '집중 시간이 짧아 20분마다 쉬게 해 주세요', authorName: '정산W11매니저' });
    expect(typeof made1.createdAt).toBe('string');
    await note({ studentId: STU, serId: s, body: '학부모 요청 — 숙제 양 줄이기' }).expect(201);

    await note({ studentId: STU, body: '강사는 못 쓴다' }, tokens.teacher).expect(403);
    expect((await note({ studentId: STU, body: '   ' }).expect(400)).body.code).toBe('NOTE_EMPTY');
    await note({ studentId: STU, body: '' }).expect(400);
    await note({ studentId: STU, body: 'x'.repeat(501) }).expect(400);
    expect((await note({ studentId: 99999999, body: '없는 학생' }).expect(404)).body.code).toBe('STUDENT_NOT_FOUND');
    expect((await note({ studentId: STU_B, serId: s, body: '명단 밖' }).expect(404)).body.code).toBe('NOTE_TARGET_NOT_FOUND');
    // 고치기 · 지우기 길은 없다
    await api('patch', `/schedule/tracking/notes/${made1.id}`, tokens.mgr).send({ body: 'x' }).expect(404);
    await api('delete', `/schedule/tracking/notes/${made1.id}`, tokens.mgr).expect(404);

    const tr = (await api('get', `/schedule/tracking?serId=${s}&onDate=${M2_MON}`, tokens.mgr).expect(200)).body;
    const card = tr.students.find((x: { id: number }) => x.id === STU);
    expect(card.noteCount).toBe(2);
    expect(card.notes.map((n: { body: string }) => n.body)).toEqual(['학부모 요청 — 숙제 양 줄이기', '집중 시간이 짧아 20분마다 쉬게 해 주세요']);

    const guides = (await api('get', `/teacher/guides?week=${M2_MON}`, tokens.teacher).expect(200)).body;
    const stu = guides.students.find((x: { studentId: number }) => x.studentId === STU);
    expect(stu.notes.map((n: { body: string }) => n.body)).toContain('집중 시간이 짧아 20분마다 쉬게 해 주세요');
    // 그 주에 이 학생을 맡지 않은 강사에게는 없다
    const other = (await api('get', `/teacher/guides?week=${M2_MON}`, tokens.teacherB).expect(200)).body;
    expect(other.students.find((x: { studentId: number }) => x.studentId === STU)).toBeUndefined();
  });

  /* ── ⑥ 지출 감사 · 영수증 (N-73 · PB-26 · PB-12-5) ────────────────────── */
  it('⑥ 지출 — 남의 영수증 403 · 같은 영수증 동시 등록은 하나만 · 심사는 감사 줄을 남긴다', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]).toString('base64');
    const upload = async (t: string) => (await api('post', '/files', t).send({ kind: 'expense-receipt', name: '영수증.png', base64: png }).expect(201)).body.id as number;
    const expense = (fileId: number, t: string) => api('post', '/accounting/expenses', t)
      .send({ spendOn: kst(), category: 'supply', merchant: '문구점', requestedAmount: 12000, receiptFileId: fileId });

    // PB-26 — 매니저가 올린 영수증을 대표가 자기 지출에 붙이면 403
    const mgrFile = await upload(tokens.mgr);
    expect((await expense(mgrFile, tokens.ceo).expect(403)).body.code).toBe('EXPENSE_RECEIPT_NOT_OWNER');
    // PB-12-5 — 같은 영수증을 다섯 번 동시에 붙여도 하나만 선다
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => expense(mgrFile, tokens.mgr)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'EXPENSE_RECEIPT_USED')).toBe(true);
    const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM expense WHERE receipt_url = $1`, [`/files/${mgrFile}`]);
    expect(n).toBe(1);

    // N-73 — 심사 한 번에 감사 한 줄(같은 트랜잭션)
    const id = results.find((r) => r.status === 201)!.body.id as number;
    await api('post', `/accounting/expenses/${id}/review`).send({ decision: 'approve', amount: 10000, reason: '일부만 인정' }).expect(201);
    const [logRow] = await q<{ action: string; before: { state: string }; after: { state: string; amount: number } }>(
      `SELECT action, before, after FROM log WHERE entity = 'EXPENSE' AND entity_id = $1 AND action IN ('approve','reject')`, [id],
    );
    expect(logRow).toMatchObject({ action: 'approve', before: { state: 'pending' }, after: { state: 'approved', amount: 10000 } });
  });
});
