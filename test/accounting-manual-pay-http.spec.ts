/** @file-guide
 * 목적: accounting-manual-pay-http.spec.ts — §55 「+ 결제 등록」(청구서 없이 들어온 돈 · A-D1 ②)의 입력 방어·권한·저장
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 증명하는 것 (A-D1 · 2026-08-25 확정 「청구서 발행 + 매니저 직접 입력 둘 다」 · DECISIONS-2026-08-27 #9) —
 *   ① 청구서 없는 입금은 `pay.inv_id = NULL` 한 줄로 남고, 누가 넣었는지·무엇에 대한 돈인지가 함께 남는다.
 *      같은 트랜잭션에 LOG(PAY create) 한 줄.
 *   ② 목록(`GET /accounting` 의 payments)과 §55 분류가 그 줄을 **「기타」** 로 읽는다 — 분류 판정은 `payCategory` 한 곳(N-37 ③).
 *   ③ 금액 권한(`canMoney`)이 없으면 403 · 모르는 칸·잘못된 날짜·0원·수단 밖 낱말은 400 · 없는 학생은 404 ·
 *      사유가 공백뿐이면 409 — 어느 거절에서도 줄이 늘지 않는다.
 *
 * ⚠ 제 픽스처만 만들고 지운다(전역 DELETE 없음).
 */
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import type { AccountingDto, PaymentDto } from '../src/modules/accounting/accounting.dto';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('§55 「+ 결제 등록」 — 청구서 없이 들어온 돈 (A-D1 ② · HTTP)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  let teacherToken = '';
  const PW = 'manual-pay-1234';
  const CEO = 1611;
  const TEACHER = 1612;
  const STU = 16111;
  const MISSING_STU = 16119;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;
  const api = (m: 'post' | 'get', p: string, t: string) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`).timeout({ response: 8000, deadline: 15000 });
  const count = async () => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM pay WHERE student_id = $1`, [STU]))[0].n);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    const ids = [CEO, TEACHER];
    await q(`DELETE FROM pay WHERE student_id = $1`, [STU]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [ids]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU, MISSING_STU]]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'수기입금대표','manual-pay-ceo@t.kr','ceo',$3,true),
         ($2,'수기입금강사','manual-pay-t@t.kr','teacher',$3,true)`,
      [CEO, TEACHER, hash],
    );
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'수기입금학생','10')`, [STU]);
    const login = async (email: string) => (await request(app.getHttpServer())
      .post('/auth/login').send({ loginId: email, password: PW }).expect(201)).body.accessToken as string;
    ceoToken = await login('manual-pay-ceo@t.kr');
    teacherToken = await login('manual-pay-t@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        const ids = [CEO, TEACHER];
        await q(`DELETE FROM pay WHERE student_id = $1`, [STU]);
        await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [ids]);
        await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
        await q(`DELETE FROM stu WHERE id = $1`, [STU]);
      }
    } finally {
      await app?.close();
    }
  });

  it('① 청구서 없는 한 줄로 남고 누가·무엇에 대한 돈인지가 남는다 — 같은 트랜잭션에 LOG · ② 목록과 §55 분류는 「기타」', async () => {
    const res = await api('post', '/accounting/payments/manual', ceoToken)
      .send({ studentId: STU, amount: 35000, paidOn: '2026-09-21', method: 'transfer', reason: '  교재비 — MAP Reading 5  ', requestKey: randomUUID() })
      .expect(201);
    const row = res.body as PaymentDto;
    expect(row).toMatchObject({
      invId: null, studentId: STU, studentName: '수기입금학생', amount: 35000, paidOn: '2026-09-21',
      method: 'transfer', reason: '교재비 — MAP Reading 5', category: 'etc', categoryLabel: '기타',
    });

    const [db] = await q<{ inv_id: string | null; entered_by: string; confirmed_by: string; reason: string }>(
      `SELECT inv_id, entered_by, confirmed_by, reason FROM pay WHERE id = $1`, [row.id],
    );
    expect(db).toMatchObject({ inv_id: null, reason: '교재비 — MAP Reading 5' });
    expect(Number(db.entered_by)).toBe(CEO);
    expect(Number(db.confirmed_by)).toBe(CEO);
    const logs = await q<{ action: string; after: { studentId: number; amount: number } }>(
      `SELECT action, after FROM log WHERE entity = 'PAY' AND entity_id = $1 AND actor_id = $2`, [row.id, CEO],
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'create', after: { studentId: STU, amount: 35000 } });

    const board = (await api('get', '/accounting', ceoToken).expect(200)).body as AccountingDto;
    expect(board.payments.find((p) => p.id === row.id)).toMatchObject({ invId: null, category: 'etc', categoryLabel: '기타' });
  });

  it('③ 권한 · 입력 · 없는 학생 · 공백 사유 — 어느 거절에서도 줄이 늘지 않는다', async () => {
    const before = await count();
    const ok = { studentId: STU, amount: 10000, paidOn: '2026-09-22', reason: '조정', requestKey: randomUUID() };

    await api('post', '/accounting/payments/manual', teacherToken).send(ok).expect(403);
    await api('post', '/accounting/payments/manual', ceoToken).send({ ...ok, amount: 0 }).expect(400);
    await api('post', '/accounting/payments/manual', ceoToken).send({ ...ok, paidOn: '2026-02-30' }).expect(400);
    await api('post', '/accounting/payments/manual', ceoToken).send({ ...ok, method: 'card' }).expect(400);
    await api('post', '/accounting/payments/manual', ceoToken).send({ ...ok, invId: 1 }).expect(400);
    await api('post', '/accounting/payments/manual', ceoToken).send({ ...ok, reason: undefined }).expect(400);
    // 요청 키가 없거나 UUID 가 아니면 400 — 재시도 방지 키 없는 입금은 받지 않는다(안건 N-132)
    await api('post', '/accounting/payments/manual', ceoToken).send({ ...ok, requestKey: undefined }).expect(400);
    await api('post', '/accounting/payments/manual', ceoToken).send({ ...ok, requestKey: 'not-a-uuid' }).expect(400);
    await api('post', '/accounting/payments', ceoToken).send({ invId: 1, amount: 1000, paidOn: '2026-09-22' }).expect(400);
    const missing = await api('post', '/accounting/payments/manual', ceoToken).send({ ...ok, studentId: MISSING_STU }).expect(404);
    expect(missing.body.code).toBe('STUDENT_NOT_FOUND');
    const blank = await api('post', '/accounting/payments/manual', ceoToken).send({ ...ok, reason: '   ' }).expect(409);
    expect(blank.body.code).toBe('PAY_REASON_REQUIRED');

    expect(await count()).toBe(before);
  });
});
