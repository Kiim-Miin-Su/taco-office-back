/** @file-guide
 * 목적: exec-compare-items-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §69~§71 대표 보고 wave 5 — **주간 지난주 대비**(§70 · N-66 주간 · K-107 · O-146) ·
 * **영역 카드 펼칠 줄**(§69~§71 「기한 지난 청구서 2건 펼치기 ▾」 · N-67 · K-111) ·
 * **§71 퍼널 네 줄**(「유입 → 1차 → 2차·진단 → 등록」 · 71-5).
 *
 * 못 박는 것.
 *   ① 지난주 값은 **같은 SQL 을 −7일 기간에 한 번 더** 부른 값이다 — 직전 주 화면의 머리 값과 같다.
 *   ② 비교는 주간에만 선다(원본 §69 · §71 머리에는 없다). 금액을 못 보면 비교에도 금액이 없다.
 *   ③ 펼칠 줄은 배지와 **같은 판정 조각**으로 뽑고 여덟 줄에서 끊는다(원본 수업 「17 → 8건」) — 0 이면 줄 자체가 없다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { BoardService } from '../src/modules/board/board.service';
import { ExecService } from '../src/modules/exec/exec.service';
import {
  EXEC_AREA_ITEM_LIMIT, execAreaItemsLabel, execLessonItems, execWeekDelta,
} from '../src/lib/exec-areas';
import { assertScratch, TEST_URL } from './db';

/* ── 순수 — 원본 §70 컷의 세 칸 ───────────────────────────────────────────────────── */

describe('§70 지난주 대비 — 순수 낱말 (lib/exec-areas)', () => {
  it('원본 §70 의 세 칸 그대로 — 「지난주 ▼ 100%」 · 「지난주 ▲ 25%」 · 「지난주 신규」', () => {
    expect(execWeekDelta(0, 1_200_000)).toBe('지난주 ▼ 100%');   // 이번 주 입금 ₩0
    expect(execWeekDelta(5, 4)).toBe('지난주 ▲ 25%');            // 신규 문의 5건
    expect(execWeekDelta(4, 0)).toBe('지난주 신규');              // 마케팅 게시 4건
  });

  it('같으면 「지난주와 같음」 — 0 과 0 도 「신규」가 아니다 · 비율은 정수 반올림', () => {
    expect(execWeekDelta(3, 3)).toBe('지난주와 같음');
    expect(execWeekDelta(0, 0)).toBe('지난주와 같음');
    expect(execWeekDelta(2, 3)).toBe('지난주 ▼ 33%');
  });

  it('어느 한쪽이라도 모르면(금액 권한 없음) 비교하지 않는다 — null', () => {
    expect(execWeekDelta(null, 5)).toBeNull();
    expect(execWeekDelta(5, null)).toBeNull();
  });
});

describe('§69~§71 펼칠 줄 — 순수 낱말 (lib/exec-areas)', () => {
  it('원본 컷의 여섯 줄 머리 그대로 — 기간 앞말은 마케팅만 붙는다', () => {
    expect(execAreaItemsLabel('money', 'day', 2)).toBe('기한 지난 청구서 2건');
    expect(execAreaItemsLabel('mkt', 'week', 4)).toBe('이번 주 올린 것 4건');
    expect(execAreaItemsLabel('mkt', 'month', 4)).toBe('이번 달 올린 것 4건');
    expect(execAreaItemsLabel('ops', 'day', 1)).toBe('결재 대기 · 기한 지난 할 일 1건');
    expect(execAreaItemsLabel('consulting', 'day', 1)).toBe('수납 전이라 잠긴 컨설팅 1건');
    expect(execAreaItemsLabel('complaint', 'week', 2)).toBe('안 끝난 컴플레인 2건');
    expect(execAreaItemsLabel('lesson', 'month', 8)).toBe('준비가 덜 된 수업 8건');
  });

  it('줄이 0 이면 머리도 없다 — 원본 §69 마케팅 · §71 회계에는 펼칠 줄이 없다', () => {
    expect(execAreaItemsLabel('mkt', 'day', 0)).toBeNull();
    expect(execAreaItemsLabel('money', 'month', 0)).toBeNull();
  });

  it('수업 줄은 덜 된 것만 · 휴강은 빼고 · 여덟 줄에서 끊는다 (원본 「수업 17 → 준비가 덜 된 수업 8건」)', () => {
    const row = (i: number, missing: number, canceled = false) => ({
      serId: 100 + i, date: `2026-08-${String(10 + i).padStart(2, '0')}`, startAt: '16:00',
      subName: `과목 ${i}`, kindName: '정규 수업', canceled, missing,
      marks: [
        { key: 'book', done: missing === 0, na: false },
        { key: 'guide', done: true, na: false },
        { key: 'zoom', done: true, na: true },
        { key: 'report', done: missing < 2, na: false },
      ],
    });
    const rows = [row(0, 0), row(1, 1, true), ...Array.from({ length: 12 }, (_, i) => row(i + 2, 2))];
    const items = execLessonItems(rows);
    expect(items).toHaveLength(EXEC_AREA_ITEM_LIMIT);
    expect(EXEC_AREA_ITEM_LIMIT).toBe(8);
    // W11 · 7-3 ① — 그 날의 현황판을 곧장 연다(현황판이 `?date=` 를 읽는다)
    expect(items[0]).toEqual({ key: 'lesson-102-2026-08-12', title: '08-12 16:00 과목 2', sub: '교재 · 리포트', go: '/board?date=2026-08-12' });
  });
});

/* ── DB ─────────────────────────────────────────────────────────────────────── */

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

/*
 * 2031년 3월 둘째 주 — 시드·다른 스위트와 겹치지 않는 먼 주를 쓴다(값을 정확히 못 박으려고).
 * 이번 주 2031-03-10(월) ~ 03-16(일) · 지난주 03-03 ~ 03-09.
 */
const WEEK = { from: '2031-03-10', to: '2031-03-16' };
const PREV = { from: '2031-03-03', to: '2031-03-09' };

d('§69~§71 지난주 대비 · 펼칠 줄 · 퍼널 네 줄 (DB)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let staffId = 0;

  const svc = () => {
    const repo = q.manager.getRepository(Lead);
    return new ExecService(repo, new BoardService(repo));
  };
  type Out = Awaited<ReturnType<ExecService['range']>>;
  const head = (out: Out, key: string) => out.head.find((h) => h.key === key)!;
  const area = (out: Out, key: string) => out.areas.find((a) => a.key === key)!;

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const [s] = (await q.query(
      `INSERT INTO staff (name, role, email, active, tz)
       VALUES ('비교 담당','manager','exec-compare-qa@tnacademy.kr',true,'Asia/Seoul') RETURNING id`,
    )) as Array<{ id: string }>;
    staffId = Number(s.id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  /** 원본 §70 컷의 세 칸을 그대로 만든다 — 입금 ₩0 ← 지난주 ₩1,200,000 · 문의 5 ← 4 · 게시 4 ← 0 */
  const seedCutWeek = async () => {
    await q.query(`INSERT INTO pay (inv_id, amount, paid_on, method) VALUES (NULL, 1200000, '2031-03-05', 'transfer')`);
    const leadAt = (day: string, n: number) => q.query(
      `INSERT INTO lead (name, stage, source, created_at)
       SELECT '비교 문의 ' || g, 'first', 'phone', ($1::date + time '10:00') AT TIME ZONE 'Asia/Seoul' FROM generate_series(1, $2) g`,
      [day, n],
    );
    await leadAt('2031-03-04', 4);
    await leadAt('2031-03-11', 5);
    await q.query(`INSERT INTO mkt (channel, item, on_date, title) VALUES
      ('naver','blog','2031-03-10','봄 학기 안내'), ('naver','ad','2031-03-11', NULL),
      ('instagram','video','2031-03-12','수업 영상'), ('kakao','channel','2031-03-15','상담 안내')`);
  };

  it('주간 머리 셋에 지난주 값과 원본 §70 의 비교 낱말이 선다 — 수업 준비는 「다 된 것」 그대로 (K-107 · O-146)', async () => {
    await seedCutWeek();
    const out = await svc().range(WEEK.from, WEEK.to, true);
    expect(head(out, 'revenue')).toMatchObject({ value: 0, prev: 1_200_000, note: '지난주 ▼ 100%' });
    expect(head(out, 'leads')).toMatchObject({ value: 5, prev: 4, note: '지난주 ▲ 25%' });
    expect(head(out, 'posts')).toMatchObject({ value: 4, prev: 0, note: '지난주 신규' });
    expect(head(out, 'prep')).toMatchObject({ note: '다 된 것', prev: null });
  });

  it('지난주 값은 **직전 주 화면의 머리 값**과 같다 — 같은 SQL 을 −7일에 한 번 더 부른다', async () => {
    await seedCutWeek();
    const out = await svc().range(WEEK.from, WEEK.to, true);
    const before = await svc().range(PREV.from, PREV.to, true);
    for (const key of ['revenue', 'leads', 'posts']) expect(head(out, key).prev).toBe(head(before, key).value);
  });

  it('금액을 못 보면 입금 비교도 없다 — 건수 비교는 그대로 선다 (D-R39)', async () => {
    await seedCutWeek();
    const out = await svc().range(WEEK.from, WEEK.to, false);
    expect(head(out, 'revenue')).toMatchObject({ value: null, prev: null, note: null });
    expect(head(out, 'leads')).toMatchObject({ prev: 4, note: '지난주 ▲ 25%' });
  });

  it('일일 · 월간 머리에는 비교가 없다 — 원본 §69 · §71 컷에 없다 (월간 기준은 N-66 결정 대기)', async () => {
    await seedCutWeek();
    const day = await svc().range('2031-03-11', '2031-03-11', true);
    day.head.forEach((h) => expect(h.prev ?? null).toBeNull());
    const month = await svc().range('2031-03-01', '2031-03-31', true);
    month.head.forEach((h) => expect(h.prev ?? null).toBeNull());
    expect(head(month, 'revenue').note).toBeNull();
  });

  it('회계 펼칠 줄 = 기한 지난 청구서 — 배지와 같은 수 · 오래된 기한 먼저 · 학생 · 남은 돈 · 청구서 목록으로 (K-111)', async () => {
    const [stu] = (await q.query(`INSERT INTO stu (name) VALUES ('줄 학생') RETURNING id`)) as { id: string }[];
    const inv = (state: string, amount: number, paid: number, due: string, title: string) => q.query(
      `INSERT INTO inv (student_id, year_month, inv_type, title, amount, paid_amount, state, due_on)
       VALUES ($1,'2031-02','tuition',$5,$2,$3,$4::inv_state_t,$6::date) RETURNING id`,
      [Number(stu.id), amount, paid, state, title, due],
    ) as Promise<Array<{ id: string }>>;
    await inv('unpaid', 300000, 0, '2031-03-01', '2월 수업료');
    const [jan] = await inv('partial', 500000, 200000, '2031-02-20', '1월 수업료');
    await inv('sent', 400000, 0, '2031-04-30', '3월 수업료');   // 기한 전 — 줄이 아니다
    const out = await svc().range('2031-03-11', '2031-03-11', true);
    const money = area(out, 'money');
    expect(money.items.length).toBe(money.count);
    expect(money.itemsLabel).toBe(`기한 지난 청구서 ${money.items.length}건`);
    expect(money.items.map((i) => i.title)).toEqual(['줄 학생 · 1월 수업료', '줄 학생 · 2월 수업료']);
    expect(money.items[0].sub).toBe('₩300,000 · 기한 02-20 · 19일 지남');
    // W11 · 7-3 ① — 그 청구서를 곧장 연다(회계 청구서 탭이 이미 읽는 invId)
    expect(money.items[0].go).toBe(`/accounting?tab=inv&invId=${Number(jan.id)}`);
    // 금액을 못 보면 줄에서도 금액이 빠진다
    const masked = area(await svc().range('2031-03-11', '2031-03-11', false), 'money');
    expect(masked.items[0].sub).toBe('기한 02-20 · 19일 지남');
    // 「누가 안 냈는가」도 금액과 같은 정보다 — 금액을 못 보면 학생 이름도 싣지 않는다
    expect(masked.items.map((i) => i.title)).toEqual(['1월 수업료', '2월 수업료']);
  });

  it('컨설팅 줄은 공개 범위 안에서만 선다 — 비공개 건은 배지로만 세고 학생 이름을 싣지 않는다 (csCan)', async () => {
    const [stu] = (await q.query(`INSERT INTO stu (name) VALUES ('비공개 학생') RETURNING id`)) as { id: string }[];
    const [cons] = (await q.query(
      `INSERT INTO cons (cons_type, stage, contract_step, amount, sessions, owner_id, share)
       VALUES ('essay','contract',3,900000,4,$1,'private') RETURNING id`, [staffId],
    )) as { id: string }[];
    await q.query(`INSERT INTO cons_stu (cons_id, student_id) VALUES ($1,$2)`, [Number(cons.id), Number(stu.id)]);
    const outsider = await svc().range('2031-03-11', '2031-03-11', true, { id: staffId + 999, canApprove: true, canHide: false });
    expect(area(outsider, 'consulting').count).toBe(1);
    expect(area(outsider, 'consulting').items).toEqual([]);
    expect(area(outsider, 'consulting').itemsLabel).toBeNull();
    // 담당은 본다 — 컨설팅 화면과 같은 판정이다
    const owner = await svc().range('2031-03-11', '2031-03-11', true, { id: staffId, canApprove: true, canHide: false });
    expect(area(owner, 'consulting').items.map((i) => i.title)).toEqual([expect.stringContaining('비공개 학생')]);
  });

  it('마케팅 · 운영 · 컨설팅 · 컴플레인 줄 — 각자 배지(또는 기간)와 같은 집합이고 원본 화면으로 간다', async () => {
    await seedCutWeek();
    const [plan] = (await q.query(
      `INSERT INTO plan (title, stage, owner_id) VALUES ('봄 설명회 기획','review',$1) RETURNING id`, [staffId],
    )) as { id: string }[];
    await q.query(`INSERT INTO todo (title, due_on, done) VALUES ('교재 주문','2031-03-01',false), ('끝난 일','2031-03-01',true)`);
    const [cons] = (await q.query(
      `INSERT INTO cons (cons_type, stage, contract_step, amount, sessions, owner_id, share)
       VALUES ('essay','contract',2,1700000,4,$1,'all') RETURNING id`, [staffId],
    )) as { id: string }[];
    const [stu] = (await q.query(`INSERT INTO stu (name) VALUES ('양찬욱') RETURNING id`)) as { id: string }[];
    await q.query(`INSERT INTO cons_stu (cons_id, student_id) VALUES ($1,$2)`, [Number(cons.id), Number(stu.id)]);
    await q.query(
      `INSERT INTO cpl (area, stage, body, student_id, created_at) VALUES
        ('lesson','received','수업 시간이 바뀌었는데 몰랐다',$1,'2031-03-11T03:00:00Z'),
        ('lesson','closed','끝난 건',$1,'2031-03-11T03:00:00Z')`,
      [Number(stu.id)],
    );
    const out = await svc().range(WEEK.from, WEEK.to, true);

    const mkt = area(out, 'mkt');
    expect(mkt.itemsLabel).toBe('이번 주 올린 것 4건');
    expect(mkt.items[0]).toMatchObject({ title: '봄 학기 안내', go: '/ops?tab=mkt' });

    const ops = area(out, 'ops');
    expect(ops.items.length).toBe(ops.count);
    expect(ops.items.map((i) => [i.title, i.go])).toEqual([
      ['봄 설명회 기획', `/ops?tab=plan&plan=${Number(plan.id)}`],
      ['교재 주문', '/ops?tab=todo'],
    ]);
    expect(ops.itemsLabel).toBe('결재 대기 · 기한 지난 할 일 2건');

    const cs = area(out, 'consulting');
    expect(cs.items.length).toBe(cs.count);
    expect(cs.items[0]).toMatchObject({ title: expect.stringContaining('양찬욱'), go: `/consulting?id=${Number(cons.id)}` });
    expect(cs.itemsLabel).toBe('수납 전이라 잠긴 컨설팅 1건');

    const cpl = area(out, 'complaint');
    expect(cpl.items.length).toBe(cpl.count);
    expect(cpl.items[0]).toMatchObject({ title: expect.stringContaining('양찬욱'), go: expect.stringMatching(/^\/ops\?tab=complaint&cpl=\d+$/) });
  });

  it('줄이 없으면 머리도 없다 — 빈 주의 마케팅은 itemsLabel null · items []', async () => {
    const out = await svc().range('2031-06-02', '2031-06-08', true);
    expect(area(out, 'mkt')).toMatchObject({ itemsLabel: null, items: [] });
  });

  it('§71 퍼널은 네 줄이다 — 유입 · 1차 상담 · 2차 · 진단 · 등록 (71-5 · 2차 대기는 「2차 안 옴」이 될 수 있어 도달로 세지 않는다)', async () => {
    const at = (day: string) => `${day}T01:00:00Z`;
    const lead = async (name: string, stage: string) => {
      const [l] = (await q.query(
        `INSERT INTO lead (name, stage, source, created_at) VALUES ($1,$2,'phone',$3) RETURNING id`, [name, stage, at('2031-05-06')],
      )) as { id: string }[];
      return Number(l.id);
    };
    await lead('대기', 'wait2nd');         // 2차를 기다리는 중 — 2차 · 진단에 아직 닿지 않았다
    await lead('상담', 'second');
    await lead('등록', 'enrolled');
    const m = (await svc().range('2031-05-01', '2031-05-31', true)).monthly!;
    expect(m.funnel.map((r) => [r.key, r.label])).toEqual([
      ['inflow', '유입'], ['first', '1차 상담'], ['second', '2차 · 진단'], ['enrolled', '등록'],
    ]);
    expect(m.funnel.find((r) => r.key === 'second')!.count).toBe(1);
  });
});
