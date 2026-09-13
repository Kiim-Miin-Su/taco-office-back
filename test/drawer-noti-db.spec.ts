/** @file-guide
 * 목적: drawer-noti-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §16 알림 — 저장 분류와 **보관** (D9 · N-7 · D-16 채택 · C76).
 *
 * 여기서 증명하는 것 셋.
 *   ① 분류는 NOTI.category가 정본이고, 마이그레이션 전 과거 행만 링크 fallback을 쓴다.
 *   ② 「1개월」은 **조회 범위**다 — 창 밖 행이 목록에서 빠져도 표에는 그대로 있다(N-7 영구 보관).
 *   ③ 「전부 읽음」은 **내게 온 것만** 바꾼다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { DrawerService } from '../src/modules/drawer/drawer.service';
import { NOTI_WINDOW_DAYS, notiCategory } from '../src/lib/noti';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

const url = TEST_URL ? assertScratch(TEST_URL) : '';

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions,
    url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

describe('§16 분류 — DB category가 정본이고 과거 행만 링크 fallback (C76)', () => {
  it.each([
    ['/reports/unwritten', 'report_due'],
    ['/reports/12/2026-09-01', 'report'],
    ['/schedule?d=2026-09-01', 'schedule'],
    ['/ops', 'request'],
    ['/accounting/paid', 'etc'],
    [null, 'etc'],
  ])('%s → %s', (link, expected) => {
    expect(notiCategory(null, link as string | null)).toBe(expected);
  });

  it('독촉이 리포트보다 먼저다 — 두 규칙에 걸리는 링크가 독촉으로 간다', () => {
    expect(notiCategory(null, '/reports/unwritten?teacher=3')).toBe('report_due');
  });

  it('같은 독촉 링크라도 저장 분류가 재알람이면 재알람이다', () => {
    expect(notiCategory('re_alarm', '/reports/unwritten')).toBe('re_alarm');
  });
});

d('§16 보관 — 안 보이는 것이지 지운 것이 아니다 (N-7 · D-16 · C38)', () => {
  let ds: DataSource;
  let q: QueryRunner;

  const svc = () => new DrawerService(q.manager.getRepository(Lead));

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM noti`);
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES (71,'받는 사람','noti71@t.kr','manager'),(72,'다른 사람','noti72@t.kr','manager')
       ON CONFLICT (id) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO noti (to_id, body, link, category, created_at) VALUES
        (71, '4시간 이상 미작성 16건', '/reports/unwritten', 'report_due', now()),
        (71, '리포트 승인', '/reports/9/2026-09-01', 'report', now() - interval '2 days'),
        (71, '아주 오래된 알림', '/ops', 'request', now() - interval '400 days'),
        (72, '남의 알림', '/ops', 'request', now())`,
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('기본 창은 최근 30일 — 창 밖 행은 목록에서 빠지지만 표에는 그대로 있다', async () => {
    const out = await svc().all(71, false, false);
    expect(out.notiWindowDays).toBe(NOTI_WINDOW_DAYS);
    expect(out.notis.map((n) => n.body)).toEqual(['4시간 이상 미작성 16건', '리포트 승인']);
    expect(out.notiOlderCount).toBe(1);

    // **지운 적이 없다** — 표에는 내 것 셋이 그대로 있다 (N-7)
    const [{ n }] = (await q.query(`SELECT count(*)::int n FROM noti WHERE to_id = 71`)) as { n: number }[];
    expect(n).toBe(3);
  });

  it('창을 넓히면 보관된 것이 그대로 나온다 — 되살린 것이 아니라 계속 있었던 것이다', async () => {
    const out = await svc().all(71, false, false, true);
    expect(out.notiWindowDays).toBe(0);
    expect(out.notis).toHaveLength(3);
    expect(out.notiOlderCount).toBe(0);
  });

  it('분류와 라벨이 함께 내려간다 — 화면이 코드표를 갖지 않는다 (D-R18)', async () => {
    const out = await svc().all(71, false, false);
    expect(out.notis[0]).toMatchObject({ category: 'report_due', categoryLabel: '작성 독촉' });
    expect(out.notis[1]).toMatchObject({ category: 'report', categoryLabel: '리포트' });
  });

  it('전부 읽음은 내게 온 것만 — 창 밖 것까지 포함하고 남의 것은 건드리지 않는다', async () => {
    const marked = await svc().markAllNotisRead(71);
    expect(marked).toBe(3); // 창 밖 400일 전 것도 포함 — 안 그러면 배지가 영영 안 내려간다
    const [mine] = (await q.query(`SELECT count(*)::int n FROM noti WHERE to_id = 71 AND read_at IS NULL`)) as { n: number }[];
    expect(mine.n).toBe(0);
    const [other] = (await q.query(`SELECT count(*)::int n FROM noti WHERE to_id = 72 AND read_at IS NULL`)) as { n: number }[];
    expect(other.n).toBe(1);
  });

  it('남의 알림은 읽음 처리되지 않고 false 로 답한다 — UPDATE RETURNING 의 [rows,count] 함정', async () => {
    const [mine] = (await q.query(`SELECT id FROM noti WHERE to_id = 71 ORDER BY id LIMIT 1`)) as { id: string }[];
    const [other] = (await q.query(`SELECT id FROM noti WHERE to_id = 72 ORDER BY id LIMIT 1`)) as { id: string }[];
    await expect(svc().markNotiRead(Number(other.id), 71)).resolves.toBe(false);
    await expect(svc().markNotiRead(Number(mine.id), 71)).resolves.toBe(true);
    const [left] = (await q.query(`SELECT count(*)::int n FROM noti WHERE to_id = 72 AND read_at IS NULL`)) as { n: number }[];
    expect(left.n).toBe(1);
  });

  it('남의 할 일도 같은 함정을 지난다 — 체크되지 않고 false 로 답한다', async () => {
    const [t] = (await q.query(
      `INSERT INTO todo (title, to_id, from_id, done) VALUES ('남의 할 일', 72, 72, false) RETURNING id`,
    )) as { id: string }[];
    await expect(svc().setTodoDone(Number(t.id), true, 71, false)).resolves.toBe(false);
    const [row] = (await q.query(`SELECT done FROM todo WHERE id = $1`, [Number(t.id)])) as { done: boolean }[];
    expect(row.done).toBe(false);
    await expect(svc().setTodoDone(Number(t.id), true, 72, false)).resolves.toBe(true);
  });

  it('관리자 범위로 봐도 보관 규칙은 같다 — 범위만 넓어진다', async () => {
    const out = await svc().all(71, true, true);
    expect(out.notis.map((n) => n.body)).toContain('남의 알림');
    expect(out.notis.map((n) => n.body)).not.toContain('아주 오래된 알림');
    expect(out.notiOlderCount).toBe(1);
  });
});
