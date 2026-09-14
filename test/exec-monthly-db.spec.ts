/** @file-guide
 * 목적: exec-monthly-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §71 월간 「어디서 놓쳤나」 — C86-b.
 *
 * 이 판은 **월간에만** 선다. 세우는 근거는 주기 종류가 아니라 **기간 자체**다 —
 * 주는 달을 채울 수 없고 하루도 그렇다. 입력이 둘이면 둘이 어긋날 수 있다.
 *
 * 묶는 기준은 **「들어온 달」**이다. 실패한 시각은 라이브 전이에만 남아 있어 그 전에
 * 만들어진 건에는 없다 — 실패한 날로 묶으면 옛 건이 통째로 사라진다.
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

d('§71 월간 「어디서 놓쳤나」 (C86-b)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let svc: ExecService;

  const lead = async (name: string, createdAt: string, stage: string, stopAt: string | null) => {
    await q.query(
      `INSERT INTO lead (name, stage, stop_at, created_at) VALUES ($1, $2, $3, $4::timestamptz)`,
      [name, stage, stopAt, `${createdAt}T00:00:00Z`],
    );
  };
  const aug = () => svc.range('2026-08-01', '2026-08-31', true);

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM lead_stage_log`);
    await q.query(`DELETE FROM lead`);
    const repo = q.manager.getRepository(Lead);
    svc = new ExecService(repo, new BoardService(repo));
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('기간이 달력 한 달 전체가 아니면 판이 서지 않는다 — 주도 하루도 달을 채울 수 없다', async () => {
    await lead('가', '2026-08-03', 'failed', 'after_first');
    expect((await svc.range('2026-08-17', '2026-08-23', true)).monthly).toBeNull();
    expect((await svc.range('2026-08-21', '2026-08-21', true)).monthly).toBeNull();
    // 1일에서 시작해도 달 끝이 아니면 아니다
    expect((await svc.range('2026-08-01', '2026-08-30', true)).monthly).toBeNull();
  });

  it('달 전체면 선다 — 2월처럼 끝날이 다른 달도 제 끝날을 안다', async () => {
    await lead('나', '2026-02-10', 'failed', 'after_first');
    expect((await svc.range('2026-02-01', '2026-02-28', true)).monthly?.lost).toBe(1);
    expect((await svc.range('2026-02-01', '2026-02-27', true)).monthly).toBeNull();
  });

  it('줄은 깔때기 순이고 **0 인 갈래는 서지 않는다**', async () => {
    await lead('다', '2026-08-02', 'failed', 'after_second');
    await lead('라', '2026-08-03', 'failed', 'before_book');
    await lead('마', '2026-08-04', 'failed', 'before_book');
    const m = (await aug()).monthly!;
    expect(m.lostRows.map((r) => r.key)).toEqual(['before_book', 'after_second']);
    expect(m.lostRows.map((r) => r.count)).toEqual([2, 1]);
    // 낱말은 서버가 쥔다 — 화면이 제 표를 들면 §24 와 갈린다 (D-R18)
    expect(m.lostRows.map((r) => r.label)).toEqual(['상담 예약 전 이탈', '2차 후 미등록']);
  });

  it('분류 안 된 실패도 제 줄로 선다 — 머리의 합과 줄들의 합이 같아야 한다 (N-19 · N-25)', async () => {
    await lead('바', '2026-08-05', 'failed', 'after_first');
    await lead('사', '2026-08-06', 'failed', null);
    const m = (await aug()).monthly!;
    expect(m.lostRows.map((r) => [r.key, r.label, r.count]))
      .toEqual([['after_first', '1차 후 미진행', 1], ['none', '분류 안 됨', 1]]);
    expect(m.lostRows.reduce((a, r) => a + r.count, 0)).toBe(m.lost);
  });

  it('모집단은 **들어온 달**이다 — 실패하지 않은 건도 세고, 지난달에 들어온 건은 안 센다', async () => {
    await lead('아', '2026-07-31', 'failed', 'after_first');   // 지난달 유입
    await lead('자', '2026-08-01', 'first', null);              // 진행 중
    await lead('차', '2026-08-31', 'failed', 'after_first');    // 달 마지막 날
    const m = (await aug()).monthly!;
    expect(m.leads).toBe(2);
    expect(m.lost).toBe(1);
  });

  it('되살린 건의 남은 stop_at 은 줄로 세지 않는다 — 지금 실패인 것만 놓친 것이다', async () => {
    await lead('카', '2026-08-07', 'second', 'after_first');    // 되살아나 2차로 돌아간 건
    const m = (await aug()).monthly!;
    expect(m.leads).toBe(1);
    expect(m.lost).toBe(0);
    expect(m.lostRows).toEqual([]);
  });
});
