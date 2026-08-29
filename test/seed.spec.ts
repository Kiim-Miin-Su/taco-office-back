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

  it('코드표가 명세서 수와 같다 — 종류 8 · 과목 21', async () => {
    expect(Number((await one(`SELECT count(*)::text AS n FROM kind`)).n)).toBe(8);
    expect(Number((await one(`SELECT count(*)::text AS n FROM sub`)).n)).toBe(21);
  });

  it('안 쓴 리포트가 실제로 있다 — §47 독촉 화면이 빈 채로 나오지 않게', async () => {
    const r = await one(`SELECT count(*)::text AS n FROM rep
      WHERE state = 'none' AND on_date < (SELECT max(on_date) FROM ser_occ)`);
    expect(Number(r.n)).toBeGreaterThan(0);
  });
});
