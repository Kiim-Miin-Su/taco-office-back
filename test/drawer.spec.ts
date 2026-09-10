/** @file-guide
 * 목적: drawer.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 탭 02 우측 서랍 — §14~§21.
 *
 * 여기서 확인하는 것은 넷이다.
 *   ① **한 번 부르면 여덟 칸이 다 온다** — 칸마다 왕복하지 않는다
 *   ② D-R34 · 승인자에게는 **전건이 뜬다** — 자동 승인도 조건부 통과도 없다
 *   ③ D-R39 · 강사에게는 남의 결재가 **목록에서 빠진다** (감추는 게 아니라 없다)
 *   ④ 줌 계정에 **로그인 정보가 섞여 내려오지 않는다** (erd V9)
 *
 * DATABASE_URL 이 없으면 건너뛴다.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { isKnownApWord } from '../src/lib/approval';
import { todayKst } from '../src/lib/kst';
import { DrawerController } from '../src/modules/drawer/drawer.controller';
import type { DrawerService } from '../src/modules/drawer/drawer.service';
import type { ScheduleService } from '../src/modules/schedule/schedule.service';
import type { ChangeReqCreateDto } from '../src/modules/drawer/drawer.dto';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(40_000);

describe('변경 요청 회차 소유권 — DB 독립', () => {
  const viewer = { id: 921, name: '강사', role: 'teacher' };
  const base = { startMin: 540, endMin: 600, teacherId: viewer.id, roomId: null, zaccId: null };
  const occurrence = { serId: 100, onDate: '2026-09-07' };
  const commands: ChangeReqCreateDto[] = [
    { ...occurrence, reqType: 'cancel', reason: '휴강 요청' },
    { ...occurrence, reqType: 'time_move', startMin: 600, endMin: 660, reason: '시간 변경' },
    { ...occurrence, reqType: 'teacher', teacherId: 922, reason: '강사 변경' },
  ];

  function setup(teacherId: number | null = viewer.id) {
    const svc = {
      occOf: jest.fn().mockResolvedValue({ ...base, teacherId }),
      activeChangeTargetExists: jest.fn().mockResolvedValue(true),
      createChangeReq: jest.fn().mockResolvedValue(200),
    };
    const sched = { conflicts: jest.fn().mockResolvedValue([]) };
    const controller = new DrawerController(
      svc as unknown as DrawerService,
      sched as unknown as ScheduleService,
    );
    return { controller, svc, sched };
  }

  it.each(commands)('타인 회차 $reqType 요청은 자원·충돌 정보 조회와 저장 전에 거절한다', async (command) => {
    const { controller, svc, sched } = setup(999);
    await expect(controller.createChangeReq(viewer, command)).rejects.toMatchObject({
      response: { code: 'OCCURRENCE_NOT_FOUND' },
    });
    expect(svc.activeChangeTargetExists).not.toHaveBeenCalled();
    expect(sched.conflicts).not.toHaveBeenCalled();
    expect(svc.createChangeReq).not.toHaveBeenCalled();
  });

  it.each(commands)('본인 회차 $reqType 요청은 기존 경로로 저장한다', async (command) => {
    const { controller, svc } = setup();
    await expect(controller.createChangeReq(viewer, command)).resolves.toEqual({ id: 200, conflicts: [] });
    expect(svc.createChangeReq).toHaveBeenCalledWith(viewer.id, expect.objectContaining(occurrence));
  });

  it.each(['manager', 'admin', 'ceo'])('%s는 다른 강사의 회차도 요청할 수 있다', async (role) => {
    const { controller, svc } = setup(999);
    await expect(controller.createChangeReq({ ...viewer, role }, commands[0])).resolves.toEqual({
      id: 200, conflicts: [],
    });
    expect(svc.createChangeReq).toHaveBeenCalledTimes(1);
  });

  it('강사 미지정 회차는 강사의 본인 회차가 아니다', async () => {
    const { controller, svc } = setup(null);
    await expect(controller.createChangeReq(viewer, commands[0])).rejects.toMatchObject({
      response: { code: 'OCCURRENCE_NOT_FOUND' },
    });
    expect(svc.createChangeReq).not.toHaveBeenCalled();
  });

  it('승인 예외 권한은 다른 강사 회차의 변경 요청 권한이 아니다', async () => {
    const { controller, svc } = setup(999);
    await expect(controller.createChangeReq({ ...viewer, perms: { canApprove: true } }, commands[0]))
      .rejects.toMatchObject({ response: { code: 'OCCURRENCE_NOT_FOUND' } });
    expect(svc.createChangeReq).not.toHaveBeenCalled();
  });
});

d('우측 서랍 — §14~§21', () => {
  let app: INestApplication;
  let ds: DataSource;
  const PW = 'drawer-test-1234';
  const T = 921, M = 922;
  const PEOPLE = [
    { id: T, name: '강사서랍', email: 'dw-teacher@t.kr', role: 'teacher' },
    { id: M, name: '매니저서랍', email: 'dw-manager@t.kr', role: 'manager' },
  ];
  const REQ_IDS: number[] = [];
  let ownSerId: number | undefined;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    ds = app.get(DataSource);

    const hash = await bcrypt.hash(PW, 4);
    await ds.query('DELETE FROM staff WHERE id IN (921, 922)');
    for (const p of PEOPLE) {
      await ds.query(
        `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES ($1,$2,$3,$4,$5,true)`,
        [p.id, p.name, p.email, p.role, hash],
      );
    }
    // 본인 회차 성공 검증은 남의 시드 일정을 빌리지 않고 이 강사 전용 원장으로 한다.
    const onDate = todayKst();
    const [series] = await ds.query(
      `INSERT INTO ser (kind_key, teacher_id, mode, start_min, end_min, rrule, from_date, to_date, title)
       VALUES ('class', $1, 'offline', 540, 600, 'ONCE', $2, $2, '서랍 권한 검증') RETURNING id`,
      [T, onDate],
    );
    ownSerId = Number(series.id);
    await ds.query(
      `INSERT INTO ser_occ (ser_id, on_date, teacher_id, span)
       VALUES ($1, $2, $3, tstzrange($4::timestamptz, $5::timestamptz, '[)'))`,
      [ownSerId, onDate, T, `${onDate}T09:00:00+09:00`, `${onDate}T10:00:00+09:00`],
    );

    // 강사가 올린 요청 3건 — **하나도 빠지지 않고** 대기함에 떠야 한다
    for (const n of [1, 2, 3]) {
      const r = await ds.query(
        `INSERT INTO req (req_type, staff_id, state, payload)
         VALUES ('doc', $1, 'open', $2::jsonb) RETURNING id`,
        [T, JSON.stringify({ note: `서랍 테스트 ${n}` })],
      );
      REQ_IDS.push(Number(r[0].id));
    }
    // 강사에게 온 할 일 · 알림 하나씩
    await ds.query(
      `INSERT INTO todo (id, title, from_id, to_id, done, src) VALUES (9210, '서랍 할 일', $1, $2, false, 'manual')`,
      [M, T],
    );
    await ds.query(
      `INSERT INTO noti (id, to_id, from_id, body, link) VALUES (9211, $1, $2, '서랍 알림', '/reports/unwritten')`,
      [T, M],
    );
  });

  afterAll(async () => {
    await ds?.query('DELETE FROM noti WHERE id = 9211');
    await ds?.query('DELETE FROM todo WHERE id = 9210');
    if (REQ_IDS.length) await ds?.query('DELETE FROM req WHERE id = ANY($1)', [REQ_IDS]);
    await ds?.query('DELETE FROM chreq WHERE by_id IN (921, 922)');
    if (ownSerId !== undefined) {
      await ds?.query('DELETE FROM ser_occ WHERE ser_id = $1', [ownSerId]);
      await ds?.query('DELETE FROM ser WHERE id = $1', [ownSerId]);
    }
    await ds?.query('DELETE FROM staff WHERE id IN (921, 922)');
    await app?.close();
  });

  const tokens = new Map<string, string>();
  beforeAll(async () => {
    for (const p of PEOPLE) {
      const res = await request(app.getHttpServer())
        .post('/auth/login').send({ email: p.email, password: PW }).expect(201);
      tokens.set(p.email, res.body.accessToken as string);
    }
  });
  const TEACHER = 'dw-teacher@t.kr';
  const MANAGER = 'dw-manager@t.kr';
  const auth = (email: string) => `Bearer ${tokens.get(email)!}`;
  // 간헐 404가 재발하면 단순 상태 숫자뿐 아니라 라우팅/업무 오류를 구분할 근거를 남긴다.
  // 토큰·전체 응답·개인정보는 출력하지 않으며 실패를 재시도/무시하지 않는다.
  const get = (path: string, email: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', auth(email))
      .expect(res => {
        expect({ path, status: res.status, code: res.body.code, message: res.body.message })
          .toMatchObject({ path, status: 200 });
      });
  const firstOccurrence = async () => {
    const [row] = await ds.query(
      `SELECT ser_id, to_char(on_date, 'YYYY-MM-DD') AS on_date
         FROM ser_occ WHERE ser_id = $1 AND teacher_id = $2 ORDER BY on_date LIMIT 1`,
      [ownSerId, T],
    );
    return { serId: Number(row.ser_id), onDate: String(row.on_date) };
  };

  /* ── ① 한 번에 여덟 칸 ─────────────────────────────────────────── */

  it('여덟 칸이 한 응답에 다 온다', async () => {
    const r = await get('/drawer', MANAGER).expect(200);
    ['approvals', 'todos', 'notis', 'members', 'tzGroups', 'kinds', 'changeReqs', 'zoomAccounts']
      .forEach((k) => expect(r.body).toHaveProperty(k));
    expect(r.body.tz).toBe('Asia/Seoul');            // 관리자 화면은 KST 고정 (D-R12)
    expect(r.body.members.length).toBeGreaterThan(0);
    expect(r.body.kinds.length).toBeGreaterThan(0);
  });

  it('D-R12 · 내려가는 시각은 전부 KST 오프셋을 달고 온다', async () => {
    const r = await get('/drawer', MANAGER).expect(200);
    const ats = [
      ...r.body.approvals.back, ...r.body.approvals.waiting, ...r.body.approvals.mine,
    ].map((a: { at: string }) => a.at)
      .concat(r.body.notis.map((n: { at: string }) => n.at))
      .concat(r.body.changeReqs.map((c: { at: string }) => c.at));
    expect(ats.length).toBeGreaterThan(0);
    // 컨테이너가 UTC 면 예전 식은 '+00' 을 붙여 아홉 시간 어긋난 시각을 보냈다
    ats.forEach((at) => expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/));
  });

  it('D-R6 · rep=true 인 종류만 리포트 대상으로 표시된다', async () => {
    const r = await get('/drawer', MANAGER).expect(200);
    expect(r.body.kinds.some((k: { rep: boolean }) => k.rep === true)).toBe(true);
    r.body.kinds.forEach((k: { rep: unknown; grp: string }) => {
      expect(typeof k.rep).toBe('boolean');
      expect(['lesson', 'intake', 'meeting']).toContain(k.grp);
    });
  });

  /* ── ② D-R34 전건 ──────────────────────────────────────────────── */

  it('D-R34 · 강사가 올린 3건이 승인자 대기함에 하나도 빠지지 않고 뜬다', async () => {
    const r = await get('/drawer', MANAGER).expect(200);
    const ids = r.body.approvals.waiting
      .filter((a: { kind: string }) => a.kind === 'req')
      .map((a: { id: number }) => a.id);
    REQ_IDS.forEach((id) => expect(ids).toContain(id));
  });

  it('D-R34 · 제출된 강사 리포트(REP)도 승인자 대기함에 전건 뜬다', async () => {
    const expected = await ds.query(`SELECT id FROM rep WHERE state='wait'`);
    const r = await get('/drawer', MANAGER).expect(200);
    const ids = r.body.approvals.waiting
      .filter((a: { kind: string }) => a.kind === 'rep')
      .map((a: { id: number }) => a.id);
    expected.forEach((row: { id: string }) => expect(ids).toContain(Number(row.id)));
  });

  it('배지 숫자는 되돌아온 것 + 기다리는 것과 정확히 같다', async () => {
    const { approvals: a } = (await get('/drawer', MANAGER).expect(200)).body;
    expect(a.count).toBe(a.back.length + a.waiting.length);
  });

  it('다섯 갈래가 전부 온다 — 빠진 갈래가 없다 (D-R26)', async () => {
    const r = await get('/drawer', MANAGER).expect(200);
    expect(r.body.approvals.missingKinds).toEqual([]);
    const kinds = new Set([
      ...r.body.approvals.back, ...r.body.approvals.waiting, ...r.body.approvals.mine,
    ].map((a: { kind: string }) => a.kind));
    // 시드가 다섯 갈래를 모두 만든다 — 하나라도 비면 그 갈래가 안 읽히고 있는 것이다
    ['rpt', 'plan', 'req', 'chreq', 'gpapack'].forEach((k) => expect([...kinds]).toContain(k));
  });

  /* ── ③ D-R39 — 감추는 게 아니라 없다 ───────────────────────────── */

  it('강사에게는 남의 결재가 목록에서 빠진다 — 「있다」는 사실도 안 흘린다', async () => {
    const r = await get('/drawer', TEACHER).expect(200);
    expect(r.body.approvals.waiting).toHaveLength(0);
    // 자기가 올린 3건은 「내가 올린 것」으로 보인다
    const mine = r.body.approvals.mine.map((a: { id: number }) => a.id);
    REQ_IDS.forEach((id) => expect(mine).toContain(id));
    r.body.approvals.back.forEach((a: { byId: number }) => expect(a.byId).toBe(T));
  });

  it('강사의 할 일·알림은 자기 것만 온다', async () => {
    const r = await get('/drawer', TEACHER).expect(200);
    r.body.todos.forEach((t: { fromId: number; toId: number }) =>
      expect([t.fromId, t.toId]).toContain(T));
    r.body.notis.forEach((n: { toId: number }) => expect(n.toId).toBe(T));
  });

  it('알림 색은 링크에서 파생되어 늘 셋 중 하나다', async () => {
    const r = await get('/drawer', TEACHER).expect(200);
    r.body.notis.forEach((n: { tone: string }) =>
      expect(['alarm', 'ok', 'warn']).toContain(n.tone));
    expect(r.body.notis.find((n: { id: number }) => n.id === 9211).tone).toBe('warn');
  });

  /* ── ④ 줌 — 로그인 정보가 안 섞인다 ────────────────────────────── */

  it('줌 계정에 로그인 정보가 없다 (erd V9)', async () => {
    const r = await get('/drawer', MANAGER).expect(200);
    r.body.zoomAccounts.forEach((z: Record<string, unknown>) => {
      expect(z).not.toHaveProperty('loginSecret');
      expect(z).not.toHaveProperty('meetingPwEnc');
      expect(typeof z.overlaps).toBe('number');
    });
    expect(JSON.stringify(r.body)).not.toMatch(/login_secret|meeting_pw_enc/);
  });

  /* ── 쓰기 셋 ───────────────────────────────────────────────────── */

  it('§15 내 할 일은 체크된다', async () => {
    await request(app.getHttpServer())
      .patch('/drawer/todos/9210').set('Authorization', auth(TEACHER))
      .send({ done: true }).expect(200);
    const r = await get('/drawer', TEACHER).expect(200);
    expect(r.body.todos.find((t: { id: number }) => t.id === 9210).done).toBe(true);
  });

  it('§16 알림은 읽음이 된다', async () => {
    await request(app.getHttpServer())
      .patch('/drawer/notis/9211/read').set('Authorization', auth(TEACHER))
      .expect(200);
    const r = await get('/drawer', TEACHER).expect(200);
    expect(r.body.notis.find((n: { id: number }) => n.id === 9211).read).toBe(true);
  });

  it('§19 사유 없는 변경 요청은 받지 않는다', async () => {
    const occurrence = await firstOccurrence();
    await request(app.getHttpServer())
      .post('/drawer/change-requests').set('Authorization', auth(TEACHER))
      .send({ ...occurrence, reqType: 'cancel', reason: '   ' }).expect(400);
  });

  it.each([
    { reqType: 'cancel', reason: '타인 휴강 요청' },
    { reqType: 'time_move', startMin: 600, endMin: 660, reason: '타인 시간 변경' },
  ])('§19 강사의 타인 회차 $reqType 요청은 404이고 원장이 늘지 않는다', async (payload) => {
    const [other] = await ds.query(
      `SELECT ser_id, to_char(on_date, 'YYYY-MM-DD') AS on_date FROM ser_occ
        WHERE teacher_id IS NOT NULL AND teacher_id <> $1 AND NOT canceled
        ORDER BY on_date, ser_id LIMIT 1`,
      [T],
    );
    expect(other).toBeDefined();
    const [{ count: before }] = await ds.query('SELECT count(*)::int AS count FROM chreq WHERE by_id = $1', [T]);
    const res = await request(app.getHttpServer())
      .post('/drawer/change-requests').set('Authorization', auth(TEACHER))
      .send({ serId: Number(other.ser_id), onDate: String(other.on_date), ...payload }).expect(404);
    expect(res.body.code).toBe('OCCURRENCE_NOT_FOUND');
    expect(res.body).not.toHaveProperty('conflicts');
    const [{ count: after }] = await ds.query('SELECT count(*)::int AS count FROM chreq WHERE by_id = $1', [T]);
    expect(after).toBe(before);
  });

  it('§19 매니저는 다른 강사 회차의 변경 요청을 올릴 수 있다', async () => {
    const occurrence = await firstOccurrence();
    const res = await request(app.getHttpServer())
      .post('/drawer/change-requests').set('Authorization', auth(MANAGER))
      .send({ ...occurrence, reqType: 'cancel', reason: '매니저 대리 요청' }).expect(201);
    const [saved] = await ds.query('SELECT by_id, ser_id FROM chreq WHERE id = $1', [res.body.id]);
    expect(Number(saved.by_id)).toBe(M);
    expect(Number(saved.ser_id)).toBe(occurrence.serId);
  });

  it('§19 종류별 필드·대상·자원을 저장 전에 막는다', async () => {
    const occurrence = await firstOccurrence();
    const mixed = await request(app.getHttpServer())
      .post('/drawer/change-requests').set('Authorization', auth(TEACHER))
      .send({ ...occurrence, reqType: 'teacher', teacherId: M, roomId: 1, reason: '혼합 필드' })
      .expect(400);
    expect(mixed.body.code).toBe('BAD_CHANGE_FIELDS');

    const missingOccurrence = await request(app.getHttpServer())
      .post('/drawer/change-requests').set('Authorization', auth(TEACHER))
      .send({ serId: occurrence.serId, onDate: '2099-01-01', reqType: 'cancel', reason: '없는 회차' })
      .expect(404);
    expect(missingOccurrence.body.code).toBe('OCCURRENCE_NOT_FOUND');

    const missingTeacher = await request(app.getHttpServer())
      .post('/drawer/change-requests').set('Authorization', auth(TEACHER))
      .send({ ...occurrence, reqType: 'teacher', teacherId: 9_999_999, reason: '없는 강사' })
      .expect(404);
    expect(missingTeacher.body.code).toBe('CHANGE_TARGET_NOT_FOUND');
  });

  it('§19 겹치면 넣지 않고 **누구와** 겹치는지 돌려준다', async () => {
    const MIN = `(EXTRACT(HOUR FROM %s AT TIME ZONE 'Asia/Seoul') * 60
                  + EXTRACT(MINUTE FROM %s AT TIME ZONE 'Asia/Seoul'))::int`;
    const lo = MIN.replace(/%s/g, 'lower(a.span)');
    const hi = MIN.replace(/%s/g, 'upper(a.span)');
    const occ = await ds.query(
      `SELECT a.ser_id, to_char(a.on_date,'YYYY-MM-DD') AS on_date, a.teacher_id,
              ${lo} AS start_min, ${hi} AS end_min
         FROM ser_occ a
        WHERE NOT a.canceled AND a.teacher_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM ser_occ b
                       WHERE b.teacher_id = a.teacher_id AND b.ser_id <> a.ser_id
                         AND b.on_date = a.on_date AND NOT b.canceled)
        LIMIT 1`,
    );
    if (occ.length === 0) return;                 // 시드에 겹치는 짝이 없으면 볼 것이 없다
    const o = occ[0];
    const other = (await ds.query(
      `SELECT ${lo} AS start_min, ${hi} AS end_min FROM ser_occ a
        WHERE a.teacher_id = $1 AND a.on_date = $2 AND a.ser_id <> $3 AND NOT a.canceled LIMIT 1`,
      [o.teacher_id, o.on_date, o.ser_id],
    ))[0];

    const res = await request(app.getHttpServer())
      .post('/drawer/change-requests').set('Authorization', auth(MANAGER))
      .send({
        reqType: 'time_move', serId: Number(o.ser_id), onDate: o.on_date,
        startMin: other.start_min, endMin: other.end_min,
        reason: '겹침 확인',
      }).expect(201);

    expect(res.body.id).toBeNull();
    expect(res.body.conflicts.length).toBeGreaterThan(0);
    // 「안 됩니다」가 아니라 **누구와**를 말한다
    expect(res.body.conflicts[0]).toHaveProperty('whoName');
    expect(['teacher', 'room', 'zoom']).toContain(res.body.conflicts[0].with);
  });

  it('§19 안 겹치면 요청이 들어간다 — 승인은 여기서 하지 않는다 (D-R27)', async () => {
    const occurrence = await firstOccurrence();
    const reason = ` ${'가'.repeat(500)} `;
    const res = await request(app.getHttpServer())
      .post('/drawer/change-requests').set('Authorization', auth(TEACHER))
      .send({ ...occurrence, reqType: 'cancel', reason }).expect(201);
    expect(res.body.conflicts).toHaveLength(0);
    expect(typeof res.body.id).toBe('number');

    const r = await get('/drawer', MANAGER).expect(200);
    const row = r.body.changeReqs.find((c: { id: number }) => c.id === res.body.id);
    expect(row.state).toBe('pending');            // 자동 승인 없음
    expect(row).toMatchObject(occurrence);
    expect(row.reason).toBe('가'.repeat(500));    // 길이 판정과 저장 모두 trim 뒤 한 번만
  });

  it('§19 DB도 임의 payload를 직접 넣지 못하게 막는다', async () => {
    const occurrence = await firstOccurrence();
    await expect(ds.query(
      `INSERT INTO chreq (ser_id, on_date, req_type, payload, reason, by_id)
       VALUES ($1, $2, 'cancel', '{"teacherId": 1}'::jsonb, '잘못된 직접 입력', $3)`,
      [occurrence.serId, occurrence.onDate, T],
    )).rejects.toMatchObject({ constraint: 'chreq_payload_contract' });
  });
});

/**
 * 낱말 대조 — **표에 실제로 있는 상태 낱말이 전부 정규화 표에 있는가.**
 *
 * `toApState` 는 모르는 낱말을 조용히 「기다리는 것」으로 둔다. 사라지는 것보다 낫지만,
 * 그 관대함 때문에 `erd.dbml` 이 'open | applied | denied' 라고 적어 둔 사이
 * DB 는 'pending · approved · rejected' 로 돌고 있었는데도 **아무것도 터지지 않았다.**
 * 끝난 요청이 배지에 계속 남고, 화면에는 영어 낱말이 그대로 찍혔다.
 *
 * 그래서 여기서 DB 를 직접 물어본다. 새 낱말이 들어오는 날 이 테스트가 먼저 운다.
 */
d('결재 낱말 — DB 와 정규화 표가 같은 말을 하는가', () => {
  let ds2: DataSource;
  let app2: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app2 = mod.createNestApplication();
    await app2.init();
    ds2 = app2.get(DataSource);
  });
  afterAll(async () => { await app2?.close(); });

  /**
   * TBO-29 에서 이 목록에 **EXPENSE 를 빠뜨렸다.** 그 표는 낱말이 세 벌이었고
   * (`submitted` 기본값 · `confirmed` 시드 · `'confirmed'` 질의)
   * 새로 올린 지출이 대표 보고의 손익에서 조용히 빠지고 있었다.
   * **표를 하나 더 만들 때 이 배열에 줄을 추가하는 것이 그 표의 안전벨트다.**
   */
  const COLS: Array<[string, string]> = [
    ['req', 'state'], ['chreq', 'state'], ['plan', 'stage'],
    ['rpt', 'state'], ['gpapack', 'state'], ['expense', 'state'],
  ];

  it.each(COLS)('%s.%s 의 낱말이 전부 표에 있다', async (table, col) => {
    const rows = (await ds2.query(
      `SELECT DISTINCT ${col} AS w FROM ${table} WHERE ${col} IS NOT NULL`,
    )) as Array<{ w: string }>;
    const unknown = rows.map((r) => r.w).filter((w) => !isKnownApWord(w));
    expect(unknown).toEqual([]);
  });

  it('기본값으로 태어나는 행도 읽을 수 있는 낱말을 갖는다', async () => {
    const rows = (await ds2.query(
      `SELECT table_name, column_default FROM information_schema.columns
        WHERE table_name IN ('req','chreq','gpapack','expense') AND column_name = 'state'`,
    )) as Array<{ table_name: string; column_default: string }>;
    expect(rows).toHaveLength(4);
    rows.forEach((r) => {
      const word = /'([^']+)'/.exec(r.column_default)?.[1];
      expect(isKnownApWord(word)).toBe(true);
      // 「어느 쪽도 아닌 새 낱말」로 태어나면 승인 대기함에서 영영 안 없어진다
      expect(word).toBe('pending');
    });
  });
});
