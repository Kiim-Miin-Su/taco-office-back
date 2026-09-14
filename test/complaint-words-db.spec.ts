/** @file-guide
 * 목적: complaint-words-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §67 컴플레인의 낱말과 §69 배지 — C86-d.
 *
 * **선언과 데이터가 달랐고, 그 차이를 읽은 쪽이 조용히 틀렸다.** DBML·entity 주석은
 * 「open | acting | done」인데 저장되는 말은 `received | acting | closed` 라,
 * `stage <> 'done'` 으로 세던 대표 보고 배지가 **끝난 건까지 전부** 세고 있었다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { BoardService } from '../src/modules/board/board.service';
import { ExecService } from '../src/modules/exec/exec.service';
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

d('§67 낱말과 §69 컴플레인 배지 (C86-d)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let svc: ExecService;

  const cpl = async (stage: string) =>
    q.query(`INSERT INTO cpl (area, stage, body) VALUES ('lesson', $1, '아무 말')`, [stage]);

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM cpl`);
    const repo = q.manager.getRepository(Lead);
    svc = new ExecService(repo, new BoardService(repo));
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const badge = async () =>
    (await svc.range('2026-08-01', '2026-08-31', true)).areas.find((a) => a.key === 'complaint')!.count;

  it('배지는 **아직 안 끝난 것만** 센다 — 결과 칸은 빠진다', async () => {
    await cpl('received'); await cpl('received');
    await cpl('acting');
    await cpl('closed'); await cpl('closed'); await cpl('closed');
    // 전부는 6 이고 열린 것은 3 이다. 한동안 이 자리가 6 을 말했다.
    expect(await badge()).toBe(3);
  });

  it('끝난 건만 있으면 배지는 0 이다 — ✓ 로 보여야 할 자리다', async () => {
    await cpl('closed'); await cpl('closed');
    expect(await badge()).toBe(0);
  });

  it('약속되지 않은 낱말은 **DB 가 막는다** — 직접 INSERT 도 (cpl_stage_words)', async () => {
    // 거절 하나가 트랜잭션을 접으므로 낱말마다 세이브포인트를 둔다
    for (const bad of ['done', 'open', 'DONE']) {
      await q.query(`SAVEPOINT bad_word`);
      await expect(cpl(bad)).rejects.toMatchObject({ constraint: 'cpl_stage_words' });
      await q.query(`ROLLBACK TO SAVEPOINT bad_word`);
    }
  });
});
