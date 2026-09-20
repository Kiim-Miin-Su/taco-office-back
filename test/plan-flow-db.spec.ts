/** @file-guide
 * 목적: plan-flow-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * S6 「기획이 결재까지 간다」 — 전수 검수 §5.
 *
 * C56 이 결재를 만들었지만 **거기까지 가는 길이 없었다.** 이 스위트가 증명하는 것 —
 *   ① `stage='review'` 로 가는 길이 있고, **`draft` 를 건너뛰고 승인할 수는 없다**
 *      (그전에는 `PLAN_OPEN_STAGES` 전부가 결재 가능이라 「검토 요청」이 전제가 아니었다).
 *   ② `research` 를 쓰는 길이 있다 — §65 「3 · 리서치」가 영원히 「—」이던 자리다.
 *   ③ **보완 요청 사유가 행에 남고**, 다시 올리면 지워진다.
 *   ④ 「보완 N」은 세는 칸이 아니라 **`log` 에서** 나온다.
 *   ⑤ 승인된 기한은 담당이 못 옮긴다 — 반려된 뒤에는 새로 낼 수 있다.
 *
 * **S5 의 규약을 그대로 따른다** — 닫힌 자리는 실제로 거절되는지, **열린 자리는 실제로
 * 통과하는지**, 그리고 **막힌 이유 문장이 쓰기가 내는 문장과 같은 말인지**를 함께 본다.
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

const CEO = 71;
const MGR = 72;

d('S6 기획이 결재까지 간다 (전수 검수 §5)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let planId: number;

  const svc = () => makeOpsService(q.manager.getRepository(Lead));
  const detail = async (viewer = CEO, canApprove = true) => (await svc().planDetail(planId, canApprove, viewer))!;
  const row = async (): Promise<{ stage: string; rework_reason: string | null; research: string | null }> =>
    (await q.query(`SELECT stage, rework_reason, research FROM plan WHERE id=$1`, [planId]))[0];

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM todo`);
    await q.query(`DELETE FROM log WHERE entity = 'plan'`);
    await q.query(`DELETE FROM plan`);
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES (${CEO},'대표','s6-ceo@t.kr','ceo'),(${MGR},'매니저','s6-mgr@t.kr','manager')
       ON CONFLICT (id) DO NOTHING`,
    );
    // **올린 기획은 언제나 첫 칸이다** — 제품이 만드는 그대로 시작한다(손으로 review 를 박지 않는다)
    const created = await svc().createPlan(MGR, {
      title: '9월 블로그 주 2편', goal: '검색 유입 30% 증가', ask: '외주 예산 40만원', dueOn: day(5),
    });
    planId = created.plan.id;
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  /* ── ① 「검토 요청」이 결재의 전제다 ─────────────────────────────── */

  it('만든 기획은 첫 칸이고, 기한을 승인해도 「검토 요청」 전에는 결재가 안 열린다', async () => {
    expect((await row()).stage).toBe('draft');
    await svc().decidePlanDue(CEO, true, planId, { approve: true });

    const before = await detail();
    expect(before.dueState).toBe('approved');
    expect(before.canReview).toBe(false);
    expect(before.reviewBlockedReason).toBe('아직 검토 요청이 올라오지 않았습니다');

    // 단추만 닫은 것이 아니다 — 같은 요청을 실제로 때려 본다
    await expect(svc().reviewPlan(CEO, true, planId, { decision: 'approve' }))
      .rejects.toMatchObject({ response: { code: 'NOT_REVIEWABLE', message: before.reviewBlockedReason } });
    expect((await row()).stage).toBe('draft');
  });

  it('올리면 열린다 — draft → review → approved 가 실제로 지나간다 (열린 자리도 본다)', async () => {
    await svc().decidePlanDue(CEO, true, planId, { approve: true });
    expect((await detail()).nextStages).toEqual([{ key: 'review', label: '검토 요청' }]);

    const sent = await svc().movePlanStage(MGR, false, planId, { to: 'review' });
    expect(sent.stage).toBe('review');
    expect(sent.stageLabel).toBe('검토 요청');
    // 올라간 뒤에는 옮길 곳이 없다 — 다음 칸을 정하는 것은 대표의 결재다
    expect(sent.nextStages).toEqual([]);

    const open = await detail();
    expect(open.canReview).toBe(true);
    expect(open.reviewBlockedReason).toBeNull();
    const done = await svc().reviewPlan(CEO, true, planId, { decision: 'approve' });
    expect(done.stage).toBe('approved');
  });

  it('승인된 기획은 「완료」로 간다 — §61 다섯째 칸에 처음으로 쓰는 길이 생긴다', async () => {
    await svc().decidePlanDue(CEO, true, planId, { approve: true });
    await svc().movePlanStage(MGR, false, planId, { to: 'review' });
    await svc().reviewPlan(CEO, true, planId, { decision: 'approve' });

    const approved = await detail();
    expect(approved.nextStages).toEqual([{ key: 'done', label: '완료' }]);
    const closed = await svc().movePlanStage(MGR, false, planId, { to: 'done' });
    expect({ stage: closed.stage, label: closed.stageLabel, next: closed.nextStages }).toEqual({
      stage: 'done', label: '완료', next: [],
    });
  });

  it('전이표 밖은 거절하고 **갈 수 있는 곳을 문장이 말한다**', async () => {
    await expect(svc().movePlanStage(MGR, false, planId, { to: 'approved' }))
      .rejects.toMatchObject({
        response: { code: 'PLAN_STAGE_INVALID', message: '작성 중에서는 검토 요청(으)로만 옮길 수 있습니다' },
      });
    expect((await row()).stage).toBe('draft');

    await svc().movePlanStage(MGR, false, planId, { to: 'review' });
    // 결재는 이 경로로 하지 않는다 — 넣으면 자기 결재 금지·기한 승인 선행을 지나지 않는 둘째 승인 경로가 된다
    await expect(svc().movePlanStage(MGR, false, planId, { to: 'approved' }))
      .rejects.toMatchObject({
        response: { code: 'PLAN_STAGE_LOCKED', message: '올라온 기획입니다 — 대표의 결재가 다음 단계를 정합니다' },
      });
  });

  /* ── ② research 를 쓰는 길 ──────────────────────────────────────── */

  it('§65 「3 · 리서치」에 처음으로 글이 들어간다 — 그전에는 시드만 채웠다', async () => {
    expect((await row()).research).toBeNull();
    const after = await svc().patchPlan(MGR, false, planId, { research: '8월 블로그 4편 · 유입 32건 중 11건이 블로그' });
    expect(after.research).toBe('8월 블로그 4편 · 유입 32건 중 11건이 블로그');
    expect((await row()).research).toBe('8월 블로그 4편 · 유입 32건 중 11건이 블로그');
  });

  it('보낸 칸만 고친다 — 안 보낸 칸은 그대로다 (대표 보고 PATCH 와 같은 규약)', async () => {
    const after = await svc().patchPlan(MGR, false, planId, { research: '근거' });
    expect({ goal: after.goal, ask: after.ask, title: after.title }).toEqual({
      goal: '검색 유입 30% 증가', ask: '외주 예산 40만원', title: '9월 블로그 주 2편',
    });
    // 「비운다」와 「안 보낸다」는 다른 뜻이다
    const cleared = await svc().patchPlan(MGR, false, planId, { goal: null });
    expect({ goal: cleared.goal, research: cleared.research }).toEqual({ goal: null, research: '근거' });
  });

  it('올린 뒤에는 못 고친다 — 단추의 이유와 쓰기의 409 가 같은 문장이다', async () => {
    await svc().movePlanStage(MGR, false, planId, { to: 'review' });
    const v = await detail();
    expect(v.canEdit).toBe(false);
    expect(v.editBlockedReason).toBe('대표 확인을 기다리는 중입니다 — 보완 요청을 받은 뒤에 고칠 수 있습니다');
    await expect(svc().patchPlan(MGR, false, planId, { research: '몰래 고치기' }))
      .rejects.toMatchObject({ response: { code: 'PLAN_LOCKED', message: v.editBlockedReason } });
    expect((await row()).research).toBeNull();
  });

  it('결재가 끝난 기획도 못 고친다 — 승인 도장이 다른 글에 찍히면 안 된다', async () => {
    await svc().decidePlanDue(CEO, true, planId, { approve: true });
    await svc().movePlanStage(MGR, false, planId, { to: 'review' });
    await svc().reviewPlan(CEO, true, planId, { decision: 'approve' });
    const v = await detail();
    expect(v.editBlockedReason).toBe('결재가 끝난 기획은 고칠 수 없습니다');
    await expect(svc().patchPlan(MGR, false, planId, { goal: '슬쩍' }))
      .rejects.toMatchObject({ response: { code: 'PLAN_LOCKED', message: v.editBlockedReason } });
  });

  /* ── ③④ 반려 사유와 「보완 N」 ──────────────────────────────────── */

  it('보완 요청 사유가 **행에** 남는다 — 그동안 담당자가 볼 방법이 없었다', async () => {
    await svc().decidePlanDue(CEO, true, planId, { approve: true });
    await svc().movePlanStage(MGR, false, planId, { to: 'review' });
    const back = await svc().reviewPlan(CEO, true, planId, { decision: 'rework', reason: '리서치 근거가 없습니다' });

    expect(back.stage).toBe('rework');
    expect(back.reworkReason).toBe('리서치 근거가 없습니다');
    expect((await row()).rework_reason).toBe('리서치 근거가 없습니다');
    // 되돌아왔으니 다시 고칠 수 있다
    expect(back.canEdit).toBe(true);
    expect(back.editBlockedReason).toBeNull();
    expect(back.nextStages).toEqual([{ key: 'review', label: '검토 요청' }]);
  });

  it('다시 올리면 지난 사유가 사라진다 — 남겨 두면 지금 상태를 속인다 (C85-a)', async () => {
    await svc().decidePlanDue(CEO, true, planId, { approve: true });
    await svc().movePlanStage(MGR, false, planId, { to: 'review' });
    await svc().reviewPlan(CEO, true, planId, { decision: 'rework', reason: '리서치 근거가 없습니다' });
    await svc().patchPlan(MGR, false, planId, { research: '8월 블로그 4편 · 유입 11건' });

    const again = await svc().movePlanStage(MGR, false, planId, { to: 'review' });
    expect(again.reworkReason).toBeNull();
    expect((await row()).rework_reason).toBeNull();
  });

  it('「보완 N」은 세는 칸이 아니라 `log` 에서 나온다 — 시드가 손으로 박은 건은 0 이다', async () => {
    await svc().decidePlanDue(CEO, true, planId, { approve: true });
    await svc().movePlanStage(MGR, false, planId, { to: 'review' });
    await svc().reviewPlan(CEO, true, planId, { decision: 'rework', reason: '근거 부족' });

    const [mine] = (await svc().all(CEO, false, true)).plans.filter((p) => p.id === planId);
    expect(mine.reworkCount).toBe(1);

    // 한 번 더 되돌아오면 2 다 — 사유는 덮이지만 횟수는 쌓인다
    await svc().movePlanStage(MGR, false, planId, { to: 'review' });
    await svc().reviewPlan(CEO, true, planId, { decision: 'rework', reason: '예산 근거 부족' });
    const after = (await svc().all(CEO, false, true)).plans.find((p) => p.id === planId)!;
    expect({ n: after.reworkCount, why: (await detail()).reworkReason }).toEqual({ n: 2, why: '예산 근거 부족' });

    // 손으로 박은 rework 건에는 그 줄이 없다 — 0 이고 칩이 서지 않는다 (N-25)
    const [seeded] = (await q.query(
      `INSERT INTO plan (title, stage, owner_id) VALUES ('손으로 박은 건','rework',${MGR}) RETURNING id`,
    )) as Array<{ id: string }>;
    const legacy = (await svc().all(CEO, false, true)).plans.find((p) => p.id === Number(seeded.id))!;
    expect(legacy.reworkCount).toBe(0);
  });

  /* ── ⑤ 기한을 다시 내는 길 ──────────────────────────────────────── */

  it('승인된 기한은 담당이 못 옮긴다 — 옮길 수 있으면 대표의 승인이 거짓이 된다', async () => {
    await svc().decidePlanDue(CEO, true, planId, { approve: true });
    await expect(svc().patchPlan(MGR, false, planId, { dueOn: day(30) }))
      .rejects.toMatchObject({ response: { code: 'PLAN_DUE_APPROVED' } });
    const v = await detail();
    expect({ due: v.dueOn, state: v.dueState }).toEqual({ due: day(5), state: 'approved' });
    // 승인된 기한만 잠긴다 — 본문은 그대로 고쳐진다
    expect((await svc().patchPlan(MGR, false, planId, { research: '근거' })).research).toBe('근거');
  });

  it('기한이 반려되면 새 날짜를 낼 수 있다 — 그전에는 그 길이 아예 없었다', async () => {
    await svc().decidePlanDue(CEO, true, planId, { approve: false });
    expect((await detail()).dueState).toBe('none');

    const again = await svc().patchPlan(MGR, false, planId, { dueOn: day(12) });
    expect({ due: again.dueOn, state: again.dueState }).toEqual({ due: day(12), state: 'proposed' });
    expect((await detail()).canDecideDue).toBe(true);
  });

  /* ── 표가 마지막으로 막는다 ─────────────────────────────────────── */

  it('표가 낯선 낱말을 거부한다 — 선언과 데이터가 갈리던 자리다 (C86-d)', async () => {
    await expect(q.query(`UPDATE plan SET stage = 'ok' WHERE id = $1`, [planId]))
      .rejects.toThrow(/plan_stage_words/);
  });
});
