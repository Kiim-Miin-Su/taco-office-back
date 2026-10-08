/** @file-guide
 * 목적: BOC-02 건의 동시 답변이 한 건만 커밋되고 뒤 요청은 409로 수렴하는지 실제 두 DB 연결로 검증한다.
 * 책임/재사용: OpsService의 행 잠금·transaction을 그대로 호출하며 scratch DB의 전용 fixture만 정리한다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-02-SCENARIOS-2026-10-06.md · docs/AGENT.md
 */
import { DataSource } from 'typeorm';
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

const CEO = 29871;
const MGR = 29872;
const TEACHER = 29873;

d('BOC-02 건의 답변 동시성', () => {
  let ds: DataSource;
  let suggestionId: number;
  const svc = () => makeOpsService(ds.getRepository(Lead));

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
    await ds.query(
      `INSERT INTO staff (id,name,email,role,active) VALUES
         ($1,'BOC02 대표','boc02-race-ceo@t.kr','ceo',true),
         ($2,'BOC02 매니저','boc02-race-mgr@t.kr','manager',true),
         ($3,'BOC02 강사','boc02-race-teacher@t.kr','teacher',true)
       ON CONFLICT (id) DO UPDATE SET active=true`,
      [CEO, MGR, TEACHER],
    );
  });

  beforeEach(async () => {
    await ds.query(`DELETE FROM noti WHERE to_id=$1 OR from_id IN ($2,$3)`, [TEACHER, CEO, MGR]);
    await ds.query(`DELETE FROM log WHERE entity='SUGGESTION' AND entity_id IN (SELECT id FROM suggestion WHERE staff_id=$1)`, [TEACHER]);
    await ds.query(`DELETE FROM suggestion WHERE staff_id=$1`, [TEACHER]);
    const [row] = await ds.query(
      `INSERT INTO suggestion (staff_id,category,body) VALUES ($1,'schedule','동시 답변 경합 검증') RETURNING id`,
      [TEACHER],
    ) as Array<{ id: string }>;
    suggestionId = Number(row.id);
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DELETE FROM noti WHERE to_id=$1 OR from_id IN ($2,$3)`, [TEACHER, CEO, MGR]);
      await ds.query(`DELETE FROM log WHERE entity='SUGGESTION' AND entity_id IN (SELECT id FROM suggestion WHERE staff_id=$1)`, [TEACHER]);
      await ds.query(`DELETE FROM suggestion WHERE staff_id=$1`, [TEACHER]);
      await ds.query(`DELETE FROM staff WHERE id IN ($1,$2,$3)`, [CEO, MGR, TEACHER]);
      await ds.destroy();
    }
  });

  it('두 답변 중 하나만 저장하고 다른 하나는 SUGGESTION_ALREADY_REPLIED 409가 된다', async () => {
    const replies = ['첫 번째 관리자가 남긴 충분히 긴 답변입니다.', '두 번째 관리자가 남긴 충분히 긴 답변입니다.'];
    const settled = await Promise.allSettled([
      svc().replySuggestion(CEO, suggestionId, { reply: replies[0] }),
      svc().replySuggestion(MGR, suggestionId, { reply: replies[1] }),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ response: { code: 'SUGGESTION_ALREADY_REPLIED' }, status: 409 });

    const [row] = await ds.query(`SELECT state,reply,reply_by FROM suggestion WHERE id=$1`, [suggestionId]);
    expect(row).toMatchObject({ state: 'done', reply: expect.stringMatching(/첫 번째|두 번째/), reply_by: expect.any(String) });
    expect(await ds.query(`SELECT count(*)::int AS n FROM log WHERE entity='SUGGESTION' AND entity_id=$1`, [suggestionId]))
      .toEqual([{ n: 1 }]);
    expect(await ds.query(`SELECT count(*)::int AS n FROM noti WHERE to_id=$1 AND title='건의 답변'`, [TEACHER]))
      .toEqual([{ n: 1 }]);
  });
});
