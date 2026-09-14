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
    await svc().addVersion(81, libId, {
      edition: 'v2026.03', fromDate: day(-30),
      seFile: { kind: 'lib-se', name: '학생용.pdf', base64: Buffer.from('se').toString('base64') },
    });
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

  it('효력일이 같은 판도 명시적으로 고른 판 하나가 현재가 된다', async () => {
    const first = await svc().addVersion(81, libId, { edition: 'v1', fromDate: todayKst() });
    const second = await svc().addVersion(81, libId, { edition: 'v2', fromDate: todayKst() });
    expect((await book()).versId).toBe(second.id);
    await svc().useVersion(81, first.id);
    expect((await book()).versId).toBe(first.id);
  });

  it('SE/TE 파일은 입력 위치와 종류가 맞아야 판에 연결한다', async () => {
    const made = await svc().addVersion(81, libId, {
      edition: 'v-file',
      seFile: { kind: 'lib-se', name: '학생.pdf', base64: Buffer.from('s').toString('base64') },
    });
    expect(made.seFileId).toEqual(expect.any(Number));
    const shelf = await svc().all();
    expect(shelf.items.find((item) => item.id === libId)).toMatchObject({ hasFile: true, teFileId: null });
    expect(shelf.noFileCount).toBe(shelf.items.filter((item) => item.teFileId === null).length);
    await expect(svc().addVersion(81, libId, {
      edition: 'v-wrong',
      teFile: { kind: 'guide-png', name: '안내.png', base64: Buffer.from('g').toString('base64') },
    }))
      .rejects.toMatchObject({ response: { code: 'BOOK_FILE_KIND_MISMATCH' } });
  });

  it('SE/TE 파일 본문·판·이력은 한 트랜잭션으로 함께 저장한다', async () => {
    const made = await svc().addVersion(81, libId, {
      edition: 'v-atomic',
      seFile: { kind: 'lib-se', name: '학생용.pdf', base64: Buffer.from('student').toString('base64') },
      teFile: { kind: 'lib-te', name: '교사용.pdf', base64: Buffer.from('teacher').toString('base64') },
    });
    expect(made.seFileId).toEqual(expect.any(Number));
    expect(made.teFileId).toEqual(expect.any(Number));
    const files = await q.query(`SELECT id,kind,mime FROM file WHERE id = ANY($1::bigint[]) ORDER BY kind`, [[made.seFileId, made.teFileId]]);
    expect(files).toMatchObject([
      { kind: 'lib-se', mime: 'application/pdf' },
      { kind: 'lib-te', mime: 'application/pdf' },
    ]);
    expect(Number((await q.query(`SELECT count(*)::int AS n FROM hist WHERE ref_id=$1 AND action='book_upload'`, [made.id]))[0].n)).toBe(1);
  });

  it('판 저장이 실패하면 같은 요청에서 올린 FILE도 남지 않는다', async () => {
    await svc().addVersion(81, libId, { edition: 'v-duplicate' });
    const before = Number((await q.query(`SELECT count(*)::int AS n FROM file`))[0].n);
    await expect(svc().addVersion(81, libId, {
      edition: 'v-duplicate',
      seFile: { kind: 'lib-se', name: '고아가되면안됨.pdf', base64: Buffer.from('rollback').toString('base64') },
    })).rejects.toMatchObject({ response: { code: 'VERS_DUPLICATE' } });
    expect(Number((await q.query(`SELECT count(*)::int AS n FROM file`))[0].n)).toBe(before);
  });

  it('한 판의 SE+TE 합계가 서버 상한을 넘으면 413이고 FILE·VERS·HIST가 모두 그대로다', async () => {
    const before = await q.query(`SELECT
      (SELECT count(*)::int FROM file) AS files,
      (SELECT count(*)::int FROM vers WHERE lib_id=$1) AS versions,
      (SELECT count(*)::int FROM hist) AS history`, [libId]);
    await expect(svc().addVersion(81, libId, {
      edition: 'v-too-large',
      seFile: { kind: 'lib-se', name: 'se.pdf', base64: Buffer.alloc(2_000_000, 1).toString('base64') },
      teFile: { kind: 'lib-te', name: 'te.pdf', base64: Buffer.alloc(1_000_001, 2).toString('base64') },
    })).rejects.toMatchObject({ status: 413, response: { code: 'BOOK_FILES_TOO_LARGE' } });
    expect(await q.query(`SELECT
      (SELECT count(*)::int FROM file) AS files,
      (SELECT count(*)::int FROM vers WHERE lib_id=$1) AS versions,
      (SELECT count(*)::int FROM hist) AS history`, [libId])).toEqual(before);
  });

  it('이력 유형 9개는 선택해도 사라지지 않고 목록만 해당 유형으로 좁아진다', async () => {
    await svc().addVersion(81, libId, { edition: 'v2026.03' });
    const board = await svc().historyBoard({ span: 'all', action: 'book_upload' });
    expect(board.actions).toHaveLength(9);
    expect(board.actions.find((action) => action.key === 'book_upload')?.count).toBe(1);
    expect(board.actions.find((action) => action.key === 'teacher_swap')?.count).toBe(0);
    expect(board.items.every((item) => item.action === 'book_upload')).toBe(true);
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

  it('action 필터는 최근 500건 제한 전에 SQL에서 적용된다', async () => {
    await q.query(
      `INSERT INTO hist (entity,ref_id,action,by_id,at) VALUES ('lib',$1,'book_swap',81,now()-interval '2 days')`,
      [libId],
    );
    await q.query(
      `INSERT INTO hist (entity,ref_id,action,by_id,at)
       SELECT 'lib',$1,'book_upload',81,now()-make_interval(secs => g)
         FROM generate_series(1,501) g`,
      [libId],
    );
    const board = await svc().historyBoard({ span: 'all', action: 'book_swap' });
    expect(board.items).toHaveLength(1);
    expect(board.items[0]).toMatchObject({ action: 'book_swap', refId: libId });
  });
});
