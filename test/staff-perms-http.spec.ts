/** @file-guide
 * 목적: staff-perms-http.spec.ts (test) — 사람별 권한 예외(N-68) · §76 권한 표(N-98) · 내 지출 신청(N-52) · 줌 계정 감사(N-73)의 실제 HTTP
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * W11 P 영역 — **권한이 걸린 것은 실제 HTTP 로 본다**(가드 · 운영과 같은 ValidationPipe · 요청마다 계정 행을 읽는 인증).
 *
 *   N-68 ① 대표 판정으로 켬/끔/역할 따름을 적는다 · 대표·관리자 줄 403 · 자기 줄 403 · 없는 권한을 남에게 켜지 못한다(403)
 *        ② **바꾼 값은 다음 요청부터 그 사람의 판정이다** — 이미 받아 둔 토큰으로도 회계가 403 이 된다(세션이 즉시 따라온다)
 *        ③ 감사 — 권한 쓰기 한 줄(STAFF perms) · 막힌 쓰기는 0 줄
 *   N-98 §76 표 · 부제 · 역할 설명 줄이 서버 문장이다 — 옛 직함 낱말이 없다 · 사람별 예외가 「지금」 칸에 반영된다
 *   N-52 회계 권한이 없어도 **내가 올린 지출**은 목록 · 금액 · 상태를 본다 · 남의 줄은 없다 · 강사는 403
 *   N-73 줌 계정 수정 감사 한 줄 — 비밀 값 · 로그인 이메일 원문이 before/after 에 없다 · 막힌 쓰기는 0 줄
 *
 * 이 스위트 전용 staff 9801~9805 · `pp-` 로 시작하는 이메일 · 줌 계정 이름만 쓴다.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('W11 P — 사람별 권한 예외 · §76 권한 표 · 내 지출 신청 · 줌 계정 감사 (실제 HTTP)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const PW = 'pp-fixture-1234';
  const CEO = 9801;
  const MGR = 9802;
  const MGR2 = 9803;
  const TEACHER = 9804;
  const ADMIN = 9805;
  const ids = [CEO, MGR, MGR2, TEACHER, ADMIN];
  const tokens: Record<string, string> = {};
  const ZLABEL = `pp-zoom-${process.pid}`;
  const SECRET = 'pp-meeting-secret-9x';

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const api = (m: 'get' | 'post' | 'patch' | 'delete', url: string, token = tokens.ceo) =>
    (request(app.getHttpServer()) as unknown as Record<string, (u: string) => request.Test>)[m](url)
      .timeout({ response: 8000, deadline: 15000 })
      .set('Authorization', `Bearer ${token}`);
  const login = async (loginId: string) =>
    (await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 })
      .send({ loginId, password: PW }).expect(201)).body.accessToken as string;
  const permLogs = async (id: number) =>
    q<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT before, after FROM log WHERE entity = 'STAFF' AND entity_id = $1 AND action = 'perms' ORDER BY id`, [id]);

  const dropFixtures = async () => {
    const zaccs = await q<{ id: string }>(`SELECT id FROM zacc WHERE label LIKE 'pp-zoom-%'`);
    for (const z of zaccs) {
      await q(`DELETE FROM zlog WHERE zacc_id = $1`, [z.id]);
      await q(`DELETE FROM log WHERE entity = 'ZACC' AND entity_id = $1`, [z.id]);
      await q(`DELETE FROM zacc WHERE id = $1`, [z.id]);
    }
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
    await q(`DELETE FROM expense WHERE requester_id = ANY($1) OR filed_by = ANY($1)`, [ids]);
    await q(`DELETE FROM log WHERE actor_id = ANY($1) OR (entity = 'STAFF' AND entity_id = ANY($1))`, [ids]);
    await q(`DELETE FROM auth_code WHERE staff_id = ANY($1)`, [ids]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);
    await dropFixtures();
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES
         ($1,'권한대표','pp-ceo@t.kr','ceo',$6,true),
         ($2,'권한매니저','pp-mgr@t.kr','manager',$6,true),
         ($3,'권한매니저둘','pp-mgr2@t.kr','manager',$6,true),
         ($4,'권한강사','pp-t@t.kr','teacher',$6,true),
         ($5,'권한관리자','pp-admin@t.kr','admin',$6,true)`,
      [CEO, MGR, MGR2, TEACHER, ADMIN, hash],
    );
    tokens.ceo = await login('pp-ceo@t.kr');
    tokens.mgr = await login('pp-mgr@t.kr');
    tokens.mgr2 = await login('pp-mgr2@t.kr');
    tokens.teacher = await login('pp-t@t.kr');
  });

  afterAll(async () => {
    if (ds?.isInitialized) await dropFixtures();
    await app?.close();
  });

  /* ── N-68 ─────────────────────────────────────────────────────────────── */

  it('서랍 구성원 줄 — 권한 예외 다섯 칸과 토글이 서는지는 서버가 준다(대표 판정 · 자기 줄 · 대표·관리자 줄 제외)', async () => {
    const res = await api('get', '/drawer').expect(200);
    const rowOf = (id: number) => (res.body.members as Array<Record<string, unknown>>).find((m) => m.id === id)!;
    expect(rowOf(MGR).canEditPerms).toBe(true);
    expect(rowOf(ADMIN).canEditPerms).toBe(false);
    expect(rowOf(CEO).canEditPerms).toBe(false);
    const perms = rowOf(MGR).perms as Array<Record<string, unknown>>;
    expect(perms.map((p) => p.key)).toEqual(['canMoney', 'canWage', 'canApprove', 'canHide', 'canGpaPack']);
    expect(perms[0]).toEqual({ key: 'canMoney', label: '회계 권한', override: null, roleDefault: true, effective: true });
    // 강사에게는 예외 칸을 싣지 않는다
    const mine = await api('get', '/drawer', tokens.teacher).expect(200);
    expect((mine.body.members as Array<Record<string, unknown>>)[0].perms).toBeNull();
  });

  it('회계 권한을 끄면 **이미 받은 토큰**의 다음 요청부터 회계가 막힌다 · 역할 따름으로 되돌리면 다시 열린다 · 감사 한 줄씩', async () => {
    await api('get', '/accounting', tokens.mgr).expect(200);
    const off = await api('patch', `/drawer/staff/${MGR}`).send({ perms: { canMoney: false } }).expect(200);
    expect((off.body.perms as Array<Record<string, unknown>>)[0]).toMatchObject({ override: false, effective: false, roleDefault: true });
    expect(await permLogs(MGR)).toEqual([{ before: { canMoney: null }, after: { canMoney: false } }]);

    await api('get', '/accounting', tokens.mgr).expect(403);
    const me = await api('get', '/auth/me', tokens.mgr).expect(200);
    expect(me.body.canMoney).toBe(false);

    await api('patch', `/drawer/staff/${MGR}`).send({ perms: { canMoney: null } }).expect(200);
    await api('get', '/accounting', tokens.mgr).expect(200);
    expect(await permLogs(MGR)).toHaveLength(2);
    // 같은 값을 다시 보내면 바뀐 것이 없다
    await api('patch', `/drawer/staff/${MGR}`).send({ perms: { canMoney: null } }).expect(409);
    expect(await permLogs(MGR)).toHaveLength(2);
  });

  it('막히는 쪽 — 없는 권한은 남에게 못 켠다 · 자기 줄 · 대표·관리자 줄 · 강사 · 잘못된 값 — 감사 0 줄', async () => {
    await api('patch', `/drawer/staff/${MGR}`).send({ perms: { canMoney: false } }).expect(200);
    await api('patch', `/drawer/staff/${MGR2}`, tokens.mgr).send({ perms: { canMoney: true } })
      .expect(403).expect((r) => expect(r.body.code).toBe('PERM_GRANT_FORBIDDEN'));
    // 역할 따름(null)도 결과가 켜지면 켜는 것이다 — 매니저 둘의 기본값은 켜짐이다
    await api('patch', `/drawer/staff/${MGR2}`).send({ perms: { canMoney: false } }).expect(200);
    await api('patch', `/drawer/staff/${MGR2}`, tokens.mgr).send({ perms: { canMoney: null } })
      .expect(403).expect((r) => expect(r.body.code).toBe('PERM_GRANT_FORBIDDEN'));
    // 가진 권한은 켜고 끌 수 있다
    await api('patch', `/drawer/staff/${MGR2}`, tokens.mgr).send({ perms: { canWage: false } }).expect(200);

    await api('patch', `/drawer/staff/${MGR}`, tokens.mgr).send({ perms: { canWage: false } })
      .expect(403).expect((r) => expect(r.body.code).toBe('SELF_ROLE'));
    await api('patch', `/drawer/staff/${ADMIN}`).send({ perms: { canMoney: false } })
      .expect(403).expect((r) => expect(r.body.code).toBe('STAFF_PROTECTED'));
    await api('patch', `/drawer/staff/${MGR2}`, tokens.teacher).send({ perms: { canMoney: false } }).expect(403);
    await api('patch', `/drawer/staff/${MGR2}`).send({ perms: { canMoney: 'yes' } }).expect(400);
    await api('patch', `/drawer/staff/${MGR2}`).send({ perms: { canFly: true } }).expect(400);
    await api('patch', `/drawer/staff/${MGR2}`).send({ perms: 7 }).expect(400);

    expect(await permLogs(ADMIN)).toHaveLength(0);
    // MGR2 에 남은 줄은 성공한 두 쓰기뿐이다(대표의 끄기 · 매니저의 시급 끄기)
    expect((await permLogs(MGR2)).map((l) => l.after)).toEqual([{ canMoney: false }, { canWage: false }]);
    await api('patch', `/drawer/staff/${MGR}`).send({ perms: { canMoney: null } }).expect(200);
    await api('patch', `/drawer/staff/${MGR2}`).send({ perms: { canMoney: null, canWage: null } }).expect(200);
  });

  it('권한 한도 — 좁혀진 매니저는 매니저 계정을 만들거나 역할을 올리지 못한다(임시 비밀번호 우회 닫힘) · 강사는 만든다 · 좁혀지지 않은 매니저는 둘 다', async () => {
    const made: number[] = [];
    const body = (loginId: string, role: 'teacher' | 'manager') => ({ name: `권한한도 ${role}`, loginId, password: 'Grant-pass-w11', role });
    const staffCount = async (loginId: string) =>
      Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM staff WHERE lower(login_id) = lower($1)`, [loginId]))[0].n);
    try {
      // 앞 시험이 중간에 멈춰도 같은 자리에서 시작한다(역할 따름 → 끔)
      await q(`UPDATE staff SET can_money = NULL WHERE id = $1`, [MGR]);
      await api('patch', `/drawer/staff/${MGR}`).send({ perms: { canMoney: false } }).expect(200);

      // ① 좁혀진 매니저가 새 매니저 계정 — 403 · 계정도 감사 줄도 안 생긴다
      const blocked = await api('post', '/drawer/staff', tokens.mgr).send(body('pp-grant-mgr', 'manager')).expect(403);
      expect(blocked.body.code).toBe('PERM_GRANT_FORBIDDEN');
      expect(blocked.body.message).toBe('매니저 계정을 만들면 회계 권한까지 주게 됩니다 — 내게 없는 권한은 남에게 줄 수 없습니다');
      expect(await staffCount('pp-grant-mgr')).toBe(0);

      // ② 강사 계정은 받는 권한이 없어 만든다
      const t = await api('post', '/drawer/staff', tokens.mgr).send(body('pp-grant-t', 'teacher')).expect(201);
      made.push(Number(t.body.id));

      // ③ 그 강사를 매니저로 올리는 것도 같은 한도 — 403 · 역할 그대로
      const up = await api('patch', `/drawer/staff/${t.body.id}`, tokens.mgr).send({ role: 'manager' }).expect(403);
      expect(up.body.code).toBe('PERM_GRANT_FORBIDDEN');
      expect(up.body.message).toBe('매니저로 바꾸면 회계 권한까지 주게 됩니다 — 내게 없는 권한은 남에게 줄 수 없습니다');
      expect((await q<{ role: string }>(`SELECT role::text AS role FROM staff WHERE id = $1`, [t.body.id]))[0].role).toBe('teacher');
      // 좁히는 쪽(이름만 · 강사로)은 막지 않는다
      await api('patch', `/drawer/staff/${t.body.id}`, tokens.mgr).send({ title: '한도 확인' }).expect(200);

      // ④ 좁혀지지 않은 매니저는 둘 다 된다(P1 그대로)
      const m2 = await api('post', '/drawer/staff', tokens.mgr2).send(body('pp-grant-mgr2', 'manager')).expect(201);
      made.push(Number(m2.body.id));
      await api('patch', `/drawer/staff/${t.body.id}`, tokens.mgr2).send({ role: 'manager' }).expect(200);
    } finally {
      await q(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = ANY($1)`, [made]);
      await q(`DELETE FROM staff WHERE id = ANY($1)`, [made]);
      await api('patch', `/drawer/staff/${MGR}`).send({ perms: { canMoney: null } });
    }
  });

  /* ── N-98 ─────────────────────────────────────────────────────────────── */

  it('§76 표 · 부제 · 역할 설명 줄은 서버 문장이다 — 옛 직함 낱말 없음 · 사람별 예외가 「지금」에 반영된다', async () => {
    const ceo = await api('get', '/permissions').expect(200);
    expect(ceo.body.sub).toBe('지금 대표 화면입니다 · 14가지 가능 / 0가지 잠김');
    expect(ceo.body.rows).toHaveLength(14);
    expect(ceo.body.roleNotes).toEqual([
      '대표 · 14가지 가능 / 0가지 잠김', '관리자 · 14가지 가능 / 0가지 잠김',
      '매니저 · 14가지 가능 / 0가지 잠김', '강사 · 0가지 가능 / 14가지 잠김',
    ]);
    expect(JSON.stringify(ceo.body)).not.toMatch(/교수실장|상담실장|코디네이터|이사|상단 오른쪽/);

    await api('patch', `/drawer/staff/${MGR}`).send({ perms: { canMoney: false } }).expect(200);
    const mgr = await api('get', '/permissions', tokens.mgr).expect(200);
    expect(mgr.body.sub).toBe('지금 매니저 화면입니다 · 12가지 가능 / 2가지 잠김');
    const locked = (mgr.body.rows as Array<{ feature: string; allowed: boolean }>).filter((r) => !r.allowed).map((r) => r.feature);
    expect(locked).toEqual(['회계 탭 전체', '컨설팅비 보기']);
    // 역할 설명은 역할의 기본값이다 — 한 사람의 예외로 흔들리지 않는다
    expect(mgr.body.roleNotes[2]).toBe('매니저 · 14가지 가능 / 0가지 잠김');
    await api('patch', `/drawer/staff/${MGR}`).send({ perms: { canMoney: null } }).expect(200);
    await api('get', '/permissions', tokens.teacher).expect(403);
  });

  /* ── N-52 ─────────────────────────────────────────────────────────────── */

  it('회계 권한이 없어도 내가 올린 지출은 본다 — 남의 줄은 없다 · 서랍 머리 수도 서버가 센다 · 강사는 403', async () => {
    await api('patch', `/drawer/staff/${MGR}`).send({ perms: { canMoney: false } }).expect(200);
    const made = await api('post', '/accounting/expenses', tokens.mgr)
      .send({ spendOn: '2026-09-20', category: 'supply', requestedAmount: 12000, purpose: 'pp 마커' }).expect(201);
    expect(made.body).toMatchObject({ requesterId: MGR, requestedAmount: 12000, state: 'pending' });
    await api('post', '/accounting/expenses', tokens.mgr2)
      .send({ spendOn: '2026-09-21', category: 'book', requestedAmount: 30000 }).expect(201);
    await api('get', '/accounting', tokens.mgr).expect(403);

    const mine = await api('get', '/accounting/expenses/mine', tokens.mgr).expect(200);
    expect((mine.body.items as Array<{ requesterId: number }>).every((e) => e.requesterId === MGR)).toBe(true);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ requestedAmount: 12000, state: 'pending', categoryLabel: expect.any(String) });
    expect(mine.body.categories).toHaveLength(6);

    const drawer = await api('get', '/drawer', tokens.mgr).expect(200);
    expect(drawer.body.myExpenses).toEqual({ total: 1, pending: 1, rejected: 0 });
    await api('get', '/accounting/expenses/mine', tokens.teacher).expect(403);
    await api('patch', `/drawer/staff/${MGR}`).send({ perms: { canMoney: null } }).expect(200);
  });

  /* ── H-83 · H-84 — §75 결재 흐름의 지출 갈래 (사용자 결정 2026-09-30 · N-64 번복) ─────────────────── */

  it('§75 지출 갈래 — 올린 지출은 대표 흐름의 「지출 결재 → 대표에게」에 서고, 반려되면 올린 사람의 「되돌아온 것」에 사유와 함께 · 회계 권한이 없으면 남의 줄은 없다 (H-83 · H-84)', async () => {
    await api('patch', `/drawer/staff/${MGR}`).send({ perms: { canMoney: false } }).expect(200);
    try {
      const made = await api('post', '/accounting/expenses', tokens.mgr)
        .send({ spendOn: '2026-09-22', category: 'book', requestedAmount: 350000, purpose: 'pp 교재 구입' }).expect(201);
      const id = made.body.id as number;
      const flowOf = async (token?: string) => (await api('get', '/drawer', token).expect(200)).body.approvalFlow as {
        tiles: Array<{ kind: string; count: number; toLabel: string }>;
        waiting: Array<{ kind: string; id: number; go: string; title: string }>;
        back: Array<{ kind: string; id: number; why: string | null; go: string }>;
        mine: Array<{ kind: string; id: number }>;
      };
      // 대표 — 결재 흐름에 집계(H-83 「결재 흐름에 집계」) · 원본은 회계 「나간 돈」 · 금액은 줄에 없다
      const ceoFlow = await flowOf();
      expect(ceoFlow.tiles.find((t) => t.kind === 'expense')).toMatchObject({ toLabel: '대표에게' });
      expect(ceoFlow.tiles.find((t) => t.kind === 'expense')!.count).toBeGreaterThanOrEqual(1);
      const row = ceoFlow.waiting.find((w) => w.kind === 'expense' && w.id === id)!;
      expect(row).toMatchObject({ go: '/accounting?tab=out', title: expect.stringContaining('pp 교재 구입') });
      expect(JSON.stringify(row)).not.toContain('350');
      // 올린 사람 — 「내가 올린 것」에 선다 · 회계 권한이 없어 남의 지출 줄은 없다
      const mgrFlow = await flowOf(tokens.mgr);
      expect(mgrFlow.mine.some((m) => m.kind === 'expense' && m.id === id)).toBe(true);
      expect([...mgrFlow.waiting, ...mgrFlow.back].filter((w) => w.kind === 'expense')).toEqual([]);
      // 반려 — 올린 사람의 「되돌아온 것」에 사유와 함께(H-84) · 누르면 서랍 「내 지출 신청」
      await api('post', `/accounting/expenses/${id}/review`).send({ decision: 'reject', reason: '영수증 첨부 필요' }).expect(201);
      const back = (await flowOf(tokens.mgr)).back.find((b) => b.kind === 'expense' && b.id === id);
      expect(back).toMatchObject({ why: '영수증 첨부 필요', go: `/schedule?myExpense=${id}` });
      expect((await flowOf()).waiting.some((w) => w.kind === 'expense' && w.id === id)).toBe(false);
      // 강사는 §75 자체가 없다
      expect((await flowOf(tokens.teacher)).tiles).toEqual([]);
    } finally {
      await api('patch', `/drawer/staff/${MGR}`).send({ perms: { canMoney: null } }).expect(200);
    }
  });

  /* ── N-99 강사 「GPA 회차 요청」 창 ─────────────────────────────────────── */

  it('「GPA 회차 요청」 창은 강사 전용이다 — 서비스 규정과 고를 회차 두 벌 · 관리 화면 사람은 403', async () => {
    const opts = await api('get', '/teacher/gpa-request-options', tokens.teacher).expect(200);
    expect(opts.body).toEqual({ services: expect.any(Array), occurrences: expect.any(Array) });
    await api('get', '/teacher/gpa-request-options', tokens.mgr).expect(403);
    // 옛 경로는 없다 — 한 창이 한 번에 읽는다
    await api('get', '/teacher/gpa-services', tokens.teacher).expect(404);
  });

  /* ── N-73 줌 계정 ──────────────────────────────────────────────────────── */

  it('줌 계정 수정 — 감사 한 줄 · 비밀 값과 로그인 이메일 원문은 싣지 않는다 · 막힌 쓰기는 0 줄', async () => {
    const made = await api('post', '/zoom/accounts').send({
      label: ZLABEL, loginEmail: 'pp-zoom-login@t.kr', joinUrl: 'https://zoom.us/j/111?pwd=abc', loginSecret: 'pp-login-secret',
    }).expect(201);
    const id = Number(made.body.id);
    const logs = () => q<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT before, after FROM log WHERE entity = 'ZACC' AND entity_id = $1 AND action = 'update'`, [id]);

    await api('patch', `/zoom/accounts/${id}`).send({ label: `${ZLABEL}-b`, meetingPw: SECRET, joinUrl: 'https://zoom.us/j/222?pwd=def' }).expect(200);
    const rows = await logs();
    expect(rows).toHaveLength(1);
    expect(rows[0].before).toMatchObject({ label: ZLABEL, active: true });
    expect(rows[0].after).toMatchObject({
      label: `${ZLABEL}-b`, joinUrlChanged: true, meetingIdChanged: false, loginSecretRotated: false, meetingPwRotated: true,
    });
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('pp-login-secret');
    expect(text).not.toContain('pp-zoom-login@t.kr');
    expect(text).not.toContain('pwd=');

    await api('patch', `/zoom/accounts/${id}`).send({}).expect(400);
    expect(await logs()).toHaveLength(1);
  });
});
