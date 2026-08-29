/**
 * 시드 무결성 — 화면이 믿고 쓰는 값이 실제로 그런지 본다.
 *
 * 여기 있는 검사는 전부 **한 번 틀렸던 것**이다:
 *   · 예외를 표에만 넣고 회차에 안 씌워서, 강사 교체를 승인했는데 시간표에는 원래 강사가 남았다
 *   · 「이번만 시간 옮김」이 회차 span 에 반영되지 않아 화면이 규칙의 시각을 보여 줬다
 *   · 리포트에 student_id 가 있어서 그룹 수업을 한 줄도 못 넣었다
 *   · 예외 날짜가 요일과 안 맞아 조용히 아무 회차에도 안 붙었다
 *
 * DATABASE_URL 이 없으면 건너뛴다.
 */
import { DataSource } from 'typeorm';
import {
  REPORT_WRITTEN_DB, REP_STATE_FROM_DB, reportStateFromDb,
} from '../src/lib/rules';

/** 규칙이 아는 상태 이름 전부 — 옮긴 값이 여기 없으면 규칙이 못 읽는다. */
const REPORT_STATES = ['na', 'plan', 'none', 'draft', 'submitted', 'approved', 'rejected'];

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;

jest.setTimeout(30_000);

d('시드 — 화면이 보는 값이 맞는가', () => {
  let ds: DataSource;
  const one = async (sql: string, p: unknown[] = []): Promise<Record<string, string>> =>
    ((await ds.query(sql, p)) as Array<Record<string, string>>)[0];

  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', url: URL, synchronize: false, logging: false });
    await ds.initialize();
  });
  afterAll(async () => { await ds?.destroy(); });

  it('예외가 붙지 않고 떠 있는 것이 없다', async () => {
    const r = await one(`SELECT count(*)::text AS n FROM exc e
      WHERE NOT EXISTS (SELECT 1 FROM ser_occ o WHERE o.ser_id = e.ser_id AND o.on_date = e.on_date)`);
    expect(Number(r.n)).toBe(0);
  });

  it('강사 교체 예외가 회차에 반영돼 있다', async () => {
    const r = await one(`SELECT count(*)::text AS n FROM exc e
      JOIN ser_occ o ON o.ser_id = e.ser_id AND o.on_date = e.on_date
      WHERE e.teacher_id IS NOT NULL AND o.teacher_id IS DISTINCT FROM e.teacher_id`);
    expect(Number(r.n)).toBe(0);
  });

  it('시간 이동 예외가 회차 span 에 반영돼 있다', async () => {
    const r = await one(`SELECT count(*)::text AS n FROM exc e
      JOIN ser_occ o ON o.ser_id = e.ser_id AND o.on_date = e.on_date
      WHERE e.start_min IS NOT NULL
        AND (EXTRACT(HOUR FROM lower(o.span) AT TIME ZONE 'Asia/Seoul') * 60
             + EXTRACT(MINUTE FROM lower(o.span) AT TIME ZONE 'Asia/Seoul'))::int <> e.start_min`);
    expect(Number(r.n)).toBe(0);
  });

  it('취소 예외가 회차에 반영돼 있다', async () => {
    const r = await one(`SELECT count(*)::text AS n FROM exc e
      JOIN ser_occ o ON o.ser_id = e.ser_id AND o.on_date = e.on_date
      WHERE e.canceled AND NOT o.canceled`);
    expect(Number(r.n)).toBe(0);
  });

  it('리포트는 회차 하나에 하나다 (그룹 수업 포함)', async () => {
    const dup = await one(`SELECT count(*)::text AS n FROM (
      SELECT ser_id, on_date FROM rep GROUP BY ser_id, on_date HAVING count(*) > 1) x`);
    expect(Number(dup.n)).toBe(0);
    const group = await one(`SELECT count(*)::text AS n FROM (
      SELECT rep_id FROM rep_stu GROUP BY rep_id HAVING count(*) > 1) x`);
    expect(Number(group.n)).toBeGreaterThan(0); // 그룹 수업이 실제로 들어 있어야 의미가 있다
  });

  it('학생이 붙지 않은 리포트가 없다', async () => {
    const r = await one(`SELECT count(*)::text AS n FROM rep r
      WHERE NOT EXISTS (SELECT 1 FROM rep_stu s WHERE s.rep_id = r.id)`);
    expect(Number(r.n)).toBe(0);
  });

  it('겹치는 회차가 하나도 없다 — EXCLUDE 가 이미 막지만 시드가 그것을 건드리지도 않는다', async () => {
    const r = await one(`SELECT count(*)::text AS n FROM ser_occ a JOIN ser_occ b
      ON a.id < b.id AND a.room_id = b.room_id AND a.span && b.span
      WHERE NOT a.canceled AND NOT b.canceled AND a.room_id IS NOT NULL`);
    expect(Number(r.n)).toBe(0);
  });

  /**
   * 시드의 절반은 SEED_TODAY 기준(회차·리포트)이고 절반은 적어 둔 날짜(학생·등록·상담)였다.
   * 시간이 지나면 둘이 벌어져서 **「이번 달 등록 0건」** 같은 화면이 나온다 —
   * 상담은 10건 들어왔는데 등록은 0인, 고장 난 것처럼 보이는 대시보드다.
   * base.ts 의 rel() 이 그 차이를 민다. 여기서 실제로 밀렸는지 본다.
   */
  it('데모 데이터가 오늘을 따라온다 — 이번 달 등록이 있다', async () => {
    const r = await one(
      `SELECT count(*)::text AS n FROM enr WHERE started_on >= date_trunc('month', current_date)`,
    );
    expect(Number(r.n)).toBeGreaterThan(0);
  });

  it('데모 데이터가 오늘을 따라온다 — 최근 30일에 들어온 상담이 있다', async () => {
    const r = await one(
      `SELECT count(*)::text AS n FROM lead WHERE created_at >= now() - interval '30 days'`,
    );
    expect(Number(r.n)).toBeGreaterThan(0);
  });

  it('코드표가 명세서 수와 같다 — 종류 8 · 과목 21', async () => {
    expect(Number((await one(`SELECT count(*)::text AS n FROM kind`)).n)).toBe(8);
    expect(Number((await one(`SELECT count(*)::text AS n FROM sub`)).n)).toBe(21);
  });

  /**
   * 표와 규칙이 **다른 낱말**을 쓰고 있었다.
   *   rep_state_t = na · plan · none · draft · wait · ok · rej
   *   REPORT_WRITTEN = submitted · approved · rejected
   * 겹치는 값이 **하나도 없어서** `written` 이 항상 false 였다 —
   * 캘린더는 모든 수업을 「안 씀」으로 칠했고 정산은 0건이 됐다.
   * 낱말이 또 갈라지면 여기서 걸린다.
   */
  it('DB 상태값이 규칙 어휘로 빠짐없이 옮겨진다', async () => {
    const rows = (await ds.query(
      `SELECT e.enumlabel AS v FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = 'rep_state_t'`,
    )) as Array<{ v: string }>;
    expect(rows.length).toBeGreaterThan(0);

    // 표에 있는 값은 전부 옮길 자리가 있어야 한다
    rows.forEach(({ v }) => expect(Object.keys(REP_STATE_FROM_DB)).toContain(v));
    // 옮긴 결과가 규칙이 아는 이름이어야 한다
    rows.forEach(({ v }) => expect(REPORT_STATES).toContain(reportStateFromDb(v)));
    // 「썼다」가 실제 DB 값과 하나 이상 겹쳐야 한다 — 0이면 조용히 다 안 쓴 게 된다
    expect(REPORT_WRITTEN_DB.length).toBeGreaterThan(0);
    REPORT_WRITTEN_DB.forEach((v) => expect(rows.map((r) => r.v)).toContain(v));
  });

  it('시드에 「썼다」로 셀 리포트가 실제로 있다', async () => {
    const r = await one(
      `SELECT count(*)::text AS n FROM rep WHERE state = ANY($1)`, [REPORT_WRITTEN_DB],
    );
    expect(Number(r.n)).toBeGreaterThan(0);
  });

  it('안 쓴 리포트가 실제로 있다 — §47 독촉 화면이 빈 채로 나오지 않게', async () => {
    const r = await one(`SELECT count(*)::text AS n FROM rep
      WHERE state = 'none' AND on_date < (SELECT max(on_date) FROM ser_occ)`);
    expect(Number(r.n)).toBeGreaterThan(0);
  });
});
