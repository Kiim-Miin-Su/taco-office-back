/** @file-guide
 * 목적: ops-plan-share-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §61 기획 공개 범위 — W11 운영(O) · N-72 (원문 두 값 · `planCan` 한 곳).
 *
 * 증명하는 것 —
 *   ① 새 기획은 두 값 중 하나를 갖는다(안 보내면 전체 공개) · 옛 기획은 NULL 그대로 모두에게 보이고 칩이 없다.
 *   ② 지정 공개는 **담당 · 지정된 사람 · 결재권자**에게만 — §61 보드 · §62 기한(과제 줄 포함) · §65 보고서 · 쓰기(404)가 같은 판정.
 *   ③ §69 대표 보고의 운영 배지 · 타일 · 펼칠 줄도 같은 판정으로 센다(보이지 않는 기획이 숫자로 새지 않는다).
 *   ④ 공개 범위 바꾸기는 담당 · 결재권자만(403) · 감사 줄(PLAN · share)을 같은 트랜잭션에 남긴다 · 지정 공개가 아니면 사람을 받지 않는다.
 *   ⑤ §75 결재 흐름 투영도 같은 판정을 지난다(`approvalPlanVisible`).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { makeOpsService } from './ops-svc';
import { todayKst } from '../src/lib/kst';
import { assertScratch, TEST_URL } from './db';
import { ExecService } from '../src/modules/exec/exec.service';
import { BoardService } from '../src/modules/board/board.service';
import { DrawerService } from '../src/modules/drawer/drawer.service';
import { approvalPlanVisible, type PlanVisibility } from '../src/lib/approval';

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

const OWNER = 981;
const PICK = 982;
const OTHER = 983;
const CEO = 984;
const GONE = 985;

describe('§75 결재 흐름의 기획 줄 판정 (approvalPlanVisible · N-72)', () => {
  // 공개 범위 재료는 줄(ApRow)이 아니라 기획 한 건의 재료다 — 줄을 만드는 쪽이 이 판정으로 거른 뒤 줄을 만든다(W11 A' 후속 · P)
  const row = (share: string | null, ownerId: number | null, pickIds: number[] = []): PlanVisibility => ({ share, ownerId, pickIds });
  it('옛 기획(NULL) · 전체 공개는 모두에게 · 지정 공개는 담당 · 지정된 사람 · 결재권자(범위 all)에게만', () => {
    expect(approvalPlanVisible(row(null, OWNER), OTHER, 'head')).toBe(true);
    expect(approvalPlanVisible(row('all', OWNER), OTHER, 'head')).toBe(true);
    expect(approvalPlanVisible(row('picked', OWNER, [PICK]), OTHER, 'head')).toBe(false);
    expect(approvalPlanVisible(row('picked', OWNER, [PICK]), PICK, 'head')).toBe(true);
    expect(approvalPlanVisible(row('picked', OWNER, [PICK]), OWNER, 'head')).toBe(true);
    expect(approvalPlanVisible(row('picked', OWNER, [PICK]), OTHER, 'all')).toBe(true);
    // 기획이 아닌 줄은 이 판정을 지나지 않는다 — 판정은 기획 재료만 받는다(서랍의 줄 만들기가 기획 줄에만 부른다)
  });
});

d('§61 기획 공개 범위 — planCan 한 곳을 다섯 읽기가 지난다 (W11 O · N-72)', () => {
  let ds: DataSource;
  let q: QueryRunner;

  const svc = () => makeOpsService(q.manager.getRepository(Lead));
  const exec = () => {
    const repo = q.manager.getRepository(Lead);
    return new ExecService(repo, new BoardService(repo));
  };

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    for (const t of ['todo', 'noti', 'plan_pick']) await q.query(`DELETE FROM ${t}`);
    await q.query(`DELETE FROM log WHERE lower(entity) = 'plan'`);
    await q.query(`DELETE FROM plan`);
    await q.query(
      `INSERT INTO staff (id,name,email,role,title,active) VALUES
         (${OWNER},'담당O7','o7p-owner@t.kr','manager','매니저',true),
         (${PICK},'지정O7','o7p-pick@t.kr','manager',NULL,true),
         (${OTHER},'남O7','o7p-other@t.kr','manager',NULL,true),
         (${CEO},'대표O7','o7p-ceo@t.kr','ceo','대표',true),
         (${GONE},'퇴사O7','o7p-gone@t.kr','manager',NULL,false)
       ON CONFLICT (id) DO NOTHING`,
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  /** 세 기획 — 옛(NULL) · 전체 공개 · 지정 공개(PICK 지정). 셋 다 검토 요청이고 기한이 있다 */
  const seed = async () => {
    const legacy = await plan('옛 기획', null);
    const open = (await svc().createPlan(OWNER, { title: '전체 공개 기획', dueOn: day(5) })).plan.id;
    const secret = (await svc().createPlan(OWNER, { title: '지정 공개 기획', dueOn: day(6), share: 'picked', pickIds: [PICK] })).plan.id;
    await q.query(`UPDATE plan SET stage = 'review' WHERE id = ANY($1::bigint[])`, [[legacy, open, secret]]);
    // 지정 공개 기획의 과제 — §62 표에서 기획이 안 보이면 과제 줄도 안 선다
    await q.query(
      `INSERT INTO todo (title, from_id, to_id, due_on, done, src, plan_id) VALUES ('비밀 과제',$1,$1,$2::date,false,'plan',$3)`,
      [OWNER, day(3), secret],
    );
    return { legacy, open, secret };
  };
  const plan = async (title: string, share: string | null): Promise<number> => {
    const [r] = (await q.query(
      `INSERT INTO plan (title, stage, due_on, owner_id, share) VALUES ($1,'draft',$2::date,$3,$4) RETURNING id`,
      [title, day(4), OWNER, share],
    )) as Array<{ id: string }>;
    return Number(r.id);
  };

  it('새 기획은 두 값 중 하나 — 안 보내면 전체 공개 · 만든 줄에 공개 범위가 남는다 · 옛 기획은 칩이 없다', async () => {
    const created = await svc().createPlan(OWNER, { title: '새 기획' });
    expect(created.plan).toMatchObject({ share: 'all', shareLabel: '전체 공개' });
    const [log] = (await q.query(
      `SELECT after FROM log WHERE entity = 'PLAN' AND action = 'create' AND entity_id = $1`, [created.plan.id],
    )) as Array<{ after: Record<string, unknown> }>;
    expect(log.after).toMatchObject({ share: 'all', pickIds: [] });

    const picked = await svc().createPlan(OWNER, { title: '지정', share: 'picked', pickIds: [PICK, PICK] });
    expect(picked.plan).toMatchObject({ share: 'picked', shareLabel: '지정 공개' });
    const picks = (await q.query(`SELECT staff_id::int AS id FROM plan_pick WHERE plan_id = $1`, [picked.plan.id])) as Array<{ id: number }>;
    expect(picks.map((p) => p.id)).toEqual([PICK]);

    const legacy = await plan('옛 기획', null);
    const all = await svc().all(OTHER, false, false, {}, false);
    expect(all.plans.find((p) => p.id === legacy)).toMatchObject({ share: null, shareLabel: null });
    expect(all.planShares).toEqual([{ key: 'all', label: '전체 공개' }, { key: 'picked', label: '지정 공개' }]);
  });

  it('지정 공개가 아닌데 사람을 보내면 막는다 · 그만둔 사람은 지정하지 못한다 — 기획도 안 생긴다', async () => {
    await expect(svc().createPlan(OWNER, { title: '어긋남', share: 'all', pickIds: [PICK] }))
      .rejects.toMatchObject({ response: { code: 'PLAN_PICK_NOT_PICKED' } });
    await expect(svc().createPlan(OWNER, { title: '퇴사자', share: 'picked', pickIds: [GONE] }))
      .rejects.toMatchObject({ response: { code: 'STAFF_NOT_FOUND' } });
    const [n] = (await q.query(`SELECT count(*)::int AS n FROM plan`)) as Array<{ n: number }>;
    expect(n.n).toBe(0);
  });

  it('§61 보드 · §62 기한 · §65 보고서 — 지정 공개는 담당 · 지정된 사람 · 결재권자에게만 (과제 줄도)', async () => {
    const { legacy, open, secret } = await seed();
    const seen = async (viewer: number, approver: boolean) => {
      const all = await svc().all(viewer, false, false, {}, approver);
      return {
        plans: all.plans.map((p) => p.id).sort((a, b) => a - b),
        dues: all.planDues.map((r) => r.key).sort(),
      };
    };
    const everyone = [legacy, open].sort((a, b) => a - b);
    expect((await seen(OTHER, false)).plans).toEqual(everyone);
    expect((await seen(OTHER, false)).dues).toEqual([`plan:${legacy}`, `plan:${open}`].sort());
    for (const [viewer, approver] of [[PICK, false], [OWNER, false], [OTHER, true]] as const) {
      const s = await seen(viewer, approver);
      expect(s.plans).toEqual([...everyone, secret].sort((a, b) => a - b));
      expect(s.dues).toContain(`plan:${secret}`);
      expect(s.dues.some((k) => k.startsWith('task:'))).toBe(true);
    }
    // 보고서 — 보이지 않으면 없는 것과 같다(null → 404) · 보이면 지정된 사람이 실린다
    expect(await svc().planDetail(secret, false, OTHER)).toBeNull();
    expect(await svc().planDetail(secret, false, PICK)).toMatchObject({
      share: 'picked', shareLabel: '지정 공개', pickIds: [PICK], pickNames: ['지정O7'], canEditShare: false,
    });
    expect(await svc().planDetail(secret, false, OWNER)).toMatchObject({ canEditShare: true });
    expect(await svc().planDetail(secret, true, OTHER)).toMatchObject({ canEditShare: true });
    // 쓰기도 같은 판정 — 안 보이는 기획은 404
    await expect(svc().movePlanStage(OTHER, false, secret, { to: 'draft' } as never))
      .rejects.toMatchObject({ response: { code: 'PLAN_NOT_FOUND' } });
  });

  it('§69 운영 배지 · 결재 대기 타일 · 펼칠 줄도 같은 판정 — 보이지 않는 기획이 숫자로 새지 않는다', async () => {
    const { secret } = await seed();
    const ops = async (viewer: { id: number; canApprovePlan: boolean }) => {
      const out = await exec().range(todayKst(), todayKst(), true, { id: viewer.id, canApprove: true, canApprovePlan: viewer.canApprovePlan });
      const area = out.areas.find((a) => a.key === 'ops')!;
      return {
        count: area.count,
        waiting: out.head.find((h) => h.key === 'waiting')?.value,
        items: area.items.filter((i) => i.key.startsWith('plan-')).map((i) => i.key),
      };
    };
    const other = await ops({ id: OTHER, canApprovePlan: false });
    const ceo = await ops({ id: CEO, canApprovePlan: true });
    expect(ceo.count - other.count).toBe(1);
    expect(Number(ceo.waiting) - Number(other.waiting)).toBe(1);
    expect(other.items).not.toContain(`plan-${secret}`);
    expect(ceo.items).toContain(`plan-${secret}`);
    // 지정된 사람은 결재권자가 아니어도 센다
    expect((await ops({ id: PICK, canApprovePlan: false })).count).toBe(ceo.count);
    // 보는 사람을 모르면 닫는다 — 지정 공개는 세지 않는다
    const unknown = await exec().range(todayKst(), todayKst(), true);
    expect(unknown.areas.find((a) => a.key === 'ops')!.count).toBe(other.count);
  });

  it('공개 범위 바꾸기 — 담당 · 결재권자만 · 단계와 무관 · 감사 줄(PLAN · share)에 앞뒤가 남는다', async () => {
    const { secret } = await seed();
    await q.query(`UPDATE plan SET stage = 'approved' WHERE id = $1`, [secret]);
    // 지정된 사람은 볼 수만 있다
    await expect(svc().patchPlan(PICK, false, secret, { share: 'all' }))
      .rejects.toMatchObject({ response: { code: 'PLAN_SHARE_FORBIDDEN' } });
    // 결재가 끝난 기획이라도 공개 범위는 바꾼다(본문이 아니다) — 본문은 여전히 잠겨 있다
    const v = await svc().patchPlan(OWNER, false, secret, { pickIds: [PICK, OTHER] });
    expect(v).toMatchObject({ share: 'picked', pickIds: [PICK, OTHER] });
    await expect(svc().patchPlan(OWNER, false, secret, { title: '고친 제목' }))
      .rejects.toMatchObject({ response: { code: 'PLAN_LOCKED' } });
    const opened = await svc().patchPlan(CEO, true, secret, { share: 'all' });
    expect(opened).toMatchObject({ share: 'all', pickIds: [] });
    const logs = (await q.query(
      `SELECT actor_id::int AS actor, before, after FROM log WHERE entity = 'PLAN' AND action = 'share' AND entity_id = $1 ORDER BY id`, [secret],
    )) as Array<{ actor: number; before: unknown; after: unknown }>;
    expect(logs).toEqual([
      { actor: OWNER, before: { share: 'picked', pickIds: [PICK] }, after: { share: 'picked', pickIds: [PICK, OTHER] } },
      { actor: CEO, before: { share: 'picked', pickIds: [PICK, OTHER] }, after: { share: 'all', pickIds: [] } },
    ]);
    // 옛 기획은 값을 고르기 전에는 사람만 보낼 수 없다
    const legacy = await plan('옛 기획', null);
    await expect(svc().patchPlan(OWNER, false, legacy, { pickIds: [PICK] }))
      .rejects.toMatchObject({ response: { code: 'PLAN_SHARE_REQUIRED' } });
  });

  it('§75 결재 흐름 — 서랍 원장 행이 공개 범위 재료를 싣고 담당에게는 내가 올린 것으로 선다', async () => {
    const { secret } = await seed();
    const drawer = new DrawerService(q.manager.getRepository(Lead));
    const mine = await drawer.all(OWNER, true, true, false, 'head');
    expect(mine.approvalFlow.mine.map((r) => r.id)).toContain(secret);
    const head = await drawer.all(OTHER, true, true, false, 'head');
    expect([...head.approvalFlow.waiting, ...head.approvalFlow.mine, ...head.approvalFlow.back].map((r) => r.id)).not.toContain(secret);
    const ceo = await drawer.all(CEO, true, true, false, 'all');
    expect(ceo.approvalFlow.waiting.map((r) => r.id)).toContain(secret);
  });
});
