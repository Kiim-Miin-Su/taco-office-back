/** @file-guide
 * 목적: staff-crud-w8-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * W8 — §17 사용자 표 CRUD (대표 지시 2026-09-26 「강사는 대표·매니저·관리자가 아이디 및 비밀번호 생성하여 넘겨줄 수 있게 ·
 * 매니저 이상급부터 user table CRUD」).
 * W10 — 「매니저가 강사의 아이디를 만들어줄 때든 모든 때의 아이디 형식은 자유 · 매니저가 아이디 비번 만들면 db 에 저장 →
 * 초기 설정 시 주요 인증 및 비번 재설정」 · 답변(초기화도 매니저가 임시 비밀번호를 적는다 · 이메일은 선택 · 아이디는 띄어쓰기만 금지).
 *
 * 실제 HTTP(권한 가드 · **운영과 같은** ValidationPipe — 허용 밖 필드는 400)와 격리 DB 로 돈다.
 * 막히는 쪽을 되는 쪽만큼 본다 — 대표·관리자 줄 보호, 자기 줄 보호, 기록 있는 계정의 삭제 거절(아무것도 안 사라짐).
 * 이 스위트 전용 staff 8861~8866 과 `w8b-` 로 시작하는 아이디 · 이메일만 쓴다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { INITIAL_PASSWORD, PASSWORD_ISSUE_MESSAGE } from '../src/lib/account-policy';
import { STAFF_OWN_TABLES, STAFF_SOFT_REFS, staffForeignKeys } from '../src/lib/staff-refs';
import { DEV_URL } from './db';

const d = DEV_URL ? describe : describe.skip;
jest.setTimeout(90_000);

d('W8 · W10 §17 사용자 표 CRUD — 만들기(아이디 · 임시 비밀번호) · 수정 · 비밀번호 초기화 · 사용 중지 · 삭제', () => {
  let app: INestApplication;
  let ds: DataSource;
  const PW = 'w8b-fixture-1234';
  /** 매니저가 적는 임시 비밀번호 — 만들기 · 초기화 (W10) */
  const TEMP = 'Temp-pass-w8b1';
  const TEMP2 = 'Reset-pass-w8b2';
  const CEO = 8861;
  const ADMIN = 8862;
  const MGR = 8863;
  const MGR2 = 8864;
  const TEACHER = 8865;
  const TEACHER2 = 8866; // 사용 중지 · 초기화 대상
  const ids = [CEO, ADMIN, MGR, MGR2, TEACHER, TEACHER2];
  const tokens: Record<string, string> = {};

  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => ds.query(sql, p) as Promise<T[]>;
  const api = (m: 'get' | 'post' | 'patch' | 'delete', url: string, token = tokens.mgr) =>
    (request(app.getHttpServer()) as unknown as Record<string, (u: string) => request.Test>)[m](url)
      .timeout({ response: 8000, deadline: 15000 })
      .set('Authorization', `Bearer ${token}`);
  const login = async (loginId: string, password = PW) =>
    (await request(app.getHttpServer()).post('/auth/login').timeout({ response: 5000, deadline: 10000 })
      .send({ loginId, password }).expect(201)).body.accessToken as string;

  /** 이 스위트가 만든 계정(w8b-new-*)과 그 흔적을 치운다 — 앞선 실행이 남긴 것까지 */
  const dropMade = async () => {
    const rows = await q<{ id: string }>(`SELECT id FROM staff WHERE lower(login_id) LIKE 'w8b-new-%' OR email LIKE 'w8b-new-%'`);
    for (const r of rows) {
      await q(`DELETE FROM wage WHERE staff_id = $1`, [r.id]);
      await q(`DELETE FROM pnoti WHERE staff_id = $1`, [r.id]);
      await q(`DELETE FROM file WHERE uploaded_by = $1`, [r.id]);
      await q(`DELETE FROM auth_code WHERE staff_id = $1`, [r.id]);
      await q(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = $1`, [r.id]);
      await q(`DELETE FROM staff WHERE id = $1`, [r.id]);
    }
  };
  const dropFixtures = async () => {
    await q(`DELETE FROM log WHERE actor_id = ANY($1) OR (entity = 'STAFF' AND entity_id = ANY($1))`, [ids]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [ids]);
    await q(`DELETE FROM wage WHERE staff_id = ANY($1) OR approved_by = ANY($1)`, [ids]);
    await q(`DELETE FROM auth_code WHERE staff_id = ANY($1)`, [ids]);
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [ids]);
  };
  /** 만들기 → 만든 줄의 id. 아이디 · 임시 비밀번호는 매니저가 적는다(W10) */
  const make = async (loginId: string, extra: Record<string, unknown> = {}) => {
    const res = await api('post', '/drawer/staff').send({ name: '새 사람', loginId, password: TEMP, role: 'teacher', ...extra }).expect(201);
    return Number(res.body.id);
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    // 운영(app.factory)과 같은 파이프 — 허용 밖 필드는 400 이다
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = app.get(DataSource);
    await dropMade();
    await dropFixtures();
    const hash = await bcrypt.hash(PW, 4);
    await q(
      `INSERT INTO staff (id, name, email, phone, role, password_hash, active) VALUES
         ($1,'표대표','w8b-ceo@t.kr',NULL,'ceo',$7,true),
         ($2,'표관리','w8b-admin@t.kr',NULL,'admin',$7,true),
         ($3,'표매니저','w8b-mgr@t.kr','01011112222','manager',$7,true),
         ($4,'표매니저둘','w8b-mgr2@t.kr',NULL,'manager',$7,true),
         ($5,'표강사','w8b-t@t.kr','01033334444','teacher',$7,true),
         ($6,'표강사둘','w8b-t2@t.kr',NULL,'teacher',$7,true)`,
      [CEO, ADMIN, MGR, MGR2, TEACHER, TEACHER2, hash],
    );
    await q(`INSERT INTO tzg (id, name, tz) VALUES (1,'한국 (KST)','Asia/Seoul'), (2,'미국 동부','America/New_York') ON CONFLICT (id) DO NOTHING`);
    tokens.ceo = await login('w8b-ceo@t.kr');
    tokens.mgr = await login('w8b-mgr@t.kr');
    tokens.teacher = await login('w8b-t@t.kr');
    tokens.teacher2 = await login('w8b-t2@t.kr');
  });

  afterAll(async () => {
    try {
      if (ds?.isInitialized) {
        await dropMade();
        await dropFixtures();
      }
    } finally {
      await app?.close();
    }
  });

  /* ── 1. 만들기 — 매니저가 정한 아이디 · 임시 비밀번호 (W10) ─────────────── */
  it('만들기 — 매니저가 정한 아이디 · 임시 비밀번호로 만들고 첫 설정을 걸며, 비밀번호는 응답 · 기록 · 목록 어디에도 없다', async () => {
    const res = await api('post', '/drawer/staff').send({
      name: ' 새 강사 ', loginId: ' w8b-new-1.Kim ', password: TEMP, email: ' W8B-New-1@T.kr ', role: 'teacher', phone: '010-5555-6666',
    }).expect(201);
    expect(res.body).toMatchObject({
      name: '새 강사', loginId: 'w8b-new-1.Kim', email: 'w8b-new-1@t.kr', role: 'teacher', active: true,
      mustChangeCredentials: true, phone: '01055556666',
    });
    expect(res.body).not.toHaveProperty('initialPassword');
    expect(JSON.stringify(res.body)).not.toContain(TEMP);
    const [row] = await q<{ login_id: string; password_hash: string; must_change_credentials: boolean; email_verified: boolean; phone_verified: boolean }>(
      `SELECT login_id, password_hash, must_change_credentials, email_verified, phone_verified FROM staff WHERE id = $1`, [res.body.id]);
    // 아이디는 적은 모양 그대로(앞뒤 공백만 지운다) · 비밀번호는 해시로만
    expect(row.login_id).toBe('w8b-new-1.Kim');
    expect(row.password_hash).not.toContain(TEMP);
    expect(await bcrypt.compare(TEMP, row.password_hash)).toBe(true);
    expect(row).toMatchObject({ must_change_credentials: true, email_verified: false, phone_verified: false });
    // 기록에는 비밀번호도 연락처도 없다
    const [log] = await q<{ after: unknown }>(`SELECT after FROM log WHERE entity = 'STAFF' AND entity_id = $1 AND action = 'create'`, [res.body.id]);
    expect(JSON.stringify(log.after)).not.toContain(TEMP);
    expect(JSON.stringify(log.after)).not.toMatch(/01055556666|w8b-new-1|password|hash/i);
    // 목록(서랍)에는 아이디가 있고 비밀번호는 없다
    const drawer = (await api('get', '/drawer').expect(200)).body;
    expect(JSON.stringify(drawer)).not.toContain(TEMP);
    expect(drawer.members.find((m: { id: number }) => m.id === res.body.id)).toMatchObject({ loginId: 'w8b-new-1.Kim', mustChangeCredentials: true });
    // 규칙 문장은 서버가 준다 — 화면이 적지 않는다 (D-R18)
    expect(drawer.loginIdRule).toContain('띄어쓰기');
    expect(drawer.tempPasswordRule).toContain('임시 비밀번호');
    // 그 아이디(대소문자 무시) · 임시 비밀번호로 들어오고 첫 설정 대상이다
    const first = await request(app.getHttpServer()).post('/auth/login').send({ loginId: 'W8B-NEW-1.KIM', password: TEMP }).expect(201);
    expect(first.body.user).toMatchObject({ id: res.body.id, mustChangeCredentials: true });
  });

  it('만들기 — 이메일은 선택이다: 비우거나 빼면 null 로 서고 그 아이디로 들어온다 · 한글 아이디도 된다 (답변 2026-09-26)', async () => {
    const blank = await api('post', '/drawer/staff').send({ name: '메일없음', loginId: 'w8b-new-메일없음', password: TEMP, email: '  ', role: 'teacher' }).expect(201);
    expect(blank.body).toMatchObject({ loginId: 'w8b-new-메일없음', email: null, mustChangeCredentials: true });
    const omitted = await api('post', '/drawer/staff').send({ name: '메일생략', loginId: 'w8b-new-nomail2', password: TEMP, role: 'teacher' }).expect(201);
    expect(omitted.body.email).toBeNull();
    const nulled = await api('post', '/drawer/staff').send({ name: '메일널', loginId: 'w8b-new-nomail3', password: TEMP, email: null, role: 'teacher' }).expect(201);
    expect(nulled.body.email).toBeNull();
    expect(await q(`SELECT email FROM staff WHERE id = ANY($1)`, [[blank.body.id, omitted.body.id, nulled.body.id]])).toEqual([{ email: null }, { email: null }, { email: null }]);
    await login('w8b-new-메일없음', TEMP);
  });

  it('만들기의 거절 — 아이디 규칙 400 · 임시 비밀번호 규칙 400 · 같은 아이디(대소문자 무시) 409 · 이메일 모양 400 · 휴대폰 400 · 강사 403 · 아무것도 안 남는다', async () => {
    const code = (c: string) => (r: request.Response) => expect(r.body.code).toBe(c);
    const ok = { name: 'x', password: TEMP, role: 'teacher' };
    // 아이디 — 빈 칸 · 공백뿐 · 띄어쓰기 · 폭 없는 공백 · 전각 공백 · 줄바꿈은 서버 규칙(LOGIN_ID_RULE) · 121자는 DTO
    for (const loginId of ['', '   ', 'w8b-new rj', 'w8b-new\u200brj', 'w8b-new\u3000rj', 'w8b-new\nrj']) {
      const res = await api('post', '/drawer/staff').send({ ...ok, loginId }).expect(400);
      expect(res.body.code).toBe('LOGIN_ID_RULE');
    }
    await api('post', '/drawer/staff').send({ ...ok, loginId: `w8b-new-${'x'.repeat(113)}` }).expect(400);
    await api('post', '/drawer/staff').send({ name: 'x', password: TEMP, role: 'teacher' }).expect(400);
    // 임시 비밀번호 — 첫 설정과 같은 규칙 · 같은 문장
    for (const [password, issue] of [['short1', 'TOO_SHORT'], ['onlyletters', 'NEEDS_LETTER_AND_DIGIT'], [INITIAL_PASSWORD, 'SAME_AS_INITIAL']] as const) {
      const res = await api('post', '/drawer/staff').send({ ...ok, loginId: 'w8b-new-rj-pw', password }).expect(400);
      expect(res.body).toMatchObject({ code: 'PASSWORD_RULE', message: PASSWORD_ISSUE_MESSAGE[issue] });
    }
    await api('post', '/drawer/staff').send({ name: 'x', loginId: 'w8b-new-rj-nopw', role: 'teacher' }).expect(400);
    // 같은 아이디 — 대소문자만 달라도 같은 아이디다(옛 계정의 아이디는 그때의 이메일)
    await api('post', '/drawer/staff').send({ ...ok, loginId: 'W8B-T@T.KR' }).expect(409).expect(code('STAFF_LOGIN_ID_TAKEN'));
    await api('post', '/drawer/staff').send({ ...ok, loginId: 'w8b-new-rj-mail', email: 'W8B-T@T.KR' }).expect(409).expect(code('STAFF_EMAIL_TAKEN'));
    await api('post', '/drawer/staff').send({ ...ok, loginId: 'w8b-new-rj-mail2', email: 'not-email' }).expect(400);
    await api('post', '/drawer/staff').send({ ...ok, loginId: 'w8b-new-rj-ph', phone: '02-123-4567' }).expect(400).expect(code('STAFF_PHONE_INVALID'));
    await api('post', '/drawer/staff', tokens.teacher).send({ ...ok, loginId: 'w8b-new-rj-t' }).expect(403);
    await api('post', '/drawer/staff').send({ ...ok, loginId: 'w8b-new-rj-c', role: 'ceo' }).expect(400);
    expect(await q(`SELECT id FROM staff WHERE lower(login_id) LIKE 'w8b-new-rj%' OR login_id LIKE 'w8b-new%rj'`)).toEqual([]);
  });

  /* ── 2. 줄마다 서버 플래그 ────────────────────────────────────────────── */
  it('줄 플래그 — 매니저는 강사·매니저 줄을 다루고 자기 줄은 수정만 · 대표·관리자 줄은 전부 false · 강사가 보면 전부 false 이고 휴대폰이 없다', async () => {
    const drawer = (await api('get', '/drawer').expect(200)).body;
    const m = (id: number) => drawer.members.find((x: { id: number }) => x.id === id);
    const all = { canEdit: true, canChangeRole: true, canResetPassword: true, canToggleActive: true, canDelete: true };
    const none = { canEdit: false, canChangeRole: false, canResetPassword: false, canToggleActive: false, canDelete: false };
    expect(m(TEACHER)).toMatchObject({ ...all, phone: '01033334444', mustChangeCredentials: false });
    expect(m(MGR2)).toMatchObject(all);
    expect(m(MGR)).toMatchObject({ ...none, canEdit: true, phone: '01011112222' });
    expect(m(CEO)).toMatchObject(none);
    expect(m(ADMIN)).toMatchObject(none);
    const asTeacher = (await api('get', '/drawer', tokens.teacher).expect(200)).body;
    expect(asTeacher.members).toHaveLength(1);
    expect(asTeacher.members[0]).toMatchObject({ ...none, phone: null });
  });

  /* ── 3. 수정 ──────────────────────────────────────────────────────────── */
  it('수정 — 보낸 칸만 바뀌고, 이메일·휴대폰을 바꾸면 그 확인이 풀리며, 기록에는 연락처 원문이 없다 · 아이디도 고친다(W10)', async () => {
    const id = await make('w8b-new-edit', { email: 'w8b-new-edit@t.kr', phone: '01077778888' });
    await q(`UPDATE staff SET email_verified = true, phone_verified = true WHERE id = $1`, [id]);
    const res = await api('patch', `/drawer/staff/${id}`).send({
      name: ' 고친 이름 ', loginId: ' w8b-new-edit.Two ', email: ' W8B-New-Edit2@T.kr ', phone: '010-9999-0000', title: '영어', tz: 'America/New_York', role: 'manager', hiredOn: '2026-09-01',
    }).expect(200);
    expect(res.body).toMatchObject({ id, name: '고친 이름', loginId: 'w8b-new-edit.Two', email: 'w8b-new-edit2@t.kr', phone: '01099990000', title: '영어', tz: 'America/New_York', role: 'manager', hiredOn: '2026-09-01' });
    const [row] = await q<Record<string, unknown>>(
      `SELECT login_id, email_verified, phone_verified, to_char(hired_on,'YYYY-MM-DD') AS hired_on FROM staff WHERE id = $1`, [id]);
    expect(row).toMatchObject({ login_id: 'w8b-new-edit.Two', email_verified: false, phone_verified: false, hired_on: '2026-09-01' });
    const [log] = await q<{ before: unknown; after: unknown }>(`SELECT before, after FROM log WHERE entity = 'STAFF' AND entity_id = $1 AND action = 'update'`, [id]);
    const text = JSON.stringify(log);
    expect(text).not.toMatch(/01099990000|01077778888|w8b-new-edit2@|w8b-new-edit@/);
    // 아이디는 연락처가 아니다 — 바뀐 칸으로 그대로 남는다(이메일 모양 아이디만 가린다)
    expect(log.before).toMatchObject({ loginId: 'w8b-new-edit' });
    expect(log.after).toMatchObject({ name: '고친 이름', loginId: 'w8b-new-edit.Two', role: 'manager', tz: 'America/New_York' });
    // 새 아이디로 들어오고(대소문자 무시) 옛 아이디는 안 된다
    await login('W8B-NEW-EDIT.TWO', TEMP);
    await request(app.getHttpServer()).post('/auth/login').send({ loginId: 'w8b-new-edit', password: TEMP }).expect(401);
    // 이메일·직함·휴대폰은 빈 글로 비운다 — 휴대폰을 비워도 확인은 풀린 채다
    const cleared = await api('patch', `/drawer/staff/${id}`).send({ title: '', phone: '', email: '' }).expect(200);
    expect(cleared.body).toMatchObject({ title: null, phone: null, email: null, loginId: 'w8b-new-edit.Two' });
    // 이메일 모양의 아이디는 기록에서 가린다(옛 계정의 아이디는 그때의 이메일이다)
    await api('patch', `/drawer/staff/${id}`).send({ loginId: 'w8b-new-edit3@t.kr' }).expect(200);
    const [mailLike] = await q<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM log WHERE entity = 'STAFF' AND entity_id = $1 AND action = 'update' ORDER BY id DESC LIMIT 1`, [id]);
    expect(mailLike.after).toMatchObject({ loginId: 'w8***@t.kr' });
    expect(JSON.stringify(mailLike)).not.toContain('w8b-new-edit3@');
  });

  // N-104 (대표 결정 2026-09-26 「첫 설정 다시 걸기」) — 확인되지 않은 연락처로 비밀번호 찾기가 가지 않게
  it('수정 N-104 — 이메일·휴대폰을 바꾸면 그 사람은 다음 요청부터 첫 설정을 다시 한다(세션은 그대로 · 아이디 · 다른 칸은 걸지 않는다)', async () => {
    const id = await make('w8b-new-redo', { email: 'w8b-new-redo@t.kr', phone: '01012120000' });
    await q(`UPDATE staff SET must_change_credentials = false, email_verified = true, phone_verified = true WHERE id = $1`, [id]);
    const token = await login('w8b-new-redo', TEMP);
    await api('get', '/drawer', token).expect(200);

    // 연락처가 아닌 칸은 첫 설정을 걸지 않는다 — 아이디도 연락처가 아니다(W10 · 세션도 그대로)
    const titled = await api('patch', `/drawer/staff/${id}`).send({ title: '영어', loginId: 'w8b-new-redo.b' }).expect(200);
    expect(titled.body).toMatchObject({ loginId: 'w8b-new-redo.b', mustChangeCredentials: false });
    await api('get', '/drawer', token).expect(200);

    // 휴대폰(해외 번호 · N-103)을 바꾸면 — 그 사람의 다음 요청부터 첫 설정으로 막힌다. 세션은 끊지 않는다(me 는 열린다)
    const phoned = await api('patch', `/drawer/staff/${id}`).send({ phone: '+1 415-555-0123' }).expect(200);
    expect(phoned.body).toMatchObject({ phone: '+14155550123', mustChangeCredentials: true });
    const blocked = await api('get', '/drawer', token).expect(403);
    expect(blocked.body.code).toBe('CREDENTIALS_CHANGE_REQUIRED');
    expect((await api('get', '/auth/me', token).expect(200)).body.mustChangeCredentials).toBe(true);
    const [row] = await q<{ must_change_credentials: boolean; email_verified: boolean; phone_verified: boolean }>(
      `SELECT must_change_credentials, email_verified, phone_verified FROM staff WHERE id = $1`, [id]);
    expect(row).toEqual({ must_change_credentials: true, email_verified: true, phone_verified: false });
    const [log] = await q<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT before, after FROM log WHERE entity = 'STAFF' AND entity_id = $1 AND action = 'update' ORDER BY id DESC LIMIT 1`, [id]);
    expect(log.before).toMatchObject({ phone: '010-****-0000', mustChangeCredentials: false });
    expect(log.after).toMatchObject({ phone: '+1 ****0123', mustChangeCredentials: true });
    expect(JSON.stringify(log)).not.toMatch(/4155550123|01012120000/);

    // 이미 첫 설정 중이어도 이메일을 바꾸면 그대로 걸린 채다(두 번 걸어도 같다)
    const mailed = await api('patch', `/drawer/staff/${id}`).send({ email: 'w8b-new-redo2@t.kr' }).expect(200);
    expect(mailed.body).toMatchObject({ email: 'w8b-new-redo2@t.kr', mustChangeCredentials: true });
    // 이메일을 비워도 연락처가 바뀐 것이다 — 확인이 풀리고 첫 설정이 걸린다(W10 · 이메일은 선택)
    await q(`UPDATE staff SET must_change_credentials = false, email_verified = true WHERE id = $1`, [id]);
    const emptied = await api('patch', `/drawer/staff/${id}`).send({ email: null }).expect(200);
    expect(emptied.body).toMatchObject({ email: null, mustChangeCredentials: true });
    expect((await q<{ email_verified: boolean }>(`SELECT email_verified FROM staff WHERE id = $1`, [id]))[0].email_verified).toBe(false);
    // 목록 밖 나라 번호는 400 — 번호 원문은 오류에 싣지 않는다
    const bad = await api('patch', `/drawer/staff/${id}`).send({ phone: '+84 912 345 678' }).expect(400);
    expect(bad.body.code).toBe('STAFF_PHONE_INVALID');
    expect(JSON.stringify(bad.body)).not.toContain('912345678');
    // 서랍은 국가번호 목록을 싣는다 — 첫 줄 대한민국(N-103)
    const drawer = (await api('get', '/drawer').expect(200)).body;
    expect(drawer.phoneCountries[0]).toEqual({ code: '82', label: '대한민국' });
  });

  it('수정의 거절 — 대표·관리자 줄 403 · 자기 역할 403 · 같은 아이디 · 이메일(대소문자 무시) 409 · 아이디 규칙 400 · 모르는 시간대 409 · 휴대폰 400 · 빈 수정 409 · 없는 id 404 · 강사 403 · 역할 ceo 400', async () => {
    const id = await make('w8b-new-rej');
    const code = (c: string) => (r: request.Response) => expect(r.body.code).toBe(c);
    await api('patch', `/drawer/staff/${CEO}`).send({ name: '가져가기' }).expect(403).expect(code('STAFF_PROTECTED'));
    await api('patch', `/drawer/staff/${ADMIN}`).send({ email: 'w8b-mine@t.kr' }).expect(403).expect(code('STAFF_PROTECTED'));
    await api('patch', `/drawer/staff/${MGR}`).send({ role: 'teacher' }).expect(403).expect(code('SELF_ROLE'));
    await api('patch', `/drawer/staff/${id}`).send({ email: 'W8B-T@T.KR' }).expect(409).expect(code('STAFF_EMAIL_TAKEN'));
    await api('patch', `/drawer/staff/${id}`).send({ loginId: 'W8B-T@T.KR' }).expect(409).expect(code('STAFF_LOGIN_ID_TAKEN'));
    await api('patch', `/drawer/staff/${id}`).send({ loginId: 'w8b new' }).expect(400).expect(code('LOGIN_ID_RULE'));
    await api('patch', `/drawer/staff/${id}`).send({ loginId: '' }).expect(400).expect(code('LOGIN_ID_RULE'));
    await api('patch', `/drawer/staff/${id}`).send({ loginId: null }).expect(400);
    await api('patch', `/drawer/staff/${id}`).send({ email: 'not-email' }).expect(400);
    // 대소문자만 바꾸는 것은 자기 아이디라 된다
    await api('patch', `/drawer/staff/${id}`).send({ loginId: 'W8B-NEW-REJ' }).expect(200);
    await api('patch', `/drawer/staff/${id}`).send({ tz: 'Mars/Olympus' }).expect(409).expect(code('TZ_UNKNOWN'));
    await api('patch', `/drawer/staff/${id}`).send({ phone: '1234' }).expect(400).expect(code('STAFF_PHONE_INVALID'));
    await api('patch', `/drawer/staff/${id}`).send({}).expect(409).expect(code('EMPTY_PATCH'));
    await api('patch', `/drawer/staff/${id}`).send({ name: '새 사람' }).expect(409).expect(code('EMPTY_PATCH'));
    await api('patch', `/drawer/staff/${id}`).send({ loginId: 'W8B-NEW-REJ' }).expect(409).expect(code('EMPTY_PATCH'));
    await api('patch', `/drawer/staff/99999999`).send({ name: '없음' }).expect(404).expect(code('STAFF_NOT_FOUND'));
    await api('patch', `/drawer/staff/${id}`, tokens.teacher).send({ name: '강사가' }).expect(403);
    await api('patch', `/drawer/staff/${id}`).send({ role: 'ceo' }).expect(400);
    await api('patch', `/drawer/staff/${id}`).send({ name: null }).expect(400);
    await api('patch', `/drawer/staff/${id}`).send({ wageRate: 50000 }).expect(400);
    // 대표·관리자 줄은 그대로다
    expect((await q<{ name: string }>(`SELECT name FROM staff WHERE id = $1`, [CEO]))[0].name).toBe('표대표');
    // 자기 이름은 바꿀 수 있다 — 막는 것은 역할뿐
    await api('patch', `/drawer/staff/${MGR}`).send({ name: '표매니저' , title: '실장' }).expect(200);
  });

  /* ── 4. 비밀번호 초기화 ───────────────────────────────────────────────── */
  it('비밀번호 초기화 — 매니저가 적은 임시 비밀번호 · 첫 설정 다시 · 세션 끊는 시각을 적고, 그 줄을 돌려준다(비밀번호는 응답 · 기록에 없다) (W10)', async () => {
    const before = new Date(Date.now() - 1000);
    const res = await api('post', `/drawer/staff/${TEACHER2}/password-reset`).send({ password: TEMP2 }).expect(201);
    expect(res.body).toMatchObject({ id: TEACHER2, loginId: 'w8b-t2@t.kr', mustChangeCredentials: true });
    expect(res.body).not.toHaveProperty('initialPassword');
    expect(JSON.stringify(res.body)).not.toContain(TEMP2);
    const [row] = await q<{ password_hash: string; must_change_credentials: boolean; credentials_changed_at: Date }>(
      `SELECT password_hash, must_change_credentials, credentials_changed_at FROM staff WHERE id = $1`, [TEACHER2]);
    expect(await bcrypt.compare(TEMP2, row.password_hash)).toBe(true);
    expect(await bcrypt.compare(PW, row.password_hash)).toBe(false);
    expect(row.must_change_credentials).toBe(true);
    expect(new Date(row.credentials_changed_at).getTime()).toBeGreaterThan(before.getTime());
    const [log] = await q<{ before: unknown; after: unknown }>(`SELECT before, after FROM log WHERE entity = 'STAFF' AND entity_id = $1 AND action = 'password_reset'`, [TEACHER2]);
    expect(JSON.stringify(log)).not.toContain(TEMP2);
    expect(JSON.stringify(log)).not.toMatch(/hash|\$2[aby]\$/);
    // 그 임시 비밀번호로 들어오고 첫 설정 대상이다
    const again = await request(app.getHttpServer()).post('/auth/login').send({ loginId: 'w8b-t2@t.kr', password: TEMP2 }).expect(201);
    expect(again.body.user.mustChangeCredentials).toBe(true);
  });

  it('비밀번호 초기화의 거절 — 임시 비밀번호 없음 · 규칙 밖 400 · 자기 것 403 SELF_RESET · 대표 403 STAFF_PROTECTED · 강사 403 · 없는 id 404 · 대표 비밀번호는 그대로', async () => {
    await api('post', `/drawer/staff/${TEACHER2}/password-reset`).send({}).expect(400);
    const rule = await api('post', `/drawer/staff/${TEACHER2}/password-reset`).send({ password: 'short1' }).expect(400);
    expect(rule.body).toMatchObject({ code: 'PASSWORD_RULE', message: PASSWORD_ISSUE_MESSAGE.TOO_SHORT });
    const ok = { password: TEMP2 };
    await api('post', `/drawer/staff/${MGR}/password-reset`).send(ok).expect(403).expect((r) => expect(r.body.code).toBe('SELF_RESET'));
    await api('post', `/drawer/staff/${CEO}/password-reset`).send(ok).expect(403).expect((r) => expect(r.body.code).toBe('STAFF_PROTECTED'));
    await api('post', `/drawer/staff/${ADMIN}/password-reset`).send(ok).expect(403);
    await api('post', `/drawer/staff/${TEACHER}/password-reset`, tokens.teacher).send(ok).expect(403);
    await api('post', `/drawer/staff/99999999/password-reset`).send(ok).expect(404);
    const [ceo] = await q<{ password_hash: string; must_change_credentials: boolean }>(`SELECT password_hash, must_change_credentials FROM staff WHERE id = $1`, [CEO]);
    expect(await bcrypt.compare(PW, ceo.password_hash)).toBe(true);
    expect(ceo.must_change_credentials).toBe(false);
  });

  /* ── 5. 사용 중지 ─────────────────────────────────────────────────────── */
  it('사용 중지 — 그 계정은 다음 요청부터 막히고 로그인도 안 된다 · 다시 사용하면 돌아온다 · 자기·대표 403', async () => {
    const id = await make('w8b-new-act');
    const off = await api('patch', `/drawer/staff/${id}/active`).send({ active: false }).expect(200);
    expect(off.body).toMatchObject({ id, active: false });
    const [log] = await q<{ action: string }>(`SELECT action FROM log WHERE entity = 'STAFF' AND entity_id = $1 AND action IN ('deactivate','activate') ORDER BY id`, [id]);
    expect(log.action).toBe('deactivate');
    // 이미 받은 토큰도 다음 요청에서 막힌다 — 기존 활성 검사(요청마다 STAFF 를 다시 읽는다)
    await api('patch', `/drawer/staff/${TEACHER}/active`).send({ active: false }).expect(200);
    await api('get', '/drawer', tokens.teacher).expect(401);
    await request(app.getHttpServer()).post('/auth/login').send({ loginId: 'w8b-t@t.kr', password: PW }).expect(401);
    await api('patch', `/drawer/staff/${TEACHER}/active`).send({ active: true }).expect(200);
    tokens.teacher = await login('w8b-t@t.kr');
    await api('patch', `/drawer/staff/${MGR}/active`).send({ active: false }).expect(403).expect((r) => expect(r.body.code).toBe('SELF_ACTIVE'));
    await api('patch', `/drawer/staff/${CEO}/active`).send({ active: false }).expect(403).expect((r) => expect(r.body.code).toBe('STAFF_PROTECTED'));
    await api('patch', `/drawer/staff/${id}/active`).send({ active: 'no' }).expect(400);
    await api('patch', `/drawer/staff/${id}/active`, tokens.teacher).send({ active: true }).expect(403);
    expect((await q<{ active: boolean }>(`SELECT active FROM staff WHERE id = $1`, [CEO]))[0].active).toBe(true);
  });

  /* ── 6. 삭제 ──────────────────────────────────────────────────────────── */
  it('삭제 — 기록 없는 새 계정은 지워지고(자기 인증 코드는 같이) 기록에 지운 줄이 남는다', async () => {
    const id = await make('w8b-new-del', { title: '임시' });
    await q(`INSERT INTO auth_code (staff_id, channel, target_hash, target_masked, code_hash, expires_at)
             VALUES ($1,'email',repeat('a',64),'w8***@t.kr',repeat('b',64), now() + interval '10 minutes')`, [id]);
    await api('delete', `/drawer/staff/${id}`).expect(200).expect((r) => expect(r.body).toEqual({ ok: true }));
    expect(await q(`SELECT id FROM staff WHERE id = $1`, [id])).toEqual([]);
    expect(await q(`SELECT id FROM auth_code WHERE staff_id = $1`, [id])).toEqual([]);
    const [log] = await q<{ actor_id: string; before: Record<string, unknown> }>(
      `SELECT actor_id, before FROM log WHERE entity = 'STAFF' AND entity_id = $1 AND action = 'delete'`, [id]);
    expect(Number(log.actor_id)).toBe(MGR);
    expect(log.before).toMatchObject({ name: '새 사람', role: 'teacher', title: '임시' });
    expect(JSON.stringify(log.before)).not.toMatch(/w8b-new-del|hash|password/i);
  });

  it('삭제의 거절 — 시급 줄 · 조용히 같이 지워질 줄(CASCADE) · FK 로 막히는 줄이 있으면 409 이고 아무것도 안 사라진다 · 자기·대표·강사는 403', async () => {
    const msg = '기록이 있는 구성원은 지울 수 없습니다 — 사용 중지로 막아 주세요';
    // ① 시급 줄 — FK 가 없는 칸이라 서버가 직접 묻는다
    const withWage = await make('w8b-new-wage', { wageRate: 41000 });
    await api('delete', `/drawer/staff/${withWage}`).expect(409).expect((r) => {
      expect(r.body.code).toBe('STAFF_HAS_RECORDS');
      expect(r.body.message).toBe(msg);
    });
    expect(await q(`SELECT id FROM staff WHERE id = $1`, [withWage])).toHaveLength(1);
    expect(await q(`SELECT id FROM wage WHERE staff_id = $1`, [withWage])).toHaveLength(1);
    // ② CASCADE FK(pnoti) — 지우면 조용히 같이 사라질 줄이다. 먼저 물어 막는다
    const withPnoti = await make('w8b-new-pnoti');
    await q(`INSERT INTO pnoti (channel, body, audience, staff_id) VALUES ('app','수업 알림','teacher',$1)`, [withPnoti]);
    await api('delete', `/drawer/staff/${withPnoti}`).expect(409).expect((r) => expect(r.body.code).toBe('STAFF_HAS_RECORDS'));
    expect(await q(`SELECT id FROM pnoti WHERE staff_id = $1`, [withPnoti])).toHaveLength(1);
    expect(await q(`SELECT id FROM staff WHERE id = $1`, [withPnoti])).toHaveLength(1);
    // ③ NO ACTION FK(file.uploaded_by) — DB 가 23503 으로 막고 서버가 409 로 바꾼다
    const withFile = await make('w8b-new-file');
    await q(`INSERT INTO file (kind, name, mime, bytes, sha256, data, uploaded_by) VALUES ('report-png','a.png','image/png',1,repeat('c',64),'\\x00'::bytea,$1)`, [withFile]);
    await api('delete', `/drawer/staff/${withFile}`).expect(409).expect((r) => expect(r.body.code).toBe('STAFF_HAS_RECORDS'));
    expect(await q(`SELECT id FROM staff WHERE id = $1`, [withFile])).toHaveLength(1);
    expect(await q(`SELECT id FROM file WHERE uploaded_by = $1`, [withFile])).toHaveLength(1);
    // 막힌 삭제는 기록도 남기지 않는다
    expect(await q(`SELECT id FROM log WHERE entity = 'STAFF' AND entity_id = ANY($1) AND action = 'delete'`, [[withWage, withPnoti, withFile]])).toEqual([]);
    // 자기 · 대표 · 관리자 · 강사
    await api('delete', `/drawer/staff/${MGR}`).expect(403).expect((r) => expect(r.body.code).toBe('SELF_DELETE'));
    await api('delete', `/drawer/staff/${CEO}`).expect(403).expect((r) => expect(r.body.code).toBe('STAFF_PROTECTED'));
    await api('delete', `/drawer/staff/${ADMIN}`).expect(403);
    await api('delete', `/drawer/staff/${withPnoti}`, tokens.teacher).expect(403);
    await api('delete', `/drawer/staff/99999999`).expect(404);
    expect(await q(`SELECT id FROM staff WHERE id = ANY($1)`, [[CEO, ADMIN, MGR]])).toHaveLength(3);
  });

  /* ── 7. 목록이 낡지 않는가 ────────────────────────────────────────────── */
  it('ERD 의 STAFF 참조는 모두 「DB FK」이거나 「FK 없는 칸 목록(STAFF_SOFT_REFS)」에 있다 — 새 표가 조용히 빠지지 않는다', async () => {
    const dbml = readFileSync(join(__dirname, '..', 'src', 'entities', 'erd.dbml.snapshot'), 'utf8');
    const refs = new Set<string>();
    let table = '';
    for (const line of dbml.split('\n')) {
      const t = /^Table\s+(\w+)/.exec(line);
      if (t) table = t[1].toLowerCase();
      // 한 줄에 여러 칸이 있는 표(CONS_PICK · MTATTD)도 본다 — 「칸 bigint [ref: > STAFF.id」 모양만 고른다
      for (const m of line.matchAll(/(\w+)\s+bigint\s+\[[^\]]*ref:\s*>\s*STAFF\.id/g)) {
        if (table) refs.add(`${table}.${m[1]}`);
      }
    }
    expect(refs.size).toBeGreaterThan(60);
    const fks = new Set((await staffForeignKeys(ds)).map((fk) => `${fk.table}.${fk.column}`));
    const soft = new Set(STAFF_SOFT_REFS.map(([t, c]) => `${t}.${c}`));
    const missing = [...refs].filter((r) => !fks.has(r) && !soft.has(r));
    expect(missing).toEqual([]);
    // 목록의 칸은 실제로 있고, FK 가 선 칸은 목록에 두지 않는다(두 벌이 되지 않게)
    const cols = await q<{ c: string }>(
      `SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public'`);
    const have = new Set(cols.map((r) => r.c));
    expect([...soft].filter((s) => !have.has(s))).toEqual([]);
    expect([...soft].filter((s) => fks.has(s))).toEqual([]);
    expect(STAFF_OWN_TABLES).toEqual(['auth_code']);
  });
});
