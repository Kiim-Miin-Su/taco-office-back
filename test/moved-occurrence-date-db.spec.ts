/** @file-guide
 * 목적: moved-occurrence-date-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 옮긴 회차의 날짜 정본 — TBO-54 P1 MEETING-MOVE.
 *
 * 회차의 키는 `(ser_id, on_date)`(규칙이 원래 찍은 날 · EXC 키)이고, **언제 하는 수업인가**는 `ser_occ.span` 의
 * KST 날짜(실제 수업일 · 화면에 그려지는 날 · `kstDateOf`)다. 명단 · 휴원 · 그날만 빠짐 · 교재 대상은 규칙 날짜로
 * 판정한다(CR-BE-01 · `serStuOn(ss, o.on_date)` · `recurrence.occ`). 그러나 「오늘인가 · 이번 주인가 · 몇 월인가 ·
 * 끝났는가 · 늦게 냈는가 · 첫 수업인가」는 실제 수업일이어야 한다 — 캘린더 · 현황판 · 리포트 목록(REPORT_DATE_SQL) ·
 * 수업료의 달(`kstMonthOf(lower(o.span))`)이 이미 그렇게 센다.
 *
 * 여기서 잡는 것은 그 규약에서 빠져 있던 자리들이다 — 옮긴 회차 하나를 `project()`(제품과 같은 투영)로 만들어
 * 각 소비자가 **실제 수업일**로 답하는지 본다. 규칙 날짜로 답하면 강사 홈이 옮긴 수업을 옛 날짜에 세우고, 강사료가
 * 아직 안 한 수업을 「미작성」으로 빼거나 늦게 낸 리포트의 차감을 놓치며, 대표 보고와 현황판의 수가 갈린다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Inv, Lead, Ser } from '../src/entities';
import { addDays, todayKst } from '../src/lib/kst';
import { payoutSheet } from '../src/lib/payout-sheet';
import { AccountingService } from '../src/modules/accounting/accounting.service';
import { invoiceLines } from '../src/modules/accounting/invoice-lines';
import { BoardService } from '../src/modules/board/board.service';
import { ExecService } from '../src/modules/exec/exec.service';
import { GUIDE_EVENT_CTE } from '../src/modules/guides/guide-events';
import { project } from '../src/modules/schedule/schedule.project';
import { loadState } from '../src/modules/schedule/schedule.state.repo';
import { TeacherService } from '../src/modules/teacher/teacher.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(90_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions, url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

const monthOf = (iso: string): string => iso.slice(0, 7);
/** 그 날짜(KST)의 요일 — 규칙 문법의 두 글자 */
const dow = (iso: string): string => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${iso}T12:00:00+09:00`).getUTCDay()];

d('옮긴 회차의 날짜 — 키는 규칙 날짜, 「언제」는 실제 수업일 (MEETING-MOVE)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let teacherId = 0;
  let studentId = 0;
  const KIND = `mv${process.pid}`.slice(0, 16);
  const today = todayKst();

  const teacher = () => new TeacherService(q.manager.getRepository(Ser));
  const exec = () => { const repo = q.manager.getRepository(Lead); return new ExecService(repo, new BoardService(repo)); };
  const accounting = () => new AccountingService(q.manager.getRepository(Inv));

  /**
   * 규칙 날짜 `ruleDate` 의 회차 하나(10:00~11:00)를 만들고, `movedTo` 가 있으면 그 날로 옮긴 EXC 를 두고
   * 제품과 같은 투영(`project`)을 돌린다 — `ser_occ.on_date` = 규칙 날짜 · `span` = 옮긴 날.
   */
  async function lesson(opts: { ruleDate: string; movedTo?: string; rrule?: string; toDate?: string | null; title?: string }): Promise<number> {
    const rrule = opts.rrule ?? 'ONCE';
    const toDate = opts.toDate === undefined ? (rrule === 'ONCE' ? opts.ruleDate : null) : opts.toDate;
    const [ser] = (await q.query(
      `INSERT INTO ser (kind_key, teacher_id, mode, start_min, end_min, rrule, from_date, to_date, title)
       VALUES ($1, $2, 'offline', 600, 660, $3, $4::date, $5::date, $6) RETURNING id`,
      [KIND, teacherId, rrule, opts.ruleDate, toDate, opts.title ?? '옮긴 회차'],
    )) as { id: string }[];
    const serId = Number(ser.id);
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1, $2)`, [serId, studentId]);
    if (opts.movedTo) {
      await q.query(
        `INSERT INTO exc (ser_id, on_date, new_date, by_id) VALUES ($1, $2::date, $3::date, $4)`,
        [serId, opts.ruleDate, opts.movedTo, teacherId],
      );
    }
    await project(q, await loadState(q, [serId], { forWrite: true }), [serId]);
    return serId;
  }

  const occ = (serId: number) => q.query(
    `SELECT to_char(on_date,'YYYY-MM-DD') AS on_date, to_char(lower(span) AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS drawn
       FROM ser_occ WHERE ser_id = $1 ORDER BY on_date`, [serId],
  ) as Promise<Array<{ on_date: string; drawn: string }>>;

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const [t] = (await q.query(
      `INSERT INTO staff (name, role, email, active, tz) VALUES ('옮김 강사','teacher','moved-teacher@qa.local',true,'Asia/Seoul') RETURNING id`,
    )) as Array<{ id: string }>;
    teacherId = Number(t.id);
    const [s] = (await q.query(`INSERT INTO stu (name, grade) VALUES ('옮김 학생', '중2') RETURNING id`)) as Array<{ id: string }>;
    studentId = Number(s.id);
    await q.query(
      `INSERT INTO kind (key, name, color, cap, grp, rep) VALUES ($1, '옮김 수업', '#123456', 4, 'lesson', true)
       ON CONFLICT (key) DO NOTHING`, [KIND],
    );
    await q.query(`INSERT INTO wage (staff_id, rate, from_date) VALUES ($1, 30000, '2020-01-01')`, [teacherId]);
    await q.query(`INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES ($1, NULL, 50000, '2020-01-01', 1)`, [KIND]);
  });
  afterEach(async () => { await q.rollbackTransaction(); await q.release(); });
  afterAll(async () => { await ds.destroy(); });

  it('투영 — 옮긴 회차는 규칙 날짜를 키로, 실제 수업일을 span 으로 갖는다 (전제)', async () => {
    const id = await lesson({ ruleDate: addDays(today, 7), movedTo: addDays(today, -1) });
    expect(await occ(id)).toEqual([{ on_date: addDays(today, 7), drawn: addDays(today, -1) }]);
  });

  describe('강사 홈 — 오늘 · 다가오는 7일은 실제 수업일로 (GET /teacher/home)', () => {
    it('오늘 규칙 날짜의 회차를 다음 주로 옮기면 「오늘」에서 빠지고 「다가오는」에 옮긴 날짜로 선다', async () => {
      const id = await lesson({ ruleDate: today, movedTo: addDays(today, 7) });
      const home = await teacher().home(teacherId);
      expect(home.today.map((l) => l.serId)).not.toContain(id);
      expect(home.todaySummary.lessons).toBe(0);
      const up = home.upcoming.find((l) => l.serId === id);
      expect(up).toBeDefined();
      // 화면이 날짜로 묶는 칸 — 키(onDate)는 그대로, 실제 수업일(date)이 따로 온다
      expect(up).toMatchObject({ onDate: today, date: addDays(today, 7) });
    });

    it('다음 주 규칙 날짜의 회차를 어제로 옮기면 「다가오는」에 서지 않는다 — 이미 한 수업이다', async () => {
      const id = await lesson({ ruleDate: addDays(today, 7), movedTo: addDays(today, -1) });
      const home = await teacher().home(teacherId);
      expect(home.upcoming.map((l) => l.serId)).not.toContain(id);
      expect(home.today.map((l) => l.serId)).not.toContain(id);
    });
  });

  describe('강사 수업 안내 — 이번 주는 실제 수업일로 (GET /teacher/guides)', () => {
    it('이번 주 규칙 날짜를 두 주 뒤로 옮기면 이번 주 안내에서 빠지고, 두 주 뒤 규칙 날짜를 오늘로 옮기면 든다', async () => {
      const out = await lesson({ ruleDate: today, movedTo: addDays(today, 14), title: '나간 회차' });
      const into = await lesson({ ruleDate: addDays(today, 14), movedTo: today, title: '들어온 회차' });
      const g = await teacher().guides(teacherId);
      const lessons = g.students.flatMap((s) => s.lessons);
      expect(lessons.map((l) => l.serId)).not.toContain(out);
      const l = lessons.find((x) => x.serId === into);
      expect(l).toMatchObject({ onDate: addDays(today, 14), date: today });
    });
  });

  describe('강사료 시트 — 끝났는가 · 지각 차감 · 몇 월 회차인가는 실제 수업일로 (lib/payout-sheet)', () => {
    it('다음 주 규칙 날짜의 회차를 어제로 옮기면 어제 달 시트에 「미작성」으로 든다 (아직 안 한 수업이 아니다)', async () => {
      const drawn = addDays(today, -1);
      const id = await lesson({ ruleDate: addDays(today, 7), movedTo: drawn });
      const sheet = await payoutSheet({ query: (sql, p) => q.query(sql, p) }, teacherId, monthOf(drawn), today, 23 * 60 + 59);
      const l = sheet.lessons.find((x) => x.serId === id);
      expect(l).toBeDefined();
      expect(l).toMatchObject({ settle: 'unwritten', onDate: addDays(today, 7), date: drawn });
      expect(sheet.agg.unwrittenCount).toBe(1);
      expect(sheet.agg.remainingCount).toBe(0);
    });

    it('한 달 전 규칙 날짜의 회차를 이번 달로 옮기면 수업료와 같은 달(옮긴 달)의 시트에 든다 — 규칙 날짜의 달에는 없다', async () => {
      const drawn = addDays(today, -1);
      // 규칙 날짜는 35일 전 — 언제나 다른 달이다
      const rule = addDays(drawn, -35);
      const id = await lesson({ ruleDate: rule, movedTo: drawn });
      const here = await payoutSheet({ query: (sql, p) => q.query(sql, p) }, teacherId, monthOf(drawn), today, 23 * 60 + 59);
      expect(here.lessons.map((l) => l.serId)).toContain(id);
      const there = await payoutSheet({ query: (sql, p) => q.query(sql, p) }, teacherId, monthOf(rule), today, 23 * 60 + 59);
      expect(there.lessons.map((l) => l.serId)).not.toContain(id);
    });

    it('지각 차감은 실제 수업이 끝난 시각부터 센다 — 규칙 날짜보다 일찍 옮긴 회차의 리포트를 실제 끝 뒤 25시간에 냈으면 10,000원', async () => {
      const drawn = addDays(today, -8);
      const id = await lesson({ ruleDate: addDays(today, -1), movedTo: drawn });
      // 투영이 만든 REP 를 「실제 수업 다음 날 12:00」에 낸 것으로 — 규칙 날짜(어제)로 재면 수업 전에 낸 것이 되어 차감 0 이 된다
      await q.query(
        `UPDATE rep SET state = 'wait', body = '{"content":"늦게 낸 리포트","progress":"","homework":""}'::jsonb,
                written_at = ($2::date + interval '1 day' + interval '12 hours') AT TIME ZONE 'Asia/Seoul',
                submitted_at = ($2::date + interval '1 day' + interval '12 hours') AT TIME ZONE 'Asia/Seoul'
          WHERE ser_id = $1`,
        [id, drawn],
      );
      const sheet = await payoutSheet({ query: (sql, p) => q.query(sql, p) }, teacherId, monthOf(drawn), today, 23 * 60 + 59);
      const l = sheet.lessons.find((x) => x.serId === id);
      expect(l).toMatchObject({ settle: 'written', lateCut: 10000, date: drawn });
      expect(sheet.agg.lateCut).toBe(10000);
    });
  });

  describe('대표 보고 — 진행한 수업 · 취소 · 학생 수는 실제 수업일 기간으로 (현황판과 같은 집합)', () => {
    it('다음 주 규칙 날짜의 회차를 어제로 옮기면 어제 하루의 「진행한 수업」에 든다', async () => {
      const yesterday = addDays(today, -1);
      await lesson({ ruleDate: addDays(today, 7), movedTo: yesterday });
      const out = await exec().range(yesterday, yesterday, false);
      const stat = (key: string) => out.stats.find((s) => s.key === key)?.value;
      expect(stat('lessons')).toBe(1);
      expect(stat('students')).toBe(1);
      // 어제 끝났고 아직 안 썼다 — 독촉 목록(REPORT_DATE_SQL)과 같은 날에 센다
      expect(stat('unwritten')).toBe(1);
      const next = await exec().range(addDays(today, 7), addDays(today, 7), false);
      expect(next.stats.find((s) => s.key === 'lessons')?.value).toBe(0);
    });
  });

  describe('청구 — 「지금까지 한 수업」과 그 날짜의 단가는 실제 수업일로 (invoice-lines · §54)', () => {
    it('다음 주 규칙 날짜의 회차를 어제로 옮기면 어제 달의 「지금까지」 줄에 든다', async () => {
      const drawn = addDays(today, -1);
      await lesson({ ruleDate: addDays(today, 7), movedTo: drawn });
      const done = await invoiceLines({ query: (sql, p) => q.query(sql, p) }, studentId, monthOf(drawn), { kind: 'done', upto: today });
      expect(done.map((l) => ({ n: l.n, unit_price: Number(l.unit_price) }))).toEqual([{ n: 1, unit_price: 50000 }]);
      const tuition = await accounting().tuition(monthOf(drawn), true);
      const row = tuition.items.find((r) => r.studentId === studentId);
      expect(row).toMatchObject({ done: 1, total: 1 });
    });

    it('단가는 실제 수업일의 것이다 — 규칙 날짜 뒤 · 옮긴 날 전에 오른 단가가 옮긴 회차에 적용된다', async () => {
      const drawn = addDays(today, -1);
      const rule = addDays(today, -10);
      await q.query(`INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES ($1, NULL, 70000, $2::date, 1)`, [KIND, addDays(today, -5)]);
      await lesson({ ruleDate: rule, movedTo: drawn });
      const lines = await invoiceLines({ query: (sql, p) => q.query(sql, p) }, studentId, monthOf(drawn), { kind: 'month' });
      expect(lines.map((l) => ({ n: l.n, unit_price: Number(l.unit_price) }))).toEqual([{ n: 1, unit_price: 70000 }]);
    });
  });

  describe('안내 사건 — 「첫 수업」은 실제로 먼저 한 회차다 (guide-events)', () => {
    it('첫 규칙 날짜의 회차를 뒤로 옮기면 그다음 회차가 첫 수업이 된다', async () => {
      // 매주 오늘 요일 · 두 주 전부터 셋(−14 · −7 · 0) — 첫 회차(−14)를 −2 로 옮겼다
      const first = addDays(today, -14);
      const id = await lesson({ ruleDate: first, rrule: `WEEKLY:${dow(first)}`, toDate: today, movedTo: addDays(today, -2) });
      const rows = (await q.query(
        `${GUIDE_EVENT_CTE} SELECT source_on::text AS source_on, event_on, reason FROM events
          WHERE ser_id = $1 AND student_id = $2 ORDER BY event_on`,
        [id, studentId],
      )) as Array<{ source_on: string; event_on: string; reason: string | null }>;
      expect(rows.map((r) => r.event_on)).toEqual([addDays(today, -7), addDays(today, -2), today]);
      expect(rows.find((r) => r.reason === 'new')).toMatchObject({ source_on: addDays(today, -7), event_on: addDays(today, -7) });
    });
  });
});
