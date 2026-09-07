/**
 * SQL 조각 — `lib/sql.ts`. 구조 검사 + 로컬 격리 DB의 읽기 전용 상수 span 회귀.
 *
 * 이 파일이 있는 이유: 시각 형식이 서비스마다 흩어져 있을 때
 * 아홉 군데 전부가 `+00` 을 내려보내고 있었는데 어느 테스트도 잡지 못했다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { KST, kstAt, kstDateOf, minOf, spanOf, START_MIN, END_MIN } from '../src/lib/sql';
import { ScheduleService } from '../src/modules/schedule/schedule.service';

describe('lib/sql', () => {
  it('시간대는 한 곳에서만 정한다 (D-R12)', () => {
    expect(KST).toBe('Asia/Seoul');
    [minOf('x'), kstAt('x'), spanOf('$1', '$2', '$3')].forEach((f) =>
      expect(f).toContain("'Asia/Seoul'"));
  });

  it('내려보내는 시각에는 KST 오프셋이 글자로 붙는다', () => {
    const f = kstAt('created_at');
    expect(f).toContain("AT TIME ZONE 'Asia/Seoul'");
    expect(f).toContain("|| '+09:00'");
    // 서버 세션 시간대를 그대로 쓰는 'OF' 로 돌아가면 안 된다
    expect(f).not.toContain('OF');
  });

  it('분은 시·분을 KST 로 뽑아 더한다', () => {
    expect(START_MIN).toBe(minOf('lower(o.span)'));
    expect(END_MIN).toContain(minOf('upper(o.span)'));
    expect(END_MIN).toContain(kstDateOf('lower(o.span)'));
    expect(minOf('x')).toContain('* 60');
  });

  it('겹침은 tstzrange 로 만든다 — DB 의 EXCLUDE 와 같은 연산자를 쓰려고', () => {
    const f = spanOf('$2', '$3', '$4');
    expect(f).toContain('tstzrange(');
    expect(f).toContain("'[)'");
    expect(f).toContain('make_interval(mins => $3)');
  });
});

// .env나 운영 DataSource를 import하지 않는다. 명시적 로컬 scratch DB만 허용한다.
const sqlTestUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = sqlTestUrl ? describe : describe.skip;

d('수업 종료 분 — 실제 KST 날짜 경계', () => {
  let ds: DataSource;
  let q: QueryRunner;

  beforeAll(async () => {
    const target = new URL(sqlTestUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
      || !/_test$/.test(target.pathname) || /prod|production/i.test(target.pathname)) {
      throw new Error('SQL boundary tests require an explicit local scratch *_test database');
    }
    ds = new DataSource({ type: 'postgres', url: sqlTestUrl, synchronize: false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query('SET TRANSACTION READ ONLY');
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  async function readRange(startMin: number, endMin: number) {
    const [row] = await q.query(`SELECT
      to_char(${kstDateOf('lower(o.span)')}, 'YYYY-MM-DD') AS date,
      ${START_MIN} AS start_min, ${END_MIN} AS end_min
      FROM (SELECT ${spanOf('$1', '$2', '$3')} AS span) o`,
    ['2026-09-10', startMin, endMin]) as Array<{ date: string; start_min: number; end_min: number }>;
    return row;
  }

  describe.each(['UTC', 'Asia/Seoul', 'America/New_York'])('DB 세션 %s', (zone) => {
    it.each([[600, 660], [1380, 1439], [1430, 1440], [960, 1440]])(
      '%i→%i를 시작일 기준 분으로 읽고 길이를 보존한다', async (startMin, endMin) => {
        await q.query("SELECT set_config('TimeZone', $1, true)", [zone]);
        const row = await readRange(startMin, endMin);
        expect(row).toEqual({ date: '2026-09-10', start_min: startMin, end_min: endMin });
        expect(row.end_min - row.start_min).toBe(endMin - startMin);
      },
    );
  });

  it('이동된 자정 종료 회차도 DTO JSON에서 1440을 보존하며 종료 전 리포트·출결을 열지 않는다', async () => {
    const row = await readRange(1380, 1440);
    const service = new ScheduleService({ query: jest.fn().mockResolvedValue([{
      ...row, ser_id: '1', on_date: '2026-09-09', reportable: true, rep_state: 'plan',
      kind_key: 'class', rrule: 'ONCE', ser_from: '2026-09-09', ser_to: '2026-09-09', students: [],
    }]) } as never);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-10T22:00:00+09:00'));
    try {
      const [dto] = await service.list({ from: '2026-09-10', to: '2026-09-10', canCrudAttendance: true });
      expect(JSON.parse(JSON.stringify(dto))).toMatchObject({
        date: '2026-09-10', onDate: '2026-09-09', startMin: 1380, endMin: 1440,
        repState: 'plan', written: false, attendanceMode: 'unavailable',
      });
    } finally {
      clock.mockRestore();
    }
  });
});
