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

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => { q = ds.createQueryRunner(); await q.connect(); await q.startTransaction(); });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('프로그램을 만들면 묶음 이름은 서버가 붙인다 — 화면에 코드표를 복사하지 않는다 (D-R18)', async () => {
    const out = await svc().createKind({ key: 'cat_a', name: '검증 수업', color: '#112233', cap: 5, grp: 'lesson' });
    expect(out).toMatchObject({ key: 'cat_a', grp: 'lesson', grpLabel: '수업', rep: false, serCount: 0 });
  });

  it('리포트 대상이면 서식이 있어야 한다 — 만들 때도 고칠 때도', async () => {
    await expect(svc().createKind({ key: 'cat_b', name: 'x', color: '#112233', cap: 5, grp: 'lesson', rep: true }))
      .rejects.toMatchObject({ response: { code: 'REP_FORM_REQUIRED' } });

    await svc().createKind({ key: 'cat_b', name: 'x', color: '#112233', cap: 5, grp: 'lesson' });
    await expect(svc().patchKind('cat_b', { rep: true }))
      .rejects.toMatchObject({ response: { code: 'REP_FORM_REQUIRED' } });
    await expect(svc().patchKind('cat_b', { rep: true, repForm: 'dev' }))
      .resolves.toMatchObject({ rep: true, repForm: 'dev' });
  });

  it('리포트를 끄면 서식도 같이 비운다 — 안 쓰는 서식이 남아 나중에 되살아나지 않게', async () => {
    await svc().createKind({ key: 'cat_c', name: 'x', color: '#112233', cap: 5, grp: 'lesson', rep: true, repForm: 'assess' });
    await expect(svc().patchKind('cat_c', { rep: false })).resolves.toMatchObject({ rep: false, repForm: null });
  });

  it('같은 코드는 두 번 만들지 않는다', async () => {
    await svc().createKind({ key: 'cat_d', name: 'x', color: '#112233', cap: 5, grp: 'meeting' });
    await expect(svc().createKind({ key: 'cat_d', name: 'y', color: '#112233', cap: 5, grp: 'meeting' }))
      .rejects.toMatchObject({ response: { code: 'KIND_KEY_TAKEN' } });
  });

  it('쓰이고 있는 수를 함께 센다 — 코드를 못 바꾸는 이유를 화면이 말할 수 있게', async () => {
    await svc().createKind({ key: 'cat_e', name: '쓰는 수업', color: '#112233', cap: 5, grp: 'lesson' });
    await q.query(
      `INSERT INTO ser (kind_key, mode, start_min, end_min, rrule, from_date)
       VALUES ('cat_e','online',600,660,'WEEKLY:MO',(now() AT TIME ZONE 'Asia/Seoul')::date)`,
    );
    const all = await svc().all();
    expect(all.kinds.find((k) => k.key === 'cat_e')!.serCount).toBe(1);
  });

  it('과목은 끄는 것으로 물러난다 — 지우기가 없다', async () => {
    await svc().createSub({ key: 'cat-sub', name: '검증 과목', color: '#445566' });
    const off = await svc().patchSub('cat-sub', { active: false });
    expect(off).toMatchObject({ key: 'cat-sub', active: false });
    expect(typeof (svc() as unknown as Record<string, unknown>).deleteSub).toBe('undefined');
  });

  it('없는 것은 없다고 말한다', async () => {
    await expect(svc().patchKind('nope', { name: 'x' })).rejects.toMatchObject({ response: { code: 'KIND_NOT_FOUND' } });
    await expect(svc().patchSub('nope', { name: 'x' })).rejects.toMatchObject({ response: { code: 'SUB_NOT_FOUND' } });
  });

  it('바꿀 값이 없으면 그렇다고 말한다 — 빈 UPDATE 를 돌리지 않는다', async () => {
    await svc().createKind({ key: 'cat_f', name: 'x', color: '#112233', cap: 5, grp: 'lesson' });
    await expect(svc().patchKind('cat_f', {})).rejects.toMatchObject({ response: { code: 'NOTHING_TO_CHANGE' } });
  });
});
