/** @file-guide
 * 목적: BO-11AD-02 학생별 누적 원장의 서버 집계·권한·재조회 계약을 실제 PostgreSQL로 검증한다. (test)
 * 책임/재사용: 기존 INV/PAY 정본만 fixture로 만들고 최근 3개월·전체 누적·분류별 합계를 제품 endpoint에서 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import type { StudentCumulativeDto } from '../src/modules/accounting/accounting.dto';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('BO-11AD-02 학생별 누적 원장', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  let teacherToken = '';

  const CEO = 9651;
  const TEACHER = 9652;
  const STUDENT = 96511;
  const EMPTY_STUDENT = 96512;
  const PASSWORD = 'boc11-cumulative-1234';
  const invoiceIds: number[] = [];

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    ds.query(sql, params) as Promise<T[]>;
  const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const month = (delta: number) => {
    const d0 = new Date(`${today().slice(0, 7)}-01T00:00:00Z`);
    d0.setUTCMonth(d0.getUTCMonth() + delta);
    return d0.toISOString().slice(0, 7);
  };
  const recent = [month(-2), month(-1), month(0)];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await q(`DELETE FROM pay WHERE student_id = ANY($1::bigint[])`, [[STUDENT, EMPTY_STUDENT]]);
    const oldInvoices = await q<{ id: string }>(`SELECT id FROM inv WHERE student_id = ANY($1::bigint[])`, [[STUDENT, EMPTY_STUDENT]]);
    if (oldInvoices.length > 0) {
      await q(`DELETE FROM inv_line WHERE inv_id = ANY($1::bigint[])`, [oldInvoices.map((row) => Number(row.id))]);
      await q(`DELETE FROM inv WHERE id = ANY($1::bigint[])`, [oldInvoices.map((row) => Number(row.id))]);
    }
    await q(`DELETE FROM stu WHERE id = ANY($1::bigint[])`, [[STUDENT, EMPTY_STUDENT]]);
    await q(`DELETE FROM staff WHERE id = ANY($1::bigint[])`, [[CEO, TEACHER]]);

    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1, '누적대표', 'boc11-cumulative-ceo@t.kr', 'ceo', $3, true),
         ($2, '누적강사', 'boc11-cumulative-teacher@t.kr', 'teacher', $3, true)`,
      [CEO, TEACHER, passwordHash],
    );
    await q(
      `INSERT INTO stu (id, name, grade, created_at) VALUES
         ($1, '누적학생', '10', $3::date),
         ($2, '거래없는학생', '10', $3::date)`,
      [STUDENT, EMPTY_STUDENT, `${month(-3)}-01`],
    );

    const insertInvoice = async (yearMonth: string, invType: string, amount: number, paidAmount: number, state: string) => {
      const [row] = await q<{ id: string }>(
        `INSERT INTO inv (student_id, year_month, inv_type, title, amount, paid_amount, state, issued_on, due_on, created_by)
         VALUES ($1, $2::varchar, $3, $3, $4, $5, $6::inv_state_t, ($2::text || '-01')::date, ($2::text || '-28')::date, $7)
         RETURNING id`,
        [STUDENT, yearMonth, invType, amount, paidAmount, state, CEO],
      );
      invoiceIds.push(Number(row.id));
      return Number(row.id);
    };

    const oldPaid = await insertInvoice(month(-3), 'tuition', 100_000, 100_000, 'paid');
    const partial = await insertInvoice(month(-2), 'tuition', 200_000, 50_000, 'partial');
    await insertInvoice(month(-1), 'exam_fee', 30_000, 0, 'sent');
    await insertInvoice(month(0), 'tuition', 999_000, 0, 'void');

    await q(
      `INSERT INTO pay (inv_id, student_id, amount, paid_on, method, reason, entered_by, entered_at, confirmed_by, confirmed_at)
       VALUES
         ($1, $4, 100000, ($5 || '-05')::date, 'transfer', '완납', $7, now(), $7, now()),
         ($2, $4,  50000, ($6 || '-07')::date, 'transfer', '부분납', $7, now(), $7, now()),
         (NULL, $4, 20000, ($3 || '-09')::date, 'cash', '기타 입금', $7, now(), $7, now())`,
      [oldPaid, partial, month(-1), STUDENT, month(-3), month(-2), CEO],
    );

    const login = async (loginId: string) => (await request(app.getHttpServer())
      .post('/auth/login').send({ loginId, password: PASSWORD }).expect(201)).body.accessToken as string;
    ceoToken = await login('boc11-cumulative-ceo@t.kr');
    teacherToken = await login('boc11-cumulative-teacher@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await q(`DELETE FROM pay WHERE student_id = ANY($1::bigint[])`, [[STUDENT, EMPTY_STUDENT]]);
        if (invoiceIds.length > 0) {
          await q(`DELETE FROM inv_line WHERE inv_id = ANY($1::bigint[])`, [invoiceIds]);
          await q(`DELETE FROM inv WHERE id = ANY($1::bigint[])`, [invoiceIds]);
        }
        await q(`DELETE FROM stu WHERE id = ANY($1::bigint[])`, [[STUDENT, EMPTY_STUDENT]]);
        await q(`DELETE FROM staff WHERE id = ANY($1::bigint[])`, [[CEO, TEACHER]]);
      }
    } finally {
      await app?.close();
    }
  });

  const get = (path: string, token: string) => request(app.getHttpServer()).get(path)
    .set('Authorization', `Bearer ${token}`).timeout({ response: 8000, deadline: 15000 });

  it('대표만 조회하며 최근 3개월·전체 누적·미수·분류를 서버가 같은 원장에서 계산한다', async () => {
    await get('/accounting/student-cumulative', teacherToken).expect(403);
    const body = (await get('/accounting/student-cumulative', ceoToken).expect(200)).body as StudentCumulativeDto;

    expect(body).toMatchObject({ asOf: today(), recentMonths: recent, canSeeAmounts: true });
    expect(body.items.some((item) => item.studentId === EMPTY_STUDENT)).toBe(false);
    const row = body.items.find((item) => item.studentId === STUDENT)!;
    expect(row).toMatchObject({
      studentId: STUDENT,
      studentName: '누적학생',
      registeredOn: `${month(-3)}-01`,
      periodFrom: `${month(-3)}-01`,
      periodTo: today(),
      totalBilled: 330_000,
      totalCollected: 170_000,
      receivable: 180_000,
      monthlyAverageBilled: 76_667,
    });
    expect(row.months).toEqual([
      { month: month(-2), billed: 200_000, collected: 50_000 },
      { month: month(-1), billed: 30_000, collected: 20_000 },
      { month: month(0), billed: 0, collected: 0 },
    ]);
    expect(row.categories.find((item) => item.key === 'tuition')).toMatchObject({
      billed: 300_000, collected: 150_000, receivable: 150_000,
    });
    expect(row.categories.find((item) => item.key === 'exam_fee')).toMatchObject({
      billed: 30_000, collected: 0, receivable: 30_000,
    });
    expect(row.categories.find((item) => item.key === 'etc')).toMatchObject({
      billed: 0, collected: 20_000, receivable: 0,
    });
  });
});
