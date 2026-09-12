/** @file-guide
 * 목적: book-version-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §39 판(VERS) · §40 이력(HIST) — C52.
 *
 * 증명하는 것 셋 —
 *   ① **「더 최신 판이 있다」를 서버가 판정한다.** 화면이 두 낱말을 비교하면 배지와 띠가 갈린다.
 *   ② **이력은 쓰기와 같은 트랜잭션에서 남는다.** 막힌 쓰기는 이력도 남기지 않는다.
 *   ③ **이력 문장은 읽을 때 만든다.** 교재 이름이 바뀌면 이력 줄도 새 이름으로 읽힌다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { BooksService } from '../src/modules/books/books.service';
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
  });
}

/** 오늘에서 n 일 (음수면 과거) */
const day = (n: number): string => {
  const t = new Date(`${todayKst()}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

d('§39 판 · §40 이력 (C52)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let libId: number;

  const svc = () => new BooksService(q.manager.getRepository(Lead));
  const book = async () => (await svc().all()).items.find((i) => i.id === libId)!;

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM hist`);
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES (81,'교재 담당','b81@t.kr','ceo') ON CONFLICT (id) DO NOTHING`,
    );
    const [l] = (await q.query(
      `INSERT INTO lib (code, title) VALUES ('VERS-TEST-001','판 시험 교재') RETURNING id`,
    )) as Array<{ id: string }>;
    libId = Number(l.id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('판이 하나도 없으면 「더 나중 판」도 없다 — null 끼리 비교해 참이 되면 안 된다', async () => {
    const b = await book();
    expect(b.edition).toBeNull();
    expect(b.latestEdition).toBeNull();
    expect(b.hasNewer).toBe(false);
    expect(b.hasFile).toBe(false);   // 줄 파일이 없는 것은 같다
  });

  it('아직 시작 안 한 판이 있으면 「더 나중 판이 있다」 — 판정은 서버가 한다', async () => {
    await svc().addVersion(81, libId, { edition: 'v2026.03', fromDate: day(-30), fileUrl: '/files/1' });
    const before = await book();
    expect(before).toMatchObject({ edition: 'v2026.03', latestEdition: 'v2026.03', hasNewer: false, hasFile: true });

    await svc().addVersion(81, libId, { edition: 'v2026.08', fromDate: day(+7) });
    const after = await book();
    // 지금 쓰는 판은 그대로고, 가장 나중 판만 달라진다 — 그게 ⇧ 배지다
    expect(after).toMatchObject({ edition: 'v2026.03', latestEdition: 'v2026.08', hasNewer: true });
  });

  it('판 버튼을 누르면 오늘부터 그 판을 쓴다 — 그리고 ⇧ 가 사라진다', async () => {
    await svc().addVersion(81, libId, { edition: 'v2026.03', fromDate: day(-30) });
    const next = await svc().addVersion(81, libId, { edition: 'v2026.08', fromDate: day(+7) });
    expect((await book()).hasNewer).toBe(true);

    const used = await svc().useVersion(81, next.id);
    expect(used).toMatchObject({ edition: 'v2026.08', fromDate: todayKst(), inUse: true });
    const after = await book();
    expect(after).toMatchObject({ edition: 'v2026.08', latestEdition: 'v2026.08', hasNewer: false });
  });

  it('이미 쓰고 있는 판은 다시 당기지 않는다 — 이력에 같은 일이 두 번 남는다', async () => {
    const v = await svc().addVersion(81, libId, { edition: 'v2026.03', fromDate: day(-1) });
    await expect(svc().useVersion(81, v.id)).rejects.toMatchObject({
      response: { code: 'VERS_ALREADY_IN_USE' },
    });
    const n = Number((await q.query(`SELECT count(*)::int AS n FROM hist WHERE action = 'book_swap'`))[0].n);
    expect(n).toBe(0);
  });

  it('같은 교재에 같은 판 이름은 둘일 수 없다 — 배지 글자가 같으면 구별이 안 된다', async () => {
    await svc().addVersion(81, libId, { edition: 'v2026.03' });
    await expect(svc().addVersion(81, libId, { edition: 'v2026.03' }))
      .rejects.toMatchObject({ response: { code: 'VERS_DUPLICATE' } });
  });

  it('막힌 쓰기는 이력도 안 남긴다 — 하지도 않은 일이 장부에 찍히면 안 된다', async () => {
    await svc().addVersion(81, libId, { edition: 'v1' });
    const before = Number((await q.query(`SELECT count(*)::int AS n FROM hist`))[0].n);
    await expect(svc().addVersion(81, libId, { edition: 'v1' })).rejects.toThrow();
    const after = Number((await q.query(`SELECT count(*)::int AS n FROM hist`))[0].n);
    expect(after).toBe(before);
  });

  it('이력 문장은 읽을 때 만든다 — 교재 이름이 바뀌면 이력도 새 이름으로 읽힌다', async () => {
    await svc().addVersion(81, libId, { edition: 'v2026.03' });
    const first = (await svc().history()).find((h) => h.action === 'book_upload')!;
    expect(first.subject).toBe('판 시험 교재 · v2026.03');
    expect(first.actionLabel).toBe('교재 업로드');   // 낱말은 서버가 만든다
    expect(first.byName).toBe('교재 담당');

    await q.query(`UPDATE lib SET title = '이름이 바뀐 교재' WHERE id = $1`, [libId]);
    const again = (await svc().history()).find((h) => h.action === 'book_upload')!;
    expect(again.subject).toBe('이름이 바뀐 교재 · v2026.03');
  });

  it('이력은 최근 것이 먼저 온다', async () => {
    const a = await svc().addVersion(81, libId, { edition: 'v1', fromDate: day(-10) });
    await svc().addVersion(81, libId, { edition: 'v2', fromDate: day(+3) });
    await svc().useVersion(81, a.id === 0 ? a.id : (await q.query(
      `SELECT id FROM vers WHERE lib_id = $1 AND edition = 'v2'`, [libId],
    ))[0].id);
    const rows = await svc().history();
    expect(rows[0].action).toBe('book_swap');
    expect(rows.map((r) => r.action)).toContain('book_upload');
  });
});
