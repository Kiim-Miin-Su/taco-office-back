/** @file-guide
 * 목적: ops-plan-due-race-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 운영 §65 기획 결재의 경합 (PB-12-2) · 기한 반려 보존 (N-95) — W11.
 *
 * PB-12-2: `decidePlanDue` 는 행을 **잠그지 않고 읽은 뒤** 트랜잭션에서 **무조건** 승인했다. 그 사이 담당이
 * `patchPlan` 으로 기한을 옮기면 **대표가 본 적 없는 날짜가 승인**되고 감사 줄에는 옛 날짜가 적혔다.
 * `reviewPlan` 도 무잠금 판정 뒤 무조건 `UPDATE` 라 동시에 들어온 승인/보완 요청이 서로를 덮었다.
 *
 * 이 스위트는 **실제 두 연결**로 그 순서를 만든다 — 한 연결이 행을 잠근 채 기한(또는 단계)을 바꾸고, 그동안
 * 결재 요청이 들어와 기다리다가, 잠금이 풀린 뒤에 무엇을 쓰는지 본다. 판정을 복제하지 않고 서비스를 그대로 부른다.
 * 쓰기가 커밋되므로 이 스위트가 만든 id 로만 지운다(전역 DELETE 없음 · S7 규약).
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
    extra: { max: 6 },
  });
}

const day = (n: number): string => {
  const t = new Date(`${todayKst()}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

const CEO = 971;
const MGR = 972;
const CEO2 = 973;

d('운영 기획 결재 — 경합과 기한 반려 보존 (PB-12-2 · N-95)', () => {
  let ds: DataSource;
  const made: number[] = [];

  const svc = () => makeOpsService(ds.getRepository(Lead));
  const planRow = async (id: number) => (await ds.query(
    `SELECT to_char(due_on,'YYYY-MM-DD') AS due_on, due_approved_at, due_approved_by, stage, rework_reason,
            to_char(due_rejected_on,'YYYY-MM-DD') AS due_rejected_on, due_rejected_at, due_rejected_by
       FROM plan WHERE id = $1`, [id],
  ))[0] as {
    due_on: string | null; due_approved_at: Date | null; due_approved_by: string | null; stage: string; rework_reason: string | null;
    due_rejected_on: string | null; due_rejected_at: Date | null; due_rejected_by: string | null;
  };
  const logs = async (id: number) => (await ds.query(
    `SELECT action, before, after FROM log WHERE lower(entity) = 'plan' AND entity_id = $1 ORDER BY id`, [id],
  )) as Array<{ action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>;

  /** 다른 연결이 **잠금을 기다리기 시작할 때까지** 기다린다 — 정해진 시간 대신 실제 대기를 본다 */
  const waitForLockWaiter = async (): Promise<void> => {
    for (let i = 0; i < 100; i += 1) {
      const [{ n }] = await ds.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`,
      ) as Array<{ n: number }>;
      if (n > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('결재 요청이 잠금을 기다리지 않았다 — 경합을 만들지 못했다');
  };

  const newPlan = async (dueOn: string | null = day(5)): Promise<number> => {
    // 담당(매니저)이 제 기획을 올린다 — 제품이 만드는 그대로 시작한다
    const created = await svc().createPlan(MGR, { title: '경합 기획', goal: '목표', ...(dueOn ? { dueOn } : {}) });
    made.push(created.plan.id);
    return created.plan.id;
  };

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
    await ds.query(
      `INSERT INTO staff (id,name,email,role) VALUES
         (${CEO},'경합 대표','w11-race-ceo@t.kr','ceo'),
         (${MGR},'경합 매니저','w11-race-mgr@t.kr','manager'),
         (${CEO2},'경합 결재자','w11-race-ceo2@t.kr','manager')
       ON CONFLICT (id) DO NOTHING`,
    );
  });
  afterAll(async () => {
    if (ds?.isInitialized) {
      if (made.length) {
        await ds.query(`DELETE FROM log WHERE lower(entity) = 'plan' AND entity_id = ANY($1::bigint[])`, [made]);
        await ds.query(`DELETE FROM noti WHERE link LIKE '/ops%' AND to_id IN (${CEO},${MGR},${CEO2})`);
        await ds.query(`DELETE FROM todo WHERE plan_id = ANY($1::bigint[])`, [made]);
        await ds.query(`DELETE FROM plan WHERE id = ANY($1::bigint[])`, [made]);
      }
      await ds.destroy();
    }
  });

  /* ── PB-12-2 ① 기한 승인 경합 ────────────────────────────────────── */

  it('담당이 잠금을 쥔 채 기한을 옮기는 동안 들어온 승인은, 풀린 뒤 **본 적 없는 날짜를 승인하지 않는다**', async () => {
    const id = await newPlan(day(5));
    const seen = (await svc().planDetail(id, true, CEO))!;
    expect({ dueOn: seen.dueOn, dueState: seen.dueState }).toEqual({ dueOn: day(5), dueState: 'proposed' });

    // 담당의 기한 고치기 — 행을 잠그고 새 날짜를 쓴 채 아직 커밋하지 않았다
    const owner: QueryRunner = ds.createQueryRunner();
    await owner.connect();
    await owner.startTransaction();
    await owner.query(`SELECT id FROM plan WHERE id = $1 FOR UPDATE`, [id]);
    await owner.query(`UPDATE plan SET due_on = $2::date WHERE id = $1`, [id, day(9)]);

    // 대표는 자기가 본 날짜(day 5)를 승인한다
    const decision = svc().decidePlanDue(CEO, true, id, { approve: true, dueOn: day(5) })
      .then(() => 'ok' as const, (e: unknown) => e);
    await waitForLockWaiter();
    await owner.commitTransaction();
    await owner.release();

    const outcome = await decision;
    expect(outcome).toMatchObject({ response: { code: 'PLAN_DUE_CHANGED' } });
    const row = await planRow(id);
    // 대표가 본 적 없는 day 9 는 승인되지 않았다 — 아직 제안이다
    expect({ due_on: row.due_on, approved: row.due_approved_at !== null }).toEqual({ due_on: day(9), approved: false });
    // 거절된 쓰기는 감사 줄을 남기지 않는다
    expect((await logs(id)).filter((l) => l.action.startsWith('due_'))).toEqual([]);
  });

  it('잠금 없이 **이미 바뀐** 기한도 같다 — 화면에 남은 옛 날짜로는 승인·반려가 되지 않는다', async () => {
    const id = await newPlan(day(4));
    await svc().patchPlan(MGR, false, id, { dueOn: day(8) });
    await expect(svc().decidePlanDue(CEO, true, id, { approve: true, dueOn: day(4) }))
      .rejects.toMatchObject({ response: { code: 'PLAN_DUE_CHANGED' } });
    await expect(svc().decidePlanDue(CEO, true, id, { approve: false, dueOn: day(4) }))
      .rejects.toMatchObject({ response: { code: 'PLAN_DUE_CHANGED' } });
    const row = await planRow(id);
    expect({ due_on: row.due_on, approved: row.due_approved_at !== null, rejected: row.due_rejected_on })
      .toEqual({ due_on: day(8), approved: false, rejected: null });

    // 본 날짜가 지금 날짜와 같으면 그대로 승인된다 — 열린 자리도 본다. 감사 줄은 **승인한 날짜**를 적는다
    const after = await svc().decidePlanDue(CEO, true, id, { approve: true, dueOn: day(8) });
    expect({ dueOn: after.dueOn, dueState: after.dueState }).toEqual({ dueOn: day(8), dueState: 'approved' });
    const approve = (await logs(id)).find((l) => l.action === 'due_approve');
    expect(approve?.after).toMatchObject({ dueOn: day(8) });
  });

  /* ── PB-12-2 ② 최종 결재 경합 ────────────────────────────────────── */

  it('다른 결재자가 잠금을 쥔 채 보완 요청을 쓰는 동안 들어온 최종 승인은, 풀린 뒤 **그 반려를 덮지 않는다**', async () => {
    const id = await newPlan(day(6));
    await svc().decidePlanDue(CEO, true, id, { approve: true, dueOn: day(6) });
    await svc().movePlanStage(MGR, false, id, { to: 'review' });
    expect((await svc().planDetail(id, true, CEO))!.canReview).toBe(true);

    // 다른 결재자가 보완 요청을 쓰고 있다 — 행을 잠근 채 아직 커밋하지 않았다
    const other: QueryRunner = ds.createQueryRunner();
    await other.connect();
    await other.startTransaction();
    await other.query(`SELECT id FROM plan WHERE id = $1 FOR UPDATE`, [id]);
    await other.query(`UPDATE plan SET stage = 'rework', rework_reason = '예산 근거가 없습니다' WHERE id = $1`, [id]);

    const approval = svc().reviewPlan(CEO, true, id, { decision: 'approve' }).then(() => 'ok' as const, (e: unknown) => e);
    await waitForLockWaiter();
    await other.commitTransaction();
    await other.release();

    const outcome = await approval;
    expect(outcome).toMatchObject({ response: { code: 'NOT_REVIEWABLE' } });
    const row = await planRow(id);
    // 먼저 커밋된 보완 요청이 남는다 — 마지막 쓰기가 이기지 않는다
    expect({ stage: row.stage, reason: row.rework_reason }).toEqual({ stage: 'rework', reason: '예산 근거가 없습니다' });
    expect((await logs(id)).filter((l) => l.action === 'approve')).toEqual([]);
  });

  /* ── N-95 기한 반려 보존 ────────────────────────────────────────── */

  it('기한 반려는 날짜를 지우고 **무엇을 언제 누가** 반려했는지 행에 남긴다 — 카드는 「기한 반려」를 세운다', async () => {
    const id = await newPlan(day(3));
    const after = await svc().decidePlanDue(CEO, true, id, { approve: false, dueOn: day(3) });
    const row = await planRow(id);
    expect({ due_on: row.due_on, rejected_on: row.due_rejected_on, by: Number(row.due_rejected_by), at: row.due_rejected_at !== null })
      .toEqual({ due_on: null, rejected_on: day(3), by: CEO, at: true });
    // 보고서 띠와 §61 카드가 같은 낱말을 쓴다 — 칩 낱말은 서버다
    expect({ dueState: after.dueState, dueStateLabel: after.dueStateLabel, dueRejectedOn: after.dueRejectedOn })
      .toEqual({ dueState: 'rejected', dueStateLabel: '기한 반려', dueRejectedOn: day(3) });
    const ops = await svc().all(CEO, true, true, {}, true);
    const card = ops.plans.find((p) => p.id === id)!;
    expect({ dueOn: card.dueOn, dueState: card.dueState, dueStateLabel: card.dueStateLabel, dueRejectedOn: card.dueRejectedOn })
      .toEqual({ dueOn: null, dueState: 'rejected', dueStateLabel: '기한 반려', dueRejectedOn: day(3) });
    // 원문 「D-2 08-19」 — 반려된 날짜의 남은 날 낱말도 서버가 짓는다
    expect(card.dueLabel).toBe('D-3');
    // 감사 줄은 지운 날짜를 before 에 갖는다 (파괴적 쓰기의 흔적)
    const reject = (await logs(id)).find((l) => l.action === 'due_reject');
    expect(reject?.before).toMatchObject({ dueOn: day(3) });
  });

  it('담당이 새 기한을 내면 반려 표시가 비고 다시 「기한 제안」이 된다 — 새 날짜와 반려가 한 카드에 서지 않는다', async () => {
    const id = await newPlan(day(3));
    await svc().decidePlanDue(CEO, true, id, { approve: false, dueOn: day(3) });
    const next = await svc().patchPlan(MGR, false, id, { dueOn: day(10) });
    expect({ dueOn: next.dueOn, dueState: next.dueState, dueRejectedOn: next.dueRejectedOn })
      .toEqual({ dueOn: day(10), dueState: 'proposed', dueRejectedOn: null });
    const row = await planRow(id);
    expect([row.due_rejected_on, row.due_rejected_at, row.due_rejected_by]).toEqual([null, null, null]);
    // 표가 마지막으로 막는다 — 반려 표시를 둔 채 새 기한을 적을 수 없다
    await expect(ds.query(
      `UPDATE plan SET due_rejected_on = $2::date, due_rejected_at = now(), due_rejected_by = ${CEO} WHERE id = $1`, [id, day(3)],
    )).rejects.toThrow(/plan_due_rejected_clears/);
  });

  it('§62 기한 표에도 반려된 날짜가 선다(원문 「08-19 · D-2 · 기획 마감」) — 지나도 붉게 세지 않는다(지금 기한이 아니다)', async () => {
    const soon = await newPlan(day(3));
    const past = await newPlan(day(-2));
    await svc().decidePlanDue(CEO, true, soon, { approve: false, dueOn: day(3) });
    await svc().decidePlanDue(CEO, true, past, { approve: false, dueOn: day(-2) });
    const ops = await svc().all(CEO, true, true, {}, true);
    const row = (id: number) => ops.planDues.find((d) => d.key === `plan:${id}`);
    expect(row(soon)).toMatchObject({ kind: 'plan', dueOn: day(3), dueLabel: 'D-3', overdueDays: 0 });
    expect(row(past)).toMatchObject({ dueOn: day(-2), dueLabel: '2일 지남', overdueDays: 0 });
    // 「기한 지난 것 N건」은 지금 기한만 센다 — 반려된 날짜는 넣지 않는다
    expect(ops.planOverdue).toBe(ops.planDues.filter((d) => d.overdueDays > 0).length);
    expect(ops.planDues.filter((d) => d.overdueDays > 0).map((d) => d.key)).not.toContain(`plan:${past}`);
    // 새 기한을 내면 그 날짜 한 줄로 바뀐다 — 반려된 날짜와 두 줄이 되지 않는다
    await svc().patchPlan(MGR, false, soon, { dueOn: day(9) });
    const again = await svc().all(CEO, true, true, {}, true);
    expect(again.planDues.filter((d) => d.key === `plan:${soon}`).map((d) => d.dueOn)).toEqual([day(9)]);
  });

  it('제목만 고치면 반려 표시는 그대로다 — 새 기한을 낸 것이 아니다', async () => {
    const id = await newPlan(day(2));
    await svc().decidePlanDue(CEO, true, id, { approve: false, dueOn: day(2) });
    const edited = await svc().patchPlan(MGR, false, id, { title: '경합 기획 (고침)' });
    expect({ dueState: edited.dueState, dueRejectedOn: edited.dueRejectedOn }).toEqual({ dueState: 'rejected', dueRejectedOn: day(2) });
  });
});
