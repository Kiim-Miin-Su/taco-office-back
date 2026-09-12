/** @file-guide
 * 목적: plan-review-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §62 기획 기한 · §65 기획 보고서 — C56.
 *
 * 원문이 두 슬라이드에서 같은 말을 한다 — **「대표는 기한을 먼저 승인해야 최종 승인이
 * 열립니다」.** 컷의 바닥 단추도 「기한부터 승인하세요」다. 아래가 증명하는 것 —
 *   ① **기한 미승인이면 최종 승인이 막힌다.** 화면이 단추를 숨겨도 서버가 막는다.
 *   ② **기한 반려는 기한을 지운다.** 승인 안 된 날짜가 §62 표에 남지 않는다.
 *   ③ **「남은 날」과 「기한 지난 것 N건」을 서버가 만든다** (D-R37).
 *   ④ 상태를 저장하지 않는다 — `due_approved_at` 한 칸에서 파생한다 (D-R39).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { OpsService } from '../src/modules/ops/ops.service';
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

const CEO = 61;
const MGR = 62;

d('§62 기획 기한 · §65 기획 보고서 (C56)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let planId: number;

  const svc = () => new OpsService(q.manager.getRepository(Lead));

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM todo`);
    await q.query(`DELETE FROM plan`);
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES (${CEO},'대표','plan-ceo@t.kr','ceo'),(${MGR},'매니저','plan-mgr@t.kr','manager')
       ON CONFLICT (id) DO NOTHING`,
    );
    const [p] = (await q.query(
      `INSERT INTO plan (title, stage, goal, research, ask, due_on, owner_id)
       VALUES ('9월 신규 상담 유입 30% 늘리기','review','목표 42건','8월 유입 32건','블로그 월 8편',$1,${MGR})
       RETURNING id`,
      [day(-4)],
    )) as Array<{ id: string }>;
    planId = Number(p.id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('기한이 아직 승인 전이면 최종 승인 단추가 닫히고 이유가 문장으로 온다', async () => {
    const v = (await svc().planDetail(planId, true))!;
    expect(v.dueState).toBe('proposed');
    expect(v.dueStateLabel).toBe('기한 제안');
    expect(v.canDecideDue).toBe(true);
    expect(v.canReview).toBe(false);
    // 원문 컷 바닥의 단추 이름 그대로다
    expect(v.reviewBlockedReason).toBe('기한부터 승인하세요');
  });

  it('화면이 단추를 숨겨도 서버가 막는다 (DUE_NOT_APPROVED)', async () => {
    await expect(svc().reviewPlan(CEO, true, planId, { decision: 'approve' }))
      .rejects.toMatchObject({ response: { code: 'DUE_NOT_APPROVED' } });
    const [p] = await q.query(`SELECT stage FROM plan WHERE id=$1`, [planId]);
    expect(p.stage).toBe('review');
  });

  it('기한을 승인하면 최종 승인이 열린다 — 원문 §61·§65 의 순서', async () => {
    const after = await svc().decidePlanDue(CEO, true, planId, { approve: true });
    expect(after.dueState).toBe('approved');
    expect(after.dueApprovedByName).toBe('대표');
    expect(after.canReview).toBe(true);
    expect(after.reviewBlockedReason).toBeNull();

    const done = await svc().reviewPlan(CEO, true, planId, { decision: 'approve' });
    expect(done.stage).toBe('approved');
    expect(done.stageLabel).toBe('승인');
  });

  it('기한 반려는 기한을 지운다 — 승인 안 된 날짜를 §62 표에 남기지 않는다', async () => {
    const after = await svc().decidePlanDue(CEO, true, planId, { approve: false });
    expect(after.dueOn).toBeNull();
    expect(after.dueState).toBe('none');
    expect(after.canDecideDue).toBe(false);
    const { planDues } = await svc().all(CEO, false, true);
    expect(planDues.filter((r) => r.planId === planId && r.kind === 'plan')).toHaveLength(0);
  });

  it('대표가 아니면 기한도 결재도 못 한다 — 매니저가 자기 기획을 스스로 승인할 수 없다', async () => {
    await expect(svc().decidePlanDue(MGR, false, planId, { approve: true }))
      .rejects.toMatchObject({ response: { code: 'CEO_ONLY' } });
    const v = (await svc().planDetail(planId, false))!;
    expect(v.canDecideDue).toBe(false);
    expect(v.reviewBlockedReason).toBe('기획 결재는 대표만 합니다');
  });

  it('보완 요청에는 사유가 필요하다 — 왜 되돌아왔는지가 남아야 한다', async () => {
    await svc().decidePlanDue(CEO, true, planId, { approve: true });
    await expect(svc().reviewPlan(CEO, true, planId, { decision: 'rework', reason: '  ' }))
      .rejects.toMatchObject({ response: { code: 'REASON_REQUIRED' } });

    const back = await svc().reviewPlan(CEO, true, planId, { decision: 'rework', reason: '리서치 근거 부족' });
    expect(back.stage).toBe('rework');
    const [log] = await q.query(
      `SELECT after FROM log WHERE entity='plan' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [planId],
    );
    expect(log.after).toMatchObject({ stage: 'rework', reason: '리서치 근거 부족' });
  });

  it('이미 승인된 기한은 다시 승인하지 않는다', async () => {
    await svc().decidePlanDue(CEO, true, planId, { approve: true });
    await expect(svc().decidePlanDue(CEO, true, planId, { approve: true }))
      .rejects.toMatchObject({ response: { code: 'DUE_ALREADY_APPROVED' } });
  });

  it('§62 는 기획 마감과 과제 기한을 한 표에 섞고 「남은 날」을 서버가 만든다', async () => {
    await q.query(
      `INSERT INTO todo (title, to_id, due_on, done, src, plan_id)
       VALUES ('인스타 릴스 주 2회로 확대',${MGR},$1,false,'plan',$3),
              ('검색광고 키워드 재조정',${MGR},$2,false,'plan',$3),
              ('이미 끝낸 과제',${MGR},$1,true,'plan',$3)`,
      [day(-5), day(2), planId],
    );
    const { planDues, planOverdue } = await svc().all(CEO, false, true);
    const mine = planDues.filter((r) => r.planId === planId);
    // 끝난 과제는 기한 표에 없다 — 남은 일의 목록이다
    expect(mine).toHaveLength(3);
    expect(mine.map((r) => r.dueLabel)).toEqual(['5일 지남', '4일 지남', 'D-2']);
    expect(mine.map((r) => r.kindLabel)).toEqual(['과제', '기획 마감', '과제']);
    expect(mine.every((r) => r.stageLabel === '검토 요청')).toBe(true);
    expect(planOverdue).toBe(2);
  });

  it('오늘 기한은 「오늘」이라고 적는다 — D-0 이 아니다', async () => {
    await q.query(`UPDATE plan SET due_on = $1 WHERE id = $2`, [todayKst(), planId]);
    const { planDues, planOverdue } = await svc().all(CEO, false, true);
    expect(planDues.find((r) => r.planId === planId)!.dueLabel).toBe('오늘');
    expect(planOverdue).toBe(0);
  });

  it('끝난 기획은 기한 표에서 빠진다 — 남은 일만 센다', async () => {
    await svc().decidePlanDue(CEO, true, planId, { approve: true });
    await svc().reviewPlan(CEO, true, planId, { decision: 'approve' });
    const { planDues } = await svc().all(CEO, false, true);
    expect(planDues.filter((r) => r.planId === planId)).toHaveLength(0);
  });

  it('과제 몇 개를 끝냈는지 서버가 센다 — 원문 「과제 1/3」', async () => {
    await q.query(
      `INSERT INTO todo (title, to_id, due_on, done, src, plan_id)
       VALUES ('가',${MGR},$1,true,'plan',$2),('나',${MGR},$1,false,'plan',$2),('다',${MGR},$1,false,'plan',$2)`,
      [day(3), planId],
    );
    const v = (await svc().planDetail(planId, true))!;
    expect({ done: v.taskDone, all: v.tasks.length }).toEqual({ done: 1, all: 3 });
  });

  it('표가 반쪽 승인을 거부한다 — 승인 시각만 있고 누가 했는지 없을 수 없다', async () => {
    await expect(q.query(`UPDATE plan SET due_approved_at = now() WHERE id = $1`, [planId]))
      .rejects.toThrow(/plan_due_approval_pair/);
  });
});
