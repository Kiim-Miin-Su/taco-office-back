/** @file-guide
 * 목적: accounting-billing-race-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 회계 청구의 경합 — README 7-3 ② · ③ (PB-12-4) · W11.
 *
 * ③ 같은 (학생 · 달 · 종류)의 발행 둘이 동시에 들어오면 둘 다 「아직 없다」를 읽고 **두 장**을 냈다(중복 검사가 SELECT 뿐).
 * ② 이월(`carryTuition`)과 받는 달 수업료 발행이 동시에 들어오면 서로 「아직 없다」를 읽고 둘 다 저장돼 **이월분이 어느 청구서에서도
 *    안 빠졌다**(돈이 샌다).
 *
 * 이 스위트는 **실제 두 연결**로 그 순서를 만든다 — 다른 연결이 표에 SHARE 잠금을 쥐어 두 쓰기가 INSERT 앞에서 기다리게 하고,
 * 둘 다 기다리기 시작한 것을 `pg_stat_activity` 로 확인한 뒤 풀어 준다. 판정을 복제하지 않고 서비스를 그대로 부른다.
 * 쓰기가 커밋되므로 이 스위트가 만든 id 로만 지운다(전역 DELETE 없음 · S7 규약).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { HttpException } from '@nestjs/common';
import { dataSourceOptions } from '../src/data-source';
import { Inv } from '../src/entities';
import { AccountingService } from '../src/modules/accounting/accounting.service';
import { StudentWithdrawService } from '../src/modules/accounting/withdraw.service';
import { ScheduleAttendanceService } from '../src/modules/schedule/schedule.attendance.service';
import { SchedulePauseService } from '../src/modules/schedule/schedule.pause.service';
import { ScheduleWriteService } from '../src/modules/schedule/schedule.write.service';
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
    extra: { max: 6 },
  });
}

const ACTOR = 9281;
const KIND = 'w11_race';
const SUB = 'w11-race';
const DUE = '2026-12-31';
/** 경합에 쓰는 달 — 지난 달이라 「이미 한 수업」이 흔들리지 않는다 */
const FROM = '2026-03';
const TO = '2026-04';
/** 월 마감 경합(A' 후속)에 쓰는 달 — 마감은 시작한 달만 되므로 지난 달이고, 위 둘 · 서로와 겹치지 않는다 */
const CLOSE_M = '2026-05';
const CARRY_FROM = '2026-06';
const CARRY_TO = '2026-07';
const REOPEN_M = '2026-08';
const VOID_M = '2026-01';
const ATTENDANCE_M = '2025-10';
const PAUSE_M = '2025-09';
const WITHDRAW_M = '2025-11';
const SCHEDULE_M = '2025-12';

type Outcome = { ok: true; value: unknown } | { ok: false; code: string };
const settle = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (e: unknown) => {
      if (e instanceof HttpException) return { ok: false as const, code: (e.getResponse() as { code?: string }).code ?? 'ERROR' };
      throw e;
    },
  );

d('회계 청구 경합 — 중복 발행 · 이월과 다음 달 발행 (7-3 ② ③ · PB-12-4)', () => {
  let ds: DataSource;
  const students: number[] = [];
  const series: number[] = [];
  const svc = () => new AccountingService(ds.getRepository(Inv));

  /** 다른 연결 n 개가 **잠금을 기다리기 시작할 때까지** 기다린다 — 정해진 시간 대신 실제 대기를 본다 */
  const waitForLockWaiters = async (n: number): Promise<void> => {
    for (let i = 0; i < 200; i += 1) {
      const [row] = (await ds.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`,
      )) as Array<{ n: number }>;
      if (row!.n >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`쓰기 ${n}개가 잠금을 기다리지 않았다 — 경합을 만들지 못했다`);
  };

  /** 표에 SHARE 잠금을 쥔 연결 — INSERT(ROW EXCLUSIVE)는 기다리고 SELECT · FOR UPDATE 는 지나간다 */
  const hold = async (tables: string[]): Promise<QueryRunner> => {
    const r = ds.createQueryRunner();
    await r.connect();
    await r.startTransaction();
    for (const t of tables) await r.query(`LOCK TABLE ${t} IN SHARE MODE`);
    return r;
  };
  const release = async (r: QueryRunner) => { await r.commitTransaction(); await r.release(); };

  /**
   * 뒤에 들어온 쓰기가 **끝났거나**, 잠금을 기다리는 연결이 n 개가 될 때까지 — 고치기 전에는 뒤 쓰기(마감 · 발행)가
   * 앞 쓰기를 기다리지 않고 그대로 끝나 버린다. 어느 쪽이든 거기서 풀어 주고 결과로 판정한다(정해진 시간을 쓰지 않는다).
   */
  const doneOrWaiting = async (p: Promise<unknown>, n: number): Promise<void> => {
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 200; i += 1) {
      if (done) return;
      const [row] = (await ds.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`,
      )) as Array<{ n: number }>;
      if (row!.n >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('뒤 쓰기가 끝나지도 기다리지도 않았다 — 경합을 만들지 못했다');
  };
  /** 그 쓰기의 감사 줄 번호 — 줄은 쓰기가 커밋하기 바로 앞에 선다. 두 쓰기의 앞뒤를 이 번호로 본다 */
  const logIdOf = async (entity: string, entityId: number, action: string): Promise<number> => {
    const [row] = (await ds.query(
      `SELECT id FROM log WHERE entity = $1 AND entity_id = $2 AND action = $3 ORDER BY id DESC LIMIT 1`,
      [entity, entityId, action],
    )) as Array<{ id: string }>;
    if (!row) throw new Error(`${entity} ${entityId} ${action} 감사 줄이 없다`);
    return Number(row.id);
  };

  const newStudent = async (): Promise<number> => {
    const [s] = (await ds.query(`INSERT INTO stu (name, grade) VALUES ('경합 학생','G9') RETURNING id`)) as Array<{ id: string }>;
    students.push(Number(s!.id));
    return Number(s!.id);
  };
  const lesson = async (studentId: number, dates: Array<{ on: string; canceled?: boolean }>) => {
    const [se] = (await ds.query(
      `INSERT INTO ser (kind_key, sub_key, title, mode, start_min, end_min, rrule, from_date)
       VALUES ($1, $2, '경합 수업', 'offline', 540, 600, 'WEEKLY:MO', '2026-01-01') RETURNING id`,
      [KIND, SUB],
    )) as Array<{ id: string }>;
    const serId = Number(se!.id);
    series.push(serId);
    await ds.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1, $2)`, [serId, studentId]);
    for (const day of dates) {
      await ds.query(
        `INSERT INTO ser_occ (ser_id, on_date, canceled, span)
         VALUES ($1, $2::date, $3,
                 tstzrange(($2::date + time '09:00') AT TIME ZONE 'Asia/Seoul',
                           ($2::date + time '10:00') AT TIME ZONE 'Asia/Seoul', '[)'))`,
        [serId, day.on, day.canceled ?? false],
      );
    }
  };
  const liveInvoices = async (studentId: number, yearMonth: string) =>
    (await ds.query(
      `SELECT id FROM inv WHERE student_id = $1 AND year_month = $2 AND inv_type = 'tuition' AND state <> 'void'`,
      [studentId, yearMonth],
    )) as Array<{ id: string }>;

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
    await ds.query(`INSERT INTO staff (id,name,email,role) VALUES ($1,'경합 대표','w11-bill-race@t.kr','ceo') ON CONFLICT (id) DO NOTHING`, [ACTOR]);
    await ds.query(`INSERT INTO kind (key,name,color,cap,grp) VALUES ($1,'경합 수업','#333333',4,'lesson') ON CONFLICT (key) DO NOTHING`, [KIND]);
    await ds.query(`INSERT INTO sub (key,name,color) VALUES ($1,'경합 과목','#444444') ON CONFLICT (key) DO NOTHING`, [SUB]);
    await ds.query(`DELETE FROM rate WHERE kind_key = $1`, [KIND]);
    await ds.query(`INSERT INTO rate (kind_key, sub_key, unit_price, from_date, heads) VALUES ($1, $2, 50000, '2026-01-01', 1)`, [KIND, SUB]);
    await ds.query(`DELETE FROM month_close WHERE year_month = ANY($1::text[])`, [[
      FROM, TO, CLOSE_M, CARRY_FROM, CARRY_TO, REOPEN_M,
      VOID_M, ATTENDANCE_M, PAUSE_M, WITHDRAW_M, SCHEDULE_M,
    ]]);
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    try {
      if (students.length) {
        const invIds = ((await ds.query(`SELECT id FROM inv WHERE student_id = ANY($1::bigint[])`, [students])) as Array<{ id: string }>).map((r) => Number(r.id));
        const carryIds = ((await ds.query(`SELECT id FROM carry WHERE student_id = ANY($1::bigint[])`, [students])) as Array<{ id: string }>).map((r) => Number(r.id));
        await ds.query(`DELETE FROM log WHERE entity = 'INV' AND entity_id = ANY($1::bigint[])`, [invIds]);
        await ds.query(`DELETE FROM log WHERE entity = 'CARRY' AND entity_id = ANY($1::bigint[])`, [carryIds]);
        await ds.query(`DELETE FROM carry WHERE student_id = ANY($1::bigint[])`, [students]);
        await ds.query(`DELETE FROM pay WHERE student_id = ANY($1::bigint[])`, [students]);
        await ds.query(`DELETE FROM inv_line WHERE inv_id = ANY($1::bigint[])`, [invIds]);
        await ds.query(`DELETE FROM inv WHERE id = ANY($1::bigint[])`, [invIds]);
      }
      if (series.length) {
        await ds.query(`DELETE FROM att WHERE ser_id = ANY($1::bigint[])`, [series]);
        await ds.query(`DELETE FROM ser_occ WHERE ser_id = ANY($1::bigint[])`, [series]);
        await ds.query(`DELETE FROM ser_stu WHERE ser_id = ANY($1::bigint[])`, [series]);
        await ds.query(`DELETE FROM ser WHERE id = ANY($1::bigint[])`, [series]);
      }
      if (students.length) await ds.query(`DELETE FROM stu_pause WHERE student_id = ANY($1::bigint[])`, [students]);
      if (students.length) await ds.query(`DELETE FROM stu WHERE id = ANY($1::bigint[])`, [students]);
      await ds.query(`DELETE FROM rate WHERE kind_key = $1`, [KIND]);
      await ds.query(`DELETE FROM sub WHERE key = $1 AND NOT EXISTS (SELECT 1 FROM ser WHERE sub_key = $1)`, [SUB]);
      await ds.query(`DELETE FROM kind WHERE key = $1 AND NOT EXISTS (SELECT 1 FROM ser WHERE kind_key = $1)`, [KIND]);
      await ds.query(`DELETE FROM log WHERE actor_id = $1`, [ACTOR]);
      await ds.query(`DELETE FROM month_close WHERE closed_by = $1 OR reopened_by = $1`, [ACTOR]);
      await ds.query(`DELETE FROM staff WHERE id = $1`, [ACTOR]);
    } finally {
      await ds.destroy();
    }
  });

  it('③ 같은 (학생 · 달 · 종류)의 발행 둘이 동시에 들어와도 **한 장만** 선다 — 둘째는 409 INV_DUPLICATE (PB-12-4)', async () => {
    const sid = await newStudent();
    await lesson(sid, [{ on: '2026-03-02' }, { on: '2026-03-09' }]);
    const dto = { studentId: sid, yearMonth: FROM, invType: 'tuition', dueOn: DUE };

    const blocker = await hold(['inv']);
    const a = settle(svc().issueInvoice(ACTOR, dto, true));
    const b = settle(svc().issueInvoice(ACTOR, dto, true));
    await waitForLockWaiters(2);
    await release(blocker);
    const outcomes = await Promise.all([a, b]);

    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok).map((o) => (o as { code: string }).code)).toEqual(['INV_DUPLICATE']);
    expect(await liveInvoices(sid, FROM)).toHaveLength(1);
    // 감사도 한 줄 — 되돌린 쪽은 흔적이 없다
    const [{ n }] = (await ds.query(
      `SELECT count(*)::int AS n FROM log WHERE entity = 'INV' AND action = 'issue'
          AND entity_id IN (SELECT id FROM inv WHERE student_id = $1)`, [sid],
    )) as Array<{ n: number }>;
    expect(n).toBe(1);
  });

  it('② 이월과 받는 달 수업료 발행이 동시에 들어와도 **이월분은 반드시 한 곳에 든다** — 둘 다 저장되고 차감이 빠지는 일이 없다', async () => {
    const sid = await newStudent();
    await lesson(sid, [{ on: '2026-03-02' }, { on: '2026-03-09', canceled: true }]); // 3월: 한 수업 + 휴강 1회(넘길 돈 50,000)
    await lesson(sid, [{ on: '2026-04-06' }, { on: '2026-04-13' }]);                   // 4월: 두 수업 100,000
    const march = await svc().issueInvoice(ACTOR, { studentId: sid, yearMonth: FROM, invType: 'tuition', dueOn: DUE }, true);
    await ds.query(`UPDATE inv SET state = 'paid', paid_amount = amount, paid_at = now() WHERE id = $1`, [march.id]);

    const blocker = await hold(['inv', 'carry']);
    const carry = settle(svc().carryTuition(ACTOR, { studentId: sid, month: FROM }));
    const april = settle(svc().issueInvoice(ACTOR, { studentId: sid, yearMonth: TO, invType: 'tuition', dueOn: DUE }, true));
    await waitForLockWaiters(2);
    await release(blocker);
    const [c, i] = await Promise.all([carry, april]);

    // 발행은 늘 된다 — 이월이 먼저 끝났으면 차감이 들고, 발행이 먼저 끝났으면 이월이 409 로 막힌다
    expect(i.ok).toBe(true);
    const carried = (await ds.query(`SELECT amount FROM carry WHERE student_id = $1 AND from_month = $2`, [sid, FROM])) as Array<{ amount: number }>;
    const [inv] = await liveInvoices(sid, TO);
    const lines = (await ds.query(`SELECT count, amount FROM inv_line WHERE inv_id = $1`, [inv!.id])) as Array<{ count: number; amount: number }>;
    const carryLine = lines.filter((l) => Number(l.count) < 0);
    if (c.ok) {
      expect(carried).toHaveLength(1);
      expect(carryLine.map((l) => Number(l.amount))).toEqual([-50_000]);
    } else {
      expect(c.code).toBe('CARRY_NEXT_ISSUED');
      expect(carried).toEqual([]);
      expect(carryLine).toEqual([]);
    }
    // 불변식 — 넘긴 줄이 있으면 받는 달 청구서에 차감 줄이 있다(돈이 새지 않는다)
    expect(carried.length).toBe(carryLine.length);
  });

  /*
   * ── 월 마감 ↔ 발행 · 이월 (W11 A' 후속) ─────────────────────────────────────────────
   * 발행 · 이월은 「그 달이 열려 있다」를 읽은 뒤에 쓴다. 그 사이 마감이 먼저 커밋되면 **마감한 달에 새 청구서 · 새 이월이 섰다**
   * (마감은 그 쓰기를 기다리지 않았다). 이제 마감 · 해제는 달 열쇠를 배타로, 발행 · 이월은 공유로 잡는다 — 둘이 겹치면 한쪽이 끝날 때까지 기다린다.
   * 판정은 커밋 차례다: 쓰기가 됐다면 그 감사 줄이 마감 줄보다 **앞**이어야 한다(마감 전 달의 쓰기) · 아니면 409 MONTH_CLOSED.
   */
  it('월 마감과 그 달 발행이 동시에 들어와도 **마감한 뒤에 새 청구서가 서지 않는다** — 발행이 먼저 끝나거나 409 MONTH_CLOSED', async () => {
    const sid = await newStudent();
    await lesson(sid, [{ on: '2026-05-04' }, { on: '2026-05-11' }]);

    const blocker = await hold(['inv']); // 발행이 INSERT 앞에서 기다린다 — 달이 열려 있다는 판정은 이미 지났다
    const issue = settle(svc().issueInvoice(ACTOR, { studentId: sid, yearMonth: CLOSE_M, invType: 'tuition', dueOn: DUE }, true));
    await waitForLockWaiters(1);
    const close = settle(svc().closeMonth(ACTOR, true, { month: CLOSE_M }));
    await doneOrWaiting(close, 2);
    await release(blocker);
    const [i, c] = await Promise.all([issue, close]);

    expect(c.ok).toBe(true);
    const closeLog = await logIdOf('MONTH_CLOSE', (c as { value: { id: number } }).value.id, 'close');
    if (i.ok) {
      const invId = (i.value as { id: number }).id;
      // 발행이 마감보다 **먼저** 커밋됐다 — 그 청구서는 마감 전 달에 선 것이다
      expect(await logIdOf('INV', invId, 'issue')).toBeLessThan(closeLog);
    } else {
      expect(i.code).toBe('MONTH_CLOSED');
      expect(await liveInvoices(sid, CLOSE_M)).toEqual([]);
    }
  });

  it('이월과 넘기는 달의 마감이 동시에 들어와도 **마감한 달에서 새로 이월이 빠지지 않는다** — 이월이 먼저 끝나거나 409 MONTH_CLOSED', async () => {
    const sid = await newStudent();
    await lesson(sid, [{ on: '2026-06-01' }, { on: '2026-06-08', canceled: true }]); // 휴강 1회 — 넘길 돈 50,000
    const june = await svc().issueInvoice(ACTOR, { studentId: sid, yearMonth: CARRY_FROM, invType: 'tuition', dueOn: DUE }, true);
    await ds.query(`UPDATE inv SET state = 'paid', paid_amount = amount, paid_at = now() WHERE id = $1`, [june.id]);

    const blocker = await hold(['carry']); // 이월이 INSERT 앞에서 기다린다 — 두 달의 판정은 이미 지났다
    const carry = settle(svc().carryTuition(ACTOR, { studentId: sid, month: CARRY_FROM }));
    await waitForLockWaiters(1);
    const close = settle(svc().closeMonth(ACTOR, true, { month: CARRY_FROM }));
    await doneOrWaiting(close, 2);
    await release(blocker);
    const [k, c] = await Promise.all([carry, close]);

    expect(c.ok).toBe(true);
    const closeLog = await logIdOf('MONTH_CLOSE', (c as { value: { id: number } }).value.id, 'close');
    const carried = (await ds.query(`SELECT id FROM carry WHERE student_id = $1 AND from_month = $2`, [sid, CARRY_FROM])) as Array<{ id: string }>;
    if (k.ok) {
      expect(carried).toHaveLength(1);
      expect(await logIdOf('CARRY', Number(carried[0]!.id), 'create')).toBeLessThan(closeLog);
    } else {
      expect(k.code).toBe('MONTH_CLOSED');
      expect(carried).toEqual([]);
    }
  });

  it('마감 해제가 도는 동안 그 달 발행은 **해제가 끝난 뒤** 판정한다 — 해제도 같은 달 열쇠를 잡는다', async () => {
    const sid = await newStudent();
    await lesson(sid, [{ on: '2026-08-03' }, { on: '2026-08-10' }]);
    await svc().closeMonth(ACTOR, true, { month: REOPEN_M });

    const blocker = await hold(['month_close']); // 해제가 UPDATE 앞에서 기다린다 — 달 열쇠는 이미 쥐었다
    const reopen = settle(svc().reopenMonth(ACTOR, true, { month: REOPEN_M, reason: '경합 시험' }));
    await waitForLockWaiters(1);
    const issue = settle(svc().issueInvoice(ACTOR, { studentId: sid, yearMonth: REOPEN_M, invType: 'tuition', dueOn: DUE }, true));
    await doneOrWaiting(issue, 2);
    await release(blocker);
    const [r, i] = await Promise.all([reopen, issue]);

    expect(r.ok).toBe(true);
    // 해제가 먼저 커밋됐으므로 발행은 열린 달을 읽는다 — 「마감됐다」를 읽고 먼저 409 로 끝나지 않는다
    expect(i).toMatchObject({ ok: true });
    expect(await liveInvoices(sid, REOPEN_M)).toHaveLength(1);
  });

  /*
   * 월 마감의 전역 공유/배타 축 — 청구 발행·이월뿐 아니라 청구 취소, 출결, 휴원,
   * 수강 종료, 일정 쓰기도 열린 달 판정과 실제 저장 사이에 마감이 끼지 못해야 한다.
   * 각 시험은 제품 쓰기를 표 잠금에서 멈춘 뒤 마감을 겹쳐 실제 두 연결의 대기를 확인한다.
   */
  it('청구 취소와 월 마감이 겹쳐도 취소가 마감 뒤에 커밋되지 않는다', async () => {
    const sid = await newStudent();
    await lesson(sid, [{ on: `${VOID_M}-05` }]);
    const invoice = await svc().issueInvoice(ACTOR, {
      studentId: sid, yearMonth: VOID_M, invType: 'tuition', dueOn: DUE,
    }, true);

    const blocker = await hold(['inv']);
    const voided = settle(svc().voidInvoice(ACTOR, true, invoice.id, { reason: '경합 검증' }, true));
    await waitForLockWaiters(1);
    const close = settle(svc().closeMonth(ACTOR, true, { month: VOID_M }));
    await doneOrWaiting(close, 2);
    await release(blocker);
    const [v, c] = await Promise.all([voided, close]);

    expect(v.ok).toBe(true);
    expect(c.ok).toBe(true);
    expect(await logIdOf('INV', invoice.id, 'void')).toBeLessThan(
      await logIdOf('MONTH_CLOSE', (c as { value: { id: number } }).value.id, 'close'),
    );
  });

  it('출결 저장과 월 마감이 겹쳐도 출결은 마감보다 먼저 끝나거나 MONTH_CLOSED다', async () => {
    const sid = await newStudent();
    const onDate = `${ATTENDANCE_M}-06`;
    await lesson(sid, [{ on: onDate }]);
    const serId = series[series.length - 1]!;

    const blocker = await hold(['att']);
    const saved = settle(new ScheduleAttendanceService(ds).save(serId, onDate, { result: 'completed' }, ACTOR));
    await waitForLockWaiters(1);
    const close = settle(svc().closeMonth(ACTOR, true, { month: ATTENDANCE_M }));
    await doneOrWaiting(close, 2);
    await release(blocker);
    const [a, c] = await Promise.all([saved, close]);

    expect(a.ok).toBe(true);
    expect(c.ok).toBe(true);
    const attendanceId = (a as { value: { attendance: { id: number } } }).value.attendance.id;
    expect(await logIdOf('ATT', attendanceId, 'create')).toBeLessThan(
      await logIdOf('MONTH_CLOSE', (c as { value: { id: number } }).value.id, 'close'),
    );
  });

  it('휴원 저장과 월 마감이 겹쳐도 휴원은 마감보다 먼저 끝나거나 MONTH_CLOSED다', async () => {
    const sid = await newStudent();
    const blocker = await hold(['stu_pause']);
    const paused = settle(new SchedulePauseService(ds).pause(sid, {
      fromDate: `${PAUSE_M}-01`, toDate: `${PAUSE_M}-30`, reason: '경합 검증',
    }, ACTOR));
    await waitForLockWaiters(1);
    const close = settle(svc().closeMonth(ACTOR, true, { month: PAUSE_M }));
    await doneOrWaiting(close, 2);
    await release(blocker);
    const [p, c] = await Promise.all([paused, close]);

    expect(p.ok).toBe(true);
    expect(c.ok).toBe(true);
    const pauseId = (p as { value: { id: number } }).value.id;
    expect(await logIdOf('STU_PAUSE', pauseId, 'create')).toBeLessThan(
      await logIdOf('MONTH_CLOSE', (c as { value: { id: number } }).value.id, 'close'),
    );
  });

  it('수강 종료와 월 마감이 겹쳐도 종료가 마감 뒤에 커밋되지 않는다', async () => {
    const sid = await newStudent();
    const endedOn = `${WITHDRAW_M}-10`;
    await lesson(sid, [{ on: `${WITHDRAW_M}-03` }]);

    const blocker = await hold(['ser_stu']);
    const withdrawn = settle(new StudentWithdrawService(ds).withdraw(
      ACTOR, { studentId: sid, endedOn, reason: '경합 검증' }, true, true,
    ));
    await waitForLockWaiters(1);
    const close = settle(svc().closeMonth(ACTOR, true, { month: WITHDRAW_M }));
    await doneOrWaiting(close, 2);
    await release(blocker);
    const [w, c] = await Promise.all([withdrawn, close]);

    expect(w.ok).toBe(true);
    expect(c.ok).toBe(true);
    const closeLog = await logIdOf('MONTH_CLOSE', (c as { value: { id: number } }).value.id, 'close');
    const [withdrawLog] = (await ds.query(
      `SELECT id FROM log WHERE actor_id=$1 AND entity='STU' AND entity_id=$2 AND action='withdraw' ORDER BY id DESC LIMIT 1`,
      [ACTOR, sid],
    )) as Array<{ id: string }>;
    expect(Number(withdrawLog!.id)).toBeLessThan(closeLog);
  });

  it('일정 생성과 월 마감이 겹쳐도 새 회차가 마감 뒤에 서지 않는다', async () => {
    const sid = await newStudent();
    const blocker = await hold(['ser']);
    const created = settle(new ScheduleWriteService(ds).create({
      kindKey: KIND,
      subKey: SUB,
      mode: 'offline',
      fromDate: `${SCHEDULE_M}-01`,
      rrule: 'ONCE',
      startMin: 660,
      endMin: 720,
      teacherId: ACTOR,
      roomId: null,
      title: '마감 경합 일정',
      studentIds: [sid],
    }, ACTOR));
    await waitForLockWaiters(1);
    const close = settle(svc().closeMonth(ACTOR, true, { month: SCHEDULE_M }));
    await doneOrWaiting(close, 2);
    await release(blocker);
    const [s, c] = await Promise.all([created, close]);

    expect(s.ok).toBe(true);
    expect(c.ok).toBe(true);
    const serId = (s as { value: { serIds: number[] } }).value.serIds[0]!;
    series.push(serId);
    expect(await logIdOf('SER', serId, 'create')).toBeLessThan(
      await logIdOf('MONTH_CLOSE', (c as { value: { id: number } }).value.id, 'close'),
    );
  });
});
