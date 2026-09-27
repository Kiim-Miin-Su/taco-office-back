/** @file-guide
 * 목적: catalog-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 프로그램·과목 관리 — **§18 서랍의 「프로그램 · 과목 전체 열기」가 가는 자리** (대표 결정 2026-09-12 신설).
 *
 * 여기서 증명하는 것은 셋이다.
 *   ① 코드(key)는 만들 때만 정한다 — 시간표가 그 낱말로 저장돼 있어 바꾸는 자리를 두지 않는다
 *   ② 「리포트 대상」이면 서식이 있어야 한다 — 서식 없이 켜면 쓸 화면이 없다
 *   ③ **지우기는 없다.** 과목은 끄고, 이미 도는 수업은 건드리지 않는다
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Kind } from '../src/entities';
import { CatalogService } from '../src/modules/catalog/catalog.service';
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

d('§18 프로그램·과목 관리 (C48)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const svc = () => new CatalogService(q.manager.getRepository(Kind));
  /** 쓰는 사람 — N-73(W11) 감사 줄의 actor. 트랜잭션 안에서 세우고 되돌린다 */
  const ACTOR = 9361;

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES ($1,'목록 담당','catalog-actor@test','admin') ON CONFLICT (id) DO NOTHING`, [ACTOR]);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('프로그램을 만들면 묶음 이름은 서버가 붙인다 — 화면에 코드표를 복사하지 않는다 (D-R18)', async () => {
    const out = await svc().createKind(ACTOR, { key: 'cat_a', name: '검증 수업', color: '#112233', cap: 5, grp: 'lesson' });
    expect(out).toMatchObject({ key: 'cat_a', grp: 'lesson', grpLabel: '수업', rep: false, serCount: 0 });
  });

  it('리포트 대상이면 서식이 있어야 한다 — 만들 때도 고칠 때도', async () => {
    await expect(svc().createKind(ACTOR, { key: 'cat_b', name: 'x', color: '#112233', cap: 5, grp: 'lesson', rep: true }))
      .rejects.toMatchObject({ response: { code: 'REP_FORM_REQUIRED' } });

    await svc().createKind(ACTOR, { key: 'cat_b', name: 'x', color: '#112233', cap: 5, grp: 'lesson' });
    await expect(svc().patchKind(ACTOR, 'cat_b', { rep: true }))
      .rejects.toMatchObject({ response: { code: 'REP_FORM_REQUIRED' } });
    await expect(svc().patchKind(ACTOR, 'cat_b', { rep: true, repForm: 'dev' }))
      .resolves.toMatchObject({ rep: true, repForm: 'dev' });
  });

  it('리포트를 끄면 서식도 같이 비운다 — 안 쓰는 서식이 남아 나중에 되살아나지 않게', async () => {
    await svc().createKind(ACTOR, { key: 'cat_c', name: 'x', color: '#112233', cap: 5, grp: 'lesson', rep: true, repForm: 'assess' });
    await expect(svc().patchKind(ACTOR, 'cat_c', { rep: false })).resolves.toMatchObject({ rep: false, repForm: null });
  });

  it('같은 코드는 두 번 만들지 않는다', async () => {
    await svc().createKind(ACTOR, { key: 'cat_d', name: 'x', color: '#112233', cap: 5, grp: 'meeting' });
    await expect(svc().createKind(ACTOR, { key: 'cat_d', name: 'y', color: '#112233', cap: 5, grp: 'meeting' }))
      .rejects.toMatchObject({ response: { code: 'KIND_KEY_TAKEN' } });
  });

  it('쓰이고 있는 수를 함께 센다 — 코드를 못 바꾸는 이유를 화면이 말할 수 있게', async () => {
    await svc().createKind(ACTOR, { key: 'cat_e', name: '쓰는 수업', color: '#112233', cap: 5, grp: 'lesson' });
    await q.query(
      `INSERT INTO ser (kind_key, mode, start_min, end_min, rrule, from_date)
       VALUES ('cat_e','online',600,660,'WEEKLY:MO',(now() AT TIME ZONE 'Asia/Seoul')::date)`,
    );
    const all = await svc().all();
    expect(all.kinds.find((k) => k.key === 'cat_e')!.serCount).toBe(1);
  });

  it('과목은 끄는 것으로 물러난다 — 지우기가 없다', async () => {
    await svc().createSub(ACTOR, { key: 'cat-sub', name: '검증 과목', color: '#445566' });
    const off = await svc().patchSub(ACTOR, 'cat-sub', { active: false });
    expect(off).toMatchObject({ key: 'cat-sub', active: false });
    expect(typeof (svc() as unknown as Record<string, unknown>).deleteSub).toBe('undefined');
  });

  it('없는 것은 없다고 말한다', async () => {
    await expect(svc().patchKind(ACTOR, 'nope', { name: 'x' })).rejects.toMatchObject({ response: { code: 'KIND_NOT_FOUND' } });
    await expect(svc().patchSub(ACTOR, 'nope', { name: 'x' })).rejects.toMatchObject({ response: { code: 'SUB_NOT_FOUND' } });
  });

  it('바꿀 값이 없으면 그렇다고 말한다 — 빈 UPDATE 를 돌리지 않는다', async () => {
    await svc().createKind(ACTOR, { key: 'cat_f', name: 'x', color: '#112233', cap: 5, grp: 'lesson' });
    await expect(svc().patchKind(ACTOR, 'cat_f', {})).rejects.toMatchObject({ response: { code: 'NOTHING_TO_CHANGE' } });
  });

  /* ── N-73 채택(W11) — 만들기 · 고치기 · 끄기는 같은 트랜잭션에 감사 한 줄 ── */

  const logs = async (entity: string, key: string) => (await q.query(
    `SELECT actor_id, entity_id, action, before, after FROM log
      WHERE entity = $1 AND (after->>'key' = $2 OR before->>'key' = $2) ORDER BY id`, [entity, key],
  )) as Array<{ actor_id: string; entity_id: string; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>;

  it('N-73 프로그램 만들기 · 고치기는 KIND 감사 줄이 남고 문자 키는 before · after 의 key 에 싣는다', async () => {
    await svc().createKind(ACTOR, { key: 'cat_log', name: '감사 수업', color: '#112233', cap: 5, grp: 'lesson' });
    await svc().patchKind(ACTOR, 'cat_log', { cap: 1, name: '감사 수업 둘' });
    const rows = await logs('KIND', 'cat_log');
    expect(rows.map((r) => r.action)).toEqual(['create', 'patch']);
    expect(rows[0]).toMatchObject({ actor_id: String(ACTOR), entity_id: '0', before: null, after: expect.objectContaining({ key: 'cat_log', cap: 5, grp: 'lesson' }) });
    // 고치기는 보낸 칸만 — 안 보낸 색 · 묶음은 적지 않는다
    expect(rows[1].before).toEqual({ key: 'cat_log', name: '감사 수업', cap: 5 });
    expect(rows[1].after).toEqual({ key: 'cat_log', name: '감사 수업 둘', cap: 1 });
  });

  it('N-73 과목 만들기 · 끄기는 SUB 감사 줄이 남는다 — 끄기는 after.active=false 다', async () => {
    await svc().createSub(ACTOR, { key: 'cat-log', name: '감사 과목', color: '#445566' });
    await svc().patchSub(ACTOR, 'cat-log', { active: false });
    const rows = await logs('SUB', 'cat-log');
    expect(rows.map((r) => r.action)).toEqual(['create', 'patch']);
    expect(rows[1]).toMatchObject({ before: { key: 'cat-log', active: true }, after: { key: 'cat-log', active: false } });
  });

  it('N-73 거절된 쓰기(같은 코드 · 서식 없음 · 바꿀 값 없음)는 감사 줄을 남기지 않는다', async () => {
    await svc().createKind(ACTOR, { key: 'cat_rej', name: 'x', color: '#112233', cap: 5, grp: 'lesson' });
    const before = (await logs('KIND', 'cat_rej')).length;
    await expect(svc().createKind(ACTOR, { key: 'cat_rej', name: 'y', color: '#112233', cap: 5, grp: 'lesson' }))
      .rejects.toMatchObject({ response: { code: 'KIND_KEY_TAKEN' } });
    await expect(svc().patchKind(ACTOR, 'cat_rej', { rep: true })).rejects.toMatchObject({ response: { code: 'REP_FORM_REQUIRED' } });
    await expect(svc().patchKind(ACTOR, 'cat_rej', {})).rejects.toMatchObject({ response: { code: 'NOTHING_TO_CHANGE' } });
    expect((await logs('KIND', 'cat_rej')).length).toBe(before);
  });
});
