/** @file-guide
 * 목적: accounting-w5-http.spec.ts — §56 강사 상세 · 합계 카드 · §55 들어온 돈 경로의 입력 방어·권한 (w5)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 증명하는 것 —
 *   ① §56 강사 상세(`GET /accounting/payouts/{staffId}`)의 줄은 **시트의 그 줄과 같은 값**이고, 수업 줄의 강사료 합이
 *      총액·차감 합이 차감이다 — 같은 함수(`lib/payout-sheet`)가 셌다 (56-01).
 *   ② 시트의 합계 카드(시간·강사료·차감·세금·보류)가 **줄의 합**이다 (56-02).
 *   ③ 두 경로 모두 `canMoney` 없는 강사는 403, 잘못된 입력은 400, 목록 밖 강사는 404, 기간 역순은 409.
 *
 * ⚠ 제 픽스처만 만들고 지운다 (payout-confirm-db 와 같은 방식 — 수업은 시간표 API 로 만든다).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import type { PayoutDetailDto, PayoutSheetDto } from '../src/modules/accounting/accounting.dto';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('§56 강사 상세 · 합계 카드 · §55 들어온 돈 HTTP (w5)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let teacherToken = '';
  const PW = 'w5-acct-1234';
  const CEO = 1591;
  const TEACHER = 1592;
  const STU = 15991;
  const RATE = 42000;
  const made: number[] = [];

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  /** 지난달 첫 월요일 — 투영 지평선이 지난달을 덮으므로 회차가 실제로 선다 (payout-confirm-db 와 같은 셈) */
  const PREV_MON = (() => {
    let d0 = `${plus(`${kst().slice(0, 7)}-01`, -1).slice(0, 7)}-01`;
    for (let i = 0; i < 7 && new Date(`${d0}T00:00:00Z`).getUTCDay() !== 1; i++) d0 = plus(d0, 1);
    return d0;
  })();
  const PREV = PREV_MON.slice(0, 7);

  const api = (m: 'post' | 'get' | 'delete', p: string, t = token) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`).timeout({ response: 8000, deadline: 15000 });

  async function lesson(startMin: number, kindKey = 'class') {
    const res = await api('post', '/schedule').send({
      kindKey, subKey: null, mode: 'offline', fromDate: PREV_MON, rrule: 'ONCE',
      startMin, endMin: startMin + 60, teacherId: TEACHER, roomId: null, title: 'W5 정산 수업', studentIds: [STU],
    }).expect(201);
    const id = res.body.serIds[0] as number;
    made.push(id);
    return id;
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    const ids = [CEO, TEACHER];
    await q(`DELETE FROM wage WHERE staff_id = ANY($1)`, [ids]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'W5정산대표','w5-acct-ceo@t.kr','ceo',$3,true),
         ($2,'W5정산강사','w5-acct-t@t.kr','teacher',$3,true)`,
      [CEO, TEACHER, hash],
    );
    await q(`INSERT INTO wage (staff_id, rate, from_date, reason) VALUES ($1, $2, '2026-01-01', 'w5 테스트')`, [TEACHER, RATE]);
    await q(`DELETE FROM stu WHERE id = $1`, [STU]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'W5정산학생','10')`, [STU]);
    const login = async (email: string) => (await request(app.getHttpServer())
      .post('/auth/login').send({ loginId: email, password: PW }).expect(201)).body.accessToken as string;
    token = await login('w5-acct-ceo@t.kr');
    teacherToken = await login('w5-acct-t@t.kr');

    // 쓴 것 · 안 쓴 것 · 휴강 — 세 갈래가 한 강사 한 달에 선다
    const written = await lesson(540);
    await lesson(660);
    const canceled = await lesson(780);
    await api('post', `/reports/${written}/${PREV_MON}/submit`, teacherToken)
      .send({ content: '이번 수업에서 다룬 내용을 사실대로 적는다', progress: '교재 12쪽까지', homework: '13~14쪽 풀어 오기' }).expect(201);
    await api('delete', `/schedule/${canceled}`).send({ scope: 'this', onDate: PREV_MON, cancelKind: 'holiday', cancelTreat: 'carry' }).expect(200);
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        const ids = [CEO, TEACHER];
        if (made.length) {
          await q(`DELETE FROM att WHERE ser_id = ANY($1)`, [made]);
          await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id = ANY($1))`, [made]);
          await q(`DELETE FROM rep WHERE ser_id = ANY($1)`, [made]);
          await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [made]);
          await q(`DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id = ANY($1))`, [made]);
          await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [made]);
          await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [made]);
          await q(`DELETE FROM ser WHERE id = ANY($1)`, [made]);
        }
        await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
        await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [ids]);
        await q(`DELETE FROM payout WHERE staff_id = ANY($1)`, [ids]);
        await q(`DELETE FROM wage WHERE staff_id = ANY($1)`, [ids]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
        await q(`DELETE FROM stu WHERE id = $1`, [STU]);
      }
    } finally {
      await app?.close();
    }
  });

  it('상세의 줄은 시트의 그 줄과 같고, 수업 줄의 강사료·차감 합이 줄의 총액·차감이다 (56-01)', async () => {
    const sheet = (await api('get', `/accounting/payouts?month=${PREV}`).expect(200)).body as PayoutSheetDto;
    const row = sheet.rows.find((r) => r.staffId === TEACHER)!;
    const v = (await api('get', `/accounting/payouts/${TEACHER}?month=${PREV}`).expect(200)).body as PayoutDetailDto;
    expect(v).toMatchObject({ staffId: TEACHER, staffName: 'W5정산강사', month: PREV });
    expect(v.row).toEqual(row);
    expect(v.rates).toEqual([{ fromDate: '2026-01-01', rate: RATE }]);
    expect(v.lessons.map((l) => l.settleLabel).sort()).toEqual(['리포트 미작성', '리포트 씀', '휴강']);
    const sum = (k: 'pay' | 'lateCut') => v.lessons.reduce((n, l) => n + (l[k] ?? 0), 0);
    expect(sum('pay')).toBe(row.gross);
    expect(sum('lateCut')).toBe(row.lateCut);
    // 쓴 수업만 돈이 선다 — 안 쓴 것·휴강은 null (빠진 금액은 줄의 unwrittenAmount 가 말한다)
    expect(v.lessons.filter((l) => l.settle !== 'written').every((l) => l.pay === null)).toBe(true);
    expect(v.lessons.find((l) => l.settle === 'written')).toMatchObject({ name: 'W5 정산 수업', students: 'W5정산학생', durMin: 60 });
  });

  it('시트의 합계 카드는 줄의 합이다 — 시간 · 강사료 · 차감 · 세금 · 보류 (56-02)', async () => {
    const s = (await api('get', `/accounting/payouts?month=${PREV}`).expect(200)).body as PayoutSheetDto;
    const sum = (pick: (r: PayoutSheetDto['rows'][number]) => number | null | undefined) => s.rows.reduce((n, r) => n + (pick(r) ?? 0), 0);
    expect(s.writtenMinutes).toBe(sum((r) => r.writtenMinutes));
    expect(s.unwrittenMinutes).toBe(sum((r) => r.unwrittenMinutes));
    expect(s.grossTotal).toBe(sum((r) => r.gross));
    expect(s.lateCutTotal).toBe(sum((r) => r.lateCut));
    expect(s.taxTotal).toBe(sum((r) => (r.incomeTax ?? 0) + (r.localTax ?? 0)));
    // 실지급 = 강사료 − 차감 − 세금 (원본 §56 「5,096,750 − 95,000 − 165,058 = 4,836,692」와 같은 등식)
    expect(s.netTotal).toBe(s.grossTotal! - s.lateCutTotal! - s.taxTotal!);
  });

  it('권한·입력 방어 — 강사 403 · 잘못된 강사/달/분류/날짜 400 · 목록 밖 강사 404 · 기간 역순 409', async () => {
    await api('get', `/accounting/payouts/${TEACHER}?month=${PREV}`, teacherToken).expect(403);
    await api('get', '/accounting/cashflow', teacherToken).expect(403);
    await api('get', `/accounting/payouts/x?month=${PREV}`).expect(400);
    await api('get', `/accounting/payouts/0?month=${PREV}`).expect(400);
    await api('get', `/accounting/payouts/${TEACHER}?month=2026-13`).expect(400);
    await api('get', `/accounting/payouts/${CEO}?month=1999-01`).expect(404);
    await api('get', '/accounting/cashflow?from=2026-02-30').expect(400);
    await api('get', '/accounting/cashflow?category=nope').expect(400);
    await api('get', '/accounting/cashflow?from=2026-08-31&to=2026-08-01').expect(409);
    const ok = (await api('get', `/accounting/cashflow?from=${PREV}-01&to=${PREV}-28`).expect(200)).body;
    expect(ok).toMatchObject({ canSeeAmounts: true, from: `${PREV}-01`, to: `${PREV}-28` });
    expect(ok.categories).toHaveLength(6);
  });
});
