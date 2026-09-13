/** @file-guide
 * 목적: exec-period.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §73 결재함의 **주간 줄이 가리키는 주** — C67.
 *
 * 결재함 줄은 「09-09 ~ 09-15」라 적는데 눌러서 열린 주간 화면은 「09-07 ~ 09-13」이었다.
 * 서버는 `RPT.on_date` 를 그대로 주의 시작으로 썼고 화면은 **월요일부터** 셌다 —
 * **누른 것과 열린 것이 다른 주**였다. 기간을 정하는 자리를 서버 하나로 모았다 (D-R37).
 *
 * 원문 §73 의 주간 줄이 「08-17 ~ 08-23」(월~일)이므로 **월요일에 건다.**
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

/** 화면이 쓰는 것과 **같은 셈** — `front/src/lib/calendar.ts` 의 `mondayOf` 와 한 답이어야 한다 */
const mondayOf = (iso: string): string => {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
};

d('§73 결재함 주간 줄 (C67)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let svc: ExecService;

  const rpt = async (rptType: string, onDate: string) => {
    const [r] = (await q.query(
      `INSERT INTO rpt (rpt_type, on_date, state, memo) VALUES ($1, $2::date, 'draft', '{}'::jsonb) RETURNING id`,
      [rptType, onDate],
    )) as Array<{ id: string }>;
    return Number(r.id);
  };
  const line = async (id: number) => (await svc.range('2026-09-01', '2026-09-30', true))
    .inbox.find((x) => x.id === id)!;

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM rpt`);
    const repo = q.manager.getRepository(Lead);
    svc = new ExecService(repo, new BoardService(repo));
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('주간 줄은 **월요일부터 일요일까지**다 — 수요일에 걸린 보고도 그 주를 가리킨다', async () => {
    const id = await rpt('week', '2026-09-09'); // 수요일
    expect((await line(id)).label).toBe('09-07 ~ 09-13');
  });

  it('월요일에 걸린 보고는 그대로다 — 원문 §73 의 「08-17 ~ 08-23」이 그 모양이다', async () => {
    const id = await rpt('week', '2026-08-17'); // 월요일
    await q.query(`DELETE FROM rpt WHERE on_date <> '2026-08-17'`);
    const v = (await svc.range('2026-08-01', '2026-08-31', true)).inbox.find((x) => x.id === id)!;
    expect(v.label).toBe('08-17 ~ 08-23');
  });

  it('일요일에 걸린 보고는 **그 주의 끝**이다 — 다음 주로 밀리지 않는다', async () => {
    const id = await rpt('week', '2026-09-13'); // 일요일
    expect((await line(id)).label).toBe('09-07 ~ 09-13');
  });

  it('서버가 만든 줄과 화면이 셈한 주가 **같은 답**이다 — 누른 것과 열린 것이 갈리면 안 된다', async () => {
    for (const day of ['2026-09-07', '2026-09-09', '2026-09-11', '2026-09-13']) {
      await q.query(`DELETE FROM rpt`);
      const id = await rpt('week', day);
      const { label } = await line(id);
      expect(label.slice(0, 5)).toBe(mondayOf(day).slice(5));
    }
  });

  it('일간·월간은 건드리지 않았다', async () => {
    const day = await rpt('day', '2026-09-09');
    expect((await line(day)).label).toBe('26년 9월 9일 수요일');
    await q.query(`DELETE FROM rpt`);
    const month = await rpt('month', '2026-09-09');
    expect((await line(month)).label).toBe('2026년 9월');
  });
});
