/** @file-guide
 * 목적: ops-create-c96.spec.ts — 회의 잡기 · 기획 올리기 · 기간/갈래 질의 (N-46 ②③ · J-102)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * C96 — **운영에 만드는 길**과 **기간·갈래로 좁히는 길**.
 *
 *   회의를 잡으면 **시간표에 회차가 생긴다** — 그래야 시각·자리가 한 곳에서 나오고
 *   겹침을 `ser_occ` 의 EXCLUDE 가 막는다. 여기서 보는 것은 그 두 가지다:
 *   ① 회의·회차·참석이 **한 트랜잭션**이다(겹치면 회의 기록도 안 생긴다)
 *   ② 기간·갈래가 목록을 자르고 **건수는 서버가 센다**(0건 갈래도 줄이 선다)
 *
 * ⚠ 이 파일은 제 픽스처만 만들고 지운다. 스크래치 DB(`*_test`)에서만 돈다 (test/db.ts).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DEV_URL } from './db';
import { opsRangeLabel } from '../src/modules/ops/ops.service';
import { MT_TYPE_SUB, MT_TYPES } from '../src/lib/meeting-words';
import { CPL_AREAS } from '../src/lib/complaint-words';
import { PLAN_STAGES } from '../src/lib/plan-words';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(60_000);

/* ── 낱말은 DB 없이도 본다 ─────────────────────────────────────────── */

describe('기간의 낱말 — 화면이 만들지 않는다 (C96 · D-R18)', () => {
  it('전체 · 하루 · 한 달 · 그 밖의 구간을 각각 부른다', () => {
    expect(opsRangeLabel()).toBe('전체');
    expect(opsRangeLabel('2026-09-19', '2026-09-19')).toBe('2026-09-19');
    // 1일 ~ 말일이면 「2026년 9월」이라 부르는 편이 읽기 쉽다
    expect(opsRangeLabel('2026-09-01', '2026-09-30')).toBe('2026년 9월');
    expect(opsRangeLabel('2026-02-01', '2026-02-28')).toBe('2026년 2월');
    expect(opsRangeLabel('2026-09-14', '2026-09-20')).toBe('2026-09-14 ~ 2026-09-20');
    expect(opsRangeLabel('2026-09-14', undefined)).toBe('2026-09-14 부터');
  });
});

describe('회의 종류와 과목 키를 잇는 표 (C96)', () => {
  it('다섯 갈래가 하나도 빠짐없이 과목 키를 갖는다', () => {
    // 주석만 「같은 다섯을 두 표가 각자 부른다」고 적어 두고 잇는 표가 없었다
    expect(MT_TYPES.map((t) => MT_TYPE_SUB[t])).toEqual(['mt-pl', 'mt-cs', 'mt-mk', 'mt-dv', 'mt-pg']);
  });
});

d('C96 — 회의 잡기 · 기획 올리기 · 기간/갈래 (N-46 ②③ · J-102)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token = '';
  let teacherToken = '';
  const PW = 'c96-ops-1234';
  const CEO = 1961;
  const TEACHER = 1962;
  // 강의실·줌 계정 id 는 **양수**다 — DTO 가 `@Min(1)` 로 막는다 (음수 id 픽스처를 쓰는 다른 스위트는
  // DB 에 바로 넣지만 여기서는 그 id 가 HTTP 본문으로 들어간다)
  const ROOM = 1961;
  const ZACC = 1961;

  /** 스위트가 시작할 때의 `mtrec` 최대 id — 이보다 큰 줄만 우리가 만든 것이다 */
  let mtBase = 0;

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    ds.query(sql, p) as Promise<T[]>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);

    const hash = await bcrypt.hash(PW, 4);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER]]);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'C96대표','c96-ceo@t.kr','ceo',$3,true),
         ($2,'C96강사','c96-t@t.kr','teacher',$3,true)`,
      [CEO, TEACHER, hash],
    );
    // 회의 종류는 시드에 있어야 한다 — 스위트가 제 강의실·줌 계정을 만든다 (C74 의 교훈)
    await q(`DELETE FROM room WHERE id = $1`, [ROOM]);
    await q(`INSERT INTO room (id, branch, name, capacity) VALUES ($1,'본원','C96 회의실',10)`, [ROOM]);
    await q(`DELETE FROM zacc WHERE id = $1`, [ZACC]);
    await q(
      `INSERT INTO zacc (id, label, login_email, login_secret, join_url, meeting_id, meeting_pw_enc, active)
       VALUES ($1,'C96 Zoom','c96-zoom@t.kr','\\x00','https://z.example/c96','999','\\x00',true)`, [ZACC],
    );
    for (const key of MT_TYPES) {
      await q(
        `INSERT INTO sub (key, name, color) VALUES ($1,$2,'#334455') ON CONFLICT (key) DO NOTHING`,
        [MT_TYPE_SUB[key], `C96 ${key}`],
      );
    }
    await q(
      `INSERT INTO kind (key, name, color, cap, grp, rep, extra) VALUES ('meeting','회의','#856C4A',10,'meeting',false,false)
       ON CONFLICT (key) DO NOTHING`,
    );

    [{ max: mtBase }] = await q<{ max: number }>(`SELECT COALESCE(max(id), 0)::int AS max FROM mtrec`);

    const res = await request(app.getHttpServer())
      .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
      .send({ email: 'c96-ceo@t.kr', password: PW }).expect(201);
    token = res.body.accessToken as string;
    const t = await request(app.getHttpServer())
      .post('/auth/login').timeout({ response: 5000, deadline: 10000 })
      .send({ email: 'c96-t@t.kr', password: PW }).expect(201);
    teacherToken = t.body.accessToken as string;
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await cleanup();
        await q(`DELETE FROM noti WHERE from_id = ANY($1) OR to_id = ANY($1)`, [[CEO, TEACHER]]);
        await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [[CEO, TEACHER]]);
        await q(`DELETE FROM zacc WHERE id = $1`, [ZACC]);
        await q(`DELETE FROM room WHERE id = $1`, [ROOM]);
        await q(`DELETE FROM staff WHERE id = ANY($1)`, [[CEO, TEACHER]]);
      }
    } finally {
      await app?.close();
    }
  });

  async function cleanup() {
    const mtIds = (await q<{ id: string }>(`SELECT id FROM mtrec WHERE id > $1`, [mtBase]))
      .map((r) => Number(r.id));
    const serIds = (await q<{ id: string }>(`SELECT id FROM ser WHERE kind_key = 'meeting' AND teacher_id = ANY($1)`, [[CEO, TEACHER]]))
      .map((r) => Number(r.id));
    if (mtIds.length) {
      await q(`DELETE FROM mtattd WHERE mt_id = ANY($1)`, [mtIds]);
      await q(`DELETE FROM mtrec WHERE id = ANY($1)`, [mtIds]);
    }
    if (serIds.length) {
      await q(`DELETE FROM zassign WHERE ser_id = ANY($1)`, [serIds]);
      await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [serIds]);
      await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [serIds]);
      await q(`DELETE FROM ser WHERE id = ANY($1)`, [serIds]);
    }
    await q(`DELETE FROM plan WHERE owner_id = ANY($1)`, [[CEO, TEACHER]]);
    await q(`DELETE FROM zlog WHERE actor_id = ANY($1)`, [[CEO, TEACHER]]);
  }
  afterEach(cleanup);

  const api = (m: 'post' | 'patch' | 'get', p: string, who = token) =>
    request(app.getHttpServer())[m](p).set('Authorization', `Bearer ${who}`)
      .timeout({ response: 5000, deadline: 10000 });

  const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const plus = (iso: string, n: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const DAY = () => plus(kst(), 12);

  const meeting = (over: Record<string, unknown> = {}) => ({
    mtType: 'plan', title: 'C96 회의', onDate: DAY(),
    startMin: 1290, endMin: 1350, mode: 'offline', roomId: ROOM, ...over,
  });

  /* ── 「+ 회의 잡기」 ─────────────────────────────────────────────── */

  it('회의를 잡으면 시간표에 회차가 생기고 회의 기록이 그 회차에 걸린다', async () => {
    const res = await api('post', '/ops/meetings').send(meeting({ attendeeIds: [TEACHER] })).expect(201);
    const { meeting: m, attendees } = res.body;
    expect(m.serId).toBeGreaterThan(0);
    // 컷 §63 의 「11:00–12:00」과 「1호」 — 둘 다 시간표에서 온다
    expect(m.startMin).toBe(1290);
    expect(m.endMin).toBe(1350);
    expect(m.placeLabel).toBe('C96 회의실');
    // 주관자도 참석자다 — 빠지면 「대기 N」의 분모가 사람마다 달라진다
    expect(attendees).toBe(2);
    expect(m.waiting).toBe(2);
    expect(m.confirmed).toBe(0);

    const ser = await q<{ kind_key: string; sub_key: string; rrule: string }>(
      `SELECT kind_key, sub_key, rrule FROM ser WHERE id = $1`, [m.serId],
    );
    expect(ser).toEqual([{ kind_key: 'meeting', sub_key: MT_TYPE_SUB.plan, rrule: 'ONCE' }]);
    // 회차가 실제로 투영됐다 — 그래야 겹침 판정 안에 든다
    expect(Number((await q<{ c: string }>(`SELECT count(*)::text AS c FROM ser_occ WHERE ser_id = $1`, [m.serId]))[0].c)).toBe(1);
  });

  it('같은 시간 같은 강의실이면 409 이고 회의 기록도 안 생긴다 — 한 트랜잭션이다', async () => {
    await api('post', '/ops/meetings').send(meeting()).expect(201);
    const before = Number((await q<{ c: string }>(`SELECT count(*)::text AS c FROM mtrec`))[0].c);

    const bad = await api('post', '/ops/meetings').send(meeting({ mtType: 'general' })).expect(409);
    expect(bad.body.code).toBe('RESOURCE_CONFLICT');
    expect(Number((await q<{ c: string }>(`SELECT count(*)::text AS c FROM mtrec`))[0].c)).toBe(before);
  });

  it('온라인 회의의 줌 계정도 겹치면 막힌다 — 배정이 다시 투영하기 때문이다', async () => {
    await api('post', '/ops/meetings')
      .send(meeting({ mode: 'online', roomId: null, zaccId: ZACC })).expect(201);
    const [row] = await q<{ zacc_id: string; place: string }>(
      `SELECT za.zacc_id::text FROM zassign za JOIN mtrec m ON m.ser_id = za.ser_id`,
    );
    expect(Number(row.zacc_id)).toBe(ZACC);

    // 다른 주관자·다른 시각이면 통과해야 하므로, 같은 계정·같은 시각으로만 부딪힌다
    const clash = await api('post', '/ops/meetings')
      .send(meeting({ mtType: 'dev', mode: 'online', roomId: null, zaccId: ZACC, ownerId: TEACHER })).expect(409);
    expect(clash.body.code).toBe('RESOURCE_CONFLICT');
  });

  it('자리를 두 번 고르거나 시각이 뒤집히면 거절한다', async () => {
    expect((await api('post', '/ops/meetings').send(meeting({ mode: 'online', zaccId: ZACC })).expect(409)).body.code)
      .toBe('MEETING_PLACE');
    expect((await api('post', '/ops/meetings').send(meeting({ endMin: 1290 })).expect(409)).body.code)
      .toBe('BAD_RANGE');
    await api('post', '/ops/meetings').send(meeting({ onDate: '2026-02-30' })).expect(400);
    await api('post', '/ops/meetings', teacherToken).send(meeting()).expect(403);
  });

  /* ── 「+ 기획 올리기」 ───────────────────────────────────────────── */

  it('기획은 언제나 첫 단계로 올라가고 기한은 제안일 뿐이다', async () => {
    const res = await api('post', '/ops/plans')
      .send({ title: 'C96 기획', goal: '목표', ask: '요청', dueOn: plus(kst(), 20), stage: 'done' })
      .expect(201);
    // `stage` 를 보내도 무시한다 — 단계를 옮기는 길은 §61 보드와 결재다
    expect(res.body.plan.stage).toBe(PLAN_STAGES[0]);
    const [row] = await q<{ stage: string; due_approved_at: string | null }>(
      `SELECT stage, due_approved_at FROM plan WHERE id = $1`, [res.body.plan.id],
    );
    expect(row.stage).toBe(PLAN_STAGES[0]);
    // 기한 승인 도장은 비어 있다 — 대표가 승인해야 최종 승인이 열린다 (C56)
    expect(row.due_approved_at).toBeNull();
    await api('post', '/ops/plans', teacherToken).send({ title: 'x' }).expect(403);
  });

  /* ── 기간 · 갈래 (N-46 ② · J-102) ───────────────────────────────── */

  it('기간이 목록을 자르고 갈래가 컴플레인을 좁힌다 — 건수는 서버가 센다', async () => {
    const day = DAY();
    await api('post', '/ops/meetings').send(meeting({ onDate: day })).expect(201);

    const all = await api('get', '/ops').expect(200);
    expect(all.body.range).toEqual({ from: null, to: null, label: '전체' });
    // 0건 갈래도 줄이 선다 — 어휘이지 데이터가 아니다 (C66)
    expect(all.body.areaCounts.map((a: { key: string }) => a.key)).toEqual([...CPL_AREAS]);
    expect(all.body.mtTypeCounts).toHaveLength(MT_TYPES.length);

    const narrow = await api('get', `/ops?from=${day}&to=${day}`).expect(200);
    expect(narrow.body.range.label).toBe(day);
    expect(narrow.body.meetings.every((m: { onDate: string | null }) => m.onDate === null || m.onDate === day)).toBe(true);
    // 그날의 회의 하나가 종류 칩에도 세어진다
    expect(narrow.body.mtTypeCounts.find((c: { key: string }) => c.key === 'plan').count).toBe(1);

    // J-102 — 지난달 컴플레인만
    const lastMonth = await api('get', '/ops?from=2026-08-01&to=2026-08-31').expect(200);
    expect(lastMonth.body.range.label).toBe('2026년 8월');
    const sum = lastMonth.body.areaCounts.reduce((n: number, a: { count: number }) => n + a.count, 0);
    // 칩 합계 = 그 기간의 컴플레인 수 (필터 없는 건수다 — 고른 뒤에도 다른 갈래가 보여야 한다)
    expect(sum).toBe(lastMonth.body.complaints.length);

    const byArea = await api('get', `/ops?area=${CPL_AREAS[0]}`).expect(200);
    expect(byArea.body.complaints.every((c: { area: string }) => c.area === CPL_AREAS[0])).toBe(true);
    // 갈래를 골라도 칩 건수는 전체를 센다
    expect(byArea.body.areaCounts.reduce((n: number, a: { count: number }) => n + a.count, 0))
      .toBe(all.body.complaints.length);
  });

  it('날짜가 없는 줄은 기간으로 가르지 않는다 — 없는 날짜를 범위 밖이라 할 수 없다', async () => {
    // 단계는 이 시험의 관심사가 아니다 — 제품이 실제로 쓰는 첫 칸을 쓴다.
    // 전에는 'idea' 라는, 어디에도 없는 낱말이었다 (S6 의 plan_stage_words CHECK 가 잡았다).
    const [plan] = (await q<{ id: string }>(
      `INSERT INTO plan (title, stage, owner_id) VALUES ('C96 기한없음','draft',$1) RETURNING id`, [CEO],
    ));
    const res = await api('get', '/ops?from=2026-01-01&to=2026-01-31').expect(200);
    expect(res.body.plans.some((p: { id: number }) => p.id === Number(plan.id))).toBe(true);
  });

  it('끝 날짜가 시작보다 앞서면 거절하고 잘못된 갈래도 거절한다', async () => {
    expect((await api('get', '/ops?from=2026-09-20&to=2026-09-01').expect(409)).body.code).toBe('BAD_RANGE');
    await api('get', '/ops?from=2026-09-32').expect(400);
    await api('get', '/ops?area=없는갈래').expect(400);
  });
});
