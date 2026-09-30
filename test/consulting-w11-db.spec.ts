/** @file-guide
 * 목적: consulting-w11-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 컨설팅 W11 결정 채택 (C1) — N-33 ② · N-65 · N-18-a(부분) · N-63 · N-77 · PB-11 · N-73.
 *
 * 증명하는 것 —
 *   ① 청구서로 전환 — 학생이 여럿이면 사람이 고른다(studentId · 없으면 409 · 남의 학생 400) · 한 명이면 자동 · 감사 한 줄.
 *   ② 받은 돈 한 조각 — 전환 청구서 입금까지 §28 · §26 · §27 · §30 이 같은 수를 말한다(7-3 「§28 이 전환 청구서 입금을 모름」).
 *   ③ 계약 → 진행이 **실제로 넘어간 때만** 담당에게 알림 두 건(「수납 · 진행 가능」 · 「회차 기록 요청」 · 링크는 그 상세) · 넣은 사람이 담당이면 0.
 *   ④ 예외 종료 — 필수 항목 · 약정 회차만 남은 진행 중 건 · 사유 필수 · 승인 권한 · 학부모 안내는 사람이 고른 틀/적은 글만 ·
 *      남은 항목 · 회차 · 사유가 감사 원장에 · 잡아 둔 회차는 여전히 막는다 · 정상 종료가 되면 예외는 필요 없다.
 *   ⑤ 항목 수정 — 더하기(manual) · 이름 바꾸기 · 빼기 · 끝낸 항목 · 기본 항목 빼기 · 파일 붙은 항목 빼기는 409 · 막히면 아무것도 안 쓴다.
 *   ⑥ 항목 파일 — 항목마다 6개 · 계약 파일 10개와 따로 센다 · 상세의 계약 파일에 섞이지 않는다 · DB 트리거 · 빼기는 감사 원장.
 *   ⑦ 계약서 전달하기 — 메일에만 첨부 · 문자에는 안 붙음 · 실제로 나간 메일이 있을 때만 전달 단계 · 남의 파일 · 학생 · 피드백은 보내기 전에 막는다.
 *   ⑧ 지우기(PB-11) — 받은 돈 · 전환 청구서 · 회차가 있으면 409(상세 단추와 같은 문장) · 없으면 지워지고 감사 원장에 한 줄.
 *
 * 발송기는 `SENDER` 를 가짜로 갈아 끼운다 — 실제 SMTP·SENS 로 나가지 않는다.
 * ⚠ 이 파일은 **표를 비우지 않는다.** 스위트 전용 번호대(직원 955~958 · 학생 9551~9553)로 만들고 스스로 치운다.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AUDIT_WRITES } from '../src/lib/audit';
import { monthClosedMessage } from '../src/lib/month-close';
import { NOTI_TITLE } from '../src/lib/noti';
import { ConsultingSessionService } from '../src/modules/consulting/consulting-session.service';
import { ConsultingService } from '../src/modules/consulting/consulting.service';
import { SENDER } from '../src/modules/notify/sender';
import { FakeSender } from './fake-sender';
import { blockedBy, DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(120_000);

type Row = Record<string, unknown>;

d('컨설팅 W11 — 전환 학생 · 받은 돈 · 진행 알림 · 예외 종료 · 항목 수정 · 항목 파일 · 계약서 전달 · 지우기 (C1)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceo = '';
  let mgr = '';
  let teacher = '';
  const fake = new FakeSender();
  const PW = 'c1-w11-spec-1234';
  const CEO = 955;
  const MGR = 956;   // 담당(owner) 매니저
  const MGR2 = 957;  // 남 — 담당도 지정도 아니다
  const TEACHER = 958;
  const STAFF = [CEO, MGR, MGR2, TEACHER];
  const STU_A = 9551;
  const STU_B = 9552;
  const STU_C = 9553;
  const STU = [STU_A, STU_B, STU_C];

  const q = <T = Row>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const TODAY = kst();
  const api = (m: 'get' | 'post' | 'patch' | 'delete', p: string, t = ceo) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`).timeout({ response: 15000, deadline: 30000 });
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

  const myCons = async (): Promise<number[]> =>
    (await q<{ id: string }>(`SELECT id FROM cons WHERE owner_id = ANY($1::bigint[])`, [STAFF])).map((r) => Number(r.id));

  /** 이 스위트가 만든 줄만 지운다 — FK 차례대로 */
  async function cleanRows(): Promise<void> {
    const cons = await myCons();
    await q(`DELETE FROM noti WHERE to_id = ANY($1::bigint[]) OR from_id = ANY($1::bigint[])`, [STAFF]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1::bigint[])`, [STAFF]);
    await q(`DELETE FROM guardian_send WHERE student_id = ANY($1::bigint[])`, [STU]);
    await q(`DELETE FROM guardian_contact WHERE guardian_id IN (SELECT id FROM guardian WHERE student_id = ANY($1::bigint[]))`, [STU]);
    await q(`DELETE FROM guardian WHERE student_id = ANY($1::bigint[])`, [STU]);
    await q(`DELETE FROM pnoti WHERE student_id = ANY($1::bigint[])`, [STU]);
    await q(`DELETE FROM pay WHERE inv_id IN (SELECT id FROM inv WHERE student_id = ANY($1::bigint[]) OR cs_id = ANY($2::bigint[]))`, [STU, cons]);
    await q(`DELETE FROM inv_line WHERE inv_id IN (SELECT id FROM inv WHERE student_id = ANY($1::bigint[]) OR cs_id = ANY($2::bigint[]))`, [STU, cons]);
    await q(`DELETE FROM inv WHERE student_id = ANY($1::bigint[]) OR cs_id = ANY($2::bigint[])`, [STU, cons]);
    await q(`DELETE FROM todo WHERE cons_id = ANY($1::bigint[])`, [cons]);
    await q(`DELETE FROM cons_event WHERE cons_id = ANY($1::bigint[])`, [cons]);
    await q(`DELETE FROM cons_feedback WHERE cons_id = ANY($1::bigint[])`, [cons]);
    const files = (await q<{ file_id: string }>(`SELECT file_id FROM cons_file WHERE cons_id = ANY($1::bigint[])`, [cons])).map((r) => Number(r.file_id));
    await q(`DELETE FROM cons_file WHERE cons_id = ANY($1::bigint[])`, [cons]);
    await q(`DELETE FROM file WHERE id = ANY($1::bigint[]) OR uploaded_by = ANY($2::bigint[])`, [files, STAFF]);
    await q(`DELETE FROM cons_item WHERE cons_id = ANY($1::bigint[])`, [cons]);
    await q(`DELETE FROM cons_pay WHERE cons_id = ANY($1::bigint[])`, [cons]);
    await q(`DELETE FROM cons_sess WHERE cons_id = ANY($1::bigint[])`, [cons]);
    await q(`DELETE FROM cons_stu WHERE cons_id = ANY($1::bigint[])`, [cons]);
    await q(`DELETE FROM cons_pick WHERE cons_id = ANY($1::bigint[])`, [cons]);
    await q(`DELETE FROM cons WHERE id = ANY($1::bigint[])`, [cons]);
    // 월 마감 시험(A′ 후속)이 세운 줄 — 이 스위트 직원이 마감한 것만
    await q(`DELETE FROM month_close WHERE closed_by = ANY($1::bigint[]) OR reopened_by = ANY($1::bigint[])`, [STAFF]);
  }

  /** 계약 상태를 SQL 로 바로 세운다 — 시험 대상은 그다음의 쓰기다 */
  const makeCons = async (o: {
    stage: 'contract' | 'running' | 'done'; step: number; amount?: number; sessions?: number | null; students: number[];
    owner?: number; share?: string; type?: string;
    items?: Array<{ label: string; required: boolean; done?: boolean; source?: 'template' | 'manual' }>;
  }): Promise<number> => {
    const [c] = await q<{ id: string }>(
      `INSERT INTO cons (cons_type, stage, contract_step, amount, sessions, start_on, end_on, requester, owner_id, share)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, 'mother', $8, $9) RETURNING id`,
      [o.type ?? 'essay', o.stage, o.step, o.amount ?? 600000, o.sessions === undefined ? 4 : o.sessions,
        plus(TODAY, -30), plus(TODAY, 60), o.owner ?? MGR, o.share ?? 'all'],
    );
    const id = Number(c.id);
    await q(`INSERT INTO cons_stu (cons_id, student_id) SELECT $1, unnest($2::bigint[])`, [id, o.students]);
    let seq = 1;
    for (const it of o.items ?? []) {
      await q(
        `INSERT INTO cons_item (cons_id, seq, label, required, done, done_by, done_at, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, seq++, it.label, it.required, it.done === true, it.done ? MGR : null, it.done ? new Date() : null, it.source ?? 'template'],
      );
    }
    return id;
  };
  const itemIds = async (consId: number) =>
    (await q<{ id: string; label: string }>(`SELECT id, label FROM cons_item WHERE cons_id = $1 ORDER BY seq`, [consId]))
      .reduce<Record<string, number>>((m, r) => ({ ...m, [r.label]: Number(r.id) }), {});
  const auditRows = (consId: number, action: string) =>
    q<{ actor_id: string; before: Row | null; after: Row | null }>(
      `SELECT actor_id, before, after FROM log WHERE entity = 'CONS' AND entity_id = $1 AND action = $2 ORDER BY id`, [consId, action],
    );
  const stageOf = async (consId: number) =>
    (await q<{ stage: string; contract_step: number }>(`SELECT stage, contract_step FROM cons WHERE id = $1`, [consId]))[0]!;
  const notisTo = (staffId: number) =>
    q<{ title: string; body: string; link: string; category: string; from_id: string | null }>(
      `SELECT title, body, link, category, from_id FROM noti WHERE to_id = $1 ORDER BY id`, [staffId],
    );
  const listItem = async (consId: number, t = ceo) => {
    const res = await api('get', '/consulting', t).expect(200);
    return (res.body.items as Row[]).find((x) => Number(x.id) === consId)!;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SENDER).useValue(fake)
      .compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await cleanRows();
    await q(`DELETE FROM stu WHERE id = ANY($1::bigint[])`, [STU]);
    await q(`DELETE FROM staff WHERE id = ANY($1::bigint[])`, [STAFF]);
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'W11대표','c1-w11-ceo@t.kr','ceo',$5,true),
         ($2,'W11담당','c1-w11-mgr@t.kr','manager',$5,true),
         ($3,'W11남','c1-w11-mgr2@t.kr','manager',$5,true),
         ($4,'W11강사','c1-w11-t@t.kr','teacher',$5,true)`,
      [CEO, MGR, MGR2, TEACHER, hash],
    );
    await q(`INSERT INTO stu (id, name, grade) VALUES ($1,'W11가','G12'), ($2,'W11나','G10'), ($3,'W11다','G9')`, [STU_A, STU_B, STU_C]);
    const login = async (loginId: string) => {
      const res = await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ loginId, password: PW }).expect(201);
      return res.body.accessToken as string;
    };
    ceo = await login('c1-w11-ceo@t.kr');
    mgr = await login('c1-w11-mgr@t.kr');
    teacher = await login('c1-w11-t@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await cleanRows();
        await q(`DELETE FROM stu WHERE id = ANY($1::bigint[])`, [STU]);
        await q(`DELETE FROM staff WHERE id = ANY($1::bigint[])`, [STAFF]);
      }
    } finally {
      await app?.close();
    }
  });

  beforeEach(async () => {
    fake.readyMap = { email: false, sms: false };
    fake.reply = () => ({ configured: true, ok: true, providerId: 'fake-1', error: null });
    fake.calls = [];
    await cleanRows();
  });

  /* ══ ① N-33 ② — 청구서로 전환: 받는 학생을 사람이 고른다 ══════════════════════════════════ */

  describe('N-33 ② 청구서로 전환 — 받는 학생', () => {
    it('학생이 둘이면 고르지 않으면 409 · 그 컨설팅 학생이 아니면 400 · 고르면 그 학생 앞으로 남은 돈 · 감사 원장에 한 줄 (N-73)', async () => {
      const id = await makeCons({ stage: 'contract', step: 5, amount: 600000, students: [STU_A, STU_B] });
      await q(`INSERT INTO cons_pay (cons_id, amount, paid_on, by_id) VALUES ($1, 200000, $2::date, $3)`, [id, TODAY, CEO]);

      const row = (await api('get', '/consulting/accounting').expect(200)).body.items.find((x: Row) => x.id === id);
      // 고르개 재료 — 학생 id · 이름(이름 차례)
      expect(row.students).toEqual([{ id: STU_A, name: 'W11가' }, { id: STU_B, name: 'W11나' }]);

      const none = await api('post', `/consulting/${id}/invoice`).send({}).expect(409);
      expect(none.body.code).toBe('CONS_INV_STUDENT_AMBIGUOUS');
      expect(none.body.message).toContain('고르세요');
      const other = await api('post', `/consulting/${id}/invoice`).send({ studentId: STU_C }).expect(400);
      expect(other.body.code).toBe('CONS_INV_STUDENT_INVALID');
      expect(await auditRows(id, 'to_invoice')).toHaveLength(0);          // 되돌린 쓰기에는 0줄

      const done = await api('post', `/consulting/${id}/invoice`).send({ studentId: STU_B }).expect(201);
      const [inv] = await q<{ student_id: string; amount: number; cs_id: string }>(`SELECT student_id, amount, cs_id FROM inv WHERE id = $1`, [done.body.invId]);
      expect(Number(inv.student_id)).toBe(STU_B);
      expect(Number(inv.amount)).toBe(400000);                           // 남은 돈
      const logs = await auditRows(id, 'to_invoice');
      expect(logs).toHaveLength(1);
      expect(Number(logs[0]!.actor_id)).toBe(CEO);
      expect(logs[0]!.after).toMatchObject({ invId: Number(done.body.invId), studentId: STU_B, amount: 400000 });
    });

    it('학생이 한 명이면 비워도 그 학생이다 — 강사는 403', async () => {
      const id = await makeCons({ stage: 'contract', step: 5, amount: 300000, students: [STU_A] });
      await api('post', `/consulting/${id}/invoice`, teacher).send({}).expect(403);
      const res = await api('post', `/consulting/${id}/invoice`).send({}).expect(201);
      const [inv] = await q<{ student_id: string }>(`SELECT student_id FROM inv WHERE id = $1`, [res.body.invId]);
      expect(Number(inv.student_id)).toBe(STU_A);
    });

    /**
     * W11 A′ 후속(M1 발견) — 전환은 달 마감을 보지 않아 **마감한 달에도 청구서가 섰다.**
     * 전환 청구서의 달(오늘 KST 의 달)을 발행 · 이월과 같은 축(`assertMonthOpenForWrite` — 달 열쇠를 공유로 잡은 뒤 읽는다)에서 막는다.
     */
    it('마감한 달에는 전환 청구서를 내지 않는다 — 409 MONTH_CLOSED(발행 · 이월과 같은 문장) · 청구서 · 감사 줄 0 · 해제하면 그 달로 선다 (A′ 후속)', async () => {
      const id = await makeCons({ stage: 'contract', step: 5, amount: 300000, students: [STU_A] });
      const month = TODAY.slice(0, 7);
      await q(`INSERT INTO month_close (year_month, closed_by) VALUES ($1, $2)`, [month, CEO]);

      const refused = await api('post', `/consulting/${id}/invoice`).send({}).expect(409);
      expect(refused.body).toMatchObject({ code: 'MONTH_CLOSED', message: monthClosedMessage(month) });
      expect(await q(`SELECT id FROM inv WHERE cs_id = $1`, [id])).toHaveLength(0);
      expect(await auditRows(id, 'to_invoice')).toHaveLength(0);

      await q(
        `UPDATE month_close SET reopened_at = now(), reopened_by = $2, reopen_reason = '시험' WHERE year_month = $1 AND reopened_at IS NULL`,
        [month, CEO],
      );
      const res = await api('post', `/consulting/${id}/invoice`).send({}).expect(201);
      const [inv] = await q<{ year_month: string }>(`SELECT year_month FROM inv WHERE id = $1`, [res.body.invId]);
      expect(inv.year_month).toBe(month);
    });
  });

  /* ══ ② N-33 ② · ③ N-65 — 받은 돈 한 조각 · 진행 알림 ═══════════════════════════════════════ */

  describe('N-33 ② 받은 돈 한 조각 · N-65 계약 → 진행 알림', () => {
    it('전환 청구서 입금까지 §28 · §26 · §27 · §30 이 같은 받은 돈을 말하고, 다 받는 순간 담당에게 알림 두 건 (I-90+)', async () => {
      const id = await makeCons({ stage: 'contract', step: 5, amount: 600000, students: [STU_A] });
      await q(`INSERT INTO cons_pay (cons_id, amount, paid_on, by_id) VALUES ($1, 200000, $2::date, $3)`, [id, TODAY, CEO]);
      const invId = Number((await api('post', `/consulting/${id}/invoice`).send({}).expect(201)).body.invId);
      await api('post', `/accounting/invoices/${invId}/deliver`).send({}).expect(201);

      await api('post', '/accounting/payments').send({ requestKey: randomUUID(), invId, amount: 150000, paidOn: TODAY }).expect(201);
      expect((await stageOf(id)).stage).toBe('contract');
      expect(await notisTo(MGR)).toHaveLength(0);                        // 아직 다 안 받았다
      const mid = (await api('get', '/consulting/accounting').expect(200)).body.items.find((x: Row) => x.id === id);
      expect(mid).toMatchObject({ paid: 350000, due: 250000 });           // 7-3 — 전환 청구서 입금을 안다

      await api('post', '/accounting/payments').send({ requestKey: randomUUID(), invId, amount: 250000, paidOn: TODAY }).expect(201);
      expect((await stageOf(id)).stage).toBe('running');
      const notis = await notisTo(MGR);
      expect(notis.map((n) => n.title)).toEqual([NOTI_TITLE.consPaid, NOTI_TITLE.consRecordRequest]);
      for (const n of notis) {
        expect(n.link).toBe(`/consulting?id=${id}`);
        expect(n.category).toBe('etc');
        expect(Number(n.from_id)).toBe(CEO);
        expect(n.body).toContain('W11가');
      }

      // 네 화면이 같은 수 — 한 조각
      const acct = (await api('get', '/consulting/accounting').expect(200)).body.items.find((x: Row) => x.id === id);
      expect(acct).toMatchObject({ paid: 600000, due: 0 });
      const detail = (await api('get', `/consulting/${id}`).expect(200)).body;
      expect(detail.payment).toMatchObject({ paid: 600000, due: 0 });
      expect((await listItem(id)).paidAmount).toBe(600000);
      const students = (await api('get', '/consulting/students').expect(200)).body.items as Array<{ studentId: number; cases: Row[] }>;
      const kase = students.find((s) => s.studentId === STU_A)!.cases.find((c) => c.id === id)!;
      expect(kase.paid).toBe(600000);
    });

    it('납부 넣기로 다 받아도 같은 두 건 — 조금씩 받는 동안에는 없고 넘어간 뒤에는 다시 가지 않는다', async () => {
      const id = await makeCons({ stage: 'contract', step: 5, amount: 300000, students: [STU_A] });
      await api('post', `/consulting/${id}/payments`).send({ requestKey: randomUUID(), amount: 100000, paidOn: TODAY }).expect(201);
      expect(await notisTo(MGR)).toHaveLength(0);
      await api('post', `/consulting/${id}/payments`).send({ requestKey: randomUUID(), amount: 200000, paidOn: TODAY }).expect(201);
      expect((await stageOf(id)).stage).toBe('running');
      expect(await notisTo(MGR)).toHaveLength(2);
      // 더 넣을 돈은 없다(OVERPAY) — 알림도 더 가지 않는다
      await api('post', `/consulting/${id}/payments`).send({ requestKey: randomUUID(), amount: 1, paidOn: TODAY }).expect(409);
      expect(await notisTo(MGR)).toHaveLength(2);
    });

    it('수납을 넣은 사람이 담당이면 되알리지 않는다 — 진행으로 넘어가기는 한다', async () => {
      const id = await makeCons({ stage: 'contract', step: 5, amount: 100000, students: [STU_A], owner: CEO });
      await api('post', `/consulting/${id}/payments`).send({ requestKey: randomUUID(), amount: 100000, paidOn: TODAY }).expect(201);
      expect((await stageOf(id)).stage).toBe('running');
      expect(await notisTo(CEO)).toHaveLength(0);
    });
  });

  /* ══ ④ N-18-a 예외 종료 ══════════════════════════════════════════════════════════════════ */

  describe('N-18-a 예외 종료 (DQ6 권장안)', () => {
    const makeRunning = async () => {
      const id = await makeCons({ stage: 'running', step: 5, sessions: 4, students: [STU_A], items: [{ label: '원서', required: true }] });
      await q(`INSERT INTO cons_sess (cons_id, seq, on_date, who, what) VALUES ($1, 1, $2::date, 'W11담당 · W11가', '첫 만남')`, [id, plus(TODAY, -7)]);
      return id;
    };

    it('정상 종료가 막힌 이유 그대로 · 예외 종료는 승인 권한이 있을 때만 선다', async () => {
      const id = await makeRunning();
      const detail = (await api('get', `/consulting/${id}`).expect(200)).body;
      expect(detail.capabilities.canClose).toBe(false);
      expect(detail.capabilities.closeBlockedReason).toContain('필수 항목 1개');
      expect(detail.capabilities.canCloseException).toBe(true);
      // 승인은 대표 전용 판정 한 줄(ceoGate) — P1 동안은 매니저에게도 열려 있다(되돌리면 대표만)
      expect((await api('get', `/consulting/${id}`, mgr).expect(200)).body.capabilities.canCloseException).toBe(true);
      // 판정 재료가 없으면(승인 권한 없음) 단추가 서지 않는다 — 서비스 한 곳이 같은 답을 한다
      const noAuth = await app.get(ConsultingService).detail(MGR2, true, true, id, false);
      expect(noAuth.capabilities.canCloseException).toBe(false);
    });

    it('사유 없이는 400 · 문구 틀도 글도 없으면 400 · 승인 권한 없으면 403 · 미리보기는 쓰기 0', async () => {
      const id = await makeRunning();
      await api('post', `/consulting/${id}/close/preview`).send({ exception: { reason: '   ' }, memo: '안내' }).expect(400);
      const noNotice = await api('post', `/consulting/${id}/close/preview`).send({ exception: { reason: '학부모 요청으로 중단' } }).expect(400);
      expect(noNotice.body.code).toBe('CONS_CLOSE_NOTICE_REQUIRED');
      await expect(app.get(ConsultingSessionService).close(CEO, true, id, { exception: { reason: '사유' }, memo: '안내' }, true, false))
        .rejects.toMatchObject({ status: 403, response: { code: 'CONS_CLOSE_EXCEPTION_FORBIDDEN' } });

      const pv = await api('post', `/consulting/${id}/close/preview`).send({ exception: { reason: '학부모 요청으로 중단' }, memo: '그동안 감사했습니다' }).expect(201);
      expect(pv.body).toMatchObject({ preview: true, exception: true, noticeBody: '그동안 감사했습니다', parentNotices: 1 });
      expect((await stageOf(id)).stage).toBe('running');
      expect(await auditRows(id, 'close_exception')).toHaveLength(0);
    });

    it('확정 — 종료 · 학부모 안내는 적은 글 그대로 · 남은 항목 · 회차 · 사유 · 승인자가 감사 원장에 · 상세가 사유를 말한다', async () => {
      const id = await makeRunning();
      const res = await api('post', `/consulting/${id}/close`).send({ exception: { reason: ' 학부모 요청으로 중단 ' }, memo: '그동안 감사했습니다' }).expect(201);
      expect(res.body).toMatchObject({ preview: false, exception: true, stage: 'done' });
      expect((await stageOf(id)).stage).toBe('done');
      const [{ closed }] = await q<{ closed: number }>(`SELECT count(*)::int AS closed FROM cons_event WHERE cons_id = $1 AND event_type = 'closed'`, [id]);
      expect(closed).toBe(1);
      const notices = await q<{ body: string }>(`SELECT body FROM pnoti WHERE student_id = $1 AND audience = 'parent'`, [STU_A]);
      expect(notices.map((n) => n.body)).toEqual(['그동안 감사했습니다']);   // 서버가 「마무리되었습니다」를 짓지 않는다

      const logs = await auditRows(id, 'close_exception');
      expect(logs).toHaveLength(1);
      expect(Number(logs[0]!.actor_id)).toBe(CEO);                        // 승인자
      expect(logs[0]!.before).toMatchObject({
        stage: 'running', sessions: 4, sessionsDone: 1, requiredLeft: 1,
        itemsLeft: [expect.objectContaining({ label: '원서', required: true })],
        sessionsLog: [expect.objectContaining({ seq: 1 })],
      });
      expect(logs[0]!.after).toMatchObject({ stage: 'done', reason: '학부모 요청으로 중단' });

      const detail = (await api('get', `/consulting/${id}`).expect(200)).body;
      expect(detail.closeReason).toBe('학부모 요청으로 중단');
      expect(detail.closedByName).toBe('W11대표');
    });

    it('앞으로 잡아 둔 회차가 있으면 예외로도 닫지 않는다 · 정상 종료가 되는 건에는 예외가 필요 없다 · 계약 단계는 409', async () => {
      const planned = await makeCons({ stage: 'running', step: 5, sessions: 4, students: [STU_A] });
      await q(`INSERT INTO cons_sess (cons_id, seq, on_date) VALUES ($1, 1, $2::date)`, [planned, plus(TODAY, 5)]);
      const a = await api('post', `/consulting/${planned}/close/preview`).send({ exception: { reason: '사유' }, memo: '안내' }).expect(409);
      expect(a.body.code).toBe('CONS_SESSIONS_PLANNED');
      expect((await api('get', `/consulting/${planned}`).expect(200)).body.capabilities.canCloseException).toBe(false);

      const ok = await makeCons({ stage: 'running', step: 5, sessions: 1, students: [STU_A] });
      await q(`INSERT INTO cons_sess (cons_id, seq, on_date) VALUES ($1, 1, $2::date)`, [ok, plus(TODAY, -1)]);
      const b = await api('post', `/consulting/${ok}/close/preview`).send({ exception: { reason: '사유' }, memo: '안내' }).expect(409);
      expect(b.body.code).toBe('CONS_CLOSE_EXCEPTION_NOT_NEEDED');
      const okDetail = (await api('get', `/consulting/${ok}`).expect(200)).body;
      expect(okDetail.capabilities).toMatchObject({ canClose: true, canCloseException: false });

      const early = await makeCons({ stage: 'contract', step: 2, students: [STU_A] });
      const c = await api('post', `/consulting/${early}/close/preview`).send({ exception: { reason: '사유' }, memo: '안내' }).expect(409);
      expect(c.body.code).toBe('CONS_NOT_RUNNING');
    });
  });

  /* ══ ⑤ 항목 수정 (원문 §31 · N-18-a DQ5 대안) ══════════════════════════════════════════════ */

  describe('항목 수정 — 더하기 · 이름 바꾸기 · 빼기', () => {
    const setup = () => makeCons({
      stage: 'running', step: 5, students: [STU_A],
      items: [
        { label: '지원서 작성', required: true },
        { label: '재학 증명서', required: true, done: true },
        { label: '추가 메모', required: false, source: 'manual' },
      ],
    });

    it('단추는 서버가 정한다 — 끝낸 항목은 이름 바꾸기·빼기 없음 · 기본 항목은 빼기 없음 · 담당이 더한 항목은 둘 다', async () => {
      const id = await setup();
      const items = (await listItem(id)).items as Array<Row>;
      expect(items.map((i) => [i.label, i.canRename, i.canRemove, i.canAddFile, (i.files as unknown[]).length])).toEqual([
        ['지원서 작성', true, false, true, 0],
        ['재학 증명서', false, false, true, 0],
        ['추가 메모', true, true, true, 0],
      ]);
      expect((await api('get', `/consulting/${id}`).expect(200)).body.capabilities.canEditItems).toBe(true);
    });

    it('더하기 — manual · 맨 뒤 · 필수는 담당이 고른다 · 필수면 종료 조건에 든다 · 활동 원장과 감사 원장에 한 줄씩', async () => {
      const id = await setup();
      const res = await api('patch', `/consulting/${id}/items`).send({ add: [{ label: '  추가 서류  ', required: true }] }).expect(200);
      const last = (res.body as Row[]).at(-1)!;
      expect(last).toMatchObject({ label: '추가 서류', source: 'manual', required: true, seq: 4, canRemove: true, files: [] });
      const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM cons_event WHERE cons_id = $1 AND event_type = 'item_added'`, [id]);
      expect(n).toBe(1);
      const logs = await auditRows(id, 'items');
      expect(logs).toHaveLength(1);
      expect(((logs[0]!.before as { items: unknown[] }).items)).toHaveLength(3);
      expect(((logs[0]!.after as { items: unknown[] }).items)).toHaveLength(4);
      expect((await api('get', `/consulting/${id}`).expect(200)).body.requiredLeft).toBe(2);
    });

    it('이름 바꾸기 — 안 끝낸 항목만 · 끝낸 항목은 409 이고 같은 요청의 다른 줄도 쓰지 않는다', async () => {
      const id = await setup();
      const ids = await itemIds(id);
      await api('patch', `/consulting/${id}/items`).send({ rename: [{ id: ids['지원서 작성'], label: '지원서 초안' }] }).expect(200);
      expect(Object.keys(await itemIds(id))).toContain('지원서 초안');
      const bad = await api('patch', `/consulting/${id}/items`)
        .send({ rename: [{ id: ids['재학 증명서'], label: '다른 이름' }], add: [{ label: '끼어든 항목', required: false }] }).expect(409);
      expect(bad.body.code).toBe('CONS_ITEM_DONE');
      expect(Object.keys(await itemIds(id))).not.toContain('끼어든 항목');
      expect(await auditRows(id, 'items')).toHaveLength(1);                // 막힌 쓰기에는 줄이 없다
    });

    it('빼기 — 기본 항목은 409 · 파일이 붙은 항목은 409 · 파일을 빼면 담당이 더한 항목은 빠진다', async () => {
      const id = await setup();
      const ids = await itemIds(id);
      const tpl = await api('patch', `/consulting/${id}/items`).send({ remove: [ids['지원서 작성']] }).expect(409);
      expect(tpl.body.code).toBe('CONS_ITEM_TEMPLATE');
      const up = await api('post', `/consulting/${id}/items/${ids['추가 메모']}/files`).send({ name: '메모.txt', base64: b64('memo') }).expect(201);
      const withFile = await api('patch', `/consulting/${id}/items`).send({ remove: [ids['추가 메모']] }).expect(409);
      expect(withFile.body.code).toBe('CONS_ITEM_HAS_FILES');
      await api('delete', `/consulting/${id}/items/${ids['추가 메모']}/files/${up.body.id}`).expect(204);
      await api('patch', `/consulting/${id}/items`).send({ remove: [ids['추가 메모']] }).expect(200);
      expect(Object.keys(await itemIds(id))).not.toContain('추가 메모');
      const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM cons_event WHERE cons_id = $1 AND event_type = 'item_removed'`, [id]);
      expect(n).toBe(1);
    });

    /*
     * I-94 「기한이 있으면 D-day 표시」 — 항목에 기한 칸(due_on · 없으면 NULL)이 생겼다. 「항목 수정」이 더할 때 · 따로(due) 적고 지운다.
     * D-day 낱말과 지남은 서버가 적는다(오늘 KST 기준 · 끝낸 항목은 기한을 말하지 않는다). 끝낸 항목의 기한은 이름처럼 바꾸지 않는다.
     */
    it('기한 — 더할 때 · 따로 적고 지운다 · D-day 와 지남은 서버가 적는다 · 끝낸 항목은 409 · 감사 원장에 앞뒤 기한 (I-94)', async () => {
      const id = await setup();
      const ids = await itemIds(id);
      const res = await api('patch', `/consulting/${id}/items`).send({
        due: [{ id: ids['지원서 작성'], dueOn: plus(TODAY, 3) }, { id: ids['추가 메모'], dueOn: plus(TODAY, -2) }],
        add: [{ label: '면접 준비', required: false, dueOn: TODAY }],
      }).expect(200);
      const by = Object.fromEntries((res.body as Row[]).map((r) => [r.label, r]));
      expect(by['지원서 작성']).toMatchObject({ dueOn: plus(TODAY, 3), dueLabel: 'D-3', dueOverdue: false });
      expect(by['추가 메모']).toMatchObject({ dueOn: plus(TODAY, -2), dueLabel: 'D+2', dueOverdue: true });
      expect(by['면접 준비']).toMatchObject({ dueOn: TODAY, dueLabel: 'D-day', dueOverdue: false });
      expect(by['재학 증명서']).toMatchObject({ dueOn: null, dueLabel: null, dueOverdue: false });
      const done = await api('patch', `/consulting/${id}/items`).send({ due: [{ id: ids['재학 증명서'], dueOn: plus(TODAY, 1) }] }).expect(409);
      expect(done.body.code).toBe('CONS_ITEM_DONE');
      const cleared = await api('patch', `/consulting/${id}/items`).send({ due: [{ id: ids['지원서 작성'], dueOn: null }] }).expect(200);
      expect((cleared.body as Row[]).find((r) => r.label === '지원서 작성')).toMatchObject({ dueOn: null, dueLabel: null });
      const logs = await auditRows(id, 'items');
      expect(logs).toHaveLength(2);
      const beforeDue = ((logs[1]!.before as { items: Array<{ label: string; dueOn: string | null }> }).items).find((x) => x.label === '지원서 작성');
      expect(beforeDue?.dueOn).toBe(plus(TODAY, 3));
      // 끝내면 기한을 말하지 않는다
      await api('patch', `/consulting/${id}/items/${ids['추가 메모']}`).send({ done: true }).expect(200);
      const after = (await listItem(id)).items as Row[];
      expect(after.find((r) => r.label === '추가 메모')).toMatchObject({ dueOn: plus(TODAY, -2), dueLabel: null, dueOverdue: false });
      await api('patch', `/consulting/${id}/items`).send({ due: [{ id: ids['지원서 작성'], dueOn: '2026-02-30' }] }).expect(400);
    });

    it('같은 이름 400 · 빈 요청 409 · 한 항목 두 번 400 · 없는 항목 404 · 종료된 건 409 · 강사 403', async () => {
      const id = await setup();
      const ids = await itemIds(id);
      expect((await api('patch', `/consulting/${id}/items`).send({ add: [{ label: '재학 증명서', required: false }] }).expect(400)).body.code).toBe('CONS_ITEM_DUPLICATE');
      expect((await api('patch', `/consulting/${id}/items`).send({}).expect(409)).body.code).toBe('EMPTY_PATCH');
      expect((await api('patch', `/consulting/${id}/items`).send({ rename: [{ id: ids['추가 메모'], label: 'a' }], remove: [ids['추가 메모']] }).expect(400)).body.code).toBe('CONS_ITEM_OP_DUPLICATE');
      await api('patch', `/consulting/${id}/items`).send({ remove: [987654321] }).expect(404);
      await api('patch', `/consulting/${id}/items`, teacher).send({ add: [{ label: 'x', required: false }] }).expect(403);
      await q(`UPDATE cons SET stage = 'done' WHERE id = $1`, [id]);
      expect((await api('patch', `/consulting/${id}/items`).send({ add: [{ label: 'x', required: false }] }).expect(409)).body.code).toBe('ITEM_LOCKED');
      expect((await api('get', `/consulting/${id}`).expect(200)).body.capabilities.canEditItems).toBe(false);
    });
  });

  /* ══ ⑥ N-63 항목 파일 ══════════════════════════════════════════════════════════════════════ */

  describe('N-63 항목 파일 — 항목마다 6개 · 계약 파일 10개와 따로', () => {
    it('항목마다 6개 · 일곱째는 409 · 상세의 계약 파일에 섞이지 않고 계약 파일 칸은 그대로 열려 있다', async () => {
      const id = await makeCons({ stage: 'contract', step: 1, students: [STU_A], items: [{ label: '지원서 작성', required: true }] });
      const item = (await itemIds(id))['지원서 작성']!;
      for (let i = 1; i <= 6; i += 1) {
        const up = await api('post', `/consulting/${id}/items/${item}/files`).send({ name: `증빙${i}.pdf`, base64: b64(`proof ${i}`) }).expect(201);
        expect(up.body.role).toBe('item');
      }
      const seventh = await api('post', `/consulting/${id}/items/${item}/files`).send({ name: '증빙7.pdf', base64: b64('proof 7') }).expect(409);
      expect(seventh.body.code).toBe('CONS_ITEM_FILE_LIMIT');
      const row = ((await listItem(id)).items as Row[])[0]!;
      expect((row.files as Row[]).map((f) => f.name)).toEqual(['증빙1.pdf', '증빙2.pdf', '증빙3.pdf', '증빙4.pdf', '증빙5.pdf', '증빙6.pdf']);
      expect(row.canAddFile).toBe(false);

      const detail = (await api('get', `/consulting/${id}`).expect(200)).body;
      expect(detail.contractFiles).toHaveLength(0);
      expect(detail.capabilities.canAddContractFile).toBe(true);
      const contract = await api('post', `/consulting/${id}/contract-files`).send({ name: '계약서.pdf', base64: b64('contract') }).expect(201);
      expect(contract.body.role).toBe('draft');                           // 항목 파일을 계약서 초안으로 세지 않는다
      expect((await stageOf(id)).contract_step).toBe(2);
    });

    it('DB 트리거 · 짝 CHECK 가 마지막에 막는다 — 일곱째 · 다른 컨설팅의 항목 · role 과 item_id 짝', async () => {
      const id = await makeCons({ stage: 'contract', step: 1, students: [STU_A], items: [{ label: '원서', required: true }] });
      const other = await makeCons({ stage: 'contract', step: 1, students: [STU_A], items: [{ label: '남의 항목', required: true }] });
      const item = (await itemIds(id))['원서']!;
      const otherItem = (await itemIds(other))['남의 항목']!;
      const qr = ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        const file = async () => Number(((await qr.query(
          `INSERT INTO file (kind, name, mime, bytes, sha256, data, uploaded_by)
           VALUES ('cons-item', 'x.txt', 'text/plain', 1, encode(sha256('a'::bytea), 'hex'), 'a'::bytea, $1) RETURNING id`, [CEO],
        )) as Array<{ id: string }>)[0]!.id);
        for (let i = 0; i < 6; i += 1) {
          await qr.query(`INSERT INTO cons_file (file_id, cons_id, role, created_by, item_id) VALUES ($1, $2, 'item', $3, $4)`, [await file(), id, CEO, item]);
        }
        expect(await blockedBy(qr, `INSERT INTO cons_file (file_id, cons_id, role, created_by, item_id) VALUES ($1, $2, 'item', $3, $4)`, [await file(), id, CEO, item]))
          .toContain('item files are limited to 6');
        expect(await blockedBy(qr, `INSERT INTO cons_file (file_id, cons_id, role, created_by, item_id) VALUES ($1, $2, 'item', $3, $4)`, [await file(), id, CEO, otherItem]))
          .toContain('same consulting');
        expect(await blockedBy(qr, `INSERT INTO cons_file (file_id, cons_id, role, created_by, item_id) VALUES ($1, $2, 'item', $3, NULL)`, [await file(), id, CEO]))
          .toContain('cons_file_item_pair_check');
        expect(await blockedBy(qr, `INSERT INTO cons_file (file_id, cons_id, role, created_by, item_id) VALUES ($1, $2, 'draft', $3, $4)`, [await file(), other, CEO, otherItem]))
          .toContain('cons_file_item_pair_check');
      } finally {
        await qr.rollbackTransaction();
        await qr.release();
      }
    });

    it('빼기는 감사 원장에 한 줄 · 파일 본문까지 지운다 · 내려받기는 같은 권한(강사 403) · 종료된 건은 409', async () => {
      const id = await makeCons({ stage: 'running', step: 5, students: [STU_A], items: [{ label: '원서', required: true }] });
      const item = (await itemIds(id))['원서']!;
      const up = await api('post', `/consulting/${id}/items/${item}/files`).send({ name: '원서.pdf', base64: b64('application form') }).expect(201);
      await api('get', `/files/${up.body.id}`).expect(200);
      await api('get', `/files/${up.body.id}`, teacher).expect(403);
      await api('post', `/consulting/${id}/items/${item}/files`, teacher).send({ name: 'x.pdf', base64: b64('x') }).expect(403);

      await api('delete', `/consulting/${id}/items/${item}/files/${up.body.id}`).expect(204);
      expect(await q(`SELECT 1 FROM file WHERE id = $1`, [up.body.id])).toHaveLength(0);
      const logs = await auditRows(id, 'item_file_delete');
      expect(logs).toHaveLength(1);
      expect(logs[0]!.before).toMatchObject({ itemId: item, fileId: Number(up.body.id), name: '원서.pdf' });

      const again = await api('post', `/consulting/${id}/items/${item}/files`).send({ name: '원서2.pdf', base64: b64('form 2') }).expect(201);
      await q(`UPDATE cons SET stage = 'done' WHERE id = $1`, [id]);
      expect((await api('delete', `/consulting/${id}/items/${item}/files/${again.body.id}`).expect(409)).body.code).toBe('ITEM_LOCKED');
      expect((await api('post', `/consulting/${id}/items/${item}/files`).send({ name: 'z.pdf', base64: b64('z') }).expect(409)).body.code).toBe('ITEM_LOCKED');
    });
  });

  /* ══ ⑦ N-77 계약서 전달하기 ════════════════════════════════════════════════════════════════ */

  describe('N-77 계약서 전달하기 — 메일에 첨부 · 실제로 나가야 전달', () => {
    const CONTRACT = 'contract body bytes';
    const setup = async () => {
      const created = await api('post', '/consulting').send({
        consType: 'essay', studentIds: [STU_A], requester: 'mother', ownerId: MGR, amount: 500000, sessions: 4,
        startOn: TODAY, endOn: plus(TODAY, 60), share: 'all',
      }).expect(201);
      const id = Number(created.body.id);
      const file = await api('post', `/consulting/${id}/contract-files`).send({ name: '계약서.pdf', base64: b64(CONTRACT) }).expect(201);
      const guardian = await api('post', `/students/${STU_A}/guardians`).send({
        name: 'W11보호자', email: 'w11-parent@example.com', receiveEmail: true, phone: '010-1234-5678', receiveSms: true,
      }).expect(201);
      return { id, fileId: Number(file.body.id), guardianId: Number(guardian.body.id) };
    };
    const send = (o: { studentId?: number; guardianId: number; channels: string[]; files: number[] }) =>
      api('post', '/guardians/send').send({
        studentId: o.studentId ?? STU_A, guardianIds: [o.guardianId], channels: o.channels,
        body: '계약서를 보내 드립니다. 확인 부탁드립니다.', requestKey: randomUUID(), consFileIds: o.files,
      });
    const deliveries = async (id: number) =>
      (await q<{ n: number }>(`SELECT count(*)::int AS n FROM cons_event WHERE cons_id = $1 AND event_type = 'parent_delivered'`, [id]))[0]!.n;

    it('상세가 「계약서 전달하기」를 연다 — 계약서가 있고 피드백이 풀려 있을 때', async () => {
      const { id } = await setup();
      const detail = (await api('get', `/consulting/${id}`).expect(200)).body;
      expect(detail.capabilities).toMatchObject({ externalParentSendSupported: true, externalParentSendReason: null, canSendContract: true });
    });

    it('메일 없이 첨부만 고르면 400 · 설정이 없으면 보내지 않고 전달 단계로도 넘어가지 않는다', async () => {
      const { id, fileId, guardianId } = await setup();
      const noMail = await send({ guardianId, channels: ['sms'], files: [fileId] }).expect(400);
      expect(noMail.body.code).toBe('CONS_DELIVERY_EMAIL_REQUIRED');
      const res = await send({ guardianId, channels: ['email'], files: [fileId] }).expect(200);
      expect(res.body.items.map((x: Row) => x.status)).toEqual(['not_configured']);
      expect(fake.calls).toHaveLength(0);
      expect((await stageOf(id)).contract_step).toBe(2);
      expect(await deliveries(id)).toBe(0);
    });

    it('메일이 실제로 나가면 계약서가 붙어 가고 전달 단계로 넘어간다 — 문자에는 붙지 않는다 · 발송 원장에 컨설팅이 남는다', async () => {
      const { id, fileId, guardianId } = await setup();
      fake.readyMap = { email: true, sms: true };
      const res = await send({ guardianId, channels: ['email', 'sms'], files: [fileId] }).expect(200);
      expect(res.body.items.map((x: Row) => [x.channel, x.status])).toEqual([['email', 'sent'], ['sms', 'sent']]);
      const mail = fake.calls.find((c) => c.channel === 'email')!;
      expect(mail.attachments).toHaveLength(1);
      expect(mail.attachments![0]!.filename).toBe('계약서.pdf');
      expect(mail.attachments![0]!.contentType).toBe('application/pdf');
      expect(mail.attachments![0]!.content.toString('utf8')).toBe(CONTRACT);
      expect(fake.calls.find((c) => c.channel === 'sms')!).not.toHaveProperty('attachments');

      expect((await stageOf(id)).contract_step).toBe(4);
      expect(await deliveries(id)).toBe(1);
      const detail = (await api('get', `/consulting/${id}`).expect(200)).body;
      expect(detail.delivery).not.toBeNull();
      expect(detail.capabilities.canAddSignedFile).toBe(true);
      const [log] = await q<{ after: Row }>(`SELECT after FROM log WHERE entity = 'GUARDIAN_SEND' AND actor_id = $1 ORDER BY id DESC LIMIT 1`, [CEO]);
      expect(log!.after).toMatchObject({ consId: id, consFileIds: [fileId] });
    });

    it('메일이 실패하면 전달로 넘어가지 않는다 — 보낸 척하지 않는다', async () => {
      const { id, fileId, guardianId } = await setup();
      fake.readyMap = { email: true, sms: false };
      fake.reply = () => ({ configured: true, ok: false, providerId: null, error: '거절' });
      const res = await send({ guardianId, channels: ['email'], files: [fileId] }).expect(200);
      expect(res.body.items.map((x: Row) => x.status)).toEqual(['failed']);
      expect((await stageOf(id)).contract_step).toBe(2);
      expect(await deliveries(id)).toBe(0);
    });

    it('항목 파일 · 다른 학생 · 풀리지 않은 피드백은 보내기 전에 막는다 — 공개 범위 밖은 404', async () => {
      const { id, fileId, guardianId } = await setup();
      fake.readyMap = { email: true, sms: true };
      await api('patch', `/consulting/${id}/items`).send({ add: [{ label: '원서', required: false }] }).expect(200);
      const item = (await itemIds(id))['원서']!;
      const itemFile = await api('post', `/consulting/${id}/items/${item}/files`).send({ name: '원서.pdf', base64: b64('x') }).expect(201);
      expect((await send({ guardianId, channels: ['email'], files: [Number(itemFile.body.id)] }).expect(400)).body.code).toBe('CONS_DELIVERY_FILE_INVALID');

      const guardianB = await api('post', `/students/${STU_B}/guardians`).send({ name: 'W11보호자B', email: 'w11-b@example.com', receiveEmail: true }).expect(201);
      expect((await send({ studentId: STU_B, guardianId: Number(guardianB.body.id), channels: ['email'], files: [fileId] }).expect(400)).body.code)
        .toBe('CONS_DELIVERY_STUDENT_INVALID');

      await api('post', `/consulting/${id}/feedback`).send({ body: '금액을 다시 봐 주세요' }).expect(201);
      expect((await send({ guardianId, channels: ['email'], files: [fileId] }).expect(409)).body.code).toBe('CONS_FEEDBACK_OPEN');
      expect(fake.calls).toHaveLength(0);                                 // 아무것도 나가지 않았다

      // 공개 범위 — 비공개 판정 재료가 없는 사람에게 지정 공개 건은 없는 건이다(존재를 숨긴다)
      await q(`UPDATE cons SET share = 'picked' WHERE id = $1`, [id]);
      await q(`INSERT INTO cons_pick (cons_id, staff_id) VALUES ($1, $2)`, [id, MGR]);
      await expect(ds.transaction((m) => app.get(ConsultingService).deliveryAttachments(m, MGR2, false, STU_A, [fileId])))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  /* ══ ⑧ PB-11 지우기 ═══════════════════════════════════════════════════════════════════════ */

  describe('PB-11 지우기 — 돈 · 청구서 · 회차가 남은 건은 지우지 않는다', () => {
    const archiveRows = (id: number) => auditRows(id, 'archive');

    it('받은 돈이 있으면 409 — 상세 단추가 미리 말한 문장 그대로 · 지워지지 않고 감사 줄도 없다', async () => {
      const id = await makeCons({ stage: 'running', step: 5, students: [STU_A] });
      await q(`INSERT INTO cons_pay (cons_id, amount, paid_on, by_id) VALUES ($1, 100000, $2::date, $3)`, [id, TODAY, CEO]);
      const detail = (await api('get', `/consulting/${id}`).expect(200)).body;
      expect(detail.capabilities.canArchive).toBe(false);
      expect(detail.capabilities.archiveBlockedReason).toBe('받은 돈이 있는 컨설팅은 지울 수 없습니다');
      const res = await api('delete', `/consulting/${id}`).expect(409);
      expect(res.body).toEqual({ code: 'CONS_ARCHIVE_BLOCKED', message: detail.capabilities.archiveBlockedReason });
      const [{ deleted_at }] = await q<{ deleted_at: string | null }>(`SELECT deleted_at FROM cons WHERE id = $1`, [id]);
      expect(deleted_at).toBeNull();
      expect(await archiveRows(id)).toHaveLength(0);
    });

    it('살아 있는 전환 청구서 · 회차 기록이 있어도 409', async () => {
      const inv = await makeCons({ stage: 'contract', step: 5, students: [STU_A] });
      await q(
        `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state, issued_on, created_by, cs_id)
         VALUES ($1, $2, 'consulting', 'W11 전환', 100000, 'draft', $3::date, $4, $5)`, [STU_A, TODAY.slice(0, 7), TODAY, CEO, inv],
      );
      expect((await api('delete', `/consulting/${inv}`).expect(409)).body.message).toContain('청구서');
      const sess = await makeCons({ stage: 'contract', step: 1, students: [STU_A] });
      await q(`INSERT INTO cons_sess (cons_id, seq, on_date) VALUES ($1, 1, $2::date)`, [sess, plus(TODAY, 3)]);
      expect((await api('delete', `/consulting/${sess}`).expect(409)).body.message).toContain('회차');
    });

    it('아무것도 없으면 지워지고(보관) 활동 원장 · 감사 원장에 한 줄씩', async () => {
      const id = await makeCons({ stage: 'contract', step: 1, students: [STU_A] });
      expect((await api('get', `/consulting/${id}`).expect(200)).body.capabilities).toMatchObject({ canArchive: true, archiveBlockedReason: null });
      await api('delete', `/consulting/${id}`).expect(204);
      const [{ deleted_at }] = await q<{ deleted_at: string | null }>(`SELECT deleted_at FROM cons WHERE id = $1`, [id]);
      expect(deleted_at).not.toBeNull();
      const logs = await archiveRows(id);
      expect(logs).toHaveLength(1);
      expect(logs[0]!.before).toMatchObject({ stage: 'contract', contractStep: 1 });
      const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM cons_event WHERE cons_id = $1 AND event_type = 'archived'`, [id]);
      expect(n).toBe(1);
    });
  });

  it('N-73 — 이번 결정이 만든 쓰기는 감사 표 한 곳에 있다(돈 · 결재 · 삭제)', () => {
    const keys = AUDIT_WRITES.map((w) => w.key as string);
    for (const k of ['consulting.to_invoice', 'consulting.close_exception', 'consulting.items', 'consulting.item_file', 'consulting.archive']) {
      expect(keys).toContain(k);
    }
  });
});
