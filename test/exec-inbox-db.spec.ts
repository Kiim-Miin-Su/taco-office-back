/** @file-guide
 * 목적: exec-inbox-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §69 6영역 · §73 결재함 — **이동만 한다** (N-12 채택 원문 그대로 · D-R27 · 원칙 22 · C37).
 *
 * 여기서 증명하는 것 둘.
 *   ① 「살펴볼 것」은 6영역 배지의 **합**이다 — 머리 숫자와 영역 배지가 따로 세지 않는다(§69: 23 = 2+0+1+1+2+17).
 *   ② 결재함에는 **쓰기 경로가 없다** — 승인·반려는 각 화면에서 한다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { BoardService } from '../src/modules/board/board.service';
import { ExecService } from '../src/modules/exec/exec.service';
import { EXEC_AREA_KEYS, filledAreas } from '../src/lib/exec-areas';
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

d('§69 6영역 · §73 결재함 — 판정 한 곳, 이동만 (C37)', () => {
  let ds: DataSource;
  let q: QueryRunner;

  const svc = () => {
    const repo = q.manager.getRepository(Lead);
    return new ExecService(repo, new BoardService(repo));
  };

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM rpt`);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('살펴볼 것은 6영역 배지의 합이다 — 영역은 대표 관심순으로 고정 (D-R25)', async () => {
    const out = await svc().range('2026-08-01', '2026-08-31', true);
    expect(out.areas.map((a) => a.key)).toEqual([...EXEC_AREA_KEYS]);
    expect(out.reviewCount).toBe(out.areas.reduce((a, x) => a + x.count, 0));
    // 마케팅은 정보성 — 판정이 없다 (DEV-SPEC §5.3)
    expect(out.areas.find((a) => a.key === 'mkt')!.count).toBe(0);
    // 이동 대상이 비어 있으면 「이동만」이 성립하지 않는다
    out.areas.forEach((a) => expect(a.go.startsWith('/')).toBe(true));
  });

  it('회계 배지는 기한이 지났는데 안 들어온 청구서만 센다 — 완납·취소·초안은 빠진다', async () => {
    const [stu] = (await q.query(`INSERT INTO stu (name) VALUES ('배지 학생') RETURNING id`)) as { id: string }[];
    const put = (state: string, due: string) =>
      q.query(
        `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state, due_on)
         VALUES ($1,'2026-08','tuition','8월 수업료',100000,$2::inv_state_t,$3::date)`,
        [Number(stu.id), state, due],
      );
    const before = (await svc().range('2026-08-01', '2026-08-31', true)).areas.find((a) => a.key === 'money')!.count;
    await put('unpaid', '2026-08-10');   // 센다
    await put('partial', '2026-08-11');  // 센다
    await put('paid', '2026-08-12');     // 안 센다 — 들어왔다
    await put('draft', '2026-08-13');    // 안 센다 — 발행 전이다
    await put('unpaid', '2026-09-30');   // 안 센다 — 기한이 아직이다
    const after = (await svc().range('2026-08-01', '2026-08-31', true)).areas.find((a) => a.key === 'money')!.count;
    expect(after - before).toBe(2);
  });

  it('수업 배지는 현황판 판정을 그대로 쓴다 — 두 곳에서 따로 세지 않는다', async () => {
    const repo = q.manager.getRepository(Lead);
    const board = await new BoardService(repo).range({ from: '2026-08-01', to: '2026-08-31' });
    const out = await new ExecService(repo, new BoardService(repo)).range('2026-08-01', '2026-08-31', true);
    expect(out.areas.find((a) => a.key === 'lesson')!.count).toBe(board.missingCount);
  });

  it('결재함은 상태·기재 수·이동 대상을 주고 **승인 버튼에 해당하는 것을 주지 않는다** (N-12)', async () => {
    await q.query(
      `INSERT INTO rpt (rpt_type, on_date, memo, state) VALUES
        ('day','2026-08-21','{"note":"한 줄"}'::jsonb,'draft'),
        ('week','2026-08-17','{"money":"회계 한 줄","ops":"운영 한 줄"}'::jsonb,'rej'),
        ('month','2026-08-01','{}'::jsonb,'sent')`,
    );
    const out = await svc().range('2026-08-01', '2026-08-31', true);
    const byType = Object.fromEntries(out.inbox.map((r) => [r.rptType, r]));

    expect(byType.day).toMatchObject({ state: 'draft', apState: 'waiting', filled: 0, go: 'day' });
    expect(byType.day.label).toBe('26년 8월 21일 금요일');
    // 6영역 키를 적은 것만 센다 — note 한 줄은 영역 기재가 아니다 (§69 «담당 x/6 기재»)
    expect(byType.week).toMatchObject({ state: 'rej', apState: 'back', filled: 2, go: 'week' });
    expect(byType.week.label).toBe('08-17 ~ 08-23');
    expect(byType.month).toMatchObject({ state: 'sent', apState: 'waiting', filled: 0, go: 'month' });
    expect(byType.month.label).toBe('2026년 8월');

    // 줄 배지는 그 줄 기간의 살펴볼 것이다 — 일간은 하루치라 월간보다 클 수 없다
    expect(byType.day.reviewCount).toBeLessThanOrEqual(byType.month.reviewCount);
    // 이동만 — 승인/반려를 뜻하는 필드가 없다
    Object.keys(byType.day).forEach((k) => expect(/approve|reject(?!Reason)|decision/i.test(k)).toBe(false));
  });

  it('기재 수는 6영역 키만 센다 — 빈 문자열·다른 키는 세지 않는다', () => {
    expect(filledAreas({ note: '한 줄' })).toBe(0);
    expect(filledAreas({ money: '  ', ops: '운영' })).toBe(1);
    expect(filledAreas(null)).toBe(0);
    expect(filledAreas({ money: 'a', mkt: 'b', ops: 'c', consulting: 'd', complaint: 'e', lesson: 'f' })).toBe(6);
  });
});
