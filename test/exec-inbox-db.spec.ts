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
  /* ══ §69 쓰기 — 「숫자만으로는 모를 것」과 서명 (C85-a) ══════════════ */

  /** 서명 칸은 STAFF 를 가리킨다(RESTRICT) — 이 스위트가 제 사람을 만든다 */
  const actor = async (name: string): Promise<number> => {
    const [row] = (await q.query(
      `INSERT INTO staff (name, email, role, password_hash, active)
       VALUES ($1, $2, 'ceo', 'x', true) RETURNING id`,
      [name, `${name}-${Date.now()}@t.kr`],
    )) as { id: string }[];
    return Number(row.id);
  };

  it('메모는 보낸 칸만 합친다 — 한 사람이 저장할 때 남의 줄이 사라지지 않는다', async () => {
    const me = await actor('적는이');
    await svc().saveMemo({ rptType: 'day', onDate: '2026-08-21', memos: [{ key: 'money', memo: '회계 한 줄' }] }, me);
    const second = await svc().saveMemo(
      { rptType: 'day', onDate: '2026-08-21', memos: [{ key: 'ops', memo: '운영 한 줄' }] }, me,
    );
    expect(second.filled).toBe(2);

    const out = await svc().range('2026-08-21', '2026-08-21', true);
    const report = out.reports.find((r) => r.rptType === 'day')!;
    // 여섯 칸이 **언제나 다** 온다 — 화면이 칸을 만들지 않는다
    expect(report.memos.map((m) => m.key)).toEqual([...EXEC_AREA_KEYS]);
    expect(report.memos.find((m) => m.key === 'money')!.memo).toBe('회계 한 줄');
    expect(report.memos.find((m) => m.key === 'ops')!.memo).toBe('운영 한 줄');
    expect(report.memos.find((m) => m.key === 'mkt')!.memo).toBe('');
  });

  it('주기 키 날짜는 서버가 정규화한다 — 같은 주에 두 번 적어도 한 건이다 (D-R23)', async () => {
    const me = await actor('정규화');
    await svc().saveMemo({ rptType: 'week', onDate: '2026-08-19', memos: [{ key: 'money', memo: '수요일에 적음' }] }, me);
    const again = await svc().saveMemo(
      { rptType: 'week', onDate: '2026-08-21', memos: [{ key: 'ops', memo: '금요일에 적음' }] }, me,
    );
    expect(again.onDate).toBe('2026-08-17');
    const [{ n }] = (await q.query(`SELECT count(*)::text n FROM rpt WHERE rpt_type='week'`)) as { n: string }[];
    expect(n).toBe('1');

    const month = await svc().saveMemo(
      { rptType: 'month', onDate: '2026-08-21', memos: [{ key: 'money', memo: '달' }] }, me,
    );
    expect(month.onDate).toBe('2026-08-01');
  });

  it('한 줄도 안 적으면 못 올린다 — 숫자는 화면이 이미 보여 준다 (D-R14)', async () => {
    const me = await actor('빈보고');
    await q.query(`INSERT INTO rpt (rpt_type, on_date, memo, state) VALUES ('day','2026-08-21','{"note":"영역이 아니다"}'::jsonb,'draft')`);
    await expect(svc().submit({ rptType: 'day', onDate: '2026-08-21' }, me))
      .rejects.toMatchObject({ response: { code: 'RPT_EMPTY' } });
  });

  it('올리면 서명과 상태가 함께 서고, 올린 뒤에는 못 고친다', async () => {
    const me = await actor('올린이');
    await svc().saveMemo({ rptType: 'day', onDate: '2026-08-21', memos: [{ key: 'money', memo: '한 줄' }] }, me);
    const sent = await svc().submit({ rptType: 'day', onDate: '2026-08-21' }, me);
    expect(sent.state).toBe('sent');
    expect(sent.sentByName).toBe('올린이');

    // 시각과 사람은 짝이다 (CHECK rpt_sign_pair)
    const [row] = (await q.query(`SELECT sent_at IS NOT NULL AS t, sent_by FROM rpt WHERE id=$1`, [sent.id])) as
      Array<{ t: boolean; sent_by: string }>;
    expect(row.t).toBe(true);
    expect(Number(row.sent_by)).toBe(me);

    await expect(svc().saveMemo({ rptType: 'day', onDate: '2026-08-21', memos: [{ key: 'ops', memo: '나중' }] }, me))
      .rejects.toMatchObject({ response: { code: 'RPT_LOCKED' } });
  });

  /**
   * **올리면 대표가 안다** (원문 K-104 · O-145). 올리기는 오래 행만 바꾸고 아무도 부르지 않아,
   * 대표는 결재함을 직접 열어야 올라온 줄 알았다. 자기에게는 보내지 않는다 (C38 의 규약).
   */
  it('올리면 대표에게 알림이 간다 — 올린 사람 자신에게는 안 간다', async () => {
    const writer = await actor('알림작성자');
    const boss = await actor('알림대표');
    await svc().saveMemo({ rptType: 'day', onDate: '2026-08-21', memos: [{ key: 'money', memo: '한 줄' }] }, writer);
    const sent = await svc().submit({ rptType: 'day', onDate: '2026-08-21' }, writer);

    const got = (await q.query(
      `SELECT to_id, body, link, category FROM noti WHERE from_id = $1`, [writer],
    )) as Array<{ to_id: string; body: string; link: string; category: string }>;
    expect(got.map((n) => Number(n.to_id))).toContain(boss);
    expect(got.map((n) => Number(n.to_id))).not.toContain(writer);
    expect(got[0]).toMatchObject({ category: 'request' });
    expect(got[0]!.link).toContain(`rpt=${sent.id}`);
    expect(got[0]!.body).toContain('일일 보고가 올라왔습니다');
  });

  it('반려는 사유가 있어야 하고, 반려된 보고는 다시 적어 올릴 수 있다 (D-R13)', async () => {
    const writer = await actor('작성자');
    const ceo = await actor('결재자');
    await svc().saveMemo({ rptType: 'day', onDate: '2026-08-21', memos: [{ key: 'money', memo: '한 줄' }] }, writer);
    const sent = await svc().submit({ rptType: 'day', onDate: '2026-08-21' }, writer);

    await expect(svc().review(sent.id, { action: 'rej' }, ceo))
      .rejects.toMatchObject({ response: { code: 'REASON_REQUIRED' } });

    const rejected = await svc().review(sent.id, { action: 'rej', reason: '컴플레인 줄이 비었습니다' }, ceo);
    expect(rejected.state).toBe('rej');
    expect(rejected.reviewedByName).toBe('결재자');

    // 반려된 것은 고칠 수 있다 — 그러라고 반려한 것이다
    const again = await svc().saveMemo(
      { rptType: 'day', onDate: '2026-08-21', memos: [{ key: 'complaint', memo: '채웠습니다' }] }, writer,
    );
    expect(again.filled).toBe(2);
    const resent = await svc().submit({ rptType: 'day', onDate: '2026-08-21' }, writer);
    // 다시 올리면 지난 결재는 지워진다 — 반려 사유가 남아 있으면 지금 상태를 속인다
    expect(resent.state).toBe('sent');
    expect(resent.reviewedByName).toBeNull();
    const [after] = (await q.query(`SELECT reject_reason, reviewed_at FROM rpt WHERE id=$1`, [sent.id])) as
      Array<{ reject_reason: string | null; reviewed_at: string | null }>;
    expect(after.reject_reason).toBeNull();
    expect(after.reviewed_at).toBeNull();
  });

  /**
   * 화면이 `canApprove && canSeeProfit` 를 스스로 조합하고 있었다. 2026-09-20 에 서버가
   * **자기 결재**까지 거절하기 시작했으므로, 그 조합만으로는 올린 사람에게 단추가 열린 채
   * 눌렀을 때만 거절당한다. 판정을 서버 한 줄(`canReview`)로 옮긴 자리의 회귀다 (S1 · D-R39).
   */
  it('§73 결재 단추는 서버가 연다 — 올린 사람에게는 닫히고 남에게는 열린다 (S1)', async () => {
    const writer = await actor('단추작성자');
    const boss = await actor('단추결재자');
    await svc().saveMemo({ rptType: 'day', onDate: '2026-08-21', memos: [{ key: 'money', memo: '한 줄' }] }, writer);
    const sent = await svc().submit({ rptType: 'day', onDate: '2026-08-21' }, writer);

    const rowFor = async (viewer?: { id: number; canApprove: boolean }) =>
      (await svc().range('2026-08-01', '2026-08-31', true, viewer)).reports.find((r) => r.id === sent.id)!;

    expect((await rowFor({ id: writer, canApprove: true })).canReview).toBe(false);
    expect((await rowFor({ id: boss, canApprove: true })).canReview).toBe(true);
    // 결재 권한이 없으면 남의 보고여도 닫힌다
    expect((await rowFor({ id: boss, canApprove: false })).canReview).toBe(false);
    // 금액을 못 보면 §69 를 결재하지 않는다 — 숫자를 안 보고 서명할 수 없다
    expect((await svc().range('2026-08-01', '2026-08-31', false, { id: boss, canApprove: true }))
      .reports.find((r) => r.id === sent.id)!.canReview).toBe(false);
    // 보는 사람을 아예 모르면 닫는다
    expect((await rowFor()).canReview).toBe(false);

    // 단추가 말하는 것과 서버가 하는 것이 같다
    await expect(svc().review(sent.id, { action: 'ok' }, writer))
      .rejects.toMatchObject({ response: { code: 'SELF_APPROVAL_FORBIDDEN' } });
    expect((await svc().review(sent.id, { action: 'ok' }, boss)).state).toBe('ok');
  });

  it('올라오지 않은 보고는 결재할 수 없다', async () => {
    const me = await actor('성급한결재');
    const draft = await svc().saveMemo(
      { rptType: 'day', onDate: '2026-08-21', memos: [{ key: 'money', memo: '아직 초안' }] }, me,
    );
    await expect(svc().review(draft.id, { action: 'ok' }, me))
      .rejects.toMatchObject({ response: { code: 'RPT_NOT_SENT' } });
  });

});
