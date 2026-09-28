/** @file-guide
 * 목적: ops-assignee-deactivate-race-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 담당 지정 ↔ 계정 「사용 중지」의 경쟁 — TBO-54 코드 리뷰 CR-BE-04.
 *
 * 기획 담당(`patchPlanOwner`)·마케팅 담당(`createMarketing` · `patchMarketing`)·상담 담당(`patchLead`)은 활성 구성원인지를
 * **잠금 없는 SELECT** 로 확인한 뒤 저장했다. 그 확인과 저장 사이에 서랍의 「사용 중지」(`UPDATE staff SET active = false`)가
 * 커밋되면 **그만둔 사람이 담당으로 저장**된다. 이제 넷 모두 `lib/staff-lock.lockActiveStaff`(FOR SHARE) 하나를 같은
 * 트랜잭션에서 부른다 — FOR KEY SHARE 로는 부족하다(키가 아닌 칸만 고치는 UPDATE 와 충돌하지 않는다).
 *
 * 이 스위트는 **실제 두 연결**로 두 순서를 만든다(`ops-plan-due-race-db.spec.ts` 와 같은 방식).
 *   · 비활성화가 먼저 — 서랍이 실제로 내는 문장(FOR UPDATE → UPDATE active=false)을 한 연결이 커밋하지 않은 채 쥐고,
 *     **실제 서비스**의 담당 지정이 들어와 기다리다가, 커밋 뒤 최신 active 로 판정해 404 다. 담당은 그대로 · 알림 · 감사 줄 0.
 *   · 지정이 먼저 — 한 연결이 서비스가 쓰는 그 함수(`lockActiveStaff`)로 담당을 잠근 채 저장하고, **실제 서랍 서비스**의
 *     「사용 중지」가 들어와 기다리다가, 커밋 뒤에야 비활성화된다. 지정 시점에 활성이었으므로 지정은 유효하고 순서가 결정적이다.
 *     (지정 뒤의 비활성화는 별도 업무 사건이다 — 그 담당을 어떻게 이어받게 할지는 이 잠금이 정하는 일이 아니다.)
 * 어느 순서도 timeout · deadlock 없이 끝난다(jest 60초 · 실제 대기는 pg_stat_activity 로 본다). 쓰기는 커밋되므로 이 스위트가 만든
 * id 로만 지운다(전역 DELETE 없음).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { DrawerService } from '../src/modules/drawer/drawer.service';
import { lockActiveStaff } from '../src/lib/staff-lock';
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

const CEO = 891;
const MGR = 892; // 처음 담당
const NEXT = 893; // 새 담당 — 「사용 중지」 대상

d('담당 지정 ↔ 계정 비활성화 경쟁 (CR-BE-04 · lib/staff-lock)', () => {
  let ds: DataSource;
  const plans: number[] = [];
  const mkts: number[] = [];

  const svc = () => makeOpsService(ds.getRepository(Lead));
  const drawer = () => new DrawerService(ds.getRepository(Lead));
  const staffActive = async (id: number) => (await ds.query(`SELECT active FROM staff WHERE id = $1`, [id]))[0].active as boolean;
  const planOwner = async (id: number) => Number((await ds.query(`SELECT owner_id FROM plan WHERE id = $1`, [id]))[0].owner_id);
  const mktBy = async (id: number) => Number((await ds.query(`SELECT by_id FROM mkt WHERE id = $1`, [id]))[0].by_id);
  const logActions = async (entity: string, id: number) => (await ds.query(
    `SELECT action FROM log WHERE lower(entity) = $1 AND entity_id = $2 ORDER BY id`, [entity, id],
  ) as Array<{ action: string }>).map((l) => l.action);

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
    throw new Error('요청이 잠금을 기다리지 않았다 — 경합을 만들지 못했다(잠금 없는 확인이다)');
  };

  /** 실패해도 잠금을 남기지 않는다 — 한 시험의 실패가 다음 시험을 60초 대기로 끌고 가지 않게 */
  const settle = async (r: QueryRunner): Promise<void> => {
    try { if (r.isTransactionActive) await r.rollbackTransaction(); } finally { if (!r.isReleased) await r.release(); }
  };

  /** 서랍 「사용 중지」가 실제로 내는 문장 — 행 FOR UPDATE 뒤 active=false · 커밋은 부르는 쪽이 */
  const holdDeactivation = async (id: number): Promise<QueryRunner> => {
    const r = ds.createQueryRunner();
    await r.connect();
    await r.startTransaction();
    await r.query(`SELECT id FROM staff WHERE id = $1 FOR UPDATE`, [id]);
    await r.query(`UPDATE staff SET active = false WHERE id = $1`, [id]);
    return r;
  };

  const newPlan = async (): Promise<number> => {
    const created = await svc().createPlan(MGR, { title: '담당 경합 기획', goal: '목표', dueOn: `${todayKst().slice(0, 4)}-12-31` });
    plans.push(created.plan.id);
    return created.plan.id;
  };

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
    // 이 스위트의 계정만(이메일로) 먼저 치운다 — 지난 실행이 다른 번호로 남긴 행이 email 유일 제약에 걸리지 않게
    await ds.query(`DELETE FROM staff WHERE email LIKE 'cr-be-04-%@t.kr' AND id <> ALL($1::bigint[])`, [[CEO, MGR, NEXT]]);
    await ds.query(
      `INSERT INTO staff (id,name,email,role) VALUES
         (${CEO},'경합 대표','cr-be-04-ceo@t.kr','ceo'),
         (${MGR},'경합 담당','cr-be-04-mgr@t.kr','manager'),
         (${NEXT},'경합 새 담당','cr-be-04-next@t.kr','manager')
       ON CONFLICT (id) DO NOTHING`,
    );
    await ds.query(`UPDATE staff SET active = true WHERE id = ANY($1::bigint[])`, [[CEO, MGR, NEXT]]);
  });
  afterAll(async () => {
    if (ds?.isInitialized) {
      if (plans.length) {
        await ds.query(`DELETE FROM log WHERE lower(entity) = 'plan' AND entity_id = ANY($1::bigint[])`, [plans]);
        await ds.query(`DELETE FROM todo WHERE plan_id = ANY($1::bigint[])`, [plans]);
        await ds.query(`DELETE FROM plan WHERE id = ANY($1::bigint[])`, [plans]);
      }
      if (mkts.length) {
        await ds.query(`DELETE FROM log WHERE entity = 'MKT' AND entity_id = ANY($1::bigint[])`, [mkts]);
        await ds.query(`DELETE FROM mkt WHERE id = ANY($1::bigint[])`, [mkts]);
      }
      await ds.query(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = ${NEXT}`);
      await ds.query(`DELETE FROM noti WHERE to_id IN (${CEO},${MGR},${NEXT}) OR from_id IN (${CEO},${MGR},${NEXT})`);
      await ds.destroy();
    }
  });
  beforeEach(async () => { await ds.query(`UPDATE staff SET active = true WHERE id = $1`, [NEXT]); });

  /* ── 비활성화가 먼저 ─────────────────────────────────────────────────── */

  it('deactivate-first · 기획 담당: 「사용 중지」가 커밋되기 전 들어온 지정은 기다렸다가 404 — 담당 그대로 · 알림 0 · 감사 줄 0', async () => {
    const id = await newPlan();
    expect(await planOwner(id)).toBe(MGR);
    const deact = await holdDeactivation(NEXT);
    const assign = svc().patchPlanOwner(CEO, true, id, { ownerId: NEXT }).then(() => 'ok' as const, (e: unknown) => e);
    try {
      await waitForLockWaiter(); // 지정이 비활성화의 행 잠금을 기다린다 — 잠금 없는 확인이면 여기서 실패한다
      // 기다리는 동안 아무것도 쓰지 않았다
      expect(await planOwner(id)).toBe(MGR);
      await deact.commitTransaction();
    } finally { await settle(deact); }

    const outcome = await assign;
    expect(outcome).toMatchObject({ response: { code: 'STAFF_NOT_FOUND' } });
    expect(await staffActive(NEXT)).toBe(false);
    expect(await planOwner(id)).toBe(MGR); // 그만둔 사람은 담당이 되지 않았다
    expect((await logActions('plan', id)).filter((a) => a === 'owner')).toEqual([]);
    expect(await ds.query(`SELECT id FROM noti WHERE to_id = $1 AND link LIKE '/ops?tab=plan%'`, [NEXT])).toEqual([]);
  });

  it('deactivate-first · 마케팅 담당(수정·등록): 같은 기다림 · 같은 404 · 행은 그대로', async () => {
    const row = await svc().createMarketing(CEO, true, { title: '담당 경합 활동', channel: 'naver_blog', item: 'post', byId: MGR });
    mkts.push(row.id);
    const deact = await holdDeactivation(NEXT);
    const patch = svc().patchMarketing(CEO, true, row.id, { byId: NEXT }).then(() => 'ok' as const, (e: unknown) => e);
    try {
      await waitForLockWaiter();
      expect(await mktBy(row.id)).toBe(MGR);
      await deact.commitTransaction();
    } finally { await settle(deact); }
    expect(await patch).toMatchObject({ response: { code: 'STAFF_NOT_FOUND' } });
    expect(await mktBy(row.id)).toBe(MGR);
    expect((await logActions('mkt', row.id)).filter((a) => a === 'edit')).toEqual([]);

    // 이미 커밋된 비활성 담당으로 새로 만들기도 404 — 행이 생기지 않는다
    const before = Number((await ds.query(`SELECT count(*)::int AS n FROM mkt WHERE by_id = $1`, [NEXT]))[0].n);
    await expect(svc().createMarketing(CEO, true, { title: '그만둔 담당', channel: 'naver_blog', item: 'post', byId: NEXT }))
      .rejects.toMatchObject({ response: { code: 'STAFF_NOT_FOUND' } });
    expect(Number((await ds.query(`SELECT count(*)::int AS n FROM mkt WHERE by_id = $1`, [NEXT]))[0].n)).toBe(before);
  });

  /* ── 지정이 먼저 ────────────────────────────────────────────────────── */

  it('assign-first · 기획 담당: 지정이 담당을 잠근 채 저장하는 동안 들어온 「사용 중지」는 그 커밋을 기다린다 — 순서가 결정적이고 deadlock 이 없다', async () => {
    const id = await newPlan();
    // 서비스가 쓰는 그 함수로 담당을 잠근다(FOR SHARE) — 트랜잭션은 열어 둔다
    const assign = ds.createQueryRunner();
    await assign.connect();
    await assign.startTransaction();
    let deact: Promise<'ok' | unknown>;
    try {
      await assign.query(`SELECT id FROM plan WHERE id = $1 FOR UPDATE`, [id]);
      expect(await lockActiveStaff(assign, NEXT)).toEqual({ id: NEXT, name: '경합 새 담당' });
      await assign.query(`UPDATE plan SET owner_id = $2 WHERE id = $1`, [id, NEXT]);

      // 실제 서랍 서비스의 「사용 중지」 — 담당 지정의 FOR SHARE 와 충돌해 기다린다
      deact = drawer().setStaffActive(CEO, true, NEXT, false).then(() => 'ok' as const, (e: unknown) => e);
      await waitForLockWaiter();
      expect(await staffActive(NEXT)).toBe(true); // 기다리는 동안 비활성화는 커밋되지 않았다
      await assign.commitTransaction();
    } finally { await settle(assign); }

    expect(await deact).toBe('ok');
    // 지정 시점에 활성이었으므로 담당 저장은 유효하고, 비활성화는 지정이 커밋된 **뒤에** 커밋됐다(기다리는 동안 active 였다)
    expect(await planOwner(id)).toBe(NEXT);
    expect(await staffActive(NEXT)).toBe(false);
    expect((await ds.query(`SELECT action FROM log WHERE entity = 'STAFF' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [NEXT]))[0].action).toBe('deactivate');
  });

  it('FOR KEY SHARE 는 이 경쟁을 막지 못한다 — active 만 고치는 UPDATE 와 충돌하지 않는다(그래서 FOR SHARE 다)', async () => {
    const keyShare = ds.createQueryRunner();
    const other = ds.createQueryRunner();
    try {
      await keyShare.connect();
      await keyShare.startTransaction();
      await keyShare.query(`SELECT id FROM staff WHERE id = $1 AND active FOR KEY SHARE`, [NEXT]);
      // 비활성화 UPDATE 가 기다리지 않고 바로 통과한다 — 확인(active)과 저장 사이에 커밋될 수 있다는 뜻이다
      await other.connect();
      await other.startTransaction();
      const raced = await Promise.race([
        other.query(`UPDATE staff SET active = false WHERE id = $1`, [NEXT]).then(() => 'updated' as const),
        new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 1500)),
      ]);
      expect(raced).toBe('updated');
    } finally { await settle(other); await settle(keyShare); }

    // 같은 자리를 FOR SHARE 로 잠그면 비활성화 UPDATE 가 기다린다
    const share = ds.createQueryRunner();
    const other2 = ds.createQueryRunner();
    try {
      await share.connect();
      await share.startTransaction();
      expect(await lockActiveStaff(share, NEXT)).not.toBeNull();
      await other2.connect();
      await other2.startTransaction();
      const update = other2.query(`UPDATE staff SET active = false WHERE id = $1`, [NEXT]).then(() => 'updated' as const);
      const blocked = await Promise.race([update, new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 1500))]);
      expect(blocked).toBe('blocked');
      await share.rollbackTransaction();
      expect(await update).toBe('updated');
    } finally { await settle(other2); await settle(share); }
    expect(await staffActive(NEXT)).toBe(true);
  });
});
