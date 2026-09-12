/** @file-guide
 * 목적: req-review-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §14 승인 대기함 — **요청 처리 (C41)**.
 *
 * C39 는 요청을 올리기만 했다. 여기서 증명하는 것은 그 요청이 **실제로 적용된다**는 것이다 —
 * 상태만 'approved' 로 적어 두면 강사 화면의 시급은 그대로고, 아무도 그 사실을 모른 채
 * 「승인했다」고 믿는다.
 *
 *   ① 시급 승인 → WAGE 새 줄. `from_date` 는 **승인일**이고 지난 줄은 그대로다 (D8 소급 없음).
 *   ② 시간대 승인 → STAFF.tz.
 *   ③ **반려는 아무것도 적용하지 않는다.** 사유 없는 반려는 저장 전에 막힌다 (D-R13).
 *   ④ 적용 대상이 없는 갈래는 상태만 닫는다 — 없는 적용을 지어내지 않는다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { DrawerService } from '../src/modules/drawer/drawer.service';
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

d('§14 요청 처리 — 승인은 실제로 바꾸고, 반려는 아무것도 바꾸지 않는다 (C41)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const TEACHER = 91;
  const BOSS = 92;

  const svc = () => new DrawerService(q.manager.getRepository(Lead));

  const openReq = async (reqType: string, payload: Record<string, unknown>, staffId = TEACHER) => {
    const [r] = (await q.query(
      `INSERT INTO req (staff_id, req_type, payload) VALUES ($1,$2,$3::jsonb) RETURNING id`,
      [staffId, reqType, JSON.stringify(payload)],
    )) as { id: string }[];
    return Number(r.id);
  };
  const reqRow = async (id: number) =>
    (await q.query(`SELECT state, resolved_by, reject_reason FROM req WHERE id = $1`, [id]))[0] as
      { state: string; resolved_by: string | null; reject_reason: string | null };
  const wages = async () =>
    (await q.query(
      `SELECT rate, to_char(from_date,'YYYY-MM-DD') AS from_date, reason, approved_by
         FROM wage WHERE staff_id = $1 ORDER BY from_date`, [TEACHER],
    )) as Array<{ rate: number; from_date: string; reason: string | null; approved_by: string | null }>;
  const tzOf = async (id: number) =>
    String(((await q.query(`SELECT tz FROM staff WHERE id = $1`, [id]))[0] as { tz: string }).tz);
  const notis = async () =>
    (await q.query(`SELECT body, link FROM noti WHERE to_id = $1 ORDER BY id`, [TEACHER])) as
      Array<{ body: string; link: string }>;

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(
      `INSERT INTO staff (id,name,email,role,tz) VALUES
         ($1,'요청 강사','req91@t.kr','teacher','Asia/Seoul'),
         ($2,'처리 관리자','boss92@t.kr','admin','Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET tz = 'Asia/Seoul'`, [TEACHER, BOSS],
    );
    await q.query(`DELETE FROM noti WHERE to_id = $1`, [TEACHER]);
    await q.query(`DELETE FROM req WHERE staff_id IN ($1,$2)`, [TEACHER, BOSS]);
    await q.query(`DELETE FROM wage WHERE staff_id = $1`, [TEACHER]);
    await q.query(`INSERT INTO wage (staff_id, rate, from_date) VALUES ($1, 42000, '2026-01-01')`, [TEACHER]);
    await q.query(
      `INSERT INTO tzg (id, name, tz) VALUES (1,'한국 (KST)','Asia/Seoul'), (2,'미국 동부','America/New_York')
       ON CONFLICT (id) DO NOTHING`,
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('시급 승인은 **WAGE 새 줄**을 만든다 — 옛 줄은 그대로다 (D8 소급 없음)', async () => {
    const id = await openReq('wage_change', { from: 42000, to: 45000, reason: '3년차' });
    const out = await svc().reviewRequest(id, BOSS, { decision: 'approve', reason: '경력 확인' }, true);

    expect(out.state).toBe('approved');
    expect(out.applied).toMatch(/45,000원\/시간 · \d{4}-\d{2}-\d{2}부터/);

    const rows = await wages();
    expect(rows).toHaveLength(2);
    // 지난 수업은 그때 시급 그대로 — 옛 줄을 고치지 않는다
    expect(rows[0]).toMatchObject({ rate: 42000, from_date: '2026-01-01' });
    expect(Number(rows[1].rate)).toBe(45000);
    expect(rows[1].from_date).not.toBe('2026-01-01');
    expect(Number(rows[1].approved_by)).toBe(BOSS);
    expect(rows[1].reason).toBe('경력 확인');

    expect(await reqRow(id)).toMatchObject({ state: 'approved', reject_reason: null });
    const sent = await notis();
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('승인');
    expect(sent[0].body).toContain('45,000원/시간');
  });

  it('시간대 승인은 STAFF.tz 를 바꾼다 — 목록에 없는 값은 승인 시점에 막힌다', async () => {
    const bad = await openReq('tz_change', { from: 'Asia/Seoul', tz: 'Mars/Olympus' });
    await expect(svc().reviewRequest(bad, BOSS, { decision: 'approve' }, true))
      .rejects.toMatchObject({ response: { code: 'TZ_UNKNOWN' } });
    expect(await tzOf(TEACHER)).toBe('Asia/Seoul');

    const ok = await openReq('tz_change', { from: 'Asia/Seoul', tz: 'America/New_York' });
    const out = await svc().reviewRequest(ok, BOSS, { decision: 'approve' }, true);
    expect(out.applied).toBe('America/New_York');
    expect(await tzOf(TEACHER)).toBe('America/New_York');
  });

  it('반려는 **아무것도 적용하지 않는다** — 그리고 사유 없이는 저장되지 않는다 (D-R13)', async () => {
    const id = await openReq('wage_change', { from: 42000, to: 45000 });

    await expect(svc().reviewRequest(id, BOSS, { decision: 'reject' }, true))
      .rejects.toMatchObject({ response: { code: 'REJECT_REASON_REQUIRED' } });
    await expect(svc().reviewRequest(id, BOSS, { decision: 'reject', reason: '   ' }, true))
      .rejects.toMatchObject({ response: { code: 'REJECT_REASON_REQUIRED' } });
    expect(await reqRow(id)).toMatchObject({ state: 'pending' });

    const out = await svc().reviewRequest(id, BOSS, { decision: 'reject', reason: '3개월 뒤 재검토' }, true);
    expect(out).toMatchObject({ state: 'rejected', applied: null });
    expect(await reqRow(id)).toMatchObject({ state: 'rejected', reject_reason: '3개월 뒤 재검토' });
    expect(await wages()).toHaveLength(1);
    const sent = await notis();
    expect(sent[0].body).toContain('반려');
    expect(sent[0].body).toContain('3개월 뒤 재검토');
  });

  it('한 줄은 한 번만 처리된다 — 두 번째는 REQ_NOT_PENDING 이고 시급 줄이 두 개 되지 않는다', async () => {
    const id = await openReq('wage_change', { from: 42000, to: 45000 });
    await svc().reviewRequest(id, BOSS, { decision: 'approve' }, true);
    await expect(svc().reviewRequest(id, BOSS, { decision: 'approve' }, true))
      .rejects.toMatchObject({ response: { code: 'REQ_NOT_PENDING' } });
    expect(await wages()).toHaveLength(2);
  });

  it('자기가 올린 요청은 자기가 처리할 수 없다', async () => {
    const mine = await openReq('wage_change', { from: 42000, to: 45000 }, BOSS);
    await expect(svc().reviewRequest(mine, BOSS, { decision: 'approve' }, true))
      .rejects.toMatchObject({ response: { code: 'SELF_APPROVAL_FORBIDDEN' } });
  });

  it('같은 날 두 번 올리면 두 번째 승인은 막힌다 — 지난 수업의 단가가 흔들리지 않게', async () => {
    const a = await openReq('wage_change', { from: 42000, to: 45000 });
    const b = await openReq('wage_change', { from: 42000, to: 46000 });
    await svc().reviewRequest(a, BOSS, { decision: 'approve' }, true);
    await expect(svc().reviewRequest(b, BOSS, { decision: 'approve' }, true))
      .rejects.toMatchObject({ response: { code: 'WAGE_SAME_DAY' } });
    expect(await wages()).toHaveLength(2);
    expect(await reqRow(b)).toMatchObject({ state: 'pending' });
  });

  it('시급을 다룰 권한이 없으면 시급 요청은 승인되지 않는다 (D-R39)', async () => {
    const id = await openReq('wage_change', { from: 42000, to: 45000 });
    await expect(svc().reviewRequest(id, BOSS, { decision: 'approve' }, false))
      .rejects.toMatchObject({ response: { code: 'WAGE_REVIEW_FORBIDDEN' } });
    expect(await wages()).toHaveLength(1);
  });

  it('적용 대상이 없는 갈래는 **상태만** 닫는다 — 없는 적용을 지어내지 않는다', async () => {
    const id = await openReq('unav_add', { note: '레거시 이력' });
    const out = await svc().reviewRequest(id, BOSS, { decision: 'approve' }, true);
    expect(out).toMatchObject({ state: 'approved', applied: null });
    expect(await wages()).toHaveLength(1);
    expect(await tzOf(TEACHER)).toBe('Asia/Seoul');
  });

  it('처리하면 서랍 목록에서 「기다리는 것」이 줄고, 처리할 수 있는 줄만 canAct 다', async () => {
    const id = await openReq('wage_change', { from: 42000, to: 45000 });
    const before = await svc().all(BOSS, true, true, false);
    const mineRow = before.approvals.waiting.find((r) => r.kind === 'req' && r.id === id);
    expect(mineRow).toBeDefined();
    expect(mineRow!.canAct).toBe(true);
    expect(mineRow!.asked).toBe('42,000원/시간 → 45,000원/시간');
    // 리포트·기획 같은 다른 갈래는 아직 이 화면에서 처리하지 않는다
    expect(before.approvals.waiting.filter((r) => r.kind !== 'req').every((r) => r.canAct === false)).toBe(true);

    await svc().reviewRequest(id, BOSS, { decision: 'approve' }, true);
    const after = await svc().all(BOSS, true, true, false);
    expect(after.approvals.waiting.some((r) => r.kind === 'req' && r.id === id)).toBe(false);
  });
});
