/** @file-guide
 * 목적: lead-fail-race-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 상담 실패 · 되살리기의 경합 (PB-12-1) — W11 · N-87.
 *
 * `failLead` 는 상담 건을 **잠그지 않고 읽은 뒤** 트랜잭션에서 **무조건** `stage = 'failed'` 로 썼다. 그 사이 등록 확정
 * (`EnrollService.enroll` — 건을 `FOR UPDATE` 로 잠그고 `enrolled` 로 쓴다)이 먼저 커밋되면, 풀린 뒤의 UPDATE 가
 * **등록된 건을 실패로 덮었다** — 학생 · 수업 · 청구는 선 채로 상담 보드에서는 「등록 실패」다. `resumeLead` 도 같았다 —
 * 「바로 수업 등록」으로 등록된 건을 옛 단계로 되돌려 놓았다.
 *
 * 이 스위트는 **실제 두 연결**로 그 순서를 만든다 — 한 연결이 등록 확정과 같은 차례(`SELECT … FOR UPDATE` → `UPDATE`)로
 * 건을 잠근 채 쓰고, 그동안 실패(되살리기) 요청이 들어와 기다리다가, 잠금이 풀린 뒤 무엇을 쓰는지 본다.
 * 판정을 복제하지 않고 서비스를 그대로 부른다. 쓰기가 커밋되므로 이 스위트가 만든 id 로만 지운다(전역 DELETE 없음 · S7 규약).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
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
    extra: { max: 6 },
  });
}

const MGR = 9661;

d('상담 실패 · 되살리기 — 등록 확정과의 경합 (PB-12-1 · N-87)', () => {
  let ds: DataSource;
  const made: number[] = [];

  const svc = () => makeOpsService(ds.getRepository(Lead));
  const leadRow = async (id: number) => (await ds.query(
    `SELECT stage, fail_from, stop_at FROM lead WHERE id = $1`, [id],
  ))[0] as { stage: string; fail_from: string | null; stop_at: string | null };
  const stageLogs = async (id: number) => ((await ds.query(
    `SELECT stage FROM lead_stage_log WHERE lead_id = $1 ORDER BY id`, [id],
  )) as Array<{ stage: string }>).map((r) => r.stage);

  const newLead = async (stage: string, failFrom: string | null = null): Promise<number> => {
    const [r] = (await ds.query(
      `INSERT INTO lead (name, stage, fail_from, owner_id) VALUES ('경합 상담', $1, $2, ${MGR}) RETURNING id`, [stage, failFrom],
    )) as Array<{ id: string }>;
    made.push(Number(r.id));
    return Number(r.id);
  };

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
    throw new Error('요청이 잠금을 기다리지 않았다 — 경합을 만들지 못했다');
  };

  /** 등록 확정과 같은 차례로 건을 잠그고 쓴다 — 커밋은 부르는 쪽이 정한다 */
  const holdAndWrite = async (id: number, sql: string): Promise<QueryRunner> => {
    const other = ds.createQueryRunner();
    await other.connect();
    await other.startTransaction();
    await other.query(`SELECT id FROM lead WHERE id = $1 FOR UPDATE`, [id]);
    await other.query(sql, [id]);
    return other;
  };

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
    await ds.query(
      `INSERT INTO staff (id,name,email,role) VALUES (${MGR},'경합 상담자','w11-c2-race@t.kr','manager') ON CONFLICT (id) DO NOTHING`,
    );
  });
  afterAll(async () => {
    if (ds?.isInitialized) {
      if (made.length) {
        await ds.query(`DELETE FROM lead_stage_log WHERE lead_id = ANY($1::bigint[])`, [made]);
        await ds.query(`DELETE FROM lead WHERE id = ANY($1::bigint[])`, [made]);
      }
      await ds.query(`DELETE FROM staff WHERE id = ${MGR}`);
      await ds.destroy();
    }
  });

  it('등록 확정이 잠금을 쥔 채 등록을 쓰는 동안 들어온 실패 지정은, 풀린 뒤 **등록된 건을 실패로 덮지 않는다**', async () => {
    const id = await newLead('second');
    const enroll = await holdAndWrite(id, `UPDATE lead SET stage = 'enrolled' WHERE id = $1`);

    const fail = svc().failLead(MGR, id, { reason: '연락이 끊김' }).then(() => 'ok' as const, (e: unknown) => e);
    await waitForLockWaiter();
    await enroll.commitTransaction();
    await enroll.release();

    expect(await fail).toMatchObject({ response: { code: 'ENROLLED_LOCKED' } });
    expect(await leadRow(id)).toMatchObject({ stage: 'enrolled', fail_from: null });
    // 거절된 쓰기는 도달 기록을 남기지 않는다
    expect(await stageLogs(id)).toEqual([]);
  });

  it('「바로 수업 등록」이 잠금을 쥔 채 등록을 쓰는 동안 들어온 되살리기는, 풀린 뒤 **등록된 건을 옛 단계로 되돌리지 않는다**', async () => {
    const id = await newLead('failed', 'second');
    const enroll = await holdAndWrite(id, `UPDATE lead SET stage = 'enrolled', fail_from = NULL WHERE id = $1`);

    const resume = svc().resumeLead(MGR, id, {}).then(() => 'ok' as const, (e: unknown) => e);
    await waitForLockWaiter();
    await enroll.commitTransaction();
    await enroll.release();

    expect(await resume).toMatchObject({ response: { code: 'NOT_FAILED' } });
    expect(await leadRow(id)).toMatchObject({ stage: 'enrolled', fail_from: null });
    expect(await stageLogs(id)).toEqual([]);
  });

  it('두 사람이 동시에 실패로 보내면 하나만 선다 — 뒤 사람은 ALREADY_FAILED · 도달 기록 failed 한 줄', async () => {
    const id = await newLead('hold');
    // 앞 사람의 실패 지정 — 서비스가 쓰는 그대로(단계 · fail_from · 도달 기록)를 잠근 채 쓴다
    const first = await holdAndWrite(id, `UPDATE lead SET stage = 'failed', fail_from = 'hold' WHERE id = $1`);
    await first.query(`INSERT INTO lead_stage_log (lead_id, stage, by_id) VALUES ($1, 'failed', ${MGR})`, [id]);

    const second = svc().failLead(MGR, id, {}).then(() => 'ok' as const, (e: unknown) => e);
    await waitForLockWaiter();
    await first.commitTransaction();
    await first.release();

    expect(await second).toMatchObject({ response: { code: 'ALREADY_FAILED' } });
    expect(await leadRow(id)).toMatchObject({ stage: 'failed', fail_from: 'hold' });
    expect(await stageLogs(id)).toEqual(['failed']);
  });

  it('경합이 없으면 그대로 선다 — 실패는 그 순간의 단계를 적고, 되살리기는 그 단계로 돌린다 · 옛 stop_at 은 건드리지 않는다', async () => {
    const id = await newLead('wait2nd');
    await ds.query(`UPDATE lead SET stop_at = 'after_first' WHERE id = $1`, [id]);
    const failed = await svc().failLead(MGR, id, {});
    expect(failed).toMatchObject({ stage: 'failed', failFrom: 'wait2nd', failStopKey: 'wait2nd', failStopLabel: '2차 안 옴', stopAt: 'after_first' });
    const back = await svc().resumeLead(MGR, id, {});
    expect(back).toMatchObject({ stage: 'wait2nd', failFrom: null, stopAt: 'after_first', failStopKey: null });
    expect(await stageLogs(id)).toEqual(['failed', 'wait2nd']);
  });
});
