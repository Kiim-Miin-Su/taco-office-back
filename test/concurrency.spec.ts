/**
 * 동시성 · 원자성 — **선택이 아니다** (D-R43 · 대표 지시).
 *
 * 원문: "동시에 여러 유저가 같은 자원 쓰는 경우: 스케줄, 입금 등에 대한 원자성 테스트도 필수"
 *
 * 여기서 증명하는 것은 **애플리케이션 검사가 아니라 DB 가 막는다**는 것이다.
 * guardResource() 는 사용자에게 미리 알려 주기 위한 안내이고, 두 사람이 같은 순간에
 * 저장을 눌렀을 때 막는 것은 제약과 잠금이다 (docs/contracts/STACK.md §1.2).
 *
 *   ① 경계  @Transactional()        — 표 여러 개가 한 번에 바뀌어야 하는 곳
 *   ② 경합  SELECT … FOR UPDATE     — 같은 행을 동시에 건드릴 때
 *   ③ 중복  EXCLUDE · UNIQUE 제약    — 재시도·더블클릭
 *
 * DATABASE_URL 이 없으면 건너뛴다 — CI 에서 DB 없이도 나머지 테스트는 돌아야 한다.
 *
 * ⚠ 이 파일은 **표를 비운다.** 그래서 개발 DB 가 아니라 스크래치 DB(`*_test`) 에서만 돈다.
 *   개발 DB 에 돌리면 시드가 통째로 사라지고 화면이 텅 빈 채로 뜬다 (test/db.ts 주석 참고).
 */
import { DataSource } from 'typeorm';
import { TEST_URL, DEV_URL, assertScratch, dbNameOf } from './db';

const URL = DEV_URL ? assertScratch(TEST_URL) : undefined;
const d = URL ? describe : describe.skip;

jest.setTimeout(30_000);

d('동시성 — DB 가 마지막에 막는다 (D-R43)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', url: URL, synchronize: false, logging: false });
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(async () => {
    // 안전벨트를 매번 다시 맨다 — 커넥션이 바뀌었을 수도 있다.
    const [{ current_database: now }] = (await ds.query('SELECT current_database()')) as Array<{
      current_database: string;
    }>;
    if (now !== dbNameOf(URL!)) throw new Error(`엉뚱한 DB 에 붙어 있다: '${now}'`);
    await ds.query('TRUNCATE ser_occ, inv, inv_line, rep RESTART IDENTITY CASCADE');
  });

  /* ══ ① 겹침 — 같은 강의실에 두 수업 ═══════════════════════════════ */
  describe('같은 시간·같은 강의실에 두 수업이 동시에 들어온다', () => {
    const put = (serId: number, room: number, from: string, to: string) =>
      ds.query(
        `INSERT INTO ser_occ (ser_id, on_date, teacher_id, room_id, span)
         VALUES ($1, '2026-09-01', $2, $3, tstzrange($4, $5))`,
        [serId, 100 + serId, room, from, to],
      );

    it('겹치면 하나만 성공한다 — 나머지는 제약이 거부한다', async () => {
      const results = await Promise.allSettled([
        put(1, 201, '2026-09-01 10:00+09', '2026-09-01 11:00+09'),
        put(2, 201, '2026-09-01 10:30+09', '2026-09-01 11:30+09'),
        put(3, 201, '2026-09-01 10:45+09', '2026-09-01 12:00+09'),
      ]);
      const okCount = results.filter((r) => r.status === 'fulfilled').length;
      expect(okCount).toBe(1);

      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      rejected.forEach((r) => {
        // 이 코드(23P01)를 409 RESOURCE_CONFLICT 로 번역해 내보낸다
        expect(String(r.reason?.code ?? r.reason)).toContain('23P01');
      });

      const rows = await ds.query('SELECT count(*)::int AS n FROM ser_occ');
      expect(rows[0].n).toBe(1);
    });

    it('붙어 있기만 하면 겹친 것이 아니다 — 10:00~11:00 과 11:00~12:00', async () => {
      await put(1, 201, '2026-09-01 10:00+09', '2026-09-01 11:00+09');
      await put(2, 201, '2026-09-01 11:00+09', '2026-09-01 12:00+09');
      const rows = await ds.query('SELECT count(*)::int AS n FROM ser_occ');
      expect(rows[0].n).toBe(2);
    });

    it('강의실이 다르면 같은 시간도 된다', async () => {
      await put(1, 201, '2026-09-01 10:00+09', '2026-09-01 11:00+09');
      await put(2, 202, '2026-09-01 10:00+09', '2026-09-01 11:00+09');
      const rows = await ds.query('SELECT count(*)::int AS n FROM ser_occ');
      expect(rows[0].n).toBe(2);
    });

    it('휴강은 자리를 차지하지 않는다', async () => {
      await ds.query(
        `INSERT INTO ser_occ (ser_id, on_date, room_id, canceled, span)
         VALUES (1, '2026-09-01', 201, true, tstzrange('2026-09-01 10:00+09','2026-09-01 11:00+09'))`,
      );
      await put(2, 201, '2026-09-01 10:00+09', '2026-09-01 11:00+09');
      const rows = await ds.query('SELECT count(*)::int AS n FROM ser_occ');
      expect(rows[0].n).toBe(2);
    });

    it('같은 강사가 같은 시간에 두 곳에 있을 수 없다', async () => {
      await ds.query(
        `INSERT INTO ser_occ (ser_id, on_date, teacher_id, room_id, span)
         VALUES (1, '2026-09-01', 11, 201, tstzrange('2026-09-01 10:00+09','2026-09-01 11:00+09'))`,
      );
      await expect(
        ds.query(
          `INSERT INTO ser_occ (ser_id, on_date, teacher_id, room_id, span)
           VALUES (2, '2026-09-01', 11, 202, tstzrange('2026-09-01 10:30+09','2026-09-01 11:30+09'))`,
        ),
      ).rejects.toMatchObject({ code: '23P01' });
    });
  });

  /* ══ ② 경합 — 같은 입금을 두 매니저가 동시에 ═══════════════════════ */
  describe('두 매니저가 같은 입금을 동시에 완납 처리한다', () => {
    const makeInvoice = () =>
      ds.query(
        `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state, paid_amount)
         VALUES (1, '2026-09', 'tuition', '9월 수업료', 1680000, 'unpaid', 0) RETURNING id`,
      );

    /** FOR UPDATE 로 잠그고 상태를 확인한 뒤에만 바꾼다 — 서비스가 하는 일과 같다 */
    const settle = async (invId: number, amount: number) =>
      ds.transaction(async (m) => {
        const [row] = await m.query(
          `SELECT state, amount, paid_amount FROM inv WHERE id = $1 FOR UPDATE`,
          [invId],
        );
        if (row.state === 'paid') throw new Error('ALREADY_PAID');
        await m.query(
          `UPDATE inv SET state = 'paid', paid_amount = $2, paid_at = now() WHERE id = $1`,
          [invId, amount],
        );
        return 'ok';
      });

    it('상태 전이가 한 번만 일어난다', async () => {
      const [{ id }] = await makeInvoice();
      const results = await Promise.allSettled([
        settle(Number(id), 1680000),
        settle(Number(id), 1680000),
        settle(Number(id), 1680000),
      ]);
      const okCount = results.filter((r) => r.status === 'fulfilled').length;
      expect(okCount).toBe(1);

      const losers = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(losers).toHaveLength(2);
      losers.forEach((r) => expect(String(r.reason?.message)).toContain('ALREADY_PAID'));
    });

    it('청구액보다 많이 받은 것으로 적을 수 없다', async () => {
      const [{ id }] = await makeInvoice();
      await expect(
        ds.query(`UPDATE inv SET paid_amount = 9999999 WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ code: '23514' }); // CHECK 위반
    });
  });

  /* ══ ③ 중복 — 같은 회차에 리포트 두 장 ════════════════════════════ */
  describe('같은 회차에 리포트가 두 장 생기지 않는다', () => {
    // 리포트는 **회차당 한 장**이다 — 학생은 rep_stu 로 붙는다 (CONTRACTS §10.5 · erd v4.4).
    // 예전에는 여기에 student_id 를 넣었는데, 그 컬럼은 그룹 수업에서
    // UNIQUE(ser_id, on_date) 와 정면으로 부딪혀 스키마에서 빠졌다.
    const writeReport = () =>
      ds.query(
        `INSERT INTO rep (ser_id, on_date, teacher_id, kind_key, lang, body, state)
         VALUES (1, '2026-09-01', 11, 'class', 'ko', '{}'::jsonb, 'draft')`,
      );

    it('더블클릭·재시도로도 한 장만 남는다', async () => {
      const results = await Promise.allSettled([writeReport(), writeReport(), writeReport()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      (results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]).forEach((r) =>
        expect(String(r.reason?.code)).toBe('23505'), // UNIQUE 위반
      );
      const rows = await ds.query('SELECT count(*)::int AS n FROM rep');
      expect(rows[0].n).toBe(1);
    });
  });
});
