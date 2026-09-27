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

  it('실패 전이는 이전 단계를 그 순간의 사실로 명시 보존하고 도달 기록을 남긴다 — 그 단계가 곧 §24 중단 지점이다 (N-87)', async () => {
    const out = await svc().failLead(51, id, { reason: '  시간대 불일치  ' });
    expect(out).toMatchObject({
      stage: 'failed', failFrom: 'second', revivalStage: 'second', revivalSource: 'explicit',
      // 중단 지점은 묻지 않는다 — 실패 당시 단계에서 읽는다 · 옛 칸(stop_at)은 쓰지 않는다
      failStopKey: 'second', failStopLabel: '2차 상담 중단', stopAt: null, stopAtLabel: null,
    });
    const logs = await q.query(`SELECT stage, by_id FROM lead_stage_log WHERE lead_id = $1 ORDER BY id`, [id]);
    expect(logs).toEqual([expect.objectContaining({ stage: 'failed' })]);
    expect(Number(logs[0].by_id)).toBe(51);
  });

  it('A-08 실패와 재연락일은 같은 트랜잭션에서 실패 단계·도달 기록·접촉 원장을 함께 남긴다', async () => {
    const nextOn = '2026-10-10';
    const input = { reason: '월 수업료가 예산을 넘음', reasonKind: 'cost', nextOn };

    const out = await svc().failLead(51, id, input);

    expect(out).toMatchObject({
      stage: 'failed', reasonKind: 'cost',
      recontact: { done: false, label: '재연락 대기', on: nextOn },
    });
    const touches = await q.query(
      `SELECT kind, note, to_char(next_on, 'YYYY-MM-DD') AS next_on, by_id
         FROM lead_touch WHERE lead_id = $1 ORDER BY id`,
      [id],
    );
    expect(touches).toEqual([{
      kind: 'memo', note: '등록 실패 후 재연락 예정', next_on: nextOn, by_id: '51',
    }]);
    expect((await q.query(`SELECT stage FROM lead_stage_log WHERE lead_id = $1 ORDER BY id`, [id])))
      .toEqual([{ stage: 'failed' }]);
  });

  it('A-08 재연락 원장 쓰기가 실패하면 실패 단계와 도달 기록도 함께 되돌아간다', async () => {
    // LeadFailDto와 같은 YYYY-MM-DD 모양이지만 PostgreSQL date로는 존재하지 않아 lead_touch INSERT에서 실패한다.
    const input = { reason: '비용', reasonKind: 'cost', nextOn: '2026-02-30' };

    await expect(svc().failLead(51, id, input)).rejects.toBeDefined();

    expect(await q.query(`SELECT stage, fail_from, reason, reason_kind FROM lead WHERE id = $1`, [id]))
      .toEqual([{ stage: 'second', fail_from: null, reason: null, reason_kind: null }]);
    expect(await q.query(`SELECT stage FROM lead_stage_log WHERE lead_id = $1`, [id])).toEqual([]);
    expect(await q.query(`SELECT id FROM lead_touch WHERE lead_id = $1`, [id])).toEqual([]);
  });

  it('등록 건은 실패로 못 보내고, 이미 실패면 ALREADY_FAILED', async () => {
    await q.query(`UPDATE lead SET stage = 'enrolled' WHERE id = $1`, [id]);
    await expect(svc().failLead(51, id, {}))
      .rejects.toMatchObject({ response: { code: 'ENROLLED_LOCKED' } });
    await q.query(`UPDATE lead SET stage = 'failed' WHERE id = $1`, [id]);
    await expect(svc().failLead(51, id, {}))
      .rejects.toMatchObject({ response: { code: 'ALREADY_FAILED' } });
  });

  it('되살리기 판정 — 명시값이 최우선이고, 되살리면 명시값은 소거되되 로그는 남는다 · 옛 중단 지점(stop_at)은 읽기 전용이라 그대로다 (N-87)', async () => {
    await q.query(`UPDATE lead SET stop_at = 'after_second' WHERE id = $1`, [id]);
    await svc().failLead(51, id, {});
    const back = await svc().resumeLead(51, id, {});
    expect(back).toMatchObject({ stage: 'second', failFrom: null, revivalStage: null, failStopKey: null, stopAt: 'after_second', stopAtLabel: '2차 후 미등록' });
    const logs = await q.query(`SELECT stage FROM lead_stage_log WHERE lead_id = $1 ORDER BY id`, [id]);
    expect(logs.map((r: { stage: string }) => r.stage)).toEqual(['failed', 'second']);
  });

  it('명시값이 없으면 도달 기록 역순(failed 제외)으로 판정한다 — §24 분류도 같은 판정이다', async () => {
    await q.query(`INSERT INTO lead_stage_log (lead_id, stage) VALUES ($1,'first'), ($1,'wait2nd')`, [id]);
    await q.query(`UPDATE lead SET stage = 'failed', fail_from = NULL WHERE id = $1`, [id]);
    const view = (await svc().all(1, false, false)).leads.find((l) => l.id === id)!;
    expect(view).toMatchObject({ revivalStage: 'wait2nd', revivalSource: 'log', failStopKey: 'wait2nd', failStopLabel: '2차 안 옴' });
    const back = await svc().resumeLead(51, id, {});
    expect(back.stage).toBe('wait2nd');
  });

  it('레거시(이력 0)는 미분류 — 추정하지 않고 UNCLASSIFIED 로 거절, 단계 지정 시에만 되살린다', async () => {
    await q.query(`UPDATE lead SET stage = 'failed', fail_from = NULL, stop_at = 'after_first' WHERE id = $1`, [id]);
    const view = (await svc().all(1, false, false)).leads.find((l) => l.id === id)!;
    // stop_at 이 있어도 fail_from 으로 추정 이관하지 않는다 (N-25) — §24 는 「미분류」 · 옛 낱말은 읽기 전용으로 곁에 선다 (N-87)
    expect(view).toMatchObject({
      failFrom: null, revivalStage: null, revivalSource: null,
      failStopKey: 'none', failStopLabel: '미분류', stopAt: 'after_first', stopAtLabel: '1차 후 미진행',
    });
    await expect(svc().resumeLead(51, id, {})).rejects.toMatchObject({ response: { code: 'UNCLASSIFIED' } });
    const back = await svc().resumeLead(51, id, { to: 'hold' });
    expect(back).toMatchObject({ stage: 'hold', stopAt: 'after_first' });
  });

  it('§24 분류 칩은 원문 넷 — 낱말 · 설명 한 줄 · 깔때기 차례 (N-87 · §24 가 정본)', async () => {
    const head = (await svc().all(1, false, false)).intakeHead;
    expect(head.stops.map((s) => [s.key, s.label])).toEqual([
      ['first', '1차 상담 중단'], ['wait2nd', '2차 안 옴'], ['second', '2차 상담 중단'], ['hold', '보류 후 무산'],
    ]);
    expect(head.stops.map((s) => s.sub)).toEqual([
      '첫 통화 뒤 더 진행되지 않았습니다', '일정은 잡았는데 오지 않았습니다', '진단까지 했는데 배치에서 멈췄습니다', '결정을 기다리다 끝났습니다',
    ]);
  });

  it('실패 아닌 건 되살리기는 NOT_FAILED', async () => {
    await expect(svc().resumeLead(51, id, {})).rejects.toMatchObject({ response: { code: 'NOT_FAILED' } });
  });
});
