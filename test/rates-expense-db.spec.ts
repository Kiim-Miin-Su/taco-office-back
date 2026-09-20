/** @file-guide
 * 목적: rates-expense-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 단가표 · 학생별 예외 · 지출 등록 · 추가 수업 — C94-d
 * (테스트 시나리오 H-81 「학생별 단가 예외 · 그 학생만 바뀐다 · 사유가 없으면 실패」 ·
 *  H-83 「지출 등록 · 직원이 올리면 pending · 바로 확정되면 실패」 ·
 *  C-38 「추가 수업 · 별도로 잡힌다 · 단가 등록 · 청구서에 든다」).
 *
 * 증명하는 것 —
 *   ① 추가 수업은 KIND 한 줄(`extra`)이다 — §18 에서 만들고 `POST /accounting/rates` 로 단가를 두면 회차에 `extra`,
 *      §54 에 「추가 수업 N」, 청구서에 **제 줄**(「추가 수업 · 과목」)로 든다. 같은 (종류·과목·인원·날짜)는 409.
 *   ② 학생별 예외는 **그 학생만** 바꾼다 — 같은 그룹의 다른 학생은 한 원도 안 바뀐다. 사유 없이는 400 · 표는 CHECK.
 *   ③ 지출 등록은 언제나 `pending` — 확정 금액은 심사가 넣고, 올린 사람이 대표여도 자기 심사는 403. 대표에게 알림 한 건.
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

d('단가표 · 학생별 예외 · 지출 등록 · 추가 수업 (C94-d · H-81 · H-83 · C-38)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let managerToken = '';
  let teacherToken = '';
  let ceo2Token = '';
  const PW = 'rates-1234';
  const CEO = 991;
  /**
   * **금액 예외를 꺼 둔** 매니저 — 회계 403 · 지출 등록은 된다(그 경로는 `canAdminPage` 다).
   * 역할 파생 `canMoney` 는 대표 결정 2026-09-21 로 관리자급까지 열려, 역할만으로는
   * 「회계 밖에 있는 사람」을 세울 수 없다(D-R9 의 경계 자체는 사람별 예외 칸으로 남아 있다).
   */
  const MANAGER = 992;
  const TEACHER = 993;
  const CEO2 = 994; // 둘째 대표 — 대신 올린 사람 말고 다른 사람이 심사하면 통과하는 것을 본다 (S2)
  const STU_A = 9991;
  const STU_B = 9992;
  const KIND = 're_kind';
  const EXTRA = 're_extra';
  const SUB = 're-sub';
  const SOLO = 60000;
  const DUO = 45000;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const THIS = kst().slice(0, 7);
  const NEXT_FIRST = `${plus(`${THIS}-01`, 32).slice(0, 7)}-01`;
  const NEXT = NEXT_FIRST.slice(0, 7);
  const DAYS = [0, 1, 2].map((n) => plus(NEXT_FIRST, n));

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, MANAGER, TEACHER, CEO2]]);
    await q(`DELETE FROM expense WHERE requester_id = ANY($1)`, [[CEO, MANAGER, TEACHER, CEO2]]);
    await q(`DELETE FROM file WHERE uploaded_by = ANY($1)`, [[CEO, MANAGER, TEACHER, CEO2]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, MANAGER, TEACHER, CEO2]]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active, can_money) VALUES
         ($1,'단가대표','re-ceo@t.kr','ceo',$4,true,null),
         ($2,'단가매니저','re-m@t.kr','manager',$4,true,false),
         ($3,'단가강사','re-t@t.kr','teacher',$4,true,null),
         ($5,'단가대표둘','re-ceo2@t.kr','ceo',$4,true,null)`,
      [CEO, MANAGER, TEACHER, hash, CEO2],
    );
    await q(`DELETE FROM sturate WHERE student_id = ANY($1)`, [[STU_A, STU_B]]);
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B]]);
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'단가A','10'), ($2,'단가B','10')`, [STU_A, STU_B]);
    await q(`DELETE FROM rate WHERE kind_key = ANY($1)`, [[KIND, EXTRA]]);
    await q(`DELETE FROM kind WHERE key = ANY($1)`, [[KIND, EXTRA]]);
    await q(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'단가 시험','#333333',4,'lesson',true)`, [KIND]);
    await q(`INSERT INTO sub (key,name,color) VALUES ($1,'단가 과목','#444444') ON CONFLICT (key) DO NOTHING`, [SUB]);
    await q(`INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES ($1, $2, $3, '2026-01-01', 1), ($1, $2, $4, '2026-01-01', 2)`, [KIND, SUB, SOLO, DUO]);
    const login = async (email: string) => {
      const res = await request(app.getHttpServer())
        .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ email, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    token = await login('re-ceo@t.kr');
    managerToken = await login('re-m@t.kr');
    teacherToken = await login('re-t@t.kr');
    ceo2Token = await login('re-ceo2@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await q(`DELETE FROM rate WHERE kind_key = ANY($1)`, [[KIND, EXTRA]]);
        await q(`DELETE FROM sturate WHERE student_id = ANY($1)`, [[STU_A, STU_B]]);
        await q(`DELETE FROM sub WHERE key = $1`, [SUB]);
        await q(`DELETE FROM kind WHERE key = ANY($1)`, [[KIND, EXTRA]]);
        await q(`DELETE FROM expense WHERE requester_id = ANY($1)`, [[CEO, MANAGER, TEACHER, CEO2]]);
        await q(`DELETE FROM file WHERE uploaded_by = ANY($1)`, [[CEO, MANAGER, TEACHER, CEO2]]);
        await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, MANAGER, TEACHER, CEO2]]);
        await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, MANAGER, TEACHER, CEO2]]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, MANAGER, TEACHER, CEO2]]);
        await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU_A, STU_B]]);
      }
    } finally {
      await app?.close();
    }
  });

  const made: number[] = [];
  afterEach(async () => {
    const stus = [STU_A, STU_B];
    await q(`DELETE FROM pay WHERE student_id = ANY($1) OR inv_id IN (SELECT id FROM inv WHERE student_id = ANY($1))`, [stus]);
    await q(`DELETE FROM inv_line WHERE inv_id IN (SELECT id FROM inv WHERE student_id = ANY($1))`, [stus]);
    await q(`DELETE FROM inv WHERE student_id = ANY($1)`, [stus]);
    await q(`DELETE FROM sturate WHERE student_id = ANY($1)`, [stus]);
    await q(`DELETE FROM rate WHERE kind_key = $1`, [EXTRA]);
    await q(`DELETE FROM expense WHERE requester_id = ANY($1)`, [[CEO, MANAGER, TEACHER, CEO2]]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, MANAGER, TEACHER, CEO2]]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, MANAGER, TEACHER, CEO2]]);
    if (!made.length) return;
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
      .timeout({ response: 8000, deadline: 15000 });

  /** 다음 달 ONCE 60분 한 회차 */
  async function lesson(day: string, students: number[], kindKey = KIND, startMin = 600) {
    const res = await api('post', '/schedule').send({
      kindKey, subKey: SUB, mode: 'offline', fromDate: day, rrule: 'ONCE',
      startMin, endMin: startMin + 60, teacherId: TEACHER, roomId: null, title: '단가 수업', studentIds: students,
    }).expect(201);
    const id = res.body.serIds[0] as number;
    made.push(id);
    return id;
  }
  const issue = (studentId: number) => api('post', '/accounting/invoices').send({ studentId, yearMonth: NEXT, invType: 'tuition', dueOn: DUE });

  /* ── ① C-38 추가 수업 ────────────────────────────────────────────────── */
  it('추가 수업은 KIND 한 줄(extra)이다 — 단가를 두면 회차 「추가」·§54 「추가 수업 N」·청구서 제 줄로 든다 (C-38)', async () => {
    // §18 프로그램에서 만든다 — 시드의 KIND 8종은 그대로다 (원문 KIND 8종 유지)
    await api('post', '/catalog/kinds').send({ key: EXTRA, name: '추가 수업', color: '#555555', cap: 4, grp: 'lesson', rep: true, repForm: 'dev', extra: true }).expect(201);
    const meta = (await api('get', '/meta').expect(200)).body;
    expect(meta.kinds.find((k: { key: string }) => k.key === EXTRA)).toMatchObject({ extra: true });

    // 단가 등록 — 그 종류 전체(과목 없음) 1인 70,000
    const made1 = (await api('post', '/accounting/rates').send({ kindKey: EXTRA, heads: 1, unitPrice: 70000, fromDate: '2026-01-01' }).expect(201)).body;
    expect(made1).toMatchObject({ kindKey: EXTRA, kindName: '추가 수업', kindExtra: true, subKey: null, heads: 1, unitPrice: 70000, fromDate: '2026-01-01', current: true });
    // 같은 자리에 두 번은 409 · 없는 종류는 404
    const dup = await api('post', '/accounting/rates').send({ kindKey: EXTRA, heads: 1, unitPrice: 80000, fromDate: '2026-01-01' }).expect(409);
    expect(dup.body.code).toBe('RATE_DUPLICATE');
    expect((await api('post', '/accounting/rates').send({ kindKey: 'no_such', heads: 1, unitPrice: 1, fromDate: '2026-01-01' }).expect(404)).body.code).toBe('KIND_NOT_FOUND');
    expect((await api('post', '/accounting/rates').send({ kindKey: EXTRA, subKey: 'no-such', heads: 1, unitPrice: 1, fromDate: '2026-02-01' }).expect(404)).body.code).toBe('SUB_NOT_FOUND');
    // 매니저는 회계 밖 (D-R9)
    await api('post', '/accounting/rates', managerToken).send({ kindKey: EXTRA, heads: 1, unitPrice: 1, fromDate: '2026-03-01' }).expect(403);
    await api('get', '/accounting/rates', managerToken).expect(403);
    // LOG
    expect(await q(`SELECT 1 FROM log WHERE actor_id = $1 AND entity = 'RATE' AND action = 'create'`, [CEO])).toHaveLength(1);

    // 단가표 — 살아 있는 줄 판정은 서버가 한다
    const book = (await api('get', '/accounting/rates').expect(200)).body;
    const extraRows = book.rates.filter((r: { kindKey: string }) => r.kindKey === EXTRA);
    expect(extraRows).toEqual([expect.objectContaining({ id: made1.id, current: true })]);
    // 더 늦은 날짜부터의 줄을 두면 그 줄이 살아 있는 줄이 되고 지난 줄은 남는다
    const later = (await api('post', '/accounting/rates').send({ kindKey: EXTRA, heads: 1, unitPrice: 75000, fromDate: '2026-02-01' }).expect(201)).body;
    const book2 = (await api('get', '/accounting/rates').expect(200)).body;
    expect(book2.rates.filter((r: { kindKey: string }) => r.kindKey === EXTRA).map((r: { id: number; current: boolean }) => [r.id, r.current])).toEqual([[later.id, true], [made1.id, false]]);

    // 정규 1회 + 추가 1회 (다른 시각) — 회차 응답에 extra
    const regular = await lesson(DAYS[0], [STU_A]);
    const extra = await lesson(DAYS[1], [STU_A], EXTRA, 720);
    const occ = (await api('get', `/schedule/occurrences?from=${DAYS[0]}&to=${DAYS[2]}`).expect(200)).body.items as Array<{ serId: number; extra: boolean }>;
    expect(occ.find((o) => o.serId === regular)?.extra).toBe(false);
    expect(occ.find((o) => o.serId === extra)?.extra).toBe(true);

    // §54 — 「추가 수업 1」 · 줄에도 extra 1
    const tuition = (await api('get', `/accounting/tuition?month=${NEXT}`).expect(200)).body;
    expect(tuition.extraCount).toBe(1);
    expect(tuition.items.find((r: { studentId: number }) => r.studentId === STU_A)).toMatchObject({ extra: 1, total: 2 });

    // 청구서 — 추가 수업은 제 줄, 단가는 회차 날짜(다음 달)의 살아 있는 줄 75,000
    const inv = (await issue(STU_A).expect(201)).body;
    expect(inv.lines.map((l: { label: string; count: number; unitPrice: number }) => [l.label, l.count, l.unitPrice])).toEqual([
      ['단가 과목', 1, SOLO], ['추가 수업 · 단가 과목', 1, 75000],
    ]);
    expect(inv.amount).toBe(SOLO + 75000);
  });

  /* ── ② H-81 학생별 예외 ──────────────────────────────────────────────── */
  it('학생별 예외는 그 학생만 바꾼다 — 같은 그룹의 다른 학생은 그대로 · 사유 없이는 400 · 표는 CHECK (H-81)', async () => {
    await lesson(DAYS[0], [STU_A, STU_B]);
    await lesson(DAYS[1], [STU_A, STU_B], KIND, 720);

    // 사유 없이 → DTO 400 · 공백 사유 → 400 STURATE_REASON_REQUIRED · 매니저 403
    await api('post', '/accounting/sturates').send({ studentId: STU_A, kindKey: KIND, unitPrice: 30000, fromDate: NEXT_FIRST }).expect(400);
    expect((await api('post', '/accounting/sturates').send({ studentId: STU_A, kindKey: KIND, unitPrice: 30000, fromDate: NEXT_FIRST, reason: '   ' }).expect(400)).body.code).toBe('STURATE_REASON_REQUIRED');
    await api('post', '/accounting/sturates', managerToken).send({ studentId: STU_A, kindKey: KIND, unitPrice: 30000, fromDate: NEXT_FIRST, reason: '형제 할인' }).expect(403);
    expect((await api('post', '/accounting/sturates').send({ studentId: 999999, kindKey: KIND, unitPrice: 30000, fromDate: NEXT_FIRST, reason: 'x' }).expect(404)).body.code).toBe('STUDENT_NOT_FOUND');
    // 표의 마지막 방어선 — 사유 없는 새 행은 들어가지 않는다 (CHECK sturate_reason_present)
    await expect(q(`INSERT INTO sturate (student_id, kind_key, unit_price, from_date) VALUES ($1, $2, 1, $3::date)`, [STU_A, KIND, NEXT_FIRST]))
      .rejects.toMatchObject({ message: expect.stringContaining('sturate_reason_present') });

    const row = (await api('post', '/accounting/sturates').send({ studentId: STU_A, kindKey: KIND, unitPrice: 30000, fromDate: NEXT_FIRST, reason: '형제 할인' }).expect(201)).body;
    expect(row).toMatchObject({ studentId: STU_A, studentName: '단가A', kindKey: KIND, kindName: '단가 시험', unitPrice: 30000, fromDate: NEXT_FIRST, reason: '형제 할인', byName: '단가대표', current: false });
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
    // 같은 학생·종류·날짜 두 번은 409
    expect((await api('post', '/accounting/sturates').send({ studentId: STU_A, kindKey: KIND, unitPrice: 31000, fromDate: NEXT_FIRST, reason: '다시' }).expect(409)).body.code).toBe('STURATE_DUPLICATE');
    // 단가표에 선다
    const book = (await api('get', '/accounting/rates').expect(200)).body;
    expect(book.studentRates.filter((r: { studentId: number }) => r.studentId === STU_A)).toEqual([expect.objectContaining({ id: row.id, reason: '형제 할인' })]);

    // 청구서 — A 는 예외 30,000 × 2 · B 는 2인 구간 45,000 × 2 그대로
    const invA = (await issue(STU_A).expect(201)).body;
    const invB = (await issue(STU_B).expect(201)).body;
    expect(invA.lines).toEqual([expect.objectContaining({ count: 2, unitPrice: 30000 })]);
    expect(invA.amount).toBe(60000);
    expect(invB.lines).toEqual([expect.objectContaining({ count: 2, unitPrice: DUO })]);
    expect(invB.amount).toBe(DUO * 2);
    // §54 도 같은 값 (D-R22)
    const tuition = (await api('get', `/accounting/tuition?month=${NEXT}`).expect(200)).body;
    expect(tuition.items.find((r: { studentId: number }) => r.studentId === STU_A)).toMatchObject({ unitPrice: 30000, unitPriceOverride: true });
    expect(tuition.items.find((r: { studentId: number }) => r.studentId === STU_B)).toMatchObject({ unitPrice: DUO, unitPriceOverride: false });
    expect(await q(`SELECT 1 FROM log WHERE actor_id = $1 AND entity = 'STURATE' AND action = 'create'`, [CEO])).toHaveLength(1);
  });

  /* ── ③ H-83 지출 등록 ─────────────────────────────────────────────────── */
  it('지출은 올리면 언제나 pending — 확정 금액은 심사가 넣고 자기 심사는 403 · 대표에게 알림 한 건 · 영수증은 한 지출에만 (H-83)', async () => {
    // 강사는 못 올린다 · 분류 코드 밖 400 · 금액 0 은 400
    await api('post', '/accounting/expenses', teacherToken).send({ spendOn: kst(), category: 'supply', requestedAmount: 1000 }).expect(403);
    await api('post', '/accounting/expenses', managerToken).send({ spendOn: kst(), category: 'travel', requestedAmount: 1000 }).expect(400);
    await api('post', '/accounting/expenses', managerToken).send({ spendOn: kst(), category: 'supply', requestedAmount: 0 }).expect(400);

    // 영수증 — 매니저가 올린다
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
    const file = (await api('post', '/files', managerToken).send({ kind: 'expense-receipt', name: '영수증.png', base64: png }).expect(201)).body;

    // 매니저(금액 권한 없음)가 올린다 — pending · 확정 금액 null · 자기가 적은 신청 금액은 돌아온다
    const made1 = (await api('post', '/accounting/expenses', managerToken).send({
      spendOn: kst(), category: 'supply', merchant: '문구점', purpose: '화이트보드 마커', requestedAmount: 35000, receiptFileId: file.id,
    }).expect(201)).body;
    expect(made1).toMatchObject({ state: 'pending', amount: null, requestedAmount: 35000, requesterId: MANAGER, requesterName: '단가매니저', hasReceipt: true, category: 'supply', categoryLabel: '소모품비', merchant: '문구점', purpose: '화이트보드 마커', reviewerName: null, reviewedAt: null });
    const [db] = await q<{ state: string; amount: number | null; receipt_url: string }>(`SELECT state, amount, receipt_url FROM expense WHERE id = $1`, [made1.id]);
    expect(db).toMatchObject({ state: 'pending', amount: null, receipt_url: `/files/${file.id}` });
    // 같은 영수증을 두 지출에 붙일 수 없다
    expect((await api('post', '/accounting/expenses', managerToken).send({ spendOn: kst(), category: 'supply', requestedAmount: 1000, receiptFileId: file.id }).expect(409)).body.code).toBe('EXPENSE_RECEIPT_USED');
    expect((await api('post', '/accounting/expenses', managerToken).send({ spendOn: kst(), category: 'supply', requestedAmount: 1000, receiptFileId: 999999999 }).expect(404)).body.code).toBe('FILE_NOT_FOUND');
    // 대표에게 알림 한 건 · LOG 한 줄
    // 대표 전원에게 간다 — 시드의 대표에게도 한 건이므로 이 스위트의 대표로 좁혀 센다
    const notis = await q<{ to_id: string; body: string; link: string; category: string }>(`SELECT to_id, body, link, category FROM noti WHERE from_id = $1 AND to_id = $2`, [MANAGER, CEO]);
    expect(notis).toEqual([expect.objectContaining({ to_id: String(CEO), link: '/accounting?tab=out', category: 'request' })]);
    expect(await q(`SELECT 1 FROM noti n JOIN staff s ON s.id = n.to_id WHERE n.from_id = $1 AND s.role <> 'ceo'`, [MANAGER])).toEqual([]);
    expect(notis[0]!.body).toContain('단가매니저');
    expect(notis[0]!.body).toContain('소모품비');
    expect(await q(`SELECT 1 FROM log WHERE actor_id = $1 AND entity = 'EXPENSE' AND action = 'create'`, [MANAGER])).toHaveLength(1);
    // 매니저는 심사할 수 없다 (canMoney) — 「바로 확정되면 실패」
    await api('post', `/accounting/expenses/${made1.id}/review`, managerToken).send({ decision: 'approve', amount: 35000 }).expect(403);
    // 대표의 「나간 돈」에 pending 으로 선다
    const acc = (await api('get', '/accounting').expect(200)).body;
    expect(acc.expenses.find((e: { id: number }) => e.id === made1.id)).toMatchObject({ state: 'pending', requestedAmount: 35000, amount: null });
    // 대표가 심사한다 — 그때야 확정
    const reviewed = (await api('post', `/accounting/expenses/${made1.id}/review`).send({ decision: 'approve', amount: 35000 }).expect(201)).body;
    expect(reviewed).toMatchObject({ state: 'approved', amount: 35000, reviewerName: '단가대표' });

    // 대표가 자기 지출을 올리면 — 역시 pending 이고 자기 심사는 403 (A-5) · 자기에게는 알림이 없다
    const mine = (await api('post', '/accounting/expenses').send({ spendOn: kst(), category: 'ent', requestedAmount: 80000, merchant: '식당' }).expect(201)).body;
    expect(mine).toMatchObject({ state: 'pending', amount: null, requesterId: CEO, hasReceipt: false });
    expect((await api('post', `/accounting/expenses/${mine.id}/review`).send({ decision: 'approve', amount: 80000 }).expect(403)).body.code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(await q(`SELECT 1 FROM noti WHERE from_id = $1 AND to_id = $1`, [CEO])).toEqual([]);
    // 대표가 직원 대신 올린다 — requesterId 가 그 직원이고 **올린 사람은 대표로 남는다** (S2)
    const onBehalf = (await api('post', '/accounting/expenses').send({ spendOn: kst(), category: 'book', requestedAmount: 12000, requesterId: MANAGER }).expect(201)).body;
    expect(onBehalf).toMatchObject({ state: 'pending', requesterId: MANAGER, requestedAmount: 12000, filedById: CEO, filedByName: '단가대표' });
    expect((await api('post', '/accounting/expenses').send({ spendOn: kst(), category: 'book', requestedAmount: 12000, requesterId: 999999 }).expect(404)).body.code).toBe('STAFF_NOT_FOUND');

    /**
     * **남의 이름으로 올린 뒤 자기가 승인하는 길**이 열려 있었다 (S2 · 2026-09-20 전수 검수).
     *
     * `requesterId` 는 누가 보내든 그대로 들어갔고(컨트롤러 주석만 「대표가 대신 올릴 때만」이라 적었다)
     * 심사 쪽은 `requester_id` 하나만 봤다 — **A-5 가 통째로 비켜간다.** S2 는 둘 다 닫았다:
     * 대리 등록은 대표만 · 실제로 올린 사람(`filed_by`)도 심사하지 못한다.
     *
     * ⭐ **대표 결정 2026-09-21 로 앞의 절반(역할 경계)이 열렸다** — `canCeoFileExpenseForOther` 가
     * `ceoGate` 를 부르므로 매니저도 남의 이름으로 올린다. **뒤의 절반은 그대로다**: 올린 사람은
     * 자기가 심사하지 못하고(`SELF_APPROVAL_GUARDED` 에 `expense` 가 남아 있다) DB CHECK 둘도 그대로다.
     * 「누가 올릴 수 있는가」와 「올린 사람이 스스로 승인할 수 있는가」는 다른 질문이고, 이번 결정은 앞만 건드렸다.
     */
    const mgrProxy = (await api('post', '/accounting/expenses', managerToken)
      .send({ spendOn: kst(), category: 'book', requestedAmount: 5000, requesterId: TEACHER }).expect(201)).body;
    expect(mgrProxy).toMatchObject({ state: 'pending', requesterId: TEACHER, filedById: MANAGER });
    // 뒤 절반(올린 사람은 자기가 심사하지 못한다)은 바로 아래 대표 건이 그대로 증명한다 —
    // 이 매니저는 금액 예외가 꺼져 있어 심사 화면 자체에 못 들어간다(그것은 다른 경계다).
    // 자기 이름으로 보내는 것은 대리가 아니다 — 막지 않는다
    await api('post', '/accounting/expenses', managerToken)
      .send({ spendOn: kst(), category: 'book', requestedAmount: 5000, requesterId: MANAGER }).expect(201);
    // 대표가 대신 올린 건은 **그 대표가** 심사하지 못한다 — 다른 사람은 한다
    expect((await api('post', `/accounting/expenses/${onBehalf.id}/review`).send({ decision: 'reject', reason: '내가 올렸다' }).expect(403)).body.code)
      .toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await api('post', `/accounting/expenses/${onBehalf.id}/review`, ceo2Token)
      .send({ decision: 'reject', reason: '영수증 없음' }).expect(201)).body).toMatchObject({ state: 'rejected', reviewerName: '단가대표둘' });
    // 서비스를 우회해도 표가 막는다
    await expect(q(`UPDATE expense SET reviewer_id = $2, reviewed_at = now() WHERE id = $1`, [onBehalf.id, CEO]))
      .rejects.toThrow(/expense_no_self_file_review/);

    /**
     * **반려는 올린 사람에게 돌아간다** (H-84) — 등록할 때는 대표에게 갔는데 돌아오는 길이 없어서,
     * 올린 사람은 자기 신청이 왜 멈췄는지 알 길이 없었다. 사유가 문장에 실린다(사유 없이는 반려가 막힌다).
     */
    const rejectMe = (await api('post', '/accounting/expenses', managerToken)
      .send({ spendOn: kst(), category: 'supply', merchant: '문구점', purpose: '반려용', requestedAmount: 9000 }).expect(201)).body;
    expect((await api('post', `/accounting/expenses/${rejectMe.id}/review`).send({ decision: 'reject' }).expect(400)).body.code)
      .toBe('AMOUNT_REASON_REQUIRED');
    const backNotisBefore = await q(`SELECT 1 FROM noti WHERE to_id = $1 AND from_id = $2`, [MANAGER, CEO]);
    await api('post', `/accounting/expenses/${rejectMe.id}/review`).send({ decision: 'reject', reason: '영수증 첨부 필요' }).expect(201);
    const backNotis = await q<{ body: string; link: string; category: string }>(
      `SELECT body, link, category FROM noti WHERE to_id = $1 AND from_id = $2`, [MANAGER, CEO]);
    expect(backNotis).toHaveLength(backNotisBefore.length + 1);
    expect(backNotis.at(-1)).toMatchObject({ link: '/accounting?tab=out', category: 'request' });
    expect(backNotis.at(-1)!.body).toContain('영수증 첨부 필요');
  });
});
