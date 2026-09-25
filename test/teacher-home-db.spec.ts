/** @file-guide
 * 목적: teacher-home-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 강사 홈 머리 숫자 — 강사 덱 slide 8 hero 「오늘 수업 3건 · 시수 5.5시간」 · slide 9 칩 「이번 주 9건 · 17.5시간 · 미작성 1」.
 *
 * 증명하는 것:
 *   ① 오늘 건수·시수는 서버가 센다(`todaySummary`) — 화면이 목록을 다시 세지 않는다(D-R37 · N-19).
 *   ② 「열린 수업」은 휴강(ser_occ.canceled)도 **출결 취소**(att.result = 'canceled')도 아니다 —
 *      캘린더(teacherSchedule)·리포트(REPORT_CANCELED_SQL)가 쓰는 것과 같은 판정이라 세 화면의 수가 갈리지 않는다.
 *   ③ 출결 취소된 수업은 「리포트 미작성」에도 들지 않는다 — 리포트 목록(/reports/unwritten)이 이미 그렇게 센다.
 * 시각에 따라 달라지는 「끝났는가」는 직접 단언하지 않고, 출결 취소 한 줄을 더하기 전후의 **차이**로 본다.
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

d('강사 홈 — 오늘·이번 주 숫자는 서버가 「열린 수업」으로 센다 (GET /teacher/home)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const ME = 86;
  const KIND = `th${process.pid}`.slice(0, 16);
  const TODAY = `(now() AT TIME ZONE 'Asia/Seoul')::date`;

  const svc = () => new TeacherService(q.manager.getRepository(Ser));

  /** 오늘(KST)로부터 dayOffset 일 뒤 HH:MM~HH:MM 한 회차 — 규칙 하나에 회차 하나 */
  async function lesson(dayOffset: number, from: string, to: string, canceled = false): Promise<number> {
    const [ser] = (await q.query(
      `INSERT INTO ser (kind_key, teacher_id, mode, start_min, end_min, rrule, from_date, to_date, title)
       VALUES ($1, $2, 'offline', 0, 60, 'ONCE', ${TODAY} + $3::int, ${TODAY} + $3::int, '홈 머리 숫자')
       RETURNING id`,
      [KIND, ME, dayOffset],
    )) as { id: number }[];
    await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, teacher_id, canceled, span)
       VALUES ($1, ${TODAY} + $2::int, $3, $4,
         tstzrange(((${TODAY} + $2::int) + $5::time) AT TIME ZONE 'Asia/Seoul',
                   ((${TODAY} + $2::int) + $6::time) AT TIME ZONE 'Asia/Seoul', '[)'))`,
      [ser.id, dayOffset, ME, canceled, from, to],
    );
    return Number(ser.id);
  }
  /** 출결 확정 「취소」 — 수업이 열리지 않았다 */
  const attCancel = (serId: number, dayOffset: number) => q.query(
    `INSERT INTO att (ser_id, on_date, result, reason, confirmed_by) VALUES ($1, ${TODAY} + $2::int, 'canceled', 'academy', $3)`,
    [serId, dayOffset, ME],
  );

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(
      `INSERT INTO staff (id, name, email, role, tz) VALUES ($1, '홈 강사', 'home86@t.kr', 'teacher', 'Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET tz = EXCLUDED.tz`, [ME],
    );
    await q.query(
      `INSERT INTO kind (key, name, color, cap, grp, rep) VALUES ($1, '홈 수업', '#123456', 4, 'lesson', true)
       ON CONFLICT (key) DO NOTHING`, [KIND],
    );
  });
  afterEach(async () => {
    await q.rollbackTransaction();
    await q.release();
  });
  afterAll(async () => {
    await ds.destroy();
  });

  it('오늘 건수·시수 — 휴강과 출결 취소는 빼고, 목록에는 넷 다 남는다', async () => {
    await lesson(0, '09:00', '10:00');
    await lesson(0, '10:00', '11:30');
    await lesson(0, '12:00', '13:00', true); // 휴강
    const d4 = await lesson(0, '14:00', '15:00');

    const before = await svc().home(ME);
    expect(before.todaySummary).toEqual({ lessons: 3, minutes: 210 });
    expect(before.week).toMatchObject({ lessons: 3, minutes: 210 });

    await attCancel(d4, 0);
    const after = await svc().home(ME);
    // 출결 취소는 「열린 수업」이 아니다 — 캘린더 머리(teacherSchedule)와 같은 판정
    expect(after.todaySummary).toEqual({ lessons: 2, minutes: 150 });
    expect(after.week).toMatchObject({ lessons: 2, minutes: 150 });
    // 목록은 거르지 않는다 — 화면이 휴강 줄을 그대로 보여 준다
    expect(after.today).toHaveLength(4);
  });

  it('출결 취소된 지난 수업은 「리포트 미작성」에 들지 않는다 — 리포트 목록과 같은 수', async () => {
    const past = await lesson(-10, '09:00', '10:00');
    await lesson(-10, '11:00', '12:00');
    const before = (await svc().home(ME)).todo.unwrittenReports;
    expect(before).toBeGreaterThanOrEqual(2);

    await attCancel(past, -10);
    const after = (await svc().home(ME)).todo.unwrittenReports;
    expect(after).toBe(before - 1);
  });

  it('리포트 대상이 아닌 종류(kind.rep = false · 자습·회의)의 지난 회차는 「리포트 미작성」에 들지 않는다', async () => {
    await lesson(-10, '09:00', '10:00');
    const before = (await svc().home(ME)).todo.unwrittenReports;
    // 리포트 목록(effectiveRepStateFromEnded)은 대상이 아닌 종류를 na 로 읽는다 — 홈도 같은 수여야 한다
    await q.query(
      `INSERT INTO kind (key, name, color, cap, grp, rep) VALUES ($1, '홈 회의', '#654321', 10, 'meeting', false)
       ON CONFLICT (key) DO NOTHING`, [`${KIND}n`.slice(0, 16)],
    );
    const [ser] = (await q.query(
      `INSERT INTO ser (kind_key, teacher_id, mode, start_min, end_min, rrule, from_date, to_date, title)
       VALUES ($1, $2, 'offline', 0, 60, 'ONCE', ${TODAY} - 10, ${TODAY} - 10, '홈 회의') RETURNING id`,
      [`${KIND}n`.slice(0, 16), ME],
    )) as { id: number }[];
    await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, teacher_id, canceled, span)
       VALUES ($1, ${TODAY} - 10, $2, false,
         tstzrange(((${TODAY} - 10) + time '13:00') AT TIME ZONE 'Asia/Seoul',
                   ((${TODAY} - 10) + time '14:00') AT TIME ZONE 'Asia/Seoul', '[)'))`,
      [ser.id, ME],
    );
    const after = await svc().home(ME);
    expect(after.todo.unwrittenReports).toBe(before);
  });
});
