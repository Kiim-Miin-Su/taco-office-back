/** @file-guide
 * 목적: lead-failure-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { makeOpsService } from './ops-svc';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('§24 상담 실패 이력 — 명시값·도달 기록·미분류 (N-25 채택 · C35)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let id: number;

  const svc = () => makeOpsService(q.manager.getRepository(Lead));

  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES (51,'상담자','lead51@t.kr','manager') ON CONFLICT (id) DO NOTHING`);
    const [row] = await q.query(`INSERT INTO lead (name, stage) VALUES ('이력 테스트', 'second') RETURNING id`) as { id: string }[];
    id = Number(row.id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('실패 전이는 이전 단계를 그 순간의 사실로 명시 보존하고 도달 기록을 남긴다', async () => {
    const out = await svc().failLead(51, id, { stopAt: 'after_second', reason: '  시간대 불일치  ' });
    expect(out).toMatchObject({ stage: 'failed', failFrom: 'second', stopAt: 'after_second', revivalStage: 'second', revivalSource: 'explicit' });
    const logs = await q.query(`SELECT stage, by_id FROM lead_stage_log WHERE lead_id = $1 ORDER BY id`, [id]);
    expect(logs).toEqual([expect.objectContaining({ stage: 'failed' })]);
    expect(Number(logs[0].by_id)).toBe(51);
  });

  it('등록 건은 실패로 못 보내고, 이미 실패면 ALREADY_FAILED', async () => {
    await q.query(`UPDATE lead SET stage = 'enrolled' WHERE id = $1`, [id]);
    await expect(svc().failLead(51, id, { stopAt: 'after_second' }))
      .rejects.toMatchObject({ response: { code: 'ENROLLED_LOCKED' } });
    await q.query(`UPDATE lead SET stage = 'failed' WHERE id = $1`, [id]);
    await expect(svc().failLead(51, id, { stopAt: 'after_second' }))
      .rejects.toMatchObject({ response: { code: 'ALREADY_FAILED' } });
  });

  it('되살리기 판정 — 명시값이 최우선이고, 되살리면 명시값·중단 지점은 소거되되 로그는 남는다', async () => {
    await svc().failLead(51, id, { stopAt: 'after_second' });
    const back = await svc().resumeLead(51, id, {});
    expect(back).toMatchObject({ stage: 'second', failFrom: null, stopAt: null, revivalStage: null });
    const logs = await q.query(`SELECT stage FROM lead_stage_log WHERE lead_id = $1 ORDER BY id`, [id]);
    expect(logs.map((r: { stage: string }) => r.stage)).toEqual(['failed', 'second']);
  });

  it('명시값이 없으면 도달 기록 역순(failed 제외)으로 판정한다', async () => {
    await q.query(`INSERT INTO lead_stage_log (lead_id, stage) VALUES ($1,'first'), ($1,'wait2nd')`, [id]);
    await q.query(`UPDATE lead SET stage = 'failed', fail_from = NULL WHERE id = $1`, [id]);
    const view = (await svc().all(1, false, false)).leads.find((l) => l.id === id)!;
    expect(view).toMatchObject({ revivalStage: 'wait2nd', revivalSource: 'log' });
    const back = await svc().resumeLead(51, id, {});
    expect(back.stage).toBe('wait2nd');
  });

  it('레거시(이력 0)는 미분류 — 추정하지 않고 UNCLASSIFIED 로 거절, 단계 지정 시에만 되살린다', async () => {
    await q.query(`UPDATE lead SET stage = 'failed', fail_from = NULL, stop_at = 'after_first' WHERE id = $1`, [id]);
    const view = (await svc().all(1, false, false)).leads.find((l) => l.id === id)!;
    // stop_at 이 있어도 fail_from 으로 추정 이관하지 않는다 (N-25)
    expect(view).toMatchObject({ failFrom: null, revivalStage: null, revivalSource: null });
    await expect(svc().resumeLead(51, id, {})).rejects.toMatchObject({ response: { code: 'UNCLASSIFIED' } });
    const back = await svc().resumeLead(51, id, { to: 'hold' });
    expect(back.stage).toBe('hold');
  });

  it('실패 아닌 건 되살리기는 NOT_FAILED', async () => {
    await expect(svc().resumeLead(51, id, {})).rejects.toMatchObject({ response: { code: 'NOT_FAILED' } });
  });
});
