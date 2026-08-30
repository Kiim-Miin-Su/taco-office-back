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
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { isKnownApWord } from '../src/lib/approval';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(40_000);

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

    // 강사가 올린 요청 3건 — **하나도 빠지지 않고** 대기함에 떠야 한다 (D-R34)
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
  const get = (path: string, email: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', auth(email));

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
    await request(app.getHttpServer())
      .post('/drawer/change-requests').set('Authorization', auth(TEACHER))
      .send({ reqType: 'time_move', reason: '   ' }).expect(400);
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
        payload: { startMin: other.start_min, endMin: other.end_min },
        reason: '겹침 확인',
      }).expect(201);

    expect(res.body.id).toBeNull();
    expect(res.body.conflicts.length).toBeGreaterThan(0);
    // 「안 됩니다」가 아니라 **누구와**를 말한다
    expect(res.body.conflicts[0]).toHaveProperty('whoName');
    expect(['teacher', 'room', 'zoom']).toContain(res.body.conflicts[0].with);
  });

  it('§19 안 겹치면 요청이 들어간다 — 승인은 여기서 하지 않는다 (D-R27)', async () => {
    const res = await request(app.getHttpServer())
      .post('/drawer/change-requests').set('Authorization', auth(TEACHER))
      .send({ reqType: 'cancel', reason: '개인 사정' }).expect(201);
    expect(res.body.conflicts).toHaveLength(0);
    expect(typeof res.body.id).toBe('number');

    const r = await get('/drawer', MANAGER).expect(200);
    const row = r.body.changeReqs.find((c: { id: number }) => c.id === res.body.id);
    expect(row.state).toBe('pending');            // 자동 승인 없음
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
