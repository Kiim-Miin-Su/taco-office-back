/** @file-guide
 * 목적: teacher-settings-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 강사 덱 §8 「내 설정」 — 시급·시간대 **변경 요청** (C39).
 *
 * 원문: 「시간대 / 기본 시급, 각각 변경 요청 버튼, **관리자 승인 후 적용**,
 * 시급은 **한 달에 한 번 신청 가능**」. 그래서 여기서 증명하는 것은 셋이다.
 *   ① 요청은 **적용하지 않는다** — staff.tz·wage 는 그대로다.
 *   ② 시급은 한 달에 한 번이고, **반려돼도 한 달을 기다린다**(결과가 아니라 신청일 기준).
 *   ③ 시간대는 진행 중인 건이 있으면 또 올리지 않는다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Ser } from '../src/entities';
import { TeacherService } from '../src/modules/teacher/teacher.service';
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

d('강사 §8 내 설정 — 올리기만 하고 적용하지 않는다 (C39)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const ME = 81;

  const svc = () => new TeacherService(q.manager.getRepository(Ser));
  const reqs = async () =>
    (await q.query(
      `SELECT req_type, payload, state FROM req WHERE staff_id = $1 ORDER BY id`, [ME],
    )) as Array<{ req_type: string; payload: Record<string, unknown>; state: string }>;

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(
      `INSERT INTO staff (id,name,email,role,tz) VALUES ($1,'요청 강사','req81@t.kr','teacher','Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET tz = 'Asia/Seoul'`, [ME],
    );
    await q.query(`DELETE FROM req WHERE staff_id = $1`, [ME]);
    await q.query(`DELETE FROM wage WHERE staff_id = $1`, [ME]);
    await q.query(`INSERT INTO wage (staff_id, rate, from_date) VALUES ($1, 42000, '2026-01-01')`, [ME]);
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

  it('시급 변경 요청은 올라가되 **시급은 그대로다** — 적용은 관리자 승인 뒤다', async () => {
    const out = await svc().createSettingRequest(ME, { reqType: 'wage_change', rate: 45000, reason: '3년차' });
    expect(out).toMatchObject({ reqType: 'wage_change', label: '시급 변경', state: 'pending', asked: '45,000원/시간' });

    const rows = await reqs();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ from: 42000, to: 45000, reason: '3년차' });

    // **적용하지 않았다** — 지금 시급은 그대로
    const [w] = (await q.query(`SELECT rate FROM wage WHERE staff_id = $1 ORDER BY from_date DESC LIMIT 1`, [ME])) as { rate: number }[];
    expect(Number(w.rate)).toBe(42000);
  });

  it('시급은 한 달에 한 번이다 — 같은 달 두 번째는 WAGE_REQ_MONTHLY_QUOTA (강사 덱 §8 원문)', async () => {
    await svc().createSettingRequest(ME, { reqType: 'wage_change', rate: 45000 });
    await expect(svc().createSettingRequest(ME, { reqType: 'wage_change', rate: 46000 }))
      .rejects.toMatchObject({ response: { code: 'WAGE_REQ_MONTHLY_QUOTA' } });
    expect(await reqs()).toHaveLength(1);
  });

  it('반려됐어도 한 달을 기다린다 — 「한 달에 한 번」은 결과가 아니라 신청일 기준이다', async () => {
    await svc().createSettingRequest(ME, { reqType: 'wage_change', rate: 45000 });
    await q.query(`UPDATE req SET state = 'rejected', reject_reason = '3개월 뒤 재검토' WHERE staff_id = $1`, [ME]);
    await expect(svc().createSettingRequest(ME, { reqType: 'wage_change', rate: 44000 }))
      .rejects.toMatchObject({ response: { code: 'WAGE_REQ_MONTHLY_QUOTA' } });
  });

  it('한 달이 지나면 다시 된다', async () => {
    await svc().createSettingRequest(ME, { reqType: 'wage_change', rate: 45000 });
    await q.query(`UPDATE req SET created_at = now() - interval '40 days' WHERE staff_id = $1`, [ME]);
    await expect(svc().createSettingRequest(ME, { reqType: 'wage_change', rate: 46000 })).resolves.toMatchObject({ state: 'pending' });
    expect(await reqs()).toHaveLength(2);
  });

  it('시간대는 TZG 에 있는 값만, 지금 쓰는 것은 안 되고, 진행 중이면 또 못 올린다', async () => {
    await expect(svc().createSettingRequest(ME, { reqType: 'tz_change', timezone: 'Mars/Olympus' }))
      .rejects.toMatchObject({ response: { code: 'TZ_UNKNOWN' } });
    await expect(svc().createSettingRequest(ME, { reqType: 'tz_change', timezone: 'Asia/Seoul' }))
      .rejects.toMatchObject({ response: { code: 'TZ_SAME' } });

    const ok = await svc().createSettingRequest(ME, { reqType: 'tz_change', timezone: 'America/New_York' });
    expect(ok).toMatchObject({ reqType: 'tz_change', label: '시간대 변경', asked: 'America/New_York' });
    await expect(svc().createSettingRequest(ME, { reqType: 'tz_change', timezone: 'America/New_York' }))
      .rejects.toMatchObject({ response: { code: 'REQ_PENDING' } });

    // 시간대도 **적용하지 않았다**
    const [me] = (await q.query(`SELECT tz FROM staff WHERE id = $1`, [ME])) as { tz: string }[];
    expect(me.tz).toBe('Asia/Seoul');
  });

  it('빠진 값은 400 으로 거절한다 — 빈 요청을 원장에 남기지 않는다', async () => {
    await expect(svc().createSettingRequest(ME, { reqType: 'wage_change' }))
      .rejects.toMatchObject({ response: { code: 'RATE_REQUIRED' } });
    await expect(svc().createSettingRequest(ME, { reqType: 'tz_change' }))
      .rejects.toMatchObject({ response: { code: 'TZ_REQUIRED' } });
    expect(await reqs()).toHaveLength(0);
  });

  it('홈의 내 설정이 신청 가능 여부와 올린 이력을 그대로 말한다', async () => {
    const before = await svc().home(ME);
    expect(before.settings.canAskWage).toBe(true);
    expect(before.settings.canAskTz).toBe(true);
    expect(before.settings.timezones.map((t) => t.tz)).toContain('America/New_York');

    await svc().createSettingRequest(ME, { reqType: 'wage_change', rate: 45000 });
    const after = await svc().home(ME);
    expect(after.settings.canAskWage).toBe(false);
    expect(after.settings.wageAskableOn).not.toBeNull();
    expect(after.settings.requests[0]).toMatchObject({ reqType: 'wage_change', state: 'pending' });
  });
});

/* ── 정산 확정 판정은 한 곳뿐이다 (N-27 · 대표 결정 2026-09-12) ────────────────────
   대표 원문: 「전부 단일 진실원을 지키며 구현하며 confirmed_by는 필요함」.
   전에는 「행이 있다」를 곧 「확정」으로 읽었다. 그래서 마감 작성 중인 정산이
   강사에게 「확정」으로 보였고, 화면은 payout.state 낱말로 또 갈랐다.
   여기서 증명하는 것은 셋이다 — ① 행이 있어도 확정이 아니다 ② 확정은 confirmed_by 다
   ③ 낱말이 무엇이든 판정이 흔들리지 않는다. */
d('강사 월 정산 — 「저장돼 있다」와 「확정됐다」는 다른 질문이다 (N-27)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const ME = 82;
  const YM = '2026-08';

  const svc = () => new TeacherService(q.manager.getRepository(Ser));
  const settlement = async () => (await svc().history(ME, YM)).settlement;
  const savePayout = async (state: string, confirmedBy: number | null) => {
    await q.query(`DELETE FROM payout WHERE staff_id = $1`, [ME]);
    await q.query(
      `INSERT INTO payout (staff_id, year_month, hours, gross, late_rep_cut, income_tax, local_tax, net,
                           state, confirmed_by, confirmed_at)
       VALUES ($1, $2, 10.00, 420000, 0, 12600, 1260, 406140, $3, $4,
               CASE WHEN $4::bigint IS NULL THEN NULL ELSE now() END)`,
      [ME, YM, state, confirmedBy],
    );
  };

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(
      `INSERT INTO staff (id,name,email,role,tz) VALUES ($1,'정산 강사','settle82@t.kr','teacher','Asia/Seoul')
       ON CONFLICT (id) DO NOTHING`, [ME],
    );
    await q.query(`DELETE FROM wage WHERE staff_id = $1`, [ME]);
    await q.query(`INSERT INTO wage (staff_id, rate, from_date) VALUES ($1, 42000, '2026-01-01')`, [ME]);
    await q.query(`DELETE FROM payout WHERE staff_id = $1`, [ME]);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('행이 없으면 실시간 계산이다 — 저장값도 확정도 아니다', async () => {
    expect(await settlement()).toMatchObject({ yearMonth: YM, saved: false, confirmed: false });
  });

  it('행이 있어도 아무도 확정하지 않았으면 **확정이 아니다** — 저장값은 쓰되 확정이라 말하지 않는다', async () => {
    await savePayout('draft', null);
    const s = await settlement();
    expect(s).toMatchObject({ saved: true, confirmed: false });
    expect(s.net).toBe(406140); // 숫자는 저장값이 정본이다
  });

  it('확정은 **누가 확정했는가**다 — 낱말이 무엇이든 판정이 같다', async () => {
    for (const word of ['approved', 'confirmed', 'paid']) {
      await savePayout(word, 2);
      expect(await settlement()).toMatchObject({ saved: true, confirmed: true });
    }
  });
});
