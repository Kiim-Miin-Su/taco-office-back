/** @file-guide
 * 목적: lead-aftercare-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 등록 뒤 사후 관리 — 담당의 할 일 (W11 · N-86 · DQ2 권장안 · S13 완료 기준 · A-14).
 *
 * 증명하는 것 —
 *   ① 등록 확정(`planLeadCare` — 등록 확정 트랜잭션이 부른다)이 **해피콜(첫 실제 수업 + 7일)**과 **첫 월간 상담(다음 달 같은 날)**을
 *      상담 담당의 할 일로 만든다. 첫 실제 수업은 시작일 이전 회차 · 휴강 · 그날 빠짐 · 휴원인 날을 잡지 않는다.
 *   ② 등록 재시도에 중복이 서지 않는다 — 표의 부분 유니크가 마지막으로 막는다(등록 확정의 잠금 · ALREADY_ENROLLED 는 enroll-db 가 본다).
 *   ③ 서랍의 할 일 체크(`DrawerService.patchTodo`)가 월간을 끝내면 **같은 트랜잭션에서** 다음 달 하나를 잇는다 —
 *      두 번 끝내도 · 풀었다 다시 끝내도 하나 · 휴원이면 복귀 뒤로 · 복귀일을 모르면 날짜 없이 · 수강이 끝났으면 멈춘다.
 *   ④ 등록 카드(`LeadDto.aftercare` · `stageDue`)가 그 할 일을 읽는다 — 「03-18 예정」 · 「완료 03-18」 · 「정기 관리 중」.
 *   ⑤ 서랍(W11 A')은 끝낸 사후 관리를 「끝난 것 지우기」로 지우지 않고(`clearable` · 서버 판정) · 「원본」이 그 상담 건이다.
 *
 * 테스트마다 트랜잭션을 열고 되돌린다(표를 비우지 않는다 · 스크래치 DB).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { DrawerService } from '../src/modules/drawer/drawer.service';
import { planLeadCare } from '../src/modules/ops/lead-care';
import { TODO_KEEP_REASON, todoSourceLabel } from '../src/lib/todo';
import { makeOpsService } from './ops-svc';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions, url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

const OWNER = 9671;
const ADMIN = 9672;
const GONE = 9673;
const START = '2026-03-01';

type CareRow = { id: string; title: string; care: string; to_id: string | null; from_id: string; due_on: string | null; done: boolean; src: string };

d('등록 뒤 사후 관리 — 담당의 할 일 (W11 · N-86)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let stuId = 0;
  let leadId = 0;
  let serId = 0;

  const svc = () => makeOpsService(q.manager.getRepository(Lead));
  const drawer = () => new DrawerService(q.manager.getRepository(Lead));
  const careRows = async (): Promise<CareRow[]> => (await q.query(
    `SELECT id, title, care, to_id, from_id, to_char(due_on,'YYYY-MM-DD') AS due_on, done, src::text AS src
       FROM todo WHERE lead_id = $1 ORDER BY id`, [leadId],
  )) as CareRow[];
  const monthlies = async () => (await careRows()).filter((r) => r.care === 'monthly').map((r) => [r.due_on, r.done]);
  const plan = (owner = OWNER) => q.query(`UPDATE lead SET owner_id = $2 WHERE id = $1`, [leadId, owner])
    .then(() => planLeadCare(q.manager, { leadId, studentId: stuId, studentName: '사후 학생', serIds: [serId], startedOn: START, byId: ADMIN }));
  const leadView = async () => (await svc().all(ADMIN, true, false)).leads.find((l) => l.id === leadId)!;

  /** 회차 하나 — KST 10:00 · out 이면 그날 이 학생만 빠진다(exc_stu_out) */
  const occ = async (on: string, opt: { canceled?: boolean; out?: boolean } = {}) => {
    await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, canceled, span)
       VALUES ($1, $2::date, $3, tstzrange(($2::date + time '10:00') AT TIME ZONE 'Asia/Seoul', ($2::date + time '11:00') AT TIME ZONE 'Asia/Seoul', '[)'))`,
      [serId, on, opt.canceled ?? false],
    );
    if (opt.out) {
      const [e] = (await q.query(`INSERT INTO exc (ser_id, on_date) VALUES ($1, $2::date) RETURNING id`, [serId, on])) as Array<{ id: string }>;
      await q.query(`INSERT INTO exc_stu_out (exc_id, student_id) VALUES ($1, $2)`, [e.id, stuId]);
    }
  };
  const pause = (from: string, to: string | null) =>
    q.query(`INSERT INTO stu_pause (student_id, from_date, to_date, by_id) VALUES ($1, $2::date, $3::date, $4)`, [stuId, from, to, ADMIN]);

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(
      `INSERT INTO staff (id,name,email,role,active) VALUES
         (${OWNER},'사후 담당','w11c2-owner@t.kr','manager',true),
         (${ADMIN},'등록 관리자','w11c2-admin@t.kr','admin',true),
         (${GONE},'그만둔 담당','w11c2-gone@t.kr','manager',false)
       ON CONFLICT (id) DO NOTHING`,
    );
    await q.query(`INSERT INTO kind (key,name,color,cap,grp) VALUES ('w11c2_class','W11 사후 수업','#333333',4,'lesson') ON CONFLICT (key) DO NOTHING`);
    await q.query(`INSERT INTO sub (key,name,color) VALUES ('w11c2-sub','W11 사후 과목','#444444') ON CONFLICT (key) DO NOTHING`);
    const [s] = (await q.query(`INSERT INTO stu (name, grade) VALUES ('사후 학생','G9') RETURNING id`)) as Array<{ id: string }>;
    stuId = Number(s.id);
    await q.query(
      `INSERT INTO enr (student_id, kind_key, sub_key, sessions, started_on) VALUES ($1,'w11c2_class','w11c2-sub',8,$2::date)`, [stuId, START],
    );
    const [l] = (await q.query(
      `INSERT INTO lead (name, stage, student_id, owner_id) VALUES ('사후 학생','enrolled',$1,${OWNER}) RETURNING id`, [stuId],
    )) as Array<{ id: string }>;
    leadId = Number(l.id);
    const [se] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, title, mode, start_min, end_min, rrule, from_date)
       VALUES ('w11c2_class','w11c2-sub','W11 사후','offline',600,660,'WEEKLY:MO,WE','2026-02-20') RETURNING id`,
    )) as Array<{ id: string }>;
    serId = Number(se.id);
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1, $2)`, [serId, stuId]);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  /** 시작일 앞 회차 · 휴강 · 그날 빠짐 · 휴원인 날을 지나 3/11 이 첫 실제 수업이 되는 규칙 */
  const standardWeek = async () => {
    await occ('2026-02-25');                   // 시작일 이전 — 첫 수업이 아니다(S13)
    await occ('2026-03-02', { canceled: true }); // 휴강
    await occ('2026-03-04', { out: true });    // 그날 이 학생만 빠짐
    await occ('2026-03-09');                   // 휴원인 날
    await pause('2026-03-08', '2026-03-10');
    await occ('2026-03-11');                   // ← 첫 실제 수업
    await occ('2026-03-16');
  };

  /* ── ① 등록 확정의 사후 관리 ────────────────────────────────────────── */

  it('첫 실제 수업은 시작일 이전 · 휴강 · 그날 빠짐 · 휴원 회차를 잡지 않는다 — 해피콜 +7일 · 첫 월간 다음 달 같은 날 · 받는 사람은 상담 담당 (A-14 · S13)', async () => {
    await standardWeek();
    const out = await plan();
    expect(out).toMatchObject({ firstLessonOn: '2026-03-11', happyCallOn: '2026-03-18', monthlyOn: '2026-04-11', ownerId: OWNER, ownerName: '사후 담당' });
    expect((await careRows()).map((r) => [r.care, r.title, r.due_on, r.done, Number(r.to_id), Number(r.from_id), r.src])).toEqual([
      ['happycall', '해피콜 — 사후 학생', '2026-03-18', false, OWNER, ADMIN, 'lead'],
      ['monthly', '월간 상담 — 사후 학생', '2026-04-11', false, OWNER, ADMIN, 'lead'],
    ]);
    const [lead] = (await q.query(`SELECT to_char(first_lesson_on,'YYYY-MM-DD') AS f FROM lead WHERE id = $1`, [leadId])) as Array<{ f: string }>;
    expect(lead.f).toBe('2026-03-11');
    // 출처 낱말은 서버 한 곳 — §64 · 서랍이 「상담」으로 읽는다
    expect(todoSourceLabel('lead')).toBe('상담');
  });

  it('담당이 그만뒀으면 받는 사람 없이 서고(§64 「담당 없음」) · 첫 수업을 모르면 날짜 없이 선다 — 날을 짓지 않는다', async () => {
    const out = await plan(GONE);
    expect(out).toMatchObject({ firstLessonOn: null, happyCallOn: null, monthlyOn: null, ownerId: null, ownerName: null });
    expect((await careRows()).map((r) => [r.care, r.due_on, r.to_id])).toEqual([['happycall', null, null], ['monthly', null, null]]);
  });

  /* ── ② 등록 재시도에 중복 0 ───────────────────────────────────────────── */

  it('같은 상담 건에 해피콜은 하나 · 같은 날 월간도 하나 — 표의 부분 유니크가 마지막으로 막는다 (S13)', async () => {
    await standardWeek();
    await plan();
    await q.query(`SAVEPOINT again`);
    await expect(plan()).rejects.toThrow(/todo_lead_happycall_once/);
    await q.query(`ROLLBACK TO SAVEPOINT again`);
    await expect(q.query(
      `INSERT INTO todo (title, from_id, due_on, src, lead_id, care) VALUES ('월간 상담 — 사후 학생', ${ADMIN}, '2026-04-11', 'lead', $1, 'monthly')`, [leadId],
    )).rejects.toThrow(/todo_lead_monthly_on/);
  });

  it('상담 출처와 상담 건 · 갈래는 함께 선다 — 한쪽만 있으면 표가 거절한다', async () => {
    await q.query(`SAVEPOINT a`);
    await expect(q.query(`INSERT INTO todo (title, from_id, src) VALUES ('상담 건 없음', ${ADMIN}, 'lead')`)).rejects.toThrow(/todo_lead_key/);
    await q.query(`ROLLBACK TO SAVEPOINT a`);
    await expect(q.query(`INSERT INTO todo (title, from_id, src, lead_id, care) VALUES ('손으로 쓴 일', ${ADMIN}, 'manual', $1, 'monthly')`, [leadId]))
      .rejects.toThrow(/todo_lead_key/);
  });

  /* ── ③ 월간을 끝내면 다음 달 하나 ──────────────────────────────────────── */

  it('서랍에서 월간을 끝내면 같은 트랜잭션에서 다음 달 하나를 잇는다 — 두 번 끝내도 · 풀었다 다시 끝내도 하나 · 해피콜은 잇지 않는다', async () => {
    await standardWeek();
    await plan();
    const [happy, m1] = await careRows();
    expect(await drawer().patchTodo(Number(happy.id), { done: true }, ADMIN, true)).toBe(true);
    expect(await monthlies()).toEqual([['2026-04-11', false]]);

    expect(await drawer().patchTodo(Number(m1.id), { done: true }, ADMIN, true)).toBe(true);
    expect(await monthlies()).toEqual([['2026-04-11', true], ['2026-05-11', false]]);
    const next = (await careRows()).at(-1)!;
    expect([next.title, Number(next.to_id), Number(next.from_id), next.src]).toEqual(['월간 상담 — 사후 학생', OWNER, ADMIN, 'lead']);

    // 같은 체크를 다시 보내도 · 풀었다 다시 끝내도 하나
    await drawer().patchTodo(Number(m1.id), { done: true }, ADMIN, true);
    await drawer().patchTodo(Number(m1.id), { done: false }, ADMIN, true);
    await drawer().patchTodo(Number(m1.id), { done: true }, ADMIN, true);
    expect(await monthlies()).toEqual([['2026-04-11', true], ['2026-05-11', false]]);

    // 기한과 함께 끝내는 길(§64 기한 변경)도 같다 — 끝낸 월간의 달 + 1
    await drawer().patchTodo(Number(next.id), { done: true, dueOn: '2026-05-13' }, ADMIN, true);
    expect(await monthlies()).toEqual([['2026-04-11', true], ['2026-05-13', true], ['2026-06-11', false]]);
  });

  it('휴원 중이면 복귀 뒤의 같은 날로 민다 (DQ2)', async () => {
    await standardWeek();
    await plan();
    await pause('2026-05-01', '2026-06-20');
    const m1 = (await careRows()).find((r) => r.care === 'monthly')!;
    await drawer().patchTodo(Number(m1.id), { done: true }, ADMIN, true);
    expect(await monthlies()).toEqual([['2026-04-11', true], ['2026-07-11', false]]);
  });

  it('복귀일을 모르는 휴원이면 날짜 없이 잇는다 — 할 일은 남고 날은 복귀하면 사람이 적는다', async () => {
    await standardWeek();
    await plan();
    await pause('2026-05-01', null);
    const m1 = (await careRows()).find((r) => r.care === 'monthly')!;
    await drawer().patchTodo(Number(m1.id), { done: true }, ADMIN, true);
    expect(await monthlies()).toEqual([['2026-04-11', true], [null, false]]);
  });

  it('수강이 끝났으면 잇지 않는다 — 끝낸 이력은 그대로 남는다', async () => {
    await standardWeek();
    await plan();
    await q.query(`UPDATE enr SET ended_on = '2026-04-30' WHERE student_id = $1`, [stuId]);
    const m1 = (await careRows()).find((r) => r.care === 'monthly')!;
    await drawer().patchTodo(Number(m1.id), { done: true }, ADMIN, true);
    expect(await monthlies()).toEqual([['2026-04-11', true]]);
  });

  it('담당이 바뀌었으면 다음 월간은 지금 담당에게 — 그만둔 담당이면 받는 사람 없이', async () => {
    await standardWeek();
    await plan();
    await q.query(`UPDATE lead SET owner_id = ${GONE} WHERE id = $1`, [leadId]);
    const m1 = (await careRows()).find((r) => r.care === 'monthly')!;
    await drawer().patchTodo(Number(m1.id), { done: true }, ADMIN, true);
    expect((await careRows()).at(-1)).toMatchObject({ care: 'monthly', due_on: '2026-05-11', to_id: null });
  });

  /* ── ④ 등록 카드가 그 할 일을 읽는다 ──────────────────────────────────── */

  it('등록 카드의 「해피콜 · 월간」 줄과 띠는 그 할 일을 읽는다 — 예정 → 완료 → 「정기 관리 중」', async () => {
    await standardWeek();
    await plan();
    const before = await leadView();
    expect(before.aftercare!.slice(0, 2).map((r) => [r.key, r.label, r.value, r.done])).toEqual([
      ['happycall', '해피콜', '03-18 예정', false], ['monthly', '월간', '04-11 예정', false],
    ]);
    expect(before.stageDue).toMatchObject({ task: '해피콜', dueOn: '2026-03-18', tone: 'danger' });

    const [happy, m1] = await careRows();
    await drawer().patchTodo(Number(happy.id), { done: true }, ADMIN, true);
    expect((await leadView()).stageDue).toMatchObject({ task: '월간 상담', dueOn: '2026-04-11' });

    await drawer().patchTodo(Number(m1.id), { done: true }, ADMIN, true);
    const after = await leadView();
    // 「월간」 줄은 **첫** 월간이다 — 다음 달이 이어져 열려 있어도 카드는 「완료」 · 띠는 「정기 관리 중」(원문 §23 박시온 카드)
    expect(after.aftercare!.slice(0, 2).map((r) => r.value)).toEqual(['완료 03-18', '완료']);
    expect(after.stageDue).toEqual({ task: '정기 관리 중', dueOn: null, dueLabel: null, tone: 'neutral' });
  });

  it('할 일이 없는 옛 등록 건은 「없음」이고 띠가 없다 — 한 적 없는 것을 짓지 않는다 (N-25)', async () => {
    const view = await leadView();
    expect(view.aftercare!.slice(0, 2).map((r) => r.value)).toEqual(['없음', '없음']);
    expect(view.stageDue).toBeNull();
  });

  /* ── ⑤ 서랍 — 끝낸 사후 관리는 지우지 않고 · 「원본」은 그 상담 건 (W11 A') ───────────── */

  it('서랍 줄은 사후 관리를 지울 수 없는 줄로 내려보내고(까닭 문장 · 서버 판정) · 「원본」은 그 상담 건이다 — 다른 할 일은 그대로', async () => {
    await standardWeek();
    await plan();
    const [manual] = (await q.query(
      `INSERT INTO todo (title, from_id, to_id, src, done) VALUES ('손으로 쓴 일', ${ADMIN}, ${OWNER}, 'manual', true) RETURNING id`,
    )) as Array<{ id: string }>;
    const rows = (await drawer().all(ADMIN, true, true)).todos;
    const care = rows.filter((t) => t.src === 'lead');
    expect(care.map((t) => [t.srcLabel, t.clearable, t.clearBlockedReason, t.go])).toEqual([
      ['상담', false, TODO_KEEP_REASON, `/intake?lead=${leadId}`],
      ['상담', false, TODO_KEEP_REASON, `/intake?lead=${leadId}`],
    ]);
    const other = rows.find((t) => t.id === Number(manual.id))!;
    expect([other.clearable, other.clearBlockedReason, other.go]).toEqual([true, null, null]);
  });

  it('「끝난 것 지우기」에 끝낸 해피콜 · 월간 id 가 섞여 와도 그 줄은 지우지 않는다 — 지운 수 · log 에서도 빠진다 (N-86 완료 이력)', async () => {
    await standardWeek();
    await plan();
    const [happy, m1] = await careRows();
    await drawer().patchTodo(Number(happy.id), { done: true }, ADMIN, true);
    await drawer().patchTodo(Number(m1.id), { done: true }, ADMIN, true);
    const [manual] = (await q.query(
      `INSERT INTO todo (title, from_id, to_id, src, done) VALUES ('손으로 쓴 일', ${ADMIN}, ${OWNER}, 'manual', true) RETURNING id`,
    )) as Array<{ id: string }>;

    const deleted = await drawer().clearDoneTodos(ADMIN, true, [Number(happy.id), Number(m1.id), Number(manual.id)]);
    expect(deleted).toBe(1);
    // 끝낸 해피콜 · 첫 월간은 그대로 남고(이어 선 다음 달 월간도) · 손으로 쓴 일만 사라졌다
    expect((await careRows()).map((r) => [r.care, r.done])).toEqual([['happycall', true], ['monthly', true], ['monthly', false]]);
    expect(await q.query(`SELECT id FROM todo WHERE id = $1`, [manual.id])).toEqual([]);
    const [log] = (await q.query(
      `SELECT before FROM log WHERE entity = 'TODO' AND action = 'clear' AND actor_id = $1 ORDER BY id DESC LIMIT 1`, [ADMIN],
    )) as Array<{ before: Array<{ id: number; src: string }> }>;
    expect(log.before.map((b) => [b.id, b.src])).toEqual([[Number(manual.id), 'manual']]);

    // 사후 관리만 보냈으면 지운 것이 없다 — log 도 남지 않는다
    const logsBefore = (await q.query(`SELECT count(*)::int AS n FROM log WHERE entity = 'TODO' AND action = 'clear'`)) as Array<{ n: number }>;
    expect(await drawer().clearDoneTodos(ADMIN, true, [Number(happy.id)])).toBe(0);
    expect(await q.query(`SELECT count(*)::int AS n FROM log WHERE entity = 'TODO' AND action = 'clear'`)).toEqual(logsBefore);
  });
});
