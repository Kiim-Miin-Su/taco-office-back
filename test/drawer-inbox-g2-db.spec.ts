/** @file-guide
 * 목적: drawer-inbox-g2-db.spec.ts (test) — §14 사유 인용 줄 · 자료 요청 제목 · §16 알림 제목/보낸 이 역할 (g2 대조 14-4 · 14-7 · 16-1 · 16-2)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 서랍 한 응답(`DrawerService.all`)에 새로 실리는 것 넷을 스크래치 DB 에서 확인한다.
 *
 *   ① §14 카드의 **사유 인용 줄**(`ApRow.reason`) — 올린 사람이 자기 말로 적은 것.
 *      「무엇을 바라는가」와 같은 글이면 두 번 싣지 않는다.
 *   ② §14·§75 자료 요청의 제목이 종류 이름을 두 번 말하지 않고, 메모는 부제가 아니라 사유 줄로 간다.
 *   ③ §16 알림 카드의 **굵은 제목**(`NOTI.title` · 옛 행은 NULL)과 보낸 이의 **역할 낱말**.
 *   ④ 서랍의 두 결재 쓰기가 올린 사람에게 보내는 알림에 제목을 적는다.
 *
 * 전부 한 트랜잭션 안에서 만들고 되돌린다 — 스크래치 DB 에 남는 줄이 없다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { DrawerService } from '../src/modules/drawer/drawer.service';
import { requesterReason } from '../src/lib/approval';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

const url = TEST_URL ? assertScratch(TEST_URL) : '';

/** 이 스위트만 쓰는 사람 번호 — 다른 스위트의 시드 번호와 겹치지 않게 멀리 둔다 */
const TEACHER = 91801;
const HEAD = 91802;

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions,
    url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

describe('§14 사유 인용 줄 — 이미 보인 글은 두 번 싣지 않는다 (DB 독립)', () => {
  it('첫 번째로 적힌 글을 사유로 고른다 — 빈 글·문자열 아닌 값은 건너뛴다', () => {
    expect(requesterReason([], undefined, '  ', 42, ' 근속 2년차입니다 ')).toBe('근속 2년차입니다');
  });
  it('이미 줄에 보인 글(바라는 것·반려 사유·제목)과 같으면 null 이다', () => {
    expect(requesterReason(['재직증명서'], '재직증명서')).toBeNull();
    expect(requesterReason([null, '병가'], '병가')).toBeNull();
  });
  it('적힌 글이 없으면 null 이다 — 사유를 지어내지 않는다', () => {
    expect(requesterReason(['무엇'], null, undefined, '')).toBeNull();
  });
});

d('§14 · §16 서랍 응답 — 사유 · 자료 요청 제목 · 알림 제목 (g2 14-4 · 14-7 · 16-1 · 16-2)', () => {
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
    await q.query(
      `INSERT INTO staff (id, name, email, role) VALUES
         ($1, 'Sophia', 'g2-teacher@t.kr', 'teacher'),
         ($2, '실장 테스트', 'g2-head@t.kr', 'manager')
       ON CONFLICT (id) DO NOTHING`,
      [TEACHER, HEAD],
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const inboxOf = async () => (await svc().all(HEAD, true, true)).approvals.inbox.filter((r) => r.byId === TEACHER);

  it('요청 줄은 올린 사람의 사유를 싣고, 바라는 것과 같은 글은 두 번 싣지 않는다', async () => {
    const [wage] = (await q.query(
      `INSERT INTO req (staff_id, req_type, payload) VALUES ($1, 'wage_change', $2::jsonb) RETURNING id`,
      [TEACHER, JSON.stringify({ from: 40000, to: 45000, reason: '근속 2년차입니다' })],
    )) as Array<{ id: string }>;
    const [doc] = (await q.query(
      `INSERT INTO req (staff_id, req_type, payload) VALUES ($1, 'doc', $2::jsonb) RETURNING id`,
      [TEACHER, JSON.stringify({ reason: '재직증명서' })],
    )) as Array<{ id: string }>;
    const rows = await inboxOf();
    const wageRow = rows.find((r) => r.kind === 'req' && r.id === Number(wage.id))!;
    expect(wageRow.asked).toBe('40,000원/시간 → 45,000원/시간');
    expect(wageRow.reason).toBe('근속 2년차입니다');
    // 모르는 갈래는 사유가 곧 「바라는 것」이다 — 같은 글을 회색 상자와 인용 줄에 두 번 적지 않는다
    const docRow = rows.find((r) => r.kind === 'req' && r.id === Number(doc.id))!;
    expect(docRow.asked).toBe('재직증명서');
    expect(docRow.reason).toBeNull();
  });

  it('옛 교재 변경 요청은 강사의 말이 message 칸에 있다 — 그것이 사유 줄이 된다', async () => {
    const [book] = (await q.query(
      `INSERT INTO req (staff_id, req_type, payload) VALUES ($1, 'book_change', $2::jsonb) RETURNING id`,
      [TEACHER, JSON.stringify({ message: '너무 어렵습니다', studentName: '강라율' })],
    )) as Array<{ id: string }>;
    const row = (await inboxOf()).find((r) => r.kind === 'req' && r.id === Number(book.id))!;
    expect(row.title).toBe('교재 변경 요청');
    expect(row.reason).toBe('너무 어렵습니다');
  });

  it('변경 요청 줄은 신청 사유를 싣는다 — 바라는 것(무엇을)과 다른 칸이다', async () => {
    const [c] = (await q.query(
      `INSERT INTO chreq (ser_id, on_date, req_type, payload, reason, by_id)
       VALUES (99018001, '2026-09-30', 'cancel', '{}'::jsonb, '병원 일정이 잡혔습니다', $1) RETURNING id`,
      [TEACHER],
    )) as Array<{ id: string }>;
    const row = (await inboxOf()).find((r) => r.kind === 'chreq' && r.id === Number(c.id))!;
    expect(row.reason).toBe('병원 일정이 잡혔습니다');
    expect(row.sub).not.toContain('병원 일정이 잡혔습니다');
  });

  it('자료 요청 제목은 종류 이름을 두 번 말하지 않고, 메모는 부제가 아니라 사유 줄로 간다 (14-7)', async () => {
    const [same] = (await q.query(
      `INSERT INTO gpapack (pack_type, title, memo, effective_on, coordinator_id, created_by)
       VALUES ('exam', '시험 대비 자료 요청', 'AP Chem 기출 5개년', '2026-10-02', $2, $1) RETURNING id`,
      [TEACHER, HEAD],
    )) as Array<{ id: string }>;
    const [named] = (await q.query(
      `INSERT INTO gpapack (pack_type, title, effective_on, coordinator_id, created_by)
       VALUES ('exam', '2학기 중간', '2026-10-02', $2, $1) RETURNING id`,
      [TEACHER, HEAD],
    )) as Array<{ id: string }>;
    // 자료 요청은 §14 승인 대기함에 들지 않는다(원문 슬라이드 14 의 원천은 REQ · SER — g2 14-2 · wave 5).
    // 한 줄의 모양(제목·부제·사유)은 같은 원장 행이라 결재 목록(`approvals.waiting`)에서 본다.
    const rows = (await svc().all(HEAD, true, true)).approvals.waiting.filter((r) => r.byId === TEACHER);
    expect((await inboxOf()).some((r) => r.kind === 'gpapack')).toBe(false);
    const a = rows.find((r) => r.kind === 'gpapack' && r.id === Number(same.id))!;
    expect(a.title).toBe('시험 대비 자료 요청');
    // 부제는 원문 §75 그대로 「학생 · 기한」 — 학생이 안 붙은 묶음이라 기한만 선다
    expect(a.sub).toBe('기한 10-02');
    expect(a.reason).toBe('AP Chem 기출 5개년');
    const b = rows.find((r) => r.kind === 'gpapack' && r.id === Number(named.id))!;
    expect(b.title).toBe('시험 대비 자료 요청 · 2학기 중간');
    expect(b.reason).toBeNull();

    // §75 결재 흐름도 같은 줄을 읽는다 — 제목·부제가 같이 따라온다 (D-R26)
    const flow = (await svc().all(HEAD, true, true, false, 'all')).approvalFlow;
    const f = flow.waiting.find((r) => r.kind === 'gpapack' && r.id === Number(same.id))!;
    expect(f.title).toBe('시험 대비 자료 요청');
    expect(f.sub ?? '').not.toContain('AP Chem');
  });

  it('알림은 제목과 보낸 이의 역할 낱말을 싣는다 — 옛 행은 제목이 null 이다 (16-1 · 16-2)', async () => {
    await q.query(
      `INSERT INTO noti (to_id, from_id, body, link, category, title) VALUES
         ($1, $2, '08-18 16:30 종료 후 65시간 경과', '/reports/unwritten', 'report_due', 'MAP Reading 리포트 독촉'),
         ($1, NULL, '예전 알림 본문', '/ops', 'request', NULL)`,
      [HEAD, TEACHER],
    );
    const out = await svc().all(HEAD, true, false);
    const titled = out.notis.find((n) => n.body === '08-18 16:30 종료 후 65시간 경과')!;
    expect(titled.title).toBe('MAP Reading 리포트 독촉');
    expect(titled.fromName).toBe('Sophia');
    expect(titled.fromRoleLabel).toBe('강사');
    const old = out.notis.find((n) => n.body === '예전 알림 본문')!;
    expect(old.title).toBeNull();
    expect(old.fromRoleLabel).toBeNull();
  });

  it('요청을 반려하면 올린 사람에게 가는 알림이 제목을 갖는다 — 본문은 그대로다', async () => {
    const [r] = (await q.query(
      `INSERT INTO req (staff_id, req_type, payload) VALUES ($1, 'wage_change', $2::jsonb) RETURNING id`,
      [TEACHER, JSON.stringify({ from: 40000, to: 45000 })],
    )) as Array<{ id: string }>;
    await svc().reviewRequest(Number(r.id), HEAD, { decision: 'reject', reason: '근거가 부족합니다' }, true);
    const [n] = (await q.query(
      `SELECT title, body FROM noti WHERE to_id = $1 ORDER BY id DESC LIMIT 1`, [TEACHER],
    )) as Array<{ title: string | null; body: string }>;
    expect(n.title).toBe('시급 변경 요청 반려');
    expect(n.body).toBe('시급 변경 요청이 반려됐습니다 — 근거가 부족합니다');
  });

  it('변경 요청을 반려하면 알림 제목이 선다', async () => {
    const [c] = (await q.query(
      `INSERT INTO chreq (ser_id, on_date, req_type, payload, reason, by_id)
       VALUES (99018002, '2026-09-30', 'cancel', '{}'::jsonb, '병가', $1) RETURNING id`,
      [TEACHER],
    )) as Array<{ id: string }>;
    await svc().reviewChangeRequest(Number(c.id), HEAD, { decision: 'reject', reason: '대체 강사가 없습니다' });
    const [n] = (await q.query(
      `SELECT title, body FROM noti WHERE to_id = $1 ORDER BY id DESC LIMIT 1`, [TEACHER],
    )) as Array<{ title: string | null; body: string }>;
    expect(n.title).toBe('변경 요청 반려');
    expect(n.body).toBe('변경 요청이 반려됐습니다 — 대체 강사가 없습니다');
  });
});
