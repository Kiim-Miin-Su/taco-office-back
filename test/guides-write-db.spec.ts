/** @file-guide
 * 목적: guides-write-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §43 「문구 관리」와 「안내 작성」 (C51).
 *
 * 여기서 증명하는 것 둘 —
 *   ① **틀을 고쳐도 이미 쓴 안내는 안 바뀐다.** 안내는 본문을 복사해 갖는다
 *      (`guide` 에 `gtpl_id` 가 없는 것이 그 뜻이다). 보낸 말이 나중에 달라지면 안 된다.
 *   ② **상태 낱말을 화면이 보내지 않는다.** 「썼다」만 주면 어느 상태가 되는지는 서버가 정한다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { GuidesService } from '../src/modules/guides/guides.service';
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

d('§43 문구 관리 · 안내 작성 (C51)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let guideId: number;

  const svc = () => new GuidesService(q.manager.getRepository(Lead));

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM gtpl`);
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES (71,'안내 담당','g71@t.kr','ceo') ON CONFLICT (id) DO NOTHING`,
    );
    const [stu] = (await q.query(`INSERT INTO stu (name, grade) VALUES ('안내 학생','G7') RETURNING id`)) as Array<{ id: string }>;
    const [g] = (await q.query(
      `INSERT INTO guide (student_id, reason, state, due_on) VALUES ($1,'new','draft','2026-09-20') RETURNING id`,
      [Number(stu.id)],
    )) as Array<{ id: string }>;
    guideId = Number(g.id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('틀을 만들고 고친다 — 이름이 겹치면 막는다', async () => {
    const made = await svc().createTemplate({ name: '첫 수업 안내', body: '안녕하세요, {학생}님' });
    expect(made).toMatchObject({ name: '첫 수업 안내' });
    await expect(svc().createTemplate({ name: '첫 수업 안내', body: '다른 몸' }))
      .rejects.toMatchObject({ response: { code: 'GTPL_DUPLICATE' } });

    const fixed = await svc().patchTemplate(made.id, { name: '첫 수업 안내(개정)', body: '새 몸' });
    expect(fixed).toMatchObject({ id: made.id, name: '첫 수업 안내(개정)', body: '새 몸' });
  });

  it('고칠 때도 남의 이름과 겹치면 막고, 자기 이름은 그대로 둘 수 있다', async () => {
    const a = await svc().createTemplate({ name: '가', body: 'A' });
    const b = await svc().createTemplate({ name: '나', body: 'B' });
    await expect(svc().patchTemplate(b.id, { name: '가', body: 'B2' }))
      .rejects.toMatchObject({ response: { code: 'GTPL_DUPLICATE' } });
    // 자기 이름을 그대로 두고 본문만 고치는 것은 겹침이 아니다
    const same = await svc().patchTemplate(a.id, { name: '가', body: 'A2' });
    expect(same.body).toBe('A2');
  });

  it('없는 틀을 고치면 404 다', async () => {
    await expect(svc().patchTemplate(99999999, { name: 'x', body: 'y' })).rejects.toThrow();
  });

  it('안내를 쓰면 보낼 준비가 된다 — 상태 낱말을 화면이 보내지 않았는데도', async () => {
    const before = (await q.query(`SELECT state FROM guide WHERE id = $1`, [guideId])) as Array<{ state: string }>;
    expect(before[0].state).toBe('draft');

    const out = await svc().writeBody(71, guideId, { body: '9월 10일 첫 수업입니다' });
    expect(out.body).toBe('9월 10일 첫 수업입니다');
    expect(out.state).toBe('ready');
    expect(out.pending).toBe(true);   // ready 는 아직 안 보낸 것이다

    // §40 「여기에 남는 것」에 「수업 안내 작성」이 있다 — 같은 트랜잭션에서 함께 남는다
    const hist = (await q.query(
      `SELECT action, by_id FROM hist WHERE entity = 'guide' AND ref_id = $1`, [guideId],
    )) as Array<{ action: string; by_id: string }>;
    expect(hist).toHaveLength(1);
    expect(hist[0].action).toBe('guide_write');
    expect(Number(hist[0].by_id)).toBe(71);
  });

  it('안내 쓰기가 막히면 이력도 안 남는다 — 하지도 않은 일이 장부에 찍히면 안 된다', async () => {
    await q.query(`UPDATE guide SET state = 'sent' WHERE id = $1`, [guideId]);
    await expect(svc().writeBody(71, guideId, { body: 'x' })).rejects.toThrow();
    const n = Number((await q.query(
      `SELECT count(*)::int AS n FROM hist WHERE entity = 'guide' AND ref_id = $1`, [guideId],
    ))[0].n);
    expect(n).toBe(0);
  });

  it('이미 보낸 안내는 고치지 않는다 — 학부모가 받은 말과 장부가 갈린다', async () => {
    await q.query(`UPDATE guide SET state = 'sent', body = '보낸 말' WHERE id = $1`, [guideId]);
    await expect(svc().writeBody(71, guideId, { body: '슬쩍 고친 말' }))
      .rejects.toMatchObject({ response: { code: 'GUIDE_ALREADY_SENT' } });
    const after = (await q.query(`SELECT body FROM guide WHERE id = $1`, [guideId])) as Array<{ body: string }>;
    expect(after[0].body).toBe('보낸 말');
  });

  it('틀을 고쳐도 이미 쓴 안내는 안 바뀐다 — 안내는 본문을 복사해 갖는다', async () => {
    const tpl = await svc().createTemplate({ name: '틀', body: '원래 문구' });
    await svc().writeBody(71, guideId, { body: tpl.body });   // 화면이 복사해 넣는다
    await svc().patchTemplate(tpl.id, { name: '틀', body: '바뀐 문구' });

    const after = (await q.query(`SELECT body FROM guide WHERE id = $1`, [guideId])) as Array<{ body: string }>;
    expect(after[0].body).toBe('원래 문구');
  });

  it('없는 안내를 쓰면 404 다', async () => {
    await expect(svc().writeBody(71, 99999999, { body: 'x' })).rejects.toThrow();
  });
});
