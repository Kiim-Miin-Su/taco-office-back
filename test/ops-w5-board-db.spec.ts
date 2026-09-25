/** @file-guide
 * 목적: ops-w5-board-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 운영 §61·§63·§65·§66·§67 — 1:1 대조 둘째 물결 (w5 · g6 61-1 · 63-2 · 63-5 · 63-6 · 65-4 · 66-2 · 67-2 · C-4).
 *
 * 증명하는 것 —
 *   ① §61 카드의 「과제 1/3」·기한 낱말·기한 상태 이름을 **서버가 센다/만든다** (D-R37 · D-R18).
 *   ② 탭 동그라미가 원문대로 「손봐야 할 것」이다 — 기획 = 검토 요청 + 보완 요청, 컴플레인 = 기한 지난 열린 건.
 *   ③ §63 줄의 참석자 이름 칩(세 값 상태)·「예정」·「내 응답 대기 N」·「속기록 N」을 서버가 준다.
 *   ④ §66 머리의 시각·자리가 **이어진 회차**에서 온다 — 목록(§63)과 같은 자리.
 *   ⑤ §65 「+ 대표 지시」 — 과제(TODO plan_id)와 담당 알림·감사 줄이 한 트랜잭션이고,
 *      막힌 이유 문장은 읽기(`addTaskBlockedReason`)와 쓰기(409)가 같은 말이다 (S5 · D-R22).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { makeOpsService } from './ops-svc';
import { todayKst } from '../src/lib/kst';
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

const day = (n: number): string => {
  const t = new Date(`${todayKst()}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

const CEO = 581;
const MGR = 582;
const T1 = 583;
const GONE = 584;

d('운영 §61·§63·§65·§66·§67 둘째 물결 (w5)', () => {
  let ds: DataSource;
  let q: QueryRunner;

  const svc = () => makeOpsService(q.manager.getRepository(Lead));

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    for (const t of ['todo', 'noti', 'mtattd', 'mtrec', 'cpl']) await q.query(`DELETE FROM ${t}`);
    await q.query(`DELETE FROM log WHERE entity = 'plan'`);
    await q.query(`DELETE FROM plan`);
    await q.query(
      `INSERT INTO staff (id,name,email,role,title,active) VALUES
         (${CEO},'대표w5','w5-ceo@t.kr','ceo','대표',true),
         (${MGR},'매니저w5','w5-mgr@t.kr','manager','매니저',true),
         (${T1},'강사w5','w5-t1@t.kr','teacher',NULL,true),
         (${GONE},'퇴사w5','w5-gone@t.kr','manager',NULL,false)
       ON CONFLICT (id) DO NOTHING`,
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const plan = async (title: string, stage: string, dueOn: string | null, approved = false): Promise<number> => {
    const [r] = (await q.query(
      `INSERT INTO plan (title, stage, due_on, owner_id, due_approved_at, due_approved_by)
       VALUES ($1,$2,$3::date,$4,$5,$6) RETURNING id`,
      [title, stage, dueOn, MGR, approved ? new Date() : null, approved ? CEO : null],
    )) as Array<{ id: string }>;
    return Number(r.id);
  };
  const task = (planId: number, title: string, done: boolean) => q.query(
    `INSERT INTO todo (title, from_id, to_id, done, src, plan_id) VALUES ($1,$2,$3,$4,'plan',$5)`,
    [title, CEO, MGR, done, planId],
  );

  /* ── ① §61 카드 · ② 기획 동그라미 ─────────────────────────────────────── */

  it('§61 카드의 「과제 1/3」 · 기한 낱말 · 기한 상태 이름은 서버가 만든다 (61-1 · 61-2 · 61-3)', async () => {
    const late = await plan('9월 신규 상담 유입 30% 늘리기', 'review', day(-4));
    await task(late, '블로그 3편', true);
    await task(late, '릴스 주 2회', false);
    await task(late, '키워드 재조정', false);
    const soon = await plan('자습 관리 정규화', 'rework', day(2), true);
    const done = await plan('SE/TE 공개 범위', 'done', day(-10), true);
    await task(done, '공지', true);
    await task(done, '배포', true);

    const { plans } = await svc().all(CEO, true, true);
    const by = Object.fromEntries(plans.map((p) => [p.id, p]));
    expect(by[late]).toMatchObject({ taskDone: 1, taskTotal: 3, dueLabel: '4일 지남', dueStateLabel: '기한 제안', overdueDays: 4 });
    expect(by[soon]).toMatchObject({ taskDone: 0, taskTotal: 0, dueLabel: 'D-2', dueState: 'approved' });
    // 끝난 기획의 날짜는 재촉이 아니다 — 「10일 지남」을 붉게 세우지 않는다 (overdueDays 와 같은 판정)
    expect(by[done]).toMatchObject({ taskDone: 2, taskTotal: 2, dueLabel: null, overdueDays: 0 });
  });

  it('기획 탭 동그라미는 「대표 손이 가야 할 것」 — 검토 요청 + 보완 요청 (C-4 · §61 「단계 보드 ②」)', async () => {
    await plan('초안', 'draft', null);
    await plan('올라온 것', 'review', day(3));
    await plan('되돌아온 것', 'rework', day(3));
    await plan('승인된 것', 'approved', day(3), true);
    const all = await svc().all(CEO, true, true);
    expect(all.plans).toHaveLength(4);
    expect(all.planPending).toBe(2);
  });

  /* ── ② 컴플레인 동그라미 · §67 「기한 지남 N」 ──────────────────────────── */

  it('§67 「기한 지남 N」은 열린 건 중 기한이 지난 것 — 갈래 칩을 골라도 수는 그대로다 (67-2 · C-4)', async () => {
    await q.query(
      `INSERT INTO cpl (area, stage, body, due_on) VALUES
         ('schedule','received','시간 변경 안내가 늦음',$1::date),
         ('lesson','acting','진도가 느림',$2::date),
         ('teacher','closed','강사 교체 요청',$1::date),
         ('lesson','received','아직 기한 안 됨',$3::date),
         ('book','received','기한 없음',NULL)`,
      [day(-2), day(-1), day(5)],
    );
    const all = await svc().all(CEO, true, true);
    expect(all.cplOverdue).toBe(2);
    // 줄의 overdueDays 와 같은 판정이다 — 두 곳에서 세지 않는다
    expect(all.complaints.filter((c) => c.overdueDays > 0)).toHaveLength(2);
    const lessonOnly = await svc().all(CEO, true, true, { area: 'lesson' });
    expect(lessonOnly.complaints).toHaveLength(2);
    expect(lessonOnly.cplOverdue).toBe(2);
  });

  /* ── ③ §63 줄 · 머리 ──────────────────────────────────────────────── */

  it('§63 줄은 참석자 이름 칩(세 값)·「예정」을 싣고, 머리는 「내 응답 대기」·「속기록 N」을 서버가 센다 (63-2 · 63-5 · 63-6)', async () => {
    const [past] = (await q.query(
      `INSERT INTO mtrec (mt_type, title, on_date, minutes) VALUES ('general','지난 회의',$1,'[정한 것] 끝') RETURNING id`, [day(-3)],
    )) as Array<{ id: string }>;
    const [next] = (await q.query(
      `INSERT INTO mtrec (mt_type, on_date) VALUES ('plan',$1) RETURNING id`, [day(2)],
    )) as Array<{ id: string }>;
    const [today] = (await q.query(
      `INSERT INTO mtrec (mt_type, on_date, minutes) VALUES ('dev',$1,'') RETURNING id`, [todayKst()],
    )) as Array<{ id: string }>;
    await q.query(`INSERT INTO mtattd (mt_id, staff_id, confirmed) VALUES ($1,${CEO},NULL),($1,${MGR},true),($1,${T1},false)`, [past.id]);
    await q.query(`INSERT INTO mtattd (mt_id, staff_id, confirmed) VALUES ($1,${CEO},NULL),($1,${MGR},NULL)`, [next.id]);
    await q.query(`INSERT INTO mtattd (mt_id, staff_id, confirmed) VALUES ($1,${CEO},true)`, [today.id]);

    const all = await svc().all(CEO, true, true);
    const by = Object.fromEntries(all.meetings.map((m) => [m.id, m]));
    expect(by[Number(past.id)].attendeeList.map((a) => [a.name, a.stateLabel])).toEqual([
      ['대표w5', '응답 대기'], ['매니저w5', '참석'], ['강사w5', '불참'],
    ]);
    expect(by[Number(past.id)].upcoming).toBe(false);
    expect(by[Number(next.id)].upcoming).toBe(true);
    // 오늘 회의도 아직 「예정」이다 — 끝났는지는 날짜만으로 모른다
    expect(by[Number(today.id)].upcoming).toBe(true);
    // 내가(대표) 아직 답하지 않은 회의 둘 · 빈 속기록은 쓴 것이 아니다
    expect(all.mtMyWaiting).toBe(2);
    expect(all.mtMinutesCount).toBe(1);
    // 다른 사람이 보면 그 사람의 수다
    expect((await svc().all(MGR, false, false)).mtMyWaiting).toBe(1);
  });

  /* ── ④ §66 머리 ─────────────────────────────────────────────────────── */

  it('§66 머리의 시각·자리는 이어진 회차에서 온다 — §63 줄과 같은 값, 옛 회의는 셋 다 null (66-2)', async () => {
    await q.query(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ('meeting','회의','#5B6470',10,'meeting',false) ON CONFLICT (key) DO NOTHING`);
    const [room] = (await q.query(`INSERT INTO room (branch, name) VALUES ('w5','6호') RETURNING id`)) as Array<{ id: string }>;
    const [ser] = (await q.query(
      `INSERT INTO ser (kind_key, teacher_id, mode, start_min, end_min, rrule, from_date, room_id)
       VALUES ('meeting',$1,'offline',1110,1170,'ONCE',$2::date,$3) RETURNING id`,
      [MGR, day(1), Number(room.id)],
    )) as Array<{ id: string }>;
    const [linked] = (await q.query(
      `INSERT INTO mtrec (mt_type, on_date, ser_id) VALUES ('general',$1,$2) RETURNING id`, [day(1), Number(ser.id)],
    )) as Array<{ id: string }>;
    const [old] = (await q.query(`INSERT INTO mtrec (mt_type, on_date) VALUES ('general',$1) RETURNING id`, [day(-9)])) as Array<{ id: string }>;

    const v = (await svc().meetingDetail(Number(linked.id)))!;
    expect(v).toMatchObject({ startMin: 1110, endMin: 1170, placeLabel: '6호' });
    const row = (await svc().all(CEO, true, true)).meetings.find((m) => m.id === Number(linked.id))!;
    expect({ startMin: row.startMin, endMin: row.endMin, placeLabel: row.placeLabel }).toEqual({ startMin: 1110, endMin: 1170, placeLabel: '6호' });
    expect(await svc().meetingDetail(Number(old.id))).toMatchObject({ startMin: null, endMin: null, placeLabel: null });
  });

  /* ── ⑤ §65 「+ 대표 지시」 ───────────────────────────────────────────── */

  it('「+ 대표 지시」 — 과제(TODO · plan_id)·담당 알림·감사 줄이 한 번에 남고 보고서가 다시 센다 (65-4)', async () => {
    const id = await plan('9월 신규 상담 유입 30% 늘리기', 'review', day(3));
    const before = (await svc().planDetail(id, true, CEO))!;
    expect(before).toMatchObject({ canAddTask: true, addTaskBlockedReason: null, tasks: [] });

    const after = await svc().addPlanTask(CEO, true, id, { title: '  검색광고 키워드 재조정 ', toId: MGR, dueOn: day(4) });
    expect(after.tasks).toEqual([expect.objectContaining({ title: '검색광고 키워드 재조정', toName: '매니저w5', dueOn: day(4), done: false })]);
    expect(after.taskDone).toBe(0);

    const [todo] = (await q.query(`SELECT src, plan_id, from_id, to_id FROM todo WHERE plan_id = $1`, [id])) as Array<Record<string, string>>;
    expect({ src: todo.src, plan: Number(todo.plan_id), from: Number(todo.from_id), to: Number(todo.to_id) })
      .toEqual({ src: 'plan', plan: id, from: CEO, to: MGR });
    const notis = (await q.query(`SELECT to_id, link, category FROM noti WHERE to_id = $1`, [MGR])) as Array<Record<string, string>>;
    expect(notis).toEqual([{ to_id: String(MGR), link: `/ops?tab=plan&plan=${id}`, category: 'request' }]);
    expect(await q.query(`SELECT 1 FROM log WHERE entity='plan' AND entity_id=$1 AND action='task'`, [id])).toHaveLength(1);

    // §61 카드 · §62 기한 표가 같은 과제를 본다
    const all = await svc().all(CEO, true, true);
    expect(all.plans.find((p) => p.id === id)).toMatchObject({ taskDone: 0, taskTotal: 1 });
    expect(all.planDues.some((r) => r.kind === 'task' && r.planId === id)).toBe(true);
  });

  it('자기에게 준 지시는 알림을 남기지 않는다 · 그만둔 사람에게는 404 · 빈 제목은 409', async () => {
    const id = await plan('자기 과제', 'draft', null);
    await svc().addPlanTask(CEO, true, id, { title: '내가 할 것', toId: CEO });
    expect(await q.query(`SELECT 1 FROM noti`)).toHaveLength(0);
    await expect(svc().addPlanTask(CEO, true, id, { title: '퇴사자', toId: GONE })).rejects.toMatchObject({ status: 404 });
    await expect(svc().addPlanTask(CEO, true, id, { title: '   ', toId: MGR })).rejects.toMatchObject({ status: 409 });
    expect(await q.query(`SELECT 1 FROM todo WHERE plan_id = $1`, [id])).toHaveLength(1);
  });

  it('끝난 기획·권한 없는 사람은 막힌다 — 단추의 이유 문장이 곧 쓰기의 409 문장이다 (S5 · D-R22)', async () => {
    const done = await plan('끝난 기획', 'done', null);
    const closed = (await svc().planDetail(done, true, CEO))!;
    expect(closed.canAddTask).toBe(false);
    const err = await svc().addPlanTask(CEO, true, done, { title: '늦은 지시', toId: MGR }).catch((e: { response?: { message?: string }; status?: number }) => e);
    expect((err as { status?: number }).status).toBe(409);
    expect((err as { response: { message: string } }).response.message).toBe(closed.addTaskBlockedReason);

    const open = await plan('열린 기획', 'draft', null);
    const noPerm = (await svc().planDetail(open, false, MGR))!;
    expect(noPerm.canAddTask).toBe(false);
    const err2 = await svc().addPlanTask(MGR, false, open, { title: '권한 없음', toId: MGR }).catch((e) => e);
    expect((err2 as { status?: number }).status).toBe(409);
    expect((err2 as { response: { message: string } }).response.message).toBe(noPerm.addTaskBlockedReason);
    expect(await q.query(`SELECT 1 FROM todo`)).toHaveLength(0);
    await expect(svc().addPlanTask(CEO, true, 999_999, { title: '없는 기획', toId: MGR })).rejects.toMatchObject({ status: 404 });
  });
});
