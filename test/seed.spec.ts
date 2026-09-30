/** @file-guide
 * 목적: seed.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 시드 무결성 — 화면이 믿고 쓰는 값이 실제로 그런지 본다.
 *
 * 여기 있는 검사는 전부 **한 번 틀렸던 것**이다:
 *   · 예외를 표에만 넣고 회차에 안 씌워서, 강사 교체를 승인했는데 시간표에는 원래 강사가 남았다
 *   · 「이번만 시간 옮김」이 회차 span 에 반영되지 않아 화면이 규칙의 시각을 보여 줬다
 *   · 리포트에 student_id 가 있어서 그룹 수업을 한 줄도 못 넣었다
 *   · 예외 날짜가 요일과 안 맞아 조용히 아무 회차에도 안 붙었다
 *   · **서명 시각만 넣고 사람을 안 넣어 `rpt_sign_pair` 가 시드를 통째로 막았다** (C86-g)
 *
 * DATABASE_URL 이 없으면 건너뛴다.
 */
import { DataSource } from 'typeorm';
import {
  REPORT_WRITTEN_DB, REP_STATE_FROM_DB, reportStateFromDb,
} from '../src/lib/rules';
import { REPORTS, REQS } from '../src/seed/ops';
import { CARRY_BLOCKED, STURATES } from '../src/seed/money';
import { STUDENTS } from '../src/seed/people';
import { SERS } from '../src/seed/schedule';
import { dataSourceOptions } from '../src/data-source';
import { Inv, Lead } from '../src/entities';
import { AccountingService } from '../src/modules/accounting/accounting.service';
import { BooksService } from '../src/modules/books/books.service';
import { horizon, project } from '../src/modules/schedule/schedule.project';
import { loadState } from '../src/modules/schedule/schedule.state.repo';
import { DEV_URL } from './db';

/** 규칙이 아는 상태 이름 전부 — 옮긴 값이 여기 없으면 규칙이 못 읽는다. */
const REPORT_STATES = ['na', 'plan', 'none', 'draft', 'submitted', 'approved', 'rejected'];

// 읽는 자리를 db.ts 하나로 모은다 — 여기서 또 읽으면 .env 를 읽어 줄 사람이 없어 조용히 건너뛴다
const URL = DEV_URL;
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

  it('ST1-b3a: 시드 보호자는 기존 주소와 같은 선택 연락처를 가지며 발송 동의는 변하지 않는다', async () => {
    const mismatch = await one(`SELECT count(*)::text AS n FROM guardian g
      WHERE (g.email IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM guardian_contact c WHERE c.guardian_id=g.id AND c.kind='email'
          AND c.value=g.email AND c.active AND c.is_delivery_selected))
       OR (g.phone IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM guardian_contact c WHERE c.guardian_id=g.id AND c.kind='phone'
          AND c.value=g.phone AND c.active AND c.is_delivery_selected))`);
    expect(Number(mismatch.n)).toBe(0);
    expect(Number((await one(`SELECT count(*)::text AS n FROM guardian_contact`)).n)).toBeGreaterThan(0);
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

  /**
   * 7-3 ③(W11 R2) — §48 「보낸 내역」 · 파일 권한(F3) e2e 가 빈 표로 시작하지 않게 발송 표본을 둔다.
   * 표본도 발송과 같은 문을 지난다: 그 학생 그날 리포트가 **전부 승인**, 파일마다 제 리포트(`rep_id`)가 그 묶음 안에 있다.
   */
  it('보낸 내역 표본 — 최초 발송 · 재발송 한 줄 · 파일마다 그 묶음의 리포트 칸(rep_id)', async () => {
    const sends = await one(`SELECT count(*) FILTER (WHERE source_send_id IS NULL)::text AS first,
      count(*) FILTER (WHERE source_send_id IS NOT NULL)::text AS resend FROM rsend`);
    expect(Number(sends.first)).toBeGreaterThanOrEqual(1);
    expect(Number(sends.resend)).toBeGreaterThanOrEqual(1);
    const files = await one(`SELECT count(*)::text AS n,
        count(*) FILTER (WHERE p.rep_id IS NULL)::text AS no_rep,
        count(*) FILTER (WHERE NOT (rs.rep_ids @> jsonb_build_array(p.rep_id)))::text AS foreign_rep,
        count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM file f WHERE '/files/' || f.id = p.file_url AND f.kind = 'report-png'))::text AS no_file
      FROM pdflog p JOIN rsend rs ON rs.id = p.ref_id WHERE p.kind = 'report_png'`);
    expect(Number(files.n)).toBeGreaterThan(0);
    expect({ noRep: Number(files.no_rep), foreignRep: Number(files.foreign_rep), noFile: Number(files.no_file) })
      .toEqual({ noRep: 0, foreignRep: 0, noFile: 0 });
    const unapproved = await one(`SELECT count(*)::text AS n FROM rsend rs
      CROSS JOIN LATERAL jsonb_array_elements_text(rs.rep_ids) AS x(rep_id)
      JOIN rep r ON r.id = x.rep_id::bigint WHERE r.state <> 'ok'`);
    expect(Number(unapproved.n)).toBe(0);
  });
});

/**
 * N-49 (W11 · 시드 보정) — 시드의 회차는 **제품 투영이 만든 것**이어야 한다.
 *
 * 전에는 반복 규칙의 시작일을 오늘로 두고 지난 3주 회차를 `ser_occ` 에 손으로 넣었다. 규칙이 만들 수 없는 행이라
 * 그 수업에 「이번만」 쓰기를 하면 재투영이 지난 회차를 지웠다(지난 회차 쓰기가 `OCCURRENCE_NOT_FOUND` 로 헛돌았다).
 * 온라인 수업의 줌 계정도 투영(`ser_occ.zacc_id`)에만 있고 정본(`zassign`)이 없어, 첫 쓰기의 재투영이 계정을 비웠다.
 *
 * 쓰기 경로와 **같은 두 함수**(`loadState` → `project(horizon())`)로 다시 펴도 표가 한 줄도 안 바뀌는지 본다.
 * 되돌리는 트랜잭션이라 개발 DB 의 행은 그대로다(시퀀스 번호만 앞으로 간다).
 */
d('시드 — 회차는 제품 투영 그대로다 (N-49)', () => {
  let ds: DataSource;
  type Runner = { query: (sql: string, p?: unknown[]) => Promise<unknown> };
  /** 시드의 규칙만 본다 — 같은 개발 DB 를 쓰는 다른 스위트의 시험 규칙 · 잔여 행은 시드가 만든 것이 아니다 */
  const SEED_SER = SERS.map((s) => s.id);
  /** 비교는 시드가 편 마지막 날까지 — 시드 뒤 자정을 넘기면 투영 기간 끝에 하루가 새로 붙는다(행이 바뀐 것이 아니다) */
  const occRows = (x: Runner, upto: string) => x.query(
    `SELECT ser_id, to_char(on_date,'YYYY-MM-DD') AS on_date, teacher_id, room_id, canceled, span::text AS span, zacc_id
       FROM ser_occ WHERE ser_id = ANY($1) AND on_date <= $2::date ORDER BY ser_id, on_date`, [SEED_SER, upto],
  );
  const repRows = (x: Runner, upto: string) => x.query(
    `SELECT r.ser_id, to_char(r.on_date,'YYYY-MM-DD') AS on_date, r.state::text AS state, r.teacher_id, r.kind_key, r.lang,
            (SELECT string_agg(s.student_id::text, ',' ORDER BY s.student_id) FROM rep_stu s WHERE s.rep_id = r.id) AS students
       FROM rep r WHERE r.ser_id = ANY($1) AND r.on_date <= $2::date ORDER BY r.ser_id, r.on_date`, [SEED_SER, upto],
  );

  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', url: URL, synchronize: false, logging: false });
    await ds.initialize();
  });
  afterAll(async () => { await ds?.destroy(); });

  it('규칙의 시작일 앞에 놓인 회차가 없다 — 규칙이 만들 수 없는 행을 넣지 않는다', async () => {
    const [bad] = (await ds.query(
      `SELECT count(*)::int AS n FROM ser_occ o JOIN ser s ON s.id = o.ser_id WHERE s.id = ANY($1) AND o.on_date < s.from_date`, [SEED_SER],
    )) as Array<{ n: number }>;
    expect(bad.n).toBe(0);
    // 지난 회차가 실제로 있어야 이 검사가 뜻이 있다 — 리포트 · 출결 · 이력 시드가 그 위에 선다
    const [past] = (await ds.query(
      `SELECT count(*)::int AS n FROM ser_occ WHERE ser_id = ANY($1) AND on_date < current_date`, [SEED_SER],
    )) as Array<{ n: number }>;
    expect(past.n).toBeGreaterThan(0);
  });

  it('쓰기 경로와 같은 투영으로 다시 펴도 회차 · 리포트 칸 · 리포트 명단이 한 줄도 안 바뀐다', async () => {
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const [{ upto }] = (await qr.query(
        `SELECT to_char(max(on_date),'YYYY-MM-DD') AS upto FROM ser_occ WHERE ser_id = ANY($1)`, [SEED_SER],
      )) as Array<{ upto: string }>;
      const beforeOcc = await occRows(qr, upto);
      const beforeRep = await repRows(qr, upto);
      expect((beforeOcc as unknown[]).length).toBeGreaterThan(0);
      await project(qr, await loadState(qr, SEED_SER), SEED_SER, horizon());
      expect(await occRows(qr, upto)).toEqual(beforeOcc);
      expect(await repRows(qr, upto)).toEqual(beforeRep);
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  });

  it('변경 요청 이력 · 줌 링크 안내 · 리포트가 가리키는 회차는 모두 투영에 있다 — 날짜 셈이 규칙 시작일과 함께 움직였다', async () => {
    const [r] = (await ds.query(`SELECT
        (SELECT count(*)::int FROM chreq c WHERE c.ser_id = ANY($1)
            AND NOT EXISTS (SELECT 1 FROM ser_occ o WHERE o.ser_id = c.ser_id AND o.on_date = c.on_date)) AS chreq,
        (SELECT count(*)::int FROM pnoti p WHERE p.ser_id = ANY($1)
            AND NOT EXISTS (SELECT 1 FROM ser_occ o WHERE o.ser_id = p.ser_id AND o.on_date = p.on_date)) AS pnoti,
        (SELECT count(*)::int FROM rep x WHERE x.ser_id = ANY($1)
            AND NOT EXISTS (SELECT 1 FROM ser_occ o WHERE o.ser_id = x.ser_id AND o.on_date = x.on_date)) AS rep,
        (SELECT count(*)::int FROM chreq c WHERE c.ser_id = ANY($1)) AS chreq_all`, [SEED_SER])) as Array<Record<string, number>>;
    expect(r.chreq_all).toBeGreaterThan(0);
    expect({ chreq: r.chreq, pnoti: r.pnoti, rep: r.rep }).toEqual({ chreq: 0, pnoti: 0, rep: 0 });
  });

  it('줌 계정이 붙은 회차는 정본(zassign)에서 온다 — 온라인 규칙마다 규칙 배정 한 줄 · 현장 회차에는 계정이 없다', async () => {
    const [r] = (await ds.query(`SELECT
        (SELECT count(*)::int FROM ser_occ o
          WHERE o.ser_id = ANY($1) AND o.zacc_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM zassign z WHERE z.ser_id = o.ser_id AND z.zacc_id = o.zacc_id)
            AND NOT EXISTS (SELECT 1 FROM zassign z JOIN exc e ON e.id = z.exc_id
                             WHERE e.ser_id = o.ser_id AND e.on_date = o.on_date AND z.zacc_id = o.zacc_id)) AS orphan,
        (SELECT count(*)::int FROM ser_occ o JOIN ser s ON s.id = o.ser_id
           LEFT JOIN exc e ON e.ser_id = o.ser_id AND e.on_date = o.on_date
          WHERE s.id = ANY($1) AND o.zacc_id IS NOT NULL AND COALESCE(e.mode, s.mode::text) <> 'online') AS offline_zoom,
        (SELECT count(*)::int FROM ser s WHERE s.id = ANY($1) AND s.mode = 'online') AS online,
        (SELECT count(*)::int FROM ser s WHERE s.id = ANY($1) AND s.mode = 'online'
            AND NOT EXISTS (SELECT 1 FROM zassign z WHERE z.ser_id = s.id)) AS online_unassigned`, [SEED_SER])) as Array<Record<string, number>>;
    expect(r.online).toBeGreaterThan(0);
    expect({ orphan: r.orphan, offlineZoom: r.offline_zoom, onlineUnassigned: r.online_unassigned })
      .toEqual({ orphan: 0, offlineZoom: 0, onlineUnassigned: 0 });
  });
});

/**
 * 시드 상수 자체의 무결성 — **DB 없이도 돈다** (C86-g).
 *
 * 이 검사가 생긴 이유: C85-a 가 `rpt_sign_pair` CHECK 를 새겼는데 시드가 `sent_at` 만 넣고
 * `sent_by` 를 안 넣어 **출하 스크립트의 시드 단계가 통째로 멈췄다.** jest·tsc·lint·openapi 는
 * 전부 초록이었다 — **아무 게이트도 시드를 다시 돌리지 않기 때문**이다.
 *
 * DB 제약을 시드 상수에 대고 미리 세는 자리다. 여기서 막히면 출하 전에 안다.
 */
describe('시드 상수 — DB 없이 보는 것', () => {
  it('보고의 서명은 **시각과 사람이 짝**이다 (rpt_sign_pair)', () => {
    for (const r of REPORTS) {
      const v = r as { rptType: string; onDate: string; sentAt?: string; sentBy?: number; reviewedAt?: string; reviewedBy?: number };
      const where = `${v.rptType} ${v.onDate}`;
      expect([where, v.sentAt != null]).toEqual([where, v.sentBy != null]);
      expect([where, v.reviewedAt != null]).toEqual([where, v.reviewedBy != null]);
    }
  });

  it('결재된 보고에는 올린 사람이 먼저 있다 — 아무도 안 올린 것을 결재할 수 없다', () => {
    for (const r of REPORTS) {
      const v = r as { rptType: string; onDate: string; sentBy?: number; reviewedBy?: number };
      if (v.reviewedBy != null) {
        expect([`${v.rptType} ${v.onDate}`, v.sentBy != null]).toEqual([`${v.rptType} ${v.onDate}`, true]);
      }
    }
  });

  /*
   * 줌 링크(PNOTI)는 회차가 있는 날에만 선다 — 전에는 「오늘 ±1일」로 적어 **금요일에 시드할 때만** 맞았다
   * (QA 0926 B3: 토요일 시드에서 준비 화면의 안내 줄이 없는 회차를 가리켜 404). 시드하는 요일이 무엇이든 맞아야 하므로
   * 일주일 일곱 날을 기준일로 바꿔 가며 상수를 다시 읽는다.
   */
  it.each(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'])(
    '기준일 %s 에도 줌 링크(PNOTI) 날짜마다 그 수업의 회차가 있다',
    (today) => {
      const before = process.env.SEED_TODAY;
      process.env.SEED_TODAY = today;
      try {
        jest.isolateModules(() => {
          /* eslint-disable @typescript-eslint/no-require-imports -- 기준일(환경 값)을 바꿔 모듈 상수를 다시 읽는다 */
          const { PNOTIS } = require('../src/seed/outputs') as typeof import('../src/seed/outputs');
          const { expand } = require('../src/seed/schedule') as typeof import('../src/seed/schedule');
          /* eslint-enable @typescript-eslint/no-require-imports */
          const occ = new Set(expand().map((o) => `${o.serId}|${o.onDate}`));
          for (const p of PNOTIS) expect([p.serId, p.onDate, occ.has(`${p.serId}|${p.onDate}`)]).toEqual([p.serId, p.onDate, true]);
          // 보낸 줄은 지난 회차, 안 보낸 줄은 오늘 포함 다음 회차 — 「오늘 20:00 … 줌 링크」가 그날 나간 것으로 읽힌다
          for (const p of PNOTIS) expect(p.sentAt ? p.onDate < today && p.sentAt === p.onDate : p.onDate >= today).toBe(true);
          // 오늘이 토요일(18번 수업 요일)이면 안 보낸 줄이 오늘 회차에 선다 — 수업 상세의 학부모 발송을 오늘 시험할 수 있다
          const saturday = new Date(`${today}T00:00:00Z`).getUTCDay() === 6;
          expect(PNOTIS.filter((p) => !p.sentAt).every((p) => (p.onDate === today) === saturday)).toBe(true);
        });
      } finally {
        if (before === undefined) delete process.env.SEED_TODAY; else process.env.SEED_TODAY = before;
      }
    },
  );

  /*
   * F12 「이월 막힘」 표본(W11) — 결강 한 회차는 **완납 청구서의 달 안**이어야 이월 판정이 선다.
   * 「뒤에서 n번째」로 고르면 월초 시드에서 지난달로 넘어가 표본이 조용히 사라진다 — 월초 · 월말 · 주말 기준일로 상수를 다시 읽는다.
   */
  it.each(['2026-09-27', '2026-10-01', '2026-10-03', '2026-10-31', '2026-11-01', '2027-02-28', '2027-03-01'])(
    '기준일 %s 에도 F12 표본의 결강 회차가 완납 청구서의 달 안에 있다',
    (today) => {
      const before = process.env.SEED_TODAY;
      process.env.SEED_TODAY = today;
      try {
        jest.isolateModules(() => {
          /* eslint-disable @typescript-eslint/no-require-imports -- 기준일(환경 값)을 바꿔 모듈 상수를 다시 읽는다 */
          const sch = require('../src/seed/schedule') as typeof import('../src/seed/schedule');
          const money = require('../src/seed/money') as typeof import('../src/seed/money');
          /* eslint-enable @typescript-eslint/no-require-imports */
          const f12 = money.CARRY_BLOCKED;
          const raw = sch.expand();
          const day = sch.occurrenceInMonth(sch.applyExceptions(raw, sch.resolveExceptions(raw)), f12.serId, f12.month);
          expect([day.slice(0, 7), f12.month]).toEqual([today.slice(0, 7), today.slice(0, 7)]);
          // 그 수업의 명단에 든 학생이고, 그 달 수업료는 완납이다 — 넘길 돈이 서는 조건
          expect(sch.SERS.find((s) => s.id === f12.serId)?.students).toContain(f12.studentId);
          expect(money.INVOICES.find((i) => i.id === f12.paidInvId))
            .toMatchObject({ studentId: f12.studentId, yearMonth: f12.month, invType: 'tuition', state: 'paid' });
          // 받는 달은 바로 다음 달이다 (N-39)
          expect(new Date(`${f12.nextMonth}-01T00:00:00Z`).getTime())
            .toBe(Date.UTC(Number(f12.month.slice(0, 4)), Number(f12.month.slice(5, 7)), 1));
          // 규칙의 시작일(가장 이른 지난 회차 이전 · N-49) 뒤의 회차다
          expect(day >= sch.serFromDate(sch.SERS.find((s) => s.id === f12.serId)!)).toBe(true);
        });
      } finally {
        if (before === undefined) delete process.env.SEED_TODAY; else process.env.SEED_TODAY = before;
      }
    },
  );

  // C94-d 가 `sturate_reason_present` 를 새겼다 — NOT VALID 는 기존 행만 미루고 시드는 언제나 새 INSERT 다 (C86-g 와 같은 자리)
  it('학생별 단가 예외에는 사유가 있다 (sturate_reason_present)', () => {
    for (const r of STURATES) {
      const v = r as { studentId: number; reason?: string };
      expect([v.studentId, (v.reason ?? '').trim() !== '']).toEqual([v.studentId, true]);
    }
  });

  /*
   * §38-8 강사 요청 칩 (wave 6) — 시드의 교재 변경 요청은 학생 칸 없이 payload.studentName 으로만 학생을 가리킨다.
   * 트래킹 보드는 그 이름이 **시드 학생 중 정확히 하나**일 때만 그 학생 줄에 「강사 요청」 칩을 세운다(동명이인은 오귀속하지 않는다).
   * 원문 컷의 표본 이름(강라율·고은성)은 시드 학생이 아니라서 칩이 한 번도 서지 않았다.
   */
  it('교재 변경 요청(§38-8)의 학생 이름은 시드 학생 중 정확히 하나를 가리킨다', () => {
    const names = STUDENTS.map((s) => s.name as string);
    const bookChanges = REQS.filter((r) => r.reqType === 'book_change');
    expect(bookChanges.length).toBeGreaterThan(0);
    for (const r of bookChanges) {
      const name = (r.payload as { studentName?: string }).studentName ?? '';
      expect([name, names.filter((n) => n === name).length]).toEqual([name, 1]);
    }
  });
});

/**
 * §38-8 — 시드가 든 DB 에서 트래킹 보드(BooksService.tracking · 화면이 받는 그 응답)가 실제로 칩을 세우는가.
 * 판정(요청 → 학생)은 서비스 한 곳이고 여기서는 결과만 본다. DATABASE_URL 이 없으면 건너뛴다.
 */
d('시드 — §38-8 트래킹 보드 강사 요청 칩', () => {
  let ds: DataSource;
  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url: URL, ssl: false, logging: false });
    await ds.initialize();
  });
  afterAll(async () => { await ds?.destroy(); });

  it('시드의 교재 변경 요청마다 그 학생 줄에 「강사 요청」 칩이 선다', async () => {
    const tracking = await new BooksService(ds.getRepository(Lead)).tracking();
    const names = REQS.filter((r) => r.reqType === 'book_change' && r.state === 'pending')
      .map((r) => (r.payload as { studentName?: string }).studentName);
    expect(names.length).toBeGreaterThan(0);
    // 머리 띠의 요청은 전부 실제 학생에 붙는다 — 어느 학생에도 안 붙은 요청(studentId null)이 없다
    expect(tracking.teacherRequests.filter((request) => request.studentId === null)).toEqual([]);
    for (const name of names) {
      const row = tracking.students.find((student) => student.name === name);
      expect([name, row?.todos.find((todo) => todo.key === 'teacher_request')?.label]).toEqual([name, '강사 요청']);
    }
    // 머리 칸 「강사 요청 N」과 칩을 단 학생 수가 같은 말을 한다
    const head = tracking.states.find((state) => state.key === 'teacher_request')?.count;
    const chips = tracking.students.reduce((sum, student) =>
      sum + (student.todos.find((todo) => todo.key === 'teacher_request')?.count ?? 0), 0);
    expect(chips).toBe(head);
  });
});

/**
 * F12 (W11) — §54 「이월 막힘」 칩이 시드에서 **실제로 선다**. 전에는 막힌 줄이 없어 칩은 「0 = 0」으로만 확인됐다(QA F12).
 * 판정은 서버 한 곳(`tuition()` 의 `carryBlockedReason` · `carryTuition` 의 409)이고 여기서는 결과만 본다.
 * 쓰기 쪽은 거절로 끝나 트랜잭션이 되돌아간다 — 개발 DB 에 이월 줄이 생기지 않는다.
 */
d('시드 — F12 「이월 막힘」 표본', () => {
  let ds: DataSource;
  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url: URL, ssl: false, logging: false });
    await ds.initialize();
  });
  afterAll(async () => { await ds?.destroy(); });

  it('이번 달 수업료 탭에 서버가 막은 이월 줄이 선다 — 완납 · 넘길 돈 있음 · 받는 달 청구서가 이미 있음', async () => {
    const svc = new AccountingService(ds.getRepository(Inv));
    const tuition = await svc.tuition(CARRY_BLOCKED.month, true);
    const row = tuition.items.find((item) => item.studentId === CARRY_BLOCKED.studentId);
    expect(row).toMatchObject({ carryable: false, carriedAt: null });
    expect(row?.carryAmount ?? 0).toBeGreaterThan(0);
    // 까닭은 받는 달 청구서다 — 서버 문장에 그 달이 적힌다(화면은 이 문장을 그대로 둔다)
    expect(row?.carryBlockedReason).toEqual(expect.stringContaining(`(${CARRY_BLOCKED.nextMonth})`));
    expect(tuition.items.filter((item) => item.carryBlockedReason).length).toBeGreaterThan(0);
  });

  it('같은 줄의 이월 쓰기는 같은 까닭으로 409 — 단추와 쓰기가 같은 판정이다', async () => {
    const svc = new AccountingService(ds.getRepository(Inv));
    await expect(svc.carryTuition(2, { studentId: CARRY_BLOCKED.studentId, month: CARRY_BLOCKED.month }))
      .rejects.toMatchObject({ status: 409, response: { code: 'CARRY_NEXT_ISSUED' } });
    const [{ n }] = (await ds.query(`SELECT count(*)::int AS n FROM carry WHERE student_id = $1`, [CARRY_BLOCKED.studentId])) as Array<{ n: number }>;
    expect(n).toBe(0);
  });
});
