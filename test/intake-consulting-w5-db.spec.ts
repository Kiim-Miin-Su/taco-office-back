/** @file-guide
 * 목적: intake-consulting-w5-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 1:1 대조 wave 5 — 상담 §23 · 컨설팅 §26·§27·§29·§31 의 남은 서버 몫을 실제 앱(ValidationPipe · PermGuard) → DB 로 관통한다.
 *
 * 증명하는 것 —
 *   상담   ① 등록 카드의 사후 관리 줄(23-18) — 그 학생의 청구서 · 교재 · 안내 원장을 읽는다. 청구서 「없음」은 머리 경고
 *            「등록했는데 청구서 없음」과 같은 판정이다 · 등록 건이 아니면 줄이 없다.
 *   컨설팅 ② 종류 이름은 가운뎃점 앞뒤를 띄우고(29-02) 목록이 §29 고르개 낱말(종류 10 · 요청자 2)을 준다 ·
 *          ③ 카드 공개 칩은 원본의 짧은 낱말 「수납만」(26-08) · ④ 「학생 N명」은 학생별 화면과 같은 셈(26-03) ·
 *          ⑤ 「N일 지남」은 계약 시작일부터 — 시작 전 · 미정이면 null(26-10 · qa-w3 「0일 지남」) ·
 *          ⑥ 지난 회차의 「다음까지」 할 일은 **아직 오지 않은** 다음 회차가 기한이다(qa-w3 관찰 · D-R44).
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

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(120_000);

d('1:1 대조 wave 5 — 상담 §23 · 컨설팅 §26·§27·§29·§31 서버 몫 (Front→DTO→Back→DB)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ceoToken = '';
  const PW = 'w5-12345';
  const CEO = 9751;
  const OWNER = 9752;
  const STU = 99751;
  const STU2 = 99752;
  const LEAD = 97501;
  const LEAD_OPEN = 97502;
  let LIB = 0;
  const consIds: number[] = [];

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const TODAY = kst();

  const api = (m: 'post' | 'patch' | 'get', p: string, t = ceoToken) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${t}`).timeout({ response: 10000, deadline: 20000 });
  const opsLead = async (id: number) => {
    const body = (await api('get', '/ops').expect(200)).body as { leads: Array<Record<string, unknown>>; intakeHead: Record<string, unknown> };
    return { lead: body.leads.find((l) => l.id === id)!, head: body.intakeHead };
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    await cleanup();
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active, can_money) VALUES
         ($1,'오차대표','w5-ceo@t.kr','ceo',$3,true,null),
         ($2,'오차담당','w5-own@t.kr','manager',$3,true,null)`,
      [CEO, OWNER, hash],
    );
    await q(`INSERT INTO stu (id, name, grade, school) VALUES ($1,'오차학생','11','테스트고'), ($2,'오차둘째','9','테스트중')`, [STU, STU2]);
    const [lib] = await q<{ id: string }>(`SELECT id FROM lib ORDER BY id LIMIT 1`);
    LIB = Number(lib.id);
    const res = await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 })
      .send({ email: 'w5-ceo@t.kr', password: PW }).expect(201);
    ceoToken = res.body.accessToken as string;
  });

  async function cleanup() {
    const cons = (await q<{ id: string }>(`SELECT id FROM cons WHERE owner_id = ANY($1) OR id IN (SELECT cons_id FROM cons_stu WHERE student_id = ANY($2))`, [[CEO, OWNER], [STU, STU2]])).map((c) => Number(c.id));
    if (cons.length) {
      await q(`DELETE FROM todo WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons_event WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons_sess WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons_item WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons_pay WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons_stu WHERE cons_id = ANY($1)`, [cons]);
      await q(`DELETE FROM cons WHERE id = ANY($1)`, [cons]);
    }
    await q(`DELETE FROM lead_touch WHERE lead_id = ANY($1)`, [[LEAD, LEAD_OPEN]]);
    await q(`DELETE FROM lead_stage_log WHERE lead_id = ANY($1)`, [[LEAD, LEAD_OPEN]]);
    await q(`DELETE FROM lead WHERE id = ANY($1)`, [[LEAD, LEAD_OPEN]]);
    await q(`DELETE FROM guide WHERE student_id = ANY($1)`, [[STU, STU2]]);
    await q(`DELETE FROM issue WHERE student_id = ANY($1)`, [[STU, STU2]]);
    await q(`DELETE FROM inv WHERE student_id = ANY($1)`, [[STU, STU2]]);
    await q(`DELETE FROM stu WHERE id = ANY($1)`, [[STU, STU2]]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [[CEO, OWNER]]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, OWNER]]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, OWNER]]);
  }

  afterAll(async () => {
    try { if (ds?.isInitialized) await cleanup(); } finally { await app?.close(); }
  });

  /* ══ 상담 ══════════════════════════════════════════════════════════════════════════ */

  it('① 등록 카드의 사후 관리 줄은 그 학생의 청구서 · 교재 · 안내를 읽는다 — 청구서 「없음」은 머리 경고와 같은 판정 · 등록 건이 아니면 줄이 없다 (23-18)', async () => {
    await q(
      `INSERT INTO lead (id, name, stage, student_id, owner_id) VALUES ($1,'오차등록','enrolled',$2,$3), ($4,'오차진행','first',NULL,$3)`,
      [LEAD, STU, OWNER, LEAD_OPEN],
    );
    const before = await opsLead(LEAD);
    expect(before.lead.aftercare).toEqual([
      { key: 'invoice', label: '청구서', value: '없음', done: false },
      { key: 'book', label: '교재', value: '없음', done: false },
      { key: 'guide', label: '안내', value: '없음', done: false },
    ]);
    // 같은 판정 — 이 학생은 머리 경고 「등록했는데 청구서 없음」에 든다
    const noInvoiceBefore = (before.head.alerts as Array<{ key: string; count: number }>).find((a) => a.key === 'noInvoice')!.count;
    expect((await opsLead(LEAD_OPEN)).lead.aftercare).toBeNull();

    await q(`INSERT INTO inv (student_id, year_month, inv_type, title, amount, state) VALUES ($1,'2026-09','tuition','오차 청구',100000,'draft')`, [STU]);
    await q(`INSERT INTO issue (lib_id, student_id, state, issued_on) VALUES ($1,$2,'ok',$3::date)`, [LIB, STU, TODAY]);
    await q(`INSERT INTO guide (student_id, reason, state) VALUES ($1,'new','draft')`, [STU]);
    const after = await opsLead(LEAD);
    expect(after.lead.aftercare).toEqual([
      { key: 'invoice', label: '청구서', value: '1건', done: true },
      { key: 'book', label: '교재', value: '1권', done: true },
      { key: 'guide', label: '안내', value: '쓰는 중', done: false },
    ]);
    const noInvoiceAfter = (after.head.alerts as Array<{ key: string; count: number }>).find((a) => a.key === 'noInvoice')!.count;
    expect(noInvoiceAfter).toBe(noInvoiceBefore - 1);
  });

  /* ══ 컨설팅 ════════════════════════════════════════════════════════════════════════ */

  it('②③④⑤ 목록 — 종류 이름 가운뎃점 · §29 고르개 낱말 · 카드 칩 「수납만」 · 학생 수는 학생별과 같은 셈 · 「N일 지남」은 시작일부터 (29-02 · 26-08 · 26-03 · 26-10)', async () => {
    const mk = async (type: string, stage: string, step: number | null, start: string | null, share: string, students: number[]) => {
      const [c] = await q<{ id: string }>(
        `INSERT INTO cons (cons_type, stage, contract_step, amount, sessions, start_on, end_on, requester, owner_id, share)
         VALUES ($1, $2, $3, 800000, 6, $4::date, $5::date, 'mother', $6, $7) RETURNING id`,
        [type, stage, step, start, plus(TODAY, 90), OWNER, share],
      );
      const id = Number(c.id);
      consIds.push(id);
      for (const s of students) await q(`INSERT INTO cons_stu (cons_id, student_id) VALUES ($1, $2)`, [id, s]);
      return id;
    };
    const running = await mk('transfer', 'running', 5, plus(TODAY, -30), 'money_only', [STU, STU2]);
    const future = await mk('visa', 'contract', 1, plus(TODAY, 10), 'all', [STU]);
    const legacy = await mk('essay', 'contract', null, null, 'all', [STU2]);

    const body = (await api('get', '/consulting').expect(200)).body as {
      items: Array<Record<string, unknown>>; types: Array<{ key: string; label: string }>;
      requesters: Array<{ key: string; label: string }>; studentCount: number;
    };
    const at = (id: number) => body.items.find((x) => x.id === id)!;
    // ② 가운뎃점 앞뒤를 띄운다 — 원본 §29 칩 「편입 · 전학」 · 「비자 · 서류」
    expect(at(running).typeLabel).toBe('편입 · 전학');
    expect(at(future).typeLabel).toBe('비자 · 서류');
    expect(body.types.map((t) => t.key)).toEqual(['admissions', 'boarding', 'transfer', 'essay', 'interview', 'exam', 'roadmap', 'college', 'portfolio', 'visa']);
    expect(body.types.find((t) => t.key === 'transfer')!.label).toBe('편입 · 전학');
    expect(body.requesters).toEqual([{ key: 'mother', label: '어머니' }, { key: 'father', label: '아버지' }]);
    // ③ 카드 칩만 짧다 — 긴 이름은 그대로
    expect(at(running)).toMatchObject({ shareLabel: '수납만 공개', shareChipLabel: '수납만' });
    expect(at(future)).toMatchObject({ shareLabel: '전체 공개', shareChipLabel: '전체 공개' });
    // ⑤ 시작일부터 — 시작 전(예정 시작일) · 미정은 null
    expect(at(running).ageDays).toBe(30);
    expect(at(future).ageDays).toBeNull();
    expect(at(legacy).ageDays).toBeNull();
    // ④ 학생별 화면의 줄 수와 같다 — 한 사람은 한 번(두 건에 걸린 오차학생)
    const students = (await api('get', '/consulting/students').expect(200)).body.items as Array<{ studentId: number; cases: Array<Record<string, unknown>> }>;
    expect(body.studentCount).toBe(students.length);
    // 학생별 · 회계 줄도 종류 이름을 서버가 준다(화면이 표를 들지 않는다)
    expect(students.find((s) => s.studentId === STU)!.cases.find((x) => x.id === running)!.typeLabel).toBe('편입 · 전학');
    const money = (await api('get', '/consulting/accounting').expect(200)).body.items as Array<Record<string, unknown>>;
    expect(money.find((x) => x.id === running)!.typeLabel).toBe('편입 · 전학');
  });

  it('⑥ 지난 회차에 「다음까지」를 적으면 기한은 **아직 오지 않은** 다음 회차다 — 앞으로 잡힌 회차가 없으면 기한 없음 (qa-w3 · D-R44)', async () => {
    const consId = consIds[0]!;
    // 회차 셋 — 열흘 전 · 닷새 전(둘 다 지남) · 이레 뒤
    for (const [seq, off] of [[1, -10], [2, -5], [3, 7]] as const) {
      await q(`INSERT INTO cons_sess (cons_id, seq, on_date) VALUES ($1, $2, $3::date)`, [consId, seq, plus(TODAY, off)]);
    }
    const sess = await q<{ id: string; seq: number }>(`SELECT id, seq FROM cons_sess WHERE cons_id = $1 ORDER BY seq`, [consId]);
    await api('patch', `/consulting/${consId}/sessions/${sess[0]!.id}`).send({ nextUntil: '성적표 준비' }).expect(200);
    const todo = await q<{ due_on: string | null }>(
      `SELECT to_char(due_on,'YYYY-MM-DD') AS due_on FROM todo WHERE cons_id = $1 AND title LIKE '컨설팅 1회차 다음까지 — %'`, [consId]);
    // 그 뒤 첫 회차(닷새 전)는 이미 지났다 — 기한은 이레 뒤 회차
    expect(todo).toEqual([{ due_on: plus(TODAY, 7) }]);

    // 마지막 회차 뒤에는 잡힌 회차가 없다 — 기한을 지어내지 않는다
    await api('patch', `/consulting/${consId}/sessions/${sess[2]!.id}`).send({ nextUntil: '결과 공유' }).expect(200);
    const last = await q<{ due_on: string | null }>(
      `SELECT to_char(due_on,'YYYY-MM-DD') AS due_on FROM todo WHERE cons_id = $1 AND title LIKE '컨설팅 3회차 다음까지 — %'`, [consId]);
    expect(last).toEqual([{ due_on: null }]);
  });
});
