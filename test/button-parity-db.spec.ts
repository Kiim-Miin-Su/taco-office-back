/** @file-guide
 * 목적: button-parity-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * **S5 — 단추와 서버가 같은 질문을 한다** (2026-09-20 전수 검수 §6 · D-R39).
 *
 * 이 스위트가 보는 것은 하나다: **`can*` 이 false 인 자리에서 실제로 쓰기가 거절되고, true 인 자리에서
 * 실제로 통과하는가.** 그리고 **막힌 이유 문장이 쓰기가 내는 문장과 같은 말인가** — 두 벌이면 화면이
 * 미리 말하는 이유와 눌렀을 때의 이유가 갈린다.
 *
 * 그래서 「단추가 false 다」만 보지 않고 **언제나 쓰기를 한 번 더 때려 본다.** 그것이 이 스토리의 전부다.
 *
 * 실제 HTTP(가드 · DTO · 트랜잭션)와 시드가 든 개발 DB 로 돈다. 바꾼 것은 끝에 되돌린다.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(120_000);

type Json = Record<string, unknown>;

d('S5 단추와 서버가 같은 질문 — can* 과 실제 거절이 맞는가', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceo = '';
  let head = '';
  const PW = 'taco1234!';
  /** 이 스위트가 마감한 달 — 끝에 반드시 해제한다 */
  const closedMonths: string[] = [];

  const q = <T = Json>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const api = (m: 'get' | 'post' | 'patch' | 'delete', url: string, token = ceo) =>
    (request(app.getHttpServer()) as unknown as Record<string, (u: string) => request.Test>)[m](url)
      .timeout({ response: 10000, deadline: 20000 })
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);
    const login = async (email: string) =>
      (await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 })
        .send({ email, password: PW }).expect(201)).body.accessToken as string;
    ceo = await login('ceo@tnacademy.kr');
    head = await login('head@tnacademy.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        for (const month of closedMonths) {
          await q(`UPDATE month_close SET reopened_at = now(), reopen_reason = 'S5 회귀 정리' WHERE year_month = $1 AND reopened_at IS NULL`, [month]);
        }
      }
    } finally {
      await app?.close();
    }
  });

  /* ── ① 청구서 「취소」 — 마감·입금이 붙으면 단추도 닫힌다 ─────────────── */

  it('① 마감한 달의 청구서는 canVoid 가 닫히고, 그 이유가 쓰기가 내는 문장과 같다', async () => {
    const before = (await api('get', '/accounting').expect(200)).body;
    const target = (before.invoices as Json[]).find((i) => i.canVoid === true);
    if (!target) throw new Error('취소할 수 있는 청구서가 시드에 없습니다 — 대상을 못 고른 채로 통과시키지 않습니다');
    const month = String(target.yearMonth);

    await api('post', '/accounting/tuition/close').send({ month }).expect(201);
    closedMonths.push(month);

    const after = (await api('get', '/accounting').expect(200)).body;
    const row = (after.invoices as Json[]).find((i) => i.id === target.id)!;
    expect(row.canVoid).toBe(false);
    expect(String(row.voidBlockedReason)).toContain('마감');

    // 단추가 말한 이유 = 쓰기가 내는 이유. 두 벌이면 화면이 미리 말하는 말과 눌렀을 때의 말이 갈린다
    const blocked = await api('post', `/accounting/invoices/${target.id}/void`).send({ reason: 'S5 회귀' }).expect(409);
    expect(blocked.body.code).toBe('MONTH_CLOSED');
    expect(blocked.body.message).toBe(row.voidBlockedReason);

    /* ── ② 같은 마감이 §54 「이월 처리」도 닫는다 ── */
    const tuition = (await api('get', `/accounting/tuition?month=${month}`).expect(200)).body;
    expect((tuition.items as Json[]).some((r) => r.carryable === true)).toBe(false);

    await api('post', '/accounting/tuition/reopen').send({ month, reason: 'S5 회귀 정리' }).expect(201);
    closedMonths.pop();

    // 열면 다시 선다 — 막기만 하고 못 여는 판정이면 기능이 죽는다
    const reopened = (await api('get', '/accounting').expect(200)).body;
    expect((reopened.invoices as Json[]).find((i) => i.id === target.id)!.canVoid).toBe(true);
  });

  it('① 입금이 붙은 청구서도 단추가 닫힌다 — 0원 입금 줄까지 센다 (쓰기가 그렇게 센다)', async () => {
    const board = (await api('get', '/accounting').expect(200)).body;
    const target = (board.invoices as Json[]).find((i) => i.canVoid === true);
    if (!target) throw new Error('취소할 수 있는 청구서가 없습니다');

    const pay = await api('post', '/accounting/payments')
      .send({ invId: target.id, amount: 1000, paidOn: '2026-09-18', method: 'cash' }).expect(201);
    try {
      const after = (await api('get', '/accounting').expect(200)).body;
      const row = (after.invoices as Json[]).find((i) => i.id === target.id)!;
      expect(row.canVoid).toBe(false);
      expect(String(row.voidBlockedReason)).toContain('입금');
      const blocked = await api('post', `/accounting/invoices/${target.id}/void`).send({ reason: 'S5 회귀' }).expect(409);
      expect(blocked.body.code).toBe('INV_HAS_PAYMENTS');
      expect(blocked.body.message).toBe(row.voidBlockedReason);
    } finally {
      const payments = (await api('get', '/accounting').expect(200)).body.payments as Json[];
      const made = payments.find((p) => p.invId === target.id && p.amount === 1000);
      if (made) await api('delete', `/accounting/payments/${made.id}`).expect(200);
      expect(pay.status).toBe(201);
    }
  });

  /* ── ③ 컨설팅 「납부 넣기」 ───────────────────────────────────────── */

  /**
   * 회계 표의 **모든 줄**에 같은 질문을 한다 — 닫힌 줄은 실제로 거절되는가, 열린 줄은 실제로 통과하는가.
   *
   * 전에는 세 곳이 서로 다른 질문을 했다: 표의 단추는 계약 단계를 안 봐서 409 `CONS_PAY_NOT_READY`,
   * 상세의 `canAddPayment` 는 `step === 5` 를 무조건 걸어 **레거시 행에서는 반대 방향**으로 어긋났다.
   */
  it('③ 회계 표의 줄마다 canAddPayment 와 실제 쓰기가 같은 답을 낸다 (막힌 이유 문장까지)', async () => {
    const acct = (await api('get', '/consulting/accounting').expect(200)).body;
    const rows = acct.items as Json[];
    expect(rows.length).toBeGreaterThan(0);
    const opened: number[] = [];
    try {
      for (const row of rows) {
        const id = Number(row.id);
        const res = await api('post', `/consulting/${id}/payments`).send({ amount: 1, paidOn: '2026-09-18' });
        if (row.canAddPayment === true) {
          // 열린 자리는 실제로 통과한다 — 막기만 하고 못 여는 판정은 기능을 죽인다
          expect([201, 200]).toContain(res.status);
          opened.push(id);
        } else {
          expect(res.status).toBe(409);
          // 미리 말하는 이유와 눌렀을 때의 이유가 같은 말이다
          expect(res.body.message).toBe(row.payBlockedReason);
        }
      }
      // 시드가 닫힌 줄과 열린 줄을 **둘 다** 갖고 있어야 이 시험이 무언가를 본 것이다
      expect(rows.some((r) => r.canAddPayment === false)).toBe(true);
      expect(opened.length).toBeGreaterThan(0);
    } finally {
      if (opened.length > 0) {
        // 원장 줄에 매달린 사건부터 지운다 — 순서가 바뀌면 가리키는 곳 없는 사건이 남는다
        await q(
          `DELETE FROM cons_event
            WHERE event_type = 'payment_added'
              AND ref_id IN (SELECT id FROM cons_pay
                              WHERE cons_id = ANY($1::bigint[]) AND amount = 1 AND paid_on = '2026-09-18'::date)`,
          [opened],
        );
        await q(`DELETE FROM cons_pay WHERE cons_id = ANY($1::bigint[]) AND amount = 1 AND paid_on = '2026-09-18'::date`, [opened]);
      }
    }
  });

  /* ── ④ 대표 보고 「저장」·「올리기」 ───────────────────────────────── */

  it('④ 이미 올린 보고는 canWriteMemo 가 닫히고, 저장·올리기 둘 다 같은 문장으로 거절된다', async () => {
    // §69 는 기간을 받는다 — 보고가 있는 기간 전체를 묻는다(없는 달을 물으면 대상이 0이다)
    const [span] = await q<{ lo: string; hi: string }>(
      `SELECT to_char(min(on_date),'YYYY-MM-DD') AS lo, to_char(max(on_date),'YYYY-MM-DD') AS hi FROM rpt`,
    );
    if (!span?.lo) throw new Error('대표 보고가 시드에 없습니다');
    const exec = (await api('get', `/exec?from=${span.lo}&to=${span.hi}`).expect(200)).body;
    const locked = (exec.reports as Json[]).find((r) => r.state !== 'draft' && r.state !== 'rej');
    if (!locked) throw new Error('이미 올린 보고가 시드에 없습니다');
    expect(locked.canWriteMemo).toBe(false);
    expect(typeof locked.writeBlockedReason).toBe('string');

    const save = await api('patch', '/exec/report')
      .send({ rptType: locked.rptType, onDate: locked.onDate, memos: [{ key: 'money', memo: 'S5 회귀' }] })
      .expect(409);
    expect(save.body.code).toBe('RPT_LOCKED');
    expect(save.body.message).toBe(locked.writeBlockedReason);

    const submit = await api('post', '/exec/report/submit')
      .send({ rptType: locked.rptType, onDate: locked.onDate }).expect(409);
    expect(submit.body.code).toBe('RPT_LOCKED');
    // 저장과 올리기가 **같은 말**을 한다 — 한 잠금에 문장이 둘이면 두 가지 일로 읽힌다
    expect(submit.body.message).toBe(locked.writeBlockedReason);

    // 아직 고칠 수 있는 보고에서는 열려 있어야 한다 — 막기만 하고 못 여는 판정은 기능을 죽인다
    const open = (exec.reports as Json[]).find((r) => r.state === 'draft' || r.state === 'rej');
    if (open) expect(open.canWriteMemo).toBe(true);
  });

  /* ── ⑤ 컴플레인 「수강 종료 · 환불」 ──────────────────────────────── */

  it('⑤ 환불 단추는 돈 권한을 본다 — 매니저에게는 닫히고 그 사람이 부르면 실제로 403 이다', async () => {
    const asCeo = (await api('get', '/ops').expect(200)).body.complaints as Json[];
    const asHead = (await api('get', '/ops', head).expect(200)).body.complaints as Json[];
    const open = asCeo.find((c) => c.canWithdraw === true);
    if (!open) throw new Error('환불을 걸 수 있는 컴플레인이 시드에 없습니다');
    expect(asHead.find((c) => c.id === open.id)!.canWithdraw).toBe(false);

    // 화면이 닫은 이유가 진짜다 — 그 사람이 그 창을 열면 미리보기부터 403 이다
    await api('post', '/accounting/withdrawals/preview', head)
      .send({ studentId: open.studentId, endedOn: '2026-09-30' }).expect(403);
  });

  /* ── ⑥ 발송 이력 「다시 보내기」 ──────────────────────────────────── */

  /**
   * 파일 수와 `canResend` 가 **같은 것을 세는가**.
   *
   * 실제 발송 이력을 만들어 보는 회귀는 `report-delivery.spec.ts` 가 갖는다 — 그 스위트가 Blob
   * 저장소를 대역으로 갈아 끼우고 리포트·학생 픽스처를 세운다. 시드에는 `rsend` 가 **0행**이라
   * 여기서는 만들 수 없고, 0행을 훑어 놓고 통과라 적으면 아무것도 안 본 시험이 된다.
   * 그래서 여기서는 **시드에 줄이 있을 때만** 두 값이 어긋나지 않는지 본다.
   */
  it('⑥ 발송 이력이 있으면 canResend 와 보존 파일 수가 어긋나지 않는다 (만드는 회귀는 report-delivery.spec)', async () => {
    const list = (await api('get', '/reports/deliveries/history').expect(200)).body;
    const items = list.items as Json[];
    for (const row of items.slice(0, 5)) {
      expect(row.canResend).toBe(Number(row.fileCount) > 0);
      expect(row.canResend === true).toBe(row.resendBlockedReason == null);
    }
    expect(Number(list.total)).toBe(items.length);
  });

  /* ── ⑦ 줌 안내 — 옮긴 회차도 목록이 준 키로 찾는다 ─────────────────── */

  it('⑦ 옮긴 회차의 줌 안내 — 목록이 준 onDate 로 쓰기가 그 회차를 찾는다 (키가 갈리면 404 였다)', async () => {
    /*
     * **제 수업을 만들어서 본다.** 시드의 회차를 빌려 옮기면 그 규칙이 통째로 다시 그려지고,
     * 시드가 `from_date` 이전에 손으로 넣어 둔 회차·리포트 줄이 어긋난 채 남는다(N-49).
     * 남의 데이터를 헤집지 않고, 끝에 이 수업을 통째로 지운다.
     */
    const [{ today, key }] = await q<{ today: string; key: string }>(
      `SELECT to_char((now() AT TIME ZONE 'Asia/Seoul')::date,'YYYY-MM-DD') AS today,
              to_char((now() AT TIME ZONE 'Asia/Seoul')::date + 7,'YYYY-MM-DD') AS key`,
    );
    const [who] = await q<{ teacher_id: string; student_id: string; zacc_id: string }>(
      `SELECT (SELECT id FROM staff WHERE active AND role = 'teacher' ORDER BY id LIMIT 1) AS teacher_id,
              (SELECT id FROM stu ORDER BY id LIMIT 1) AS student_id,
              (SELECT id FROM zacc WHERE active ORDER BY id LIMIT 1) AS zacc_id`,
    );
    if (!who?.teacher_id || !who.student_id || !who.zacc_id) throw new Error('강사·학생·줌 계정 중 하나가 시드에 없습니다');
    const teacherId = Number(who.teacher_id);
    const zaccId = Number(who.zacc_id);

    // 두 날(만드는 날 · 옮겨 갈 오늘) **모두** 비어 있는 한 시간 — 겹치면 EXCLUDE 가 409 다
    const [slot] = await q<{ start_min: number }>(
      `SELECT gs AS start_min
         FROM generate_series(480, 1320, 30) gs
        WHERE NOT EXISTS (
          SELECT 1 FROM ser_occ x, unnest(ARRAY[$1::date, $2::date]) AS d
           WHERE NOT x.canceled
             AND x.span && tstzrange((d + make_interval(mins => gs)) AT TIME ZONE 'Asia/Seoul',
                                     (d + make_interval(mins => gs + 60)) AT TIME ZONE 'Asia/Seoul', '[)')
             AND (x.teacher_id = $3 OR x.zacc_id = $4))
        ORDER BY gs LIMIT 1`,
      [today, key, teacherId, zaccId],
    );
    if (!slot) throw new Error('두 날 모두 비어 있는 자리가 없습니다 — 대상을 못 고른 채로 통과시키지 않습니다');

    const made = await api('post', '/schedule').send({
      kindKey: 'class', subKey: null, mode: 'online', fromDate: key, toDate: key, rrule: 'ONCE',
      startMin: slot.start_min, endMin: slot.start_min + 60,
      teacherId, roomId: null, title: 'S5 회귀 — 옮긴 회차의 줌 안내', studentIds: [Number(who.student_id)],
    }).expect(201);
    const serId = Number(made.body.serIds[0]);

    try {
      // 이번 회차만 오늘로 옮긴다 — **회차 키(EXC 키)는 만든 날 그대로 남는다**
      await api('patch', `/schedule/${serId}`)
        .send({ scope: 'this', onDate: key, date: today, startMin: slot.start_min, endMin: slot.start_min + 60 })
        .expect(200);
      // 줌 배정도 **회차 키**로 받는다 — 정본은 ZASSIGN 이고 `ser_occ.zacc_id` 는 투영이다
      await api('post', '/zoom/assign').send({ serId, onDate: key, zaccId }).expect(201);

      // 오늘 목록에 선다 — 그리고 그 줄의 onDate 는 **회차 키**이지 그려지는 날이 아니다
      const list = (await api('get', '/guides').expect(200)).body;
      const row = (list.perLesson as Json[]).find((l) => l.serId === serId);
      expect(row).toBeDefined();
      expect(row!.onDate).toBe(key);
      expect(row!.onDate).not.toBe(today);
      expect(row!.zoomAssigned).toBe(true);
      expect(row!.canSendTeacher).toBe(true);
      expect(row!.sendBlockedReason).toBeNull();

      // 화면이 되돌려 보내는 값 그대로 — 전에는 「그려지는 날」을 보내 회차를 못 찾았다
      const sent = await api('post', '/guides/zoom-notice').send({ serId, onDate: row!.onDate }).expect(201);
      expect(sent.body.teacherNotices).toBe(1);
      // 쓰기의 되읽기도 같은 키로 찾는다 — 그려지는 날로 찾으면 **쓰고 나서** 404 였다
      expect(sent.body.lesson.onDate).toBe(key);
      expect(sent.body.lesson.teacherDeliveryRecorded).toBe(true);
      expect(sent.body.lesson.canSendTeacher).toBe(false);
      // 본문의 일시는 **그려지는 날**이다 — 강사가 실제로 들어가는 날이 오늘이기 때문이다
      const [notice] = await q<{ body: string }>(
        `SELECT body FROM pnoti WHERE ser_id=$1 AND on_date=$2::date AND audience='teacher'`, [serId, key],
      );
      expect(notice.body).toContain(today);

      // 두 번은 막힌다 — 단추가 닫힌 그 자리에서 쓰기도 닫힌다
      const again = await api('post', '/guides/zoom-notice').send({ serId, onDate: row!.onDate }).expect(409);
      expect(again.body.code).toBe('ZOOM_NOTICE_ALREADY');
    } finally {
      /* 이 수업이 남긴 것부터 지운다 — 참조가 남아 있으면 규칙을 못 지운다(SCHEDULE_REF_TABLES) */
      await q(`DELETE FROM hist WHERE entity='pnoti' AND ref_id IN (SELECT id FROM pnoti WHERE ser_id=$1)`, [serId]);
      await q(`DELETE FROM pnoti WHERE ser_id = $1`, [serId]);
      await q(`DELETE FROM noti WHERE body LIKE 'S5 회귀 — 옮긴 회차의 줌 안내%' OR body LIKE '줌 안내 — S5 회귀%'`);
      await q(`DELETE FROM rep_stu WHERE rep_id IN (SELECT id FROM rep WHERE ser_id=$1)`, [serId]);
      await q(`DELETE FROM rep WHERE ser_id = $1`, [serId]);
      await api('delete', `/schedule/${serId}`).send({ scope: 'all', onDate: key });
      const [left] = await q<{ n: string }>(`SELECT count(*)::text AS n FROM ser WHERE id = $1`, [serId]);
      expect(Number(left.n)).toBe(0);
    }
  });
});
