/** @file-guide
 * 목적: exec-sheet-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §69~§71 대표 보고 **시트** — 머리 제목·기간 낱말 · 머리 지표 넷 · 영역 카드의 한 줄 요약과 타일
 * (spec-1to1 g7 69-1 · 69-4 · 69-6 · 69-8 · 70-1 · 70-3 · 71-1 · 71-2).
 *
 * 여기서 못 박는 것 셋.
 *   ① 기간 낱말과 머리 지표는 **기간이 말해 준다** — 주기를 인자로 받지 않는다.
 *   ② 카드 타일과 배지가 **같은 판정 조각**에서 나온다 — 「기한 지남 2건」과 배지 「2」가 갈리지 않는다(N-19).
 *   ③ 금액을 못 보는 사람에게는 금액이 **문장에서도** 빠진다(D-R39).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { BoardService } from '../src/modules/board/board.service';
import { ExecService } from '../src/modules/exec/exec.service';
import { ConsultingService } from '../src/modules/consulting/consulting.service';
import {
  execAreaDetails, execPeriodKind, execPeriodLabel, type ExecAreaFacts,
} from '../src/lib/exec-areas';
import { mktChannelLabel } from '../src/lib/marketing-words';
import { assertScratch, TEST_URL } from './db';

/* ── 순수 — 원본 컷의 수를 넣으면 원본 컷의 문장이 나온다 ─────────────────────────── */

/** 원본 §69(일일 2026-08-21) 컷에 적힌 사실 그대로 */
const cut69: ExecAreaFacts = {
  money: { inCount: 0, inSum: 0, unpaidCount: 5, unpaidSum: 8_550_000, overdueCount: 2, overdueSum: 3_000_000 },
  mkt: { posts: 0, channels: 0, topChannel: null, topCount: 0, comments: 0 },
  ops: { waiting: 1, running: 2, meetings: 1, openTodos: 3, packsPending: 0, packsDelivered: 0 },
  consulting: { locked: 1, paid: 400_000, contract: 1_700_000, nextOn: '2026-08-24' },
  complaint: { received: 0, receivedNames: [], open: 2 },
  lesson: { lessons: 20, missing: 17, canceled: 0, missingMarks: ['교재', '안내', '줌'] },
};

describe('§69~§71 시트 낱말 — 순수 판정 (lib/exec-areas)', () => {
  it('주기는 기간이 말해 준다 — 하루 · 월~일 · 달력 한 달 · 그 밖', () => {
    expect(execPeriodKind('2026-08-21', '2026-08-21')).toBe('day');
    expect(execPeriodKind('2026-08-17', '2026-08-23')).toBe('week');
    // 화요일부터 이레는 주간이 아니다 — 주는 월요일에 건다(§73 결재함 줄과 같은 셈)
    expect(execPeriodKind('2026-08-18', '2026-08-24')).toBe('range');
    expect(execPeriodKind('2026-08-01', '2026-08-31')).toBe('month');
    expect(execPeriodKind('2026-02-01', '2026-02-28')).toBe('month');
  });

  it('시트 머리 날짜는 원본 컷의 모양이다 (69-4)', () => {
    expect(execPeriodLabel('day', '2026-08-21', '2026-08-21')).toBe('26년 8월 21일 금요일');
    expect(execPeriodLabel('week', '2026-08-17', '2026-08-23')).toBe('08월 17일 ~ 08월 23일');
    expect(execPeriodLabel('month', '2026-08-01', '2026-08-31')).toBe('2026년 8월');
  });

  it('원본 §69 의 사실을 넣으면 여섯 카드의 한 줄 요약이 컷 글자 그대로다 (69-8)', () => {
    const d = execAreaDetails('day', cut69);
    expect(d.money.headline).toBe('못 받은 돈 ₩8,550,000 · 그중 2건은 기한이 지났습니다');
    expect(d.mkt.headline).toBe('오늘 올린 것이 없습니다');
    expect(d.ops.headline).toBe('기획 1건이 대표 결재를 기다립니다');
    expect(d.consulting.headline).toBe('1건이 수납 전이라 진행이 잠겨 있습니다');
    expect(d.complaint.headline).toBe('2건이 아직 안 끝났습니다');
    expect(d.lesson.headline).toBe('수업 20건 중 17건 준비 덜 됨');
  });

  it('타일의 이름·값·부제도 컷 그대로다 — 기간 앞말은 서버가 붙인다', () => {
    const d = execAreaDetails('day', cut69);
    expect(d.money.tiles.map((t) => [t.label, t.value, t.sub])).toEqual([
      ['오늘 입금', 0, '0건'], ['못 받은 돈', 8_550_000, '5건'], ['기한 지남', 2, '₩3,000,000'],
    ]);
    expect(d.consulting.tiles.map((t) => [t.label, t.value, t.sub])).toEqual([
      ['받은 돈', 400_000, '계약 ₩1,700,000'], ['남은 돈', 1_300_000, '다음 회차 08-24'],
    ]);
    expect(d.lesson.tiles.map((t) => [t.label, t.value, t.sub])).toEqual([
      ['오늘 수업', 20, '휴강 없음'], ['준비 안 됨', 17, '교재 · 안내 · 줌'],
    ]);
    expect(d.ops.tiles.map((t) => [t.label, t.value, t.sub])).toEqual([
      ['결재 대기', 1, '확인 필요'], ['진행 중 기획', 2, '오늘 회의 1건'], ['안 끝난 할 일', 3, null],
    ]);
    /*
     * E-57 「자료 요청 처리 → 대표 보고 운영 영역에 반영」 — 끝나지 않은 자료 요청(준비 중 · 전달 완료 · 수령 확인 전)이 있으면
     * 운영 카드에 넷째 칸이 선다. 없으면 컷의 세 칸 그대로다(원본 §69 컷에는 자료 요청 칸이 없다 — 없는 날의 모양).
     * 배지(결재 대기 + 기한 지난 할 일)와 펼칠 줄은 그대로다 — 줄은 배지와 같은 집합이어야 한다(N-67).
     */
    const withPacks = execAreaDetails('day', { ...cut69, ops: { ...cut69.ops, packsPending: 2, packsDelivered: 1 } });
    expect(withPacks.ops.tiles.map((t) => [t.key, t.label, t.value, t.sub])).toEqual([
      ['waiting', '결재 대기', 1, '확인 필요'], ['running', '진행 중 기획', 2, '오늘 회의 1건'], ['todos', '안 끝난 할 일', 3, null],
      ['packs', '자료 요청', 3, '준비 중 2 · 수령 대기 1'],
    ]);
    expect(withPacks.ops.headline).toBe(d.ops.headline);
    // 붉게 볼 칸도 서버가 정한다 — 컷의 분홍 칸들
    expect(d.money.tiles.map((t) => t.alert)).toEqual([false, true, true]);
    expect(d.mkt.tiles.find((t) => t.key === 'posts')!.alert).toBe(true);
  });

  it('주간 · 월간은 앞말과 문장이 바뀐다 (원본 §70 · §71)', () => {
    const week = execAreaDetails('week', {
      ...cut69,
      mkt: { posts: 4, channels: 4, topChannel: 'blog', topCount: 1, comments: 2 },
      complaint: { received: 2, receivedNames: ['양찬욱', '고은설'], open: 2 },
    });
    expect(week.mkt.headline).toBe('이번 주 4건 올렸습니다 · blog 1건이 가장 많습니다');
    expect(week.mkt.tiles.map((t) => t.sub)).toEqual(['채널 4종', '답변 확인']);
    expect(week.complaint.tiles[0]).toMatchObject({ label: '이번 주 접수', value: 2, sub: '양찬욱, 고은설' });

    const month = execAreaDetails('month', {
      ...cut69,
      money: { inCount: 6, inSum: 2_864_000, unpaidCount: 5, unpaidSum: 8_550_000, overdueCount: 0, overdueSum: 0 },
      lesson: { lessons: 174, missing: 155, canceled: 5, missingMarks: ['교재', '안내', '줌'] },
      consulting: { locked: 1, paid: 400_000, contract: 1_700_000, nextOn: null },
    });
    expect(month.money.headline).toBe('이번 달 ₩2,864,000 들어왔고 · 못 받은 돈 ₩8,550,000');
    // 기한 지난 것이 없으면 값 대신 「없음」 (원본 §71)
    expect(month.money.tiles[2]).toMatchObject({ label: '기한 지남', display: '없음', sub: null, alert: false });
    expect(month.lesson.headline).toBe('수업 174건 중 155건 준비 덜 됨 · 휴강 5건');
    expect(month.consulting.tiles[1].sub).toBe('예정 없음');
  });

  it('금액을 못 보면 **문장에서도** 금액이 빠진다 — 값은 null 이지 0 이 아니다 (D-R39)', () => {
    const masked = execAreaDetails('day', {
      ...cut69,
      money: { ...cut69.money, inSum: null, unpaidSum: null, overdueSum: null },
      consulting: { ...cut69.consulting, paid: null, contract: null },
    });
    expect(masked.money.headline).toBe('못 받은 돈 5건 · 그중 2건은 기한이 지났습니다');
    const all = Object.values(masked).flatMap((a) => [a.headline, ...a.tiles.map((t) => t.sub ?? '')]);
    expect(all.join(' ')).not.toContain('₩');
    expect(masked.money.tiles.map((t) => t.value)).toEqual([null, null, 2]);
    expect(masked.consulting.tiles.map((t) => t.value)).toEqual([null, null]);
  });
});

/* ── DB — 서비스가 같은 판정 조각으로 센다 ────────────────────────────────────── */

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

d('§69~§71 시트 — 머리 지표 · 카드 타일 · 기간 (DB)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let staffId = 0;

  const svc = () => {
    const repo = q.manager.getRepository(Lead);
    return new ExecService(repo, new BoardService(repo));
  };
  const area = (out: Awaited<ReturnType<ExecService['range']>>, key: string) => out.areas.find((a) => a.key === key)!;
  const tileOf = (out: Awaited<ReturnType<ExecService['range']>>, key: string, tile: string) =>
    area(out, key).tiles.find((t) => t.key === tile)!;

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const [s] = (await q.query(
      `INSERT INTO staff (name, role, email, active, tz)
       VALUES ('시트 담당','manager','exec-sheet-qa@tnacademy.kr',true,'Asia/Seoul') RETURNING id`,
    )) as Array<{ id: string }>;
    staffId = Number(s.id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('시트 머리 제목과 기간 낱말을 서버가 준다 — 결재함 줄과 같은 날짜 모양이다 (69-1 · 69-4)', async () => {
    const day = await svc().range('2026-08-21', '2026-08-21', true);
    expect(day).toMatchObject({ periodKind: 'day', sheetTitle: '일일 업무 보고', periodLabel: '26년 8월 21일 금요일' });
    const week = await svc().range('2026-08-17', '2026-08-23', true);
    expect(week).toMatchObject({ periodKind: 'week', sheetTitle: '주간 업무 보고', periodLabel: '08월 17일 ~ 08월 23일' });
    const month = await svc().range('2026-08-01', '2026-08-31', true);
    expect(month).toMatchObject({ periodKind: 'month', sheetTitle: '월간 업무 보고', periodLabel: '2026년 8월' });

    // 결재함 일일 줄도 같은 함수다 — 한 화면 안에서 날짜가 두 모양이면 안 된다
    await q.query(`INSERT INTO rpt (rpt_type, on_date, memo, state) VALUES ('day','2026-08-21','{}'::jsonb,'draft')`);
    const again = await svc().range('2026-08-21', '2026-08-21', true);
    expect(again.inbox.find((r) => r.onDate === '2026-08-21' && r.rptType === 'day')!.label).toBe(again.periodLabel);
  });

  it('일일 머리 넷은 원문 칸이고, 결재 대기·컴플레인은 **카드 타일과 같은 수**다 (69-6 · N-19)', async () => {
    const out = await svc().range('2026-08-21', '2026-08-21', true);
    expect(out.head.map((h) => h.label)).toEqual(['오늘 들어온 돈', '못 받은 돈', '결재 대기', '안 끝난 컴플레인']);
    const head = (key: string) => out.head.find((h) => h.key === key)!.value;
    expect(head('waiting')).toBe(tileOf(out, 'ops', 'waiting').value);
    expect(head('complaints')).toBe(tileOf(out, 'complaint', 'open').value);
    expect(head('complaints')).toBe(area(out, 'complaint').count);
    expect(head('unpaid')).toBe(tileOf(out, 'money', 'unpaid').value);
    expect(head('revenue')).toBe(tileOf(out, 'money', 'in').value);
  });

  it('회계 카드의 「기한 지남」은 배지와 **같은 판정 조각**이다 — 금액은 남은 돈의 합이다', async () => {
    const [stu] = (await q.query(`INSERT INTO stu (name) VALUES ('시트 학생') RETURNING id`)) as { id: string }[];
    const inv = (state: string, amount: number, paid: number, due: string) => q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, paid_amount, state, due_on)
       VALUES ($1,'2026-08','tuition','8월 수업료',$2,$3,$4::inv_state_t,$5::date)`,
      [Number(stu.id), amount, paid, state, due],
    );
    const before = await svc().range('2026-08-21', '2026-08-21', true);
    await inv('unpaid', 300000, 0, '2026-08-10');      // 기한 지남 · 못 받은 돈 300,000
    await inv('partial', 500000, 200000, '2026-08-11'); // 기한 지남 · 못 받은 돈 300,000
    await inv('sent', 400000, 0, '2026-09-30');         // 기한 전 · 못 받은 돈 400,000
    await inv('paid', 100000, 100000, '2026-08-01');    // 안 센다 — 다 들어왔다
    const out = await svc().range('2026-08-21', '2026-08-21', true);
    const overdue = tileOf(out, 'money', 'overdue');
    expect(overdue.value).toBe(area(out, 'money').count);
    expect(overdue.value! - tileOf(before, 'money', 'overdue').value!).toBe(2);
    expect(tileOf(out, 'money', 'unpaid').value! - tileOf(before, 'money', 'unpaid').value!).toBe(1_000_000);
    expect(area(out, 'money').headline).toContain('기한이 지났습니다');
  });

  it('주간 머리 넷 — 입금 · 신규 문의 · 마케팅 게시 · 수업 준비 x/y (현황판 판정 그대로 · 70-1 · 70-3)', async () => {
    await q.query(`INSERT INTO mkt (channel, item, on_date) VALUES
      ('naver','blog','2026-08-18'), ('naver','ad','2026-08-19'), ('instagram','video','2026-08-20'),
      ('kakao','channel','2026-08-30')`);
    const out = await svc().range('2026-08-17', '2026-08-23', true);
    expect(out.head.map((h) => h.label)).toEqual(['이번 주 입금', '신규 문의', '마케팅 게시', '수업 준비']);
    const repo = q.manager.getRepository(Lead);
    const board = await new BoardService(repo).range({ from: '2026-08-17', to: '2026-08-23' });
    expect(out.head.find((h) => h.key === 'prep')).toMatchObject({
      value: board.summary.doneLessons, total: board.summary.lessons, note: '다 된 것',
    });
    // 기간 밖(8/30) 게시는 안 센다 · 가장 많은 채널은 채널 낱말로 말한다
    expect(out.head.find((h) => h.key === 'posts')!.value).toBe(3);
    expect(area(out, 'mkt').headline).toBe(`이번 주 3건 올렸습니다 · ${mktChannelLabel('naver')} 2건이 가장 많습니다`);
    expect(tileOf(out, 'mkt', 'posts').sub).toBe('채널 2종');
    // 통계 낱말도 원문으로 — 「신규 상담」이 아니라 「신규 문의」
    expect(out.stats.find((s) => s.key === 'leads')!.label).toBe('신규 문의');
  });

  it('월간 머리 넷은 돈이다 — 매출 (입금) · 강사료 · 지출 · 이익(부제 이익률) (71-1 · 71-2)', async () => {
    await q.query(`INSERT INTO pay (inv_id, amount, paid_on, method) VALUES (NULL, 1000000, '2026-08-10', 'transfer')`);
    await q.query(
      `INSERT INTO expense (spend_on, category, merchant, purpose, requested_amount, amount, state, requester_id)
       VALUES ('2026-08-12','supply','QA','QA 지출',300000,300000,'approved',$1)`, [staffId],
    );
    const out = await svc().range('2026-08-01', '2026-08-31', true);
    expect(out.head.map((h) => h.label)).toEqual(['매출 (입금)', '강사료', '지출', '이익']);
    const stat = (key: string) => out.stats.find((s) => s.key === key)!.value;
    expect(out.head.find((h) => h.key === 'revenue')!.value).toBe(stat('revenue'));
    expect(out.head.find((h) => h.key === 'profit')).toMatchObject({ value: stat('profit'), note: `${stat('margin')}%` });
    expect(out.stats.find((s) => s.key === 'revenue')!.label).toBe('매출 (입금)');
    // 회계 카드의 입금 타일도 같은 한 문장(REVENUE_SQL)을 읽는다
    expect(tileOf(out, 'money', 'in').value).toBe(stat('revenue'));
  });

  it('금액을 못 보면 머리·타일 금액은 null 이고 문장에 ₩ 가 없다 (D-R39)', async () => {
    const out = await svc().range('2026-08-21', '2026-08-21', false);
    out.head.filter((h) => h.money).forEach((h) => expect(h.value).toBeNull());
    expect(tileOf(out, 'money', 'in').value).toBeNull();
    expect(tileOf(out, 'money', 'unpaid').value).toBeNull();
    expect(tileOf(out, 'consulting', 'paid').value).toBeNull();
    const words = out.areas.flatMap((a) => [a.headline, ...a.tiles.map((t) => t.sub ?? '')]).join(' ');
    expect(words).not.toContain('₩');
  });

  it('보관 삭제한 컨설팅은 「수납 전이라 잠긴」 배지에서 빠진다 — 카드 타일과 같은 집합이다', async () => {
    const before = area(await svc().range('2026-08-21', '2026-08-21', true), 'consulting').count;
    const cons = (deleted: boolean) => q.query(
      `INSERT INTO cons (cons_type, stage, contract_step, amount, sessions, owner_id, share, deleted_at, deleted_by)
       VALUES ('essay','contract',2,1700000,4,$1,'all',$2,$3) RETURNING id`,
      [staffId, deleted ? '2026-08-20T00:00:00Z' : null, deleted ? staffId : null],
    ) as Promise<Array<{ id: string }>>;
    const [live] = await cons(false);
    await cons(true);
    await q.query(`INSERT INTO cons_pay (cons_id, amount, paid_on, memo, by_id) VALUES ($1,400000,'2026-08-05','QA',$2)`, [Number(live.id), staffId]);
    await q.query(`INSERT INTO cons_sess (cons_id, seq, on_date) VALUES ($1,1,'2026-08-24')`, [Number(live.id)]);
    const out = await svc().range('2026-08-21', '2026-08-21', true);
    expect(area(out, 'consulting').count - before).toBe(1);
    expect(tileOf(out, 'consulting', 'paid').sub).toContain('계약 ₩');
    expect(tileOf(out, 'consulting', 'due').sub).toBe('다음 회차 08-24');
  });

  it('서명까지 끝나 수납 단계(5)인데 아직 못 받은 계약도 「수납 전이라 잠긴」 계약이다 — 다 받아 진행으로 넘어가야 빠진다 (I-89)', async () => {
    /*
     * 계약은 `stage='contract'` 인 동안 잠겨 있다 — 5단계(수납)에 **와 있는 것**과 **다 받은 것**은 다르다(`promoteWhenPaid`
     * 가 받은 합 ≥ 계약 금액일 때만 running 으로 옮긴다). 한동안 이 판정이 `contract_step < 5` 를 더 물어, 서명본까지
     * 올리고 돈을 한 푼도 못 받은 계약이 대표 보고에서 조용히 사라졌다 — 원문 「수납 전에는 진행이 잠깁니다 … 이 잠금이
     * 풀리지 않으면 대표 보고에 '잠긴 계약'으로 올라갑니다」의 바로 그 계약이다.
     */
    const before = area(await svc().range('2026-08-21', '2026-08-21', true), 'consulting');
    const [c] = (await q.query(
      `INSERT INTO cons (cons_type, stage, contract_step, amount, sessions, owner_id, share)
       VALUES ('essay','contract',5,1000000,4,$1,'all') RETURNING id`, [staffId],
    )) as Array<{ id: string }>;
    const consId = Number(c.id);
    const unpaid = await svc().range('2026-08-21', '2026-08-21', true);
    expect(area(unpaid, 'consulting').count - before.count).toBe(1);
    expect(area(unpaid, 'consulting').items.map((i) => i.key)).toContain(`cons-${consId}`);
    expect(area(unpaid, 'consulting').items.find((i) => i.key === `cons-${consId}`)!.sub).toBe('계약 5/5단계 · 수납 전');
    // 일부만 받아도 잠겨 있다
    await q.query(`INSERT INTO cons_pay (cons_id, amount, paid_on, memo, by_id) VALUES ($1,400000,'2026-08-05','QA',$2)`, [consId, staffId]);
    expect(area(await svc().range('2026-08-21', '2026-08-21', true), 'consulting').count - before.count).toBe(1);
    // 다 받아 진행으로 넘어가면 빠진다 — 옮기는 것은 수납 경로 하나(promoteWhenPaid)다
    await q.query(`INSERT INTO cons_pay (cons_id, amount, paid_on, memo, by_id) VALUES ($1,600000,'2026-08-06','QA',$2)`, [consId, staffId]);
    expect(await ConsultingService.promoteWhenPaid(q.manager, consId, staffId)).toBe(true);
    const running = await svc().range('2026-08-21', '2026-08-21', true);
    expect(area(running, 'consulting').count).toBe(before.count);
    expect(area(running, 'consulting').items.map((i) => i.key)).not.toContain(`cons-${consId}`);
  });

  it('컴플레인 접수 타일은 이 기간에 들어온 건의 학생 이름을 적는다', async () => {
    const [a] = (await q.query(`INSERT INTO stu (name) VALUES ('양찬욱') RETURNING id`)) as { id: string }[];
    const [b] = (await q.query(`INSERT INTO stu (name) VALUES ('고은설') RETURNING id`)) as { id: string }[];
    await q.query(
      `INSERT INTO cpl (area, stage, body, student_id, created_at) VALUES
        ('lesson','received','QA',$1,'2026-08-18T03:00:00Z'),
        ('lesson','closed','QA',$2,'2026-08-20T03:00:00Z'),
        ('lesson','received','QA',NULL,'2026-07-01T03:00:00Z')`,
      [Number(a.id), Number(b.id)],
    );
    const out = await svc().range('2026-08-17', '2026-08-23', true);
    expect(tileOf(out, 'complaint', 'received')).toMatchObject({ label: '이번 주 접수', value: 2, sub: '고은설, 양찬욱' });
  });
});
