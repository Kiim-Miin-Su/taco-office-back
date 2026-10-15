/** @file-guide
 * 목적: auth-self-profile.spec.ts — AUTH-SELF-01 본인 프로필·연락처 변경의 HTTP·DB 회귀 (test)
 * 책임/재사용: 실제 앱과 가짜 발송기로 본인 경로의 입력 방어·원자성·세션 교체를 센다. 제품 규칙을 시험에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * AUTH-SELF-01 (사용자 결정 2026-10-16) — 마이페이지에서 본인 이름 · 영어 이름을 고치고, 휴대폰 · 이메일은 새 수신처의
 * 코드와 지금 비밀번호로 확인한 뒤에만 바꾼다. 여기서 세는 것:
 *   ① 경로에 사람 id 가 없다 — 대상은 세션의 본인뿐 · role/id/verified/email/phone 을 PATCH 에 실으면 400.
 *   ② 이름 규칙(1~40자 · 앞뒤 공백 제외) · 영어 이름 생략=유지 · null/빈 글자=비움 · DB 재조회 · 셸 이름(Me) · 구성원 목록 영어 이름.
 *   ③ 연락처 변경: 성공 전에는 지금 값 · 인증이 그대로 · 틀린 코드 · 다른 용도 코드 · 다른 사람 코드 · 틀린 비밀번호 · 같은 값 ·
 *      남의 이메일 거절 · 성공은 값 + 인증 + 코드 닫기 + 세션 교체(옛 토큰 401) + 가린 감사 줄.
 *   ④ 필수 초기설정이 남은 계정은 이 경로를 못 쓴다(AllowWhileOnboarding 이 아니다).
 * 발송기는 가짜(`FakeSender`)다. DATABASE_URL 이 없으면 건너뛴다. 고정 id 픽스처만 넣고 지운다.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ApiErrorFilter } from '../src/common/filters/api-error.filter';
import { SENDER, SMS_MAX_BYTES, smsBytes } from '../src/modules/notify/sender';
import { insertCode } from '../src/auth/auth-code';
import { PHONE_COUNTRIES } from '../src/lib/phone';
import { FakeSender } from './fake-sender';

const d = process.env.DATABASE_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('AUTH-SELF-01 본인 프로필 · 연락처 변경', () => {
  let app: INestApplication;
  let ds: DataSource;
  const fake = new FakeSender();
  const PW = 'Self-profile-pass-1';
  const IDS = { me: 9_000_000_001_801, teacher: 9_000_000_001_802, other: 9_000_000_001_803, locked: 9_000_000_001_804 } as const;
  const PEOPLE = [
    { id: IDS.me, name: '본인', loginId: 'self-profile-me', email: 'self-me@t.kr', phone: '01066660001', role: 'manager', must: false },
    { id: IDS.teacher, name: '본인강사', loginId: 'self-profile-teacher', email: 'self-teacher@t.kr', phone: '01066660002', role: 'teacher', must: false },
    { id: IDS.other, name: '남의계정', loginId: 'self-profile-other', email: 'self-other@t.kr', phone: '01066660003', role: 'teacher', must: false },
    { id: IDS.locked, name: '잠긴계정', loginId: 'self-profile-locked', email: 'self-locked@t.kr', phone: '01066660004', role: 'manager', must: true },
  ] as const;
  const ALL = PEOPLE.map((p) => p.id);
  const server = () => app.getHttpServer();
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = async (loginId: string, password = PW) => {
    const res = await request(server()).post('/auth/login').send({ loginId, password }).expect(201);
    return res.body.accessToken as string;
  };
  const lastCode = (channel: 'email' | 'sms') => {
    const call = [...fake.calls].reverse().find((c) => c.channel === channel);
    return /\d{6}/.exec(call?.body ?? '')?.[0] ?? '';
  };
  const staffRow = async (id: number) => {
    const [r] = await ds.query(
      `SELECT name, english_name, email, phone, email_verified, phone_verified, must_change_credentials, credentials_changed_at
         FROM staff WHERE id=$1`, [id],
    );
    return r as {
      name: string; english_name: string | null; email: string | null; phone: string | null;
      email_verified: boolean; phone_verified: boolean; must_change_credentials: boolean; credentials_changed_at: Date | null;
    };
  };
  const logs = (id: number, action: string) =>
    ds.query(`SELECT before, after FROM log WHERE entity='STAFF' AND entity_id=$1 AND action=$2 ORDER BY id`, [id, action]) as
      Promise<Array<{ before: Record<string, unknown>; after: Record<string, unknown> }>>;

  const reset = async () => {
    await ds.query('DELETE FROM auth_code WHERE staff_id = ANY($1)', [ALL]);
    await ds.query(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = ANY($1)`, [ALL]);
    const hash = await bcrypt.hash(PW, 4);
    for (const p of PEOPLE) {
      await ds.query(
        `UPDATE staff SET name=$2, english_name=NULL, login_id=$3, email=$4, phone=$5, password_hash=$6, must_change_credentials=$7,
                email_verified=true, phone_verified=true, credentials_changed_at=NULL, active=true WHERE id=$1`,
        [p.id, p.name, p.loginId, p.email, p.phone, hash, p.must],
      );
    }
    fake.readyMap = { email: true, sms: true };
    fake.reply = () => ({ configured: true, ok: true, providerId: 'fake-1', error: null });
    fake.calls = [];
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(SENDER).useValue(fake).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiErrorFilter());
    await app.init();
    ds = app.get(DataSource);
    await ds.query('DELETE FROM auth_code WHERE staff_id = ANY($1)', [ALL]);
    await ds.query('DELETE FROM staff WHERE id = ANY($1)', [ALL]);
    for (const p of PEOPLE) {
      await ds.query(
        `INSERT INTO staff (id, name, login_id, role, password_hash, active, hired_on) VALUES ($1,$2,$3,$4,'x',true,'2026-06-01')`,
        [p.id, p.name, p.loginId, p.role],
      );
    }
  });

  beforeEach(reset);

  afterAll(async () => {
    await ds?.query('DELETE FROM auth_code WHERE staff_id = ANY($1)', [ALL]);
    await ds?.query(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = ANY($1)`, [ALL]);
    await ds?.query('DELETE FROM staff WHERE id = ANY($1)', [ALL]);
    await app?.close();
  });

  describe('GET /auth/profile', () => {
    it('본인 최소 정보와 코드 안내를 싣고 비밀 · 권한 칸은 싣지 않는다', async () => {
      const t = await login('self-profile-me');
      const res = await request(server()).get('/auth/profile').set(bearer(t)).expect(200);
      expect(res.body).toMatchObject({
        id: IDS.me, loginId: 'self-profile-me', name: '본인', englishName: null, roleLabel: '매니저',
        email: 'self-me@t.kr', emailVerified: true, phone: '01066660001', phoneVerified: true, hiredOn: '2026-06-01',
      });
      expect(res.body.contactCodes).toMatchObject({ codeTtlMinutes: 10, resendAfterSeconds: 60, phoneCountries: PHONE_COUNTRIES });
      expect(res.body.contactCodes.channels.map((c: { channel: string }) => c.channel)).toEqual(['email', 'sms']);
      for (const key of ['passwordHash', 'password_hash', 'credentialsChangedAt', 'mustChangeCredentials', 'canMoney', 'role']) {
        expect(res.body).not.toHaveProperty(key);
      }
    });

    it('필수 초기설정이 남은 계정은 프로필 세 경로 모두 403 CREDENTIALS_CHANGE_REQUIRED', async () => {
      const t = await login('self-profile-locked');
      // supertest 요청은 하나씩 만든다(만드는 순간 서버를 띄운다)
      for (const req of [
        () => request(server()).get('/auth/profile').set(bearer(t)),
        () => request(server()).patch('/auth/profile').set(bearer(t)).send({ name: '바꿈' }),
        () => request(server()).post('/auth/profile/contact-codes').set(bearer(t)).send({ channel: 'email', target: 'locked-new@t.kr' }),
        () => request(server()).post('/auth/profile/contact-change').set(bearer(t))
          .send({ channel: 'email', target: 'locked-new@t.kr', code: '123456', currentPassword: PW }),
      ]) {
        expect((await req().expect(403)).body.code).toBe('CREDENTIALS_CHANGE_REQUIRED');
      }
      expect(fake.calls).toHaveLength(0);
      expect((await staffRow(IDS.locked)).name).toBe('잠긴계정');
    });

    it('로그인이 없으면 401', async () => {
      await request(server()).get('/auth/profile').expect(401);
    });
  });

  describe('PATCH /auth/profile — 이름 · 영어 이름', () => {
    it('이름은 앞뒤 공백을 지워 저장하고 Me(셸 이름) · 재조회 · 감사 줄이 같다 · 생략한 영어 이름은 그대로', async () => {
      const t = await login('self-profile-me');
      await request(server()).patch('/auth/profile').set(bearer(t)).send({ englishName: 'Kim Bon' }).expect(200);
      const res = await request(server()).patch('/auth/profile').set(bearer(t)).send({ name: '  새이름  ' }).expect(200);
      expect(res.body).toMatchObject({ name: '새이름', englishName: 'Kim Bon' });
      expect((await request(server()).get('/auth/me').set(bearer(t)).expect(200)).body.name).toBe('새이름');
      expect((await request(server()).get('/auth/profile').set(bearer(t)).expect(200)).body).toMatchObject({ name: '새이름', englishName: 'Kim Bon' });
      const row = await staffRow(IDS.me);
      expect(row).toMatchObject({ name: '새이름', english_name: 'Kim Bon', credentials_changed_at: null });
      const audit = await logs(IDS.me, 'profile_update');
      expect(audit).toHaveLength(2);
      // 바뀐 칸만 싣는다 — 두 번째 요청은 이름만 바꿨다
      expect(audit[1]).toEqual({ before: { name: '본인' }, after: { name: '새이름' } });
    });

    it.each([[null], ['   '], ['']])('영어 이름 %p 는 비운다(NULL) — 이름은 그대로', async (value) => {
      const t = await login('self-profile-me');
      await request(server()).patch('/auth/profile').set(bearer(t)).send({ englishName: 'Kim Bon' }).expect(200);
      const res = await request(server()).patch('/auth/profile').set(bearer(t)).send({ englishName: value }).expect(200);
      expect(res.body).toMatchObject({ name: '본인', englishName: null });
      expect((await staffRow(IDS.me)).english_name).toBeNull();
    });

    it('아무것도 바뀌지 않으면 쓰지 않고 기록도 남기지 않는다', async () => {
      const t = await login('self-profile-me');
      await request(server()).patch('/auth/profile').set(bearer(t)).send({}).expect(200);
      await request(server()).patch('/auth/profile').set(bearer(t)).send({ name: '본인' }).expect(200);
      expect(await logs(IDS.me, 'profile_update')).toHaveLength(0);
    });

    it.each([
      [{ name: '' }], [{ name: '   ' }], [{ name: null }], [{ name: 'ㄱ'.repeat(41) }], [{ englishName: 'A'.repeat(41) }],
      [{ name: 7 }], [{ role: 'ceo' }], [{ id: IDS.other }], [{ emailVerified: true }], [{ phoneVerified: true }],
      [{ email: 'swap@t.kr' }], [{ phone: '01011112222' }], [{ mustChangeCredentials: false }], [{ loginId: 'stolen' }],
    ])('잘못된 칸 · 허용하지 않은 칸은 400 이고 DB 는 그대로다: %p', async (body) => {
      const t = await login('self-profile-me');
      const before = await staffRow(IDS.me);
      expect((await request(server()).patch('/auth/profile').set(bearer(t)).send(body).expect(400)).body.code).toBeDefined();
      expect(await staffRow(IDS.me)).toEqual(before);
      expect(await logs(IDS.me, 'profile_update')).toHaveLength(0);
    });

    it('강사의 영어 이름은 구성원 목록 · 상세 projection 에 그대로 실린다(타인 수정 경로는 없다)', async () => {
      const teacher = await login('self-profile-teacher');
      await request(server()).patch('/auth/profile').set(bearer(teacher)).send({ englishName: 'Teacher Kim' }).expect(200);
      const manager = await login('self-profile-me');
      const list = await request(server()).get('/drawer/staff-directory')
        .query({ search: '본인강사' }).set(bearer(manager)).expect(200);
      const row = (list.body.items as Array<{ id: number; englishName: string | null }>).find((i) => i.id === IDS.teacher);
      expect(row?.englishName).toBe('Teacher Kim');
      const detail = await request(server()).get(`/drawer/staff-directory/${IDS.teacher}`).set(bearer(manager)).expect(200);
      expect(detail.body.profile.englishName).toBe('Teacher Kim');
      // 같은 상세의 감사 목록이 본인 수정 줄을 제 이름으로 읽는다(허용 칸만 · 「기타 변경」이 아니다)
      expect(detail.body.audit[0]).toMatchObject({
        actionLabel: '본인 정보 수정', changes: [{ field: '영어 이름', before: null, after: 'Teacher Kim' }],
      });
      // 연락처 변경 줄은 가린 값도 공개 칸으로 내보내지 않는다
      const code = await (async () => {
        await request(server()).post('/auth/profile/contact-codes').set(bearer(teacher)).send({ channel: 'email', target: 'teacher-moved@t.kr' }).expect(201);
        return lastCode('email');
      })();
      await request(server()).post('/auth/profile/contact-change').set(bearer(teacher))
        .send({ channel: 'email', target: 'teacher-moved@t.kr', code, currentPassword: PW }).expect(201);
      const after = await request(server()).get(`/drawer/staff-directory/${IDS.teacher}`).set(bearer(manager)).expect(200);
      expect(after.body.audit[0]).toMatchObject({ actionLabel: '본인 연락처 변경', changes: [] });
      expect(after.body.audit[0].privateFields).toEqual(expect.arrayContaining(['연락처', '인증 상태']));
      expect(JSON.stringify(after.body.audit)).not.toContain('teacher-moved');
    });
  });

  describe('POST /auth/profile/contact-codes', () => {
    it('새 이메일로 연락처 변경 코드를 보내고 원장에는 용도 · 해시 · 가린 모양만 남는다', async () => {
      const t = await login('self-profile-me');
      const res = await request(server()).post('/auth/profile/contact-codes').set(bearer(t))
        .send({ channel: 'email', target: '  NEW-Me@T.kr ' }).expect(201);
      expect(res.body).toMatchObject({ channel: 'email', resendAfterSeconds: 60 });
      expect(res.body.devCode).toBeUndefined();
      expect(fake.calls[0]).toMatchObject({ channel: 'email', to: 'new-me@t.kr' });
      expect(`${fake.calls[0].subject} ${fake.calls[0].body}`).toContain('연락처 변경');
      const code = lastCode('email');
      const [row] = await ds.query('SELECT * FROM auth_code WHERE staff_id=$1', [IDS.me]);
      expect(row.purpose).toBe('contact_change');
      expect(JSON.stringify(row)).not.toContain(code);
      expect(JSON.stringify(row)).not.toContain('new-me@t.kr');
      // 지금 값은 코드 받기만으로 바뀌지 않는다
      expect(await staffRow(IDS.me)).toMatchObject({ email: 'self-me@t.kr', email_verified: true });
    });

    it('문자도 한 통(90바이트) 안에 연락처 변경 문장으로 간다', async () => {
      const t = await login('self-profile-me');
      await request(server()).post('/auth/profile/contact-codes').set(bearer(t)).send({ channel: 'sms', target: '010-5555-1212' }).expect(201);
      expect(fake.calls[0].to).toBe('01055551212');
      expect(fake.calls[0].body).toContain('연락처 변경');
      expect(smsBytes(fake.calls[0].body)).toBeLessThanOrEqual(SMS_MAX_BYTES);
    });

    it.each([
      [{ channel: 'email', target: 'Self-Me@t.kr' }, 409, 'CONTACT_UNCHANGED'],
      [{ channel: 'sms', target: '010-6666-0001' }, 409, 'CONTACT_UNCHANGED'],
      [{ channel: 'email', target: 'SELF-OTHER@t.kr' }, 409, 'EMAIL_TAKEN'],
      [{ channel: 'email', target: 'not-an-email' }, 400, 'INVALID_EMAIL'],
      [{ channel: 'sms', target: '02-123-4567' }, 400, 'INVALID_PHONE'],
      [{ channel: 'fax', target: 'x@t.kr' }, 400, undefined],
      [{ channel: 'email' }, 400, undefined],
      [{ channel: 'email', target: 'x@t.kr', staffId: IDS.other }, 400, undefined],
    ])('%p → %d %s · 보내지 않는다', async (body, status, code) => {
      const t = await login('self-profile-me');
      const res = await request(server()).post('/auth/profile/contact-codes').set(bearer(t)).send(body).expect(status);
      if (code) expect(res.body.code).toBe(code);
      expect(fake.calls).toHaveLength(0);
      expect(await ds.query('SELECT 1 FROM auth_code WHERE staff_id=$1', [IDS.me])).toHaveLength(0);
    });

    it('같은 채널은 60초 뒤에 다시 받는다 — 첫 설정 · 비밀번호 찾기와 같은 한도', async () => {
      const t = await login('self-profile-me');
      await request(server()).post('/auth/profile/contact-codes').set(bearer(t)).send({ channel: 'email', target: 'a1@t.kr' }).expect(201);
      expect((await request(server()).post('/auth/profile/contact-codes').set(bearer(t))
        .send({ channel: 'email', target: 'a2@t.kr' }).expect(429)).body.code).toBe('CODE_TOO_SOON');
    });

    it('발송 설정이 없으면 503 이고 줄을 만들지 않는다 · 공급자 실패는 502 이고 그 코드는 닫힌다', async () => {
      const t = await login('self-profile-me');
      fake.readyMap = { email: false, sms: true };
      expect((await request(server()).post('/auth/profile/contact-codes').set(bearer(t))
        .send({ channel: 'email', target: 'b1@t.kr' }).expect(503)).body.code).toBe('SENDER_NOT_CONFIGURED');
      fake.reply = () => ({ configured: true, ok: false, providerId: null, error: 'x' });
      expect((await request(server()).post('/auth/profile/contact-codes').set(bearer(t))
        .send({ channel: 'sms', target: '010-4444-1212' }).expect(502)).body.code).toBe('SEND_FAILED');
      const rows = await ds.query('SELECT consumed_at FROM auth_code WHERE staff_id=$1', [IDS.me]);
      expect(rows).toHaveLength(1);
      expect(rows[0].consumed_at).not.toBeNull();
    });
  });

  describe('POST /auth/profile/contact-change', () => {
    const ask = async (t: string, channel: 'email' | 'sms', target: string) => {
      await request(server()).post('/auth/profile/contact-codes').set(bearer(t)).send({ channel, target }).expect(201);
      return lastCode(channel);
    };
    const change = (t: string, body: Record<string, unknown>) =>
      request(server()).post('/auth/profile/contact-change').set(bearer(t)).send(body);

    it('코드 · 지금 비밀번호가 맞으면 한 transaction 으로 값 · 인증 · 코드 닫기 · 세션 교체 · 가린 감사 줄', async () => {
      const t = await login('self-profile-me');
      const code = await ask(t, 'email', 'Moved-Me@t.kr');
      const res = await change(t, { channel: 'email', target: 'moved-me@T.KR', code, currentPassword: PW }).expect(201);
      expect(res.body.user).toMatchObject({ id: IDS.me, mustChangeCredentials: false });
      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies.some((c) => c.startsWith('taco_rt='))).toBe(true);
      const row = await staffRow(IDS.me);
      expect(row).toMatchObject({ email: 'moved-me@t.kr', email_verified: true, phone: '01066660001', phone_verified: true });
      expect(row.credentials_changed_at).not.toBeNull();
      // 옛 세션은 끊기고 새 세션으로 이어진다
      await request(server()).get('/auth/profile').set(bearer(t)).expect(401);
      const fresh = await request(server()).get('/auth/profile').set(bearer(res.body.accessToken)).expect(200);
      expect(fresh.body).toMatchObject({ email: 'moved-me@t.kr', emailVerified: true });
      expect(await ds.query('SELECT 1 FROM auth_code WHERE staff_id=$1 AND consumed_at IS NULL', [IDS.me])).toHaveLength(0);
      const audit = await logs(IDS.me, 'contact_change');
      expect(audit).toHaveLength(1);
      expect(audit[0].after).toMatchObject({ channel: 'email', verified: true, sessionsCut: true });
      const raw = JSON.stringify(audit);
      expect(raw).not.toContain('moved-me@t.kr');
      expect(raw).not.toContain('self-me@t.kr');
      expect(raw).not.toContain(code);
      // 새 이메일로 로그인 아이디가 바뀌지 않는다 — 아이디는 매니저가 정한 그대로
      await login('self-profile-me');
    });

    it('휴대폰도 같은 길이다 — 해외 번호는 +국가번호 모양으로 저장한다', async () => {
      const t = await login('self-profile-me');
      const code = await ask(t, 'sms', '+1 415 555 0101');
      await change(t, { channel: 'sms', target: '+1 415 555 0101', code, currentPassword: PW }).expect(201);
      expect(await staffRow(IDS.me)).toMatchObject({ phone: '+14155550101', phone_verified: true, email: 'self-me@t.kr' });
    });

    it('틀린 코드는 409 CODE_MISMATCH 이고 지금 값 · 인증이 그대로다', async () => {
      const t = await login('self-profile-me');
      const code = await ask(t, 'email', 'c1@t.kr');
      const wrong = code === '000000' ? '111111' : '000000';
      const before = await staffRow(IDS.me);
      expect((await change(t, { channel: 'email', target: 'c1@t.kr', code: wrong, currentPassword: PW }).expect(409)).body.code)
        .toBe('CODE_MISMATCH');
      expect(await staffRow(IDS.me)).toEqual(before);
    });

    it('지금 비밀번호가 틀리면 409 CURRENT_PASSWORD_MISMATCH · 그 코드의 틀린 횟수가 남고 맞게 다시 적으면 된다', async () => {
      const t = await login('self-profile-me');
      const code = await ask(t, 'email', 'c2@t.kr');
      const before = await staffRow(IDS.me);
      const res = await change(t, { channel: 'email', target: 'c2@t.kr', code, currentPassword: 'Wrong-pass-123' }).expect(409);
      expect(res.body).toMatchObject({ code: 'CURRENT_PASSWORD_MISMATCH' });
      expect(res.body.message).toContain('4번');
      expect(await staffRow(IDS.me)).toEqual(before);
      const [row] = await ds.query('SELECT attempts, consumed_at FROM auth_code WHERE staff_id=$1', [IDS.me]);
      expect(row).toEqual({ attempts: 1, consumed_at: null });
      await change(t, { channel: 'email', target: 'c2@t.kr', code, currentPassword: PW }).expect(201);
    });

    it('비밀번호를 다섯 번 틀린 코드는 맞는 비밀번호로도 쓸 수 없다(CODE_LOCKED)', async () => {
      const t = await login('self-profile-me');
      const code = await ask(t, 'email', 'c3@t.kr');
      for (let i = 0; i < 5; i += 1) {
        await change(t, { channel: 'email', target: 'c3@t.kr', code, currentPassword: `Wrong-pass-${i}` }).expect(409);
      }
      expect((await change(t, { channel: 'email', target: 'c3@t.kr', code, currentPassword: PW }).expect(409)).body.code).toBe('CODE_LOCKED');
      expect((await staffRow(IDS.me)).email).toBe('self-me@t.kr');
    });

    it('다른 용도(첫 설정 · 비밀번호 찾기) 코드 · 다른 수신처로 받은 코드는 통하지 않는다', async () => {
      const t = await login('self-profile-me');
      // c5 로 받은 코드를 c6 저장에 쓰지 못한다(받는 곳이 코드에 묶여 있다)
      const code = await ask(t, 'email', 'c5@t.kr');
      expect((await change(t, { channel: 'email', target: 'c6@t.kr', code, currentPassword: PW }).expect(409)).body.code)
        .toBe('CODE_NOT_REQUESTED');
      // 같은 수신처로 원장에 직접 넣은 다른 용도 코드 — 용도가 다르면 해시 · 조건이 달라 통하지 않는다
      // (원장에 직접 넣으므로 발급 한도와 무관하다 · 한도는 용도를 가리지 않고 같은 예산이다)
      await ds.transaction(async (m) => {
        await insertCode(m, { staffId: IDS.me, channel: 'email', purpose: 'onboarding', to: 'c4@t.kr', masked: 'c4***', code: '246810' });
        await insertCode(m, { staffId: IDS.me, channel: 'email', purpose: 'password_reset', to: 'c4@t.kr', masked: 'c4***', code: '135791' });
      });
      for (const other of ['246810', '135791']) {
        expect((await change(t, { channel: 'email', target: 'c4@t.kr', code: other, currentPassword: PW }).expect(409)).body.code)
          .toBe('CODE_NOT_REQUESTED');
      }
      expect((await staffRow(IDS.me)).email).toBe('self-me@t.kr');
    });

    it('남의 계정이 받은 코드는 내 저장에 쓰지 못한다 — 대상은 늘 세션의 본인이다', async () => {
      const other = await login('self-profile-other');
      const code = await ask(other, 'email', 'c7@t.kr');
      const me = await login('self-profile-me');
      expect((await change(me, { channel: 'email', target: 'c7@t.kr', code, currentPassword: PW }).expect(409)).body.code)
        .toBe('CODE_NOT_REQUESTED');
      expect((await staffRow(IDS.other)).email).toBe('self-other@t.kr');
      expect((await staffRow(IDS.me)).email).toBe('self-me@t.kr');
    });

    it('코드를 받은 뒤 다른 계정이 그 이메일을 가져가면 409 EMAIL_TAKEN 이고 아무것도 바뀌지 않는다', async () => {
      const t = await login('self-profile-me');
      const code = await ask(t, 'email', 'c8@t.kr');
      await ds.query(`UPDATE staff SET email='c8@t.kr' WHERE id=$1`, [IDS.other]);
      const before = await staffRow(IDS.me);
      expect((await change(t, { channel: 'email', target: 'c8@t.kr', code, currentPassword: PW }).expect(409)).body.code)
        .toBe('EMAIL_TAKEN');
      expect(await staffRow(IDS.me)).toEqual(before);
    });

    it.each([
      [{ channel: 'email', target: 'c9@t.kr', code: '12345', currentPassword: PW }],
      [{ channel: 'email', target: 'c9@t.kr', code: '123456' }],
      [{ channel: 'email', target: '', code: '123456', currentPassword: PW }],
      [{ channel: 'email', target: 'c9@t.kr', code: '123456', currentPassword: PW, staffId: IDS.other }],
      [{ channel: 'email', target: 'c9@t.kr', code: '123456', currentPassword: PW, emailVerified: true }],
    ])('입력 모양이 틀리거나 허용하지 않은 칸이면 400 이고 아무것도 바뀌지 않는다: %p', async (body) => {
      const t = await login('self-profile-me');
      const before = await staffRow(IDS.me);
      await change(t, body).expect(400);
      expect(await staffRow(IDS.me)).toEqual(before);
    });

    it('지금 값과 같은 수신처는 409 CONTACT_UNCHANGED — 연락처를 비우는 입력은 400 이다', async () => {
      const t = await login('self-profile-me');
      expect((await change(t, { channel: 'email', target: 'self-me@t.kr', code: '123456', currentPassword: PW }).expect(409)).body.code)
        .toBe('CONTACT_UNCHANGED');
      expect((await change(t, { channel: 'sms', target: '   ', code: '123456', currentPassword: PW }).expect(400)).body.code)
        .toBe('INVALID_PHONE');
    });

    it('코드를 받은 뒤 관리자가 잠금을 켜면 저장 직전에 403 이다', async () => {
      const t = await login('self-profile-me');
      const code = await ask(t, 'email', 'c10@t.kr');
      await ds.query('UPDATE staff SET must_change_credentials = true WHERE id=$1', [IDS.me]);
      expect((await change(t, { channel: 'email', target: 'c10@t.kr', code, currentPassword: PW }).expect(403)).body.code)
        .toBe('CREDENTIALS_CHANGE_REQUIRED');
      expect((await staffRow(IDS.me)).email).toBe('self-me@t.kr');
    });
  });
});
