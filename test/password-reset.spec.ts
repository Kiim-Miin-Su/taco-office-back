/** @file-guide
 * 목적: password-reset.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 비밀번호 찾기 (N-101 · 대표 결정 2026-09-26 「로그인 화면의 비밀번호 찾기 — 등록된 이메일과 휴대폰 코드를 둘 다 확인해야
 * 새 비밀번호를 정한다 · 옛 세션은 끊는다 · 모든 역할」).
 *
 * 로그인 전 경로라 **계정이 있는지 새지 않는가**를 되는 쪽만큼 센다 — 없는 계정 · 확인 안 된 계정 · 사용 중지 계정 · 한도 ·
 * 발송 실패가 모두 같은 답인지, 마치기의 거절이 한 문장인지, 「지금 비밀번호와 같다」가 코드 없이 새지 않는지.
 * 발송기는 가짜(`FakeSender`)로 갈아 끼운다 — 실제 SMTP · SENS 로 나가지 않는다. DATABASE_URL 이 없으면 건너뛴다.
 */
import { Controller, Get, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ApiErrorFilter } from '../src/common/filters/api-error.filter';
import { buildOpenApi } from '../src/openapi';
import { SENDER, SMS_MAX_BYTES, smsBytes } from '../src/modules/notify/sender';
import { PASSWORD_ISSUE_MESSAGE, PASSWORD_RULE_TEXT } from '../src/lib/account-policy';
import { CODE_DAILY_LIMIT, SECRET_MISSING_REASON } from '../src/auth/auth-code';
import { RESET_CODE_INVALID_MESSAGE } from '../src/auth/password-reset.service';
import { FakeSender } from './fake-sender';

/** 옛 세션이 끊기는지 보려고 만든 끝점 — 인증만 요구한다 */
@Controller('probe-reset')
class ProbeController {
  @Get('any')
  any() { return { ok: true }; }
}

const d = process.env.DATABASE_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('비밀번호 찾기 (N-101)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const fake = new FakeSender();
  const PW = 'Current-pass-1234';
  const NEW_PW = 'Recovered-pass-55';
  const IDS = { ready: 9_000_000_000_971, unverified: 9_000_000_000_972, abroad: 9_000_000_000_973, off: 9_000_000_000_974 } as const;
  const PEOPLE = [
    // 첫 설정을 마친 계정 — 이메일 · 휴대폰 확인됨
    { id: IDS.ready, name: '찾기', email: 'n101-ready@t.kr', phone: '01055556666', verified: true, active: true },
    // 첫 설정 전 계정 — 확인 안 됨(비밀번호 찾기를 쓸 수 없다)
    { id: IDS.unverified, name: '확인전', email: 'n101-unverified@t.kr', phone: '01077778888', verified: false, active: true },
    // 해외 번호 계정 (N-103)
    { id: IDS.abroad, name: '해외', email: 'n101-abroad@t.kr', phone: '+14155550123', verified: true, active: true },
    // 사용 중지 계정
    { id: IDS.off, name: '중지', email: 'n101-off@t.kr', phone: '01099990000', verified: true, active: false },
  ];
  const ALL = PEOPLE.map((p) => p.id);

  const server = () => app.getHttpServer();
  const reset = async () => {
    await ds.query('DELETE FROM auth_code WHERE staff_id = ANY($1)', [ALL]);
    await ds.query(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = ANY($1)`, [ALL]);
    const hash = await bcrypt.hash(PW, 4);
    for (const p of PEOPLE) {
      await ds.query(
        `UPDATE staff SET email=$2, phone=$3, password_hash=$4, email_verified=$5, phone_verified=$5,
                must_change_credentials=NOT $5, credentials_changed_at=NULL, active=$6 WHERE id=$1`,
        [p.id, p.email, p.phone, hash, p.verified, p.active],
      );
    }
    fake.readyMap = { email: true, sms: true };
    fake.reply = () => ({ configured: true, ok: true, providerId: 'fake-1', error: null });
    fake.calls = [];
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule], controllers: [ProbeController] })
      .overrideProvider(SENDER).useValue(fake)
      .compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiErrorFilter());
    await app.init();
    ds = app.get(DataSource);
    await ds.query('DELETE FROM staff WHERE id = ANY($1)', [ALL]);
    for (const p of PEOPLE) {
      await ds.query(
        `INSERT INTO staff (id, name, email, role, password_hash, active) VALUES ($1,$2,$3,'teacher','x',true)`,
        [p.id, p.name, p.email],
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

  const askCode = (email: string, channel: string) =>
    request(server()).post('/auth/password-reset/codes').send({ email, channel });
  const lastCode = (channel: 'email' | 'sms') => {
    const call = [...fake.calls].reverse().find((c) => c.channel === channel);
    return /\d{6}/.exec(call?.body ?? '')?.[0] ?? '';
  };
  const complete = (body: Record<string, unknown>) => request(server()).post('/auth/password-reset/complete').send(body);
  const rows = (id: number) => ds.query(
    'SELECT channel, purpose, attempts, consumed_at FROM auth_code WHERE staff_id=$1 ORDER BY id', [id],
  ) as Promise<Array<{ channel: string; purpose: string; attempts: number; consumed_at: Date | null }>>;
  /** 두 코드를 받아 두고 맞는 본문을 만든다 */
  const prepared = async (email = 'n101-ready@t.kr') => {
    await askCode(email, 'email').expect(201);
    await askCode(email, 'sms').expect(201);
    return { email, emailCode: lastCode('email'), phoneCode: lastCode('sms'), password: NEW_PW };
  };
  const login = async (email: string, password: string) => {
    const res = await request(server()).post('/auth/login').send({ email, password }).expect(201);
    return { access: res.body.accessToken as string, cookies: res.headers['set-cookie'] as unknown as string[], body: res.body };
  };
  /** 계정 여부가 새지 않는지 볼 때 — 만료 시각은 요청마다 다르므로 뺀 모양 */
  const shape = (body: Record<string, unknown>) => ({ ...body, expiresAt: typeof body.expiresAt });

  describe('GET /auth/password-reset — 토큰 없이 읽는 안내', () => {
    it('비밀번호 규칙 · 코드 시간 · 채널을 서버 낱말로 싣는다', async () => {
      const res = await request(server()).get('/auth/password-reset').expect(200);
      expect(res.body).toEqual({
        passwordRule: PASSWORD_RULE_TEXT, codeTtlMinutes: 10, resendAfterSeconds: 60,
        channels: [
          { channel: 'email', label: '메일', ready: true, notReadyReason: null },
          { channel: 'sms', label: '문자', ready: true, notReadyReason: null },
        ],
      });
    });
  });

  describe('POST /auth/password-reset/codes', () => {
    it('확인된 계정이면 등록된 이메일 · 휴대폰으로 보낸다 — 받는 곳을 적게 하지 않는다 · 응답에 코드 · 받는 곳이 없다', async () => {
      const email = await askCode(' N101-Ready@T.kr ', 'email').expect(201);
      const sms = await askCode('n101-ready@t.kr', 'sms').expect(201);
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[0]).toMatchObject({ channel: 'email', to: 'n101-ready@t.kr', subject: '[티엔아카데미] 비밀번호 찾기 코드' });
      expect(fake.calls[1]).toMatchObject({ channel: 'sms', to: '01055556666' });
      expect(smsBytes(fake.calls[1].body)).toBeLessThanOrEqual(SMS_MAX_BYTES);
      expect(fake.calls[1].body).toContain('비밀번호 찾기');
      for (const res of [email, sms]) {
        expect(res.body).toMatchObject({ resendAfterSeconds: 60 });
        expect(res.body.devCode).toBeUndefined();
        const text = JSON.stringify(res.body);
        for (const secret of [lastCode('email'), lastCode('sms'), '01055556666', '5555', 'n101-ready']) expect(text).not.toContain(secret);
      }
      expect(email.body.message).toContain('이메일');
      expect(sms.body.message).toContain('휴대폰');
      const ledger = await rows(IDS.ready);
      expect(ledger.map((r) => [r.channel, r.purpose])).toEqual([['email', 'password_reset'], ['sms', 'password_reset']]);
    });

    it('없는 계정 · 확인 안 된 계정 · 사용 중지 계정도 같은 201 · 같은 문장이고 아무것도 보내지 않는다', async () => {
      const real = shape((await askCode('n101-ready@t.kr', 'sms').expect(201)).body);
      fake.calls = [];
      for (const email of ['n101-nobody@t.kr', 'n101-unverified@t.kr', 'n101-off@t.kr']) {
        const res = await askCode(email, 'sms').expect(201);
        expect(shape(res.body)).toEqual(real);
      }
      expect(fake.calls).toHaveLength(0);
      expect(await rows(IDS.unverified)).toHaveLength(0);
      expect(await rows(IDS.off)).toHaveLength(0);
    });

    it('한도(60초 · 하루)에 걸려도 같은 201 이다 — 다르게 답하면 그 아이디가 있다는 것이 드러난다', async () => {
      const first = shape((await askCode('n101-ready@t.kr', 'email').expect(201)).body);
      const again = await askCode('n101-ready@t.kr', 'email').expect(201);
      expect(shape(again.body)).toEqual(first);
      expect(fake.calls).toHaveLength(1);
      // 하루 한도 — 첫 설정 코드와 같은 예산(N-105)
      for (let i = 0; i < CODE_DAILY_LIMIT; i += 1) {
        await ds.query(
          `INSERT INTO auth_code (staff_id, channel, purpose, target_hash, target_masked, code_hash, expires_at, created_at)
           VALUES ($1,'sms','onboarding',$2,'x',$2, now() - make_interval(mins => $3) + interval '10 minutes', now() - make_interval(mins => $3))`,
          [IDS.ready, 'f'.repeat(64), 70 + i * 60],
        );
      }
      const limited = await askCode('n101-ready@t.kr', 'sms').expect(201);
      const nobody = await askCode('n101-nobody@t.kr', 'sms').expect(201);
      expect(shape(limited.body)).toEqual(shape(nobody.body));
      expect(fake.calls.filter((c) => c.channel === 'sms')).toHaveLength(0);
    });

    it('발송이 실패해도 같은 201 이고 그 코드는 쓸 수 없게 닫힌다', async () => {
      fake.reply = (req) => ({ configured: true, ok: false, providerId: null, error: `rejected ${req.to}` });
      const res = await askCode('n101-ready@t.kr', 'email').expect(201);
      expect(res.body.message).toContain('이메일');
      expect(JSON.stringify(res.body)).not.toContain('rejected');
      const [row] = await rows(IDS.ready);
      expect(row.consumed_at).not.toBeNull();
    });

    it.each([
      [{ email: 'not-an-email', channel: 'email' }],
      [{ email: 'n101-ready@t.kr', channel: 'fax' }],
      [{ email: 'n101-ready@t.kr' }],
      [{ email: 'n101-ready@t.kr', channel: 'email', target: 'me@evil.kr' }],
    ])('잘못된 입력은 400 이고 보내지 않는다 — 받는 곳(target)을 따로 적을 수 없다: %p', async (body) => {
      await request(server()).post('/auth/password-reset/codes').send(body).expect(400);
      expect(fake.calls).toHaveLength(0);
      expect(await rows(IDS.ready)).toHaveLength(0);
    });

    it('해외 번호 계정은 국제 문자 인증 문장으로 그 번호에 보낸다 (N-103)', async () => {
      await askCode('n101-abroad@t.kr', 'sms').expect(201);
      expect(fake.calls[0]).toMatchObject({ channel: 'sms', to: '+14155550123' });
      expect(fake.calls[0].body).toMatch(/^\[TN Academy\] verification: \d{6}$/);
    });

    describe('서버 설정 — 계정과 무관한 503', () => {
      const saved = { node: process.env.NODE_ENV, secret: process.env.AUTH_CODE_SECRET, echo: process.env.AUTH_CODE_DEV_ECHO };
      afterEach(() => {
        process.env.NODE_ENV = saved.node;
        if (saved.secret === undefined) delete process.env.AUTH_CODE_SECRET; else process.env.AUTH_CODE_SECRET = saved.secret;
        if (saved.echo === undefined) delete process.env.AUTH_CODE_DEV_ECHO; else process.env.AUTH_CODE_DEV_ECHO = saved.echo;
      });

      it('발송 설정이 없으면 없는 계정에도 같은 503 SENDER_NOT_CONFIGURED', async () => {
        fake.readyMap = { email: false, sms: false };
        for (const email of ['n101-ready@t.kr', 'n101-nobody@t.kr']) {
          expect((await askCode(email, 'email').expect(503)).body.code).toBe('SENDER_NOT_CONFIGURED');
        }
        expect(await rows(IDS.ready)).toHaveLength(0);
      });

      it('운영에 AUTH_CODE_SECRET 이 없으면 안내가 채널을 잠그고 코드 받기 · 마치기가 503 AUTH_CODE_SECRET_MISSING', async () => {
        process.env.NODE_ENV = 'production';
        delete process.env.AUTH_CODE_SECRET;
        const info = await request(server()).get('/auth/password-reset').expect(200);
        expect(info.body.channels.map((c: { ready: boolean; notReadyReason: string }) => [c.ready, c.notReadyReason]))
          .toEqual([[false, SECRET_MISSING_REASON], [false, SECRET_MISSING_REASON]]);
        expect((await askCode('n101-ready@t.kr', 'email').expect(503)).body.code).toBe('AUTH_CODE_SECRET_MISSING');
        const done = await complete({ email: 'n101-ready@t.kr', emailCode: '123456', phoneCode: '123456', password: NEW_PW }).expect(503);
        expect(done.body.code).toBe('AUTH_CODE_SECRET_MISSING');
        expect(fake.calls).toHaveLength(0);
      });

      it('개발용 되돌려 주기는 코드를 실제로 만든 계정에만 실린다(운영이 아닐 때만)', async () => {
        fake.readyMap = { email: false, sms: false };
        process.env.AUTH_CODE_DEV_ECHO = 'on';
        const real = await askCode('n101-ready@t.kr', 'email').expect(201);
        expect(real.body.devCode).toMatch(/^\d{6}$/);
        const none = await askCode('n101-nobody@t.kr', 'email').expect(201);
        expect(none.body.devCode).toBeUndefined();
        expect(fake.calls).toHaveLength(0);
      });
    });
  });

  describe('POST /auth/password-reset/complete — 거절', () => {
    it('규칙에 맞지 않는 비밀번호는 계정과 무관하게 400 PASSWORD_RULE (첫 설정과 같은 문장)', async () => {
      const body = await prepared();
      for (const email of ['n101-ready@t.kr', 'n101-nobody@t.kr']) {
        const res = await complete({ ...body, email, password: 'short1' }).expect(400);
        expect(res.body).toEqual({ code: 'PASSWORD_RULE', message: PASSWORD_ISSUE_MESSAGE.TOO_SHORT });
      }
    });

    it('없는 계정 · 확인 안 된 계정 · 사용 중지 계정 · 틀린 코드가 모두 같은 409 RESET_CODE_INVALID 한 문장이다', async () => {
      const body = await prepared();
      const want = { code: 'RESET_CODE_INVALID', message: RESET_CODE_INVALID_MESSAGE };
      for (const email of ['n101-nobody@t.kr', 'n101-unverified@t.kr', 'n101-off@t.kr']) {
        expect((await complete({ ...body, email }).expect(409)).body).toEqual(want);
      }
      const wrong = body.emailCode === '000000' ? '111111' : '000000';
      expect((await complete({ ...body, emailCode: wrong }).expect(409)).body).toEqual(want);
      const wrongPhone = body.phoneCode === '000000' ? '111111' : '000000';
      expect((await complete({ ...body, phoneCode: wrongPhone }).expect(409)).body).toEqual(want);
      // 틀린 횟수는 실패한 요청 뒤에도 남는다 — 코드마다 다섯 번이면 끝이다
      const ledger = await rows(IDS.ready);
      expect(ledger.find((r) => r.channel === 'email')?.attempts).toBe(1);
      expect(ledger.find((r) => r.channel === 'sms')?.attempts).toBe(1);
      // 비밀번호는 그대로다
      const [s] = await ds.query('SELECT password_hash FROM staff WHERE id=$1', [IDS.ready]);
      expect(await bcrypt.compare(PW, s.password_hash)).toBe(true);
    });

    it('다섯 번 틀린 코드는 맞게 적어도 거절 · 만료된 코드도 거절 — 같은 한 문장', async () => {
      const body = await prepared();
      await ds.query(`UPDATE auth_code SET attempts = 5 WHERE staff_id=$1 AND channel='sms'`, [IDS.ready]);
      expect((await complete(body).expect(409)).body.code).toBe('RESET_CODE_INVALID');
      await ds.query(`UPDATE auth_code SET attempts = 0 WHERE staff_id=$1`, [IDS.ready]);
      await ds.query(
        `UPDATE auth_code SET created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes'
          WHERE staff_id=$1 AND channel='email'`, [IDS.ready],
      );
      expect((await complete(body).expect(409)).body.code).toBe('RESET_CODE_INVALID');
    });

    it('용도가 다른 코드는 서로 쓰지 못한다 — 첫 설정 코드로 비밀번호를 바꾸지 못하고 그 반대도 안 된다', async () => {
      const body = await prepared();
      await ds.query(`UPDATE auth_code SET purpose = 'onboarding' WHERE staff_id=$1`, [IDS.ready]);
      expect((await complete(body).expect(409)).body.code).toBe('RESET_CODE_INVALID');
      // 반대 — 첫 설정 중인(확인은 된) 계정이 받은 비밀번호 찾기 코드는 첫 설정을 마치지 못한다
      await ds.query('DELETE FROM auth_code WHERE staff_id=$1', [IDS.ready]);
      await ds.query('UPDATE staff SET must_change_credentials = true WHERE id=$1', [IDS.ready]);
      const codes = await prepared();
      const { access } = await login('n101-ready@t.kr', PW);
      const res = await request(server()).post('/auth/onboarding/complete').set('Authorization', `Bearer ${access}`).send({
        email: 'n101-ready@t.kr', password: NEW_PW, phone: '01055556666', emailCode: codes.emailCode, phoneCode: codes.phoneCode,
      }).expect(409);
      expect(res.body.code).toBe('CODE_NOT_REQUESTED');
    });

    it('「지금 비밀번호와 같다」는 두 코드를 확인한 뒤에만 말한다 — 코드 없이 비밀번호를 떠볼 수 없다', async () => {
      const body = await prepared();
      const wrong = body.emailCode === '000000' ? '111111' : '000000';
      expect((await complete({ ...body, emailCode: wrong, password: PW }).expect(409)).body.code).toBe('RESET_CODE_INVALID');
      expect((await complete({ ...body, password: PW }).expect(409)).body.code).toBe('SAME_AS_CURRENT');
      // 코드는 닫지 않는다 — 다른 비밀번호로 곧바로 마칠 수 있다
      await complete(body).expect(204);
    });
  });

  describe('POST /auth/password-reset/complete — 성공', () => {
    it('비밀번호만 바꾸고 옛 세션을 끊는다 · 코드를 모두 닫는다 · 기록에 비밀 값이 없다 · 첫 설정 상태는 그대로', async () => {
      const old = await login('n101-ready@t.kr', PW);
      const body = await prepared(' N101-READY@t.kr ');
      // 토큰 발급 시각(iat)은 초 단위다 — 옛 토큰과 변경이 같은 초에 겹치지 않게 다음 초까지 기다린다
      await new Promise((r) => setTimeout(r, 1_050 - (Date.now() % 1_000)));
      const res = await complete(body).expect(204);
      expect(res.text).toBe('');
      expect(res.headers['set-cookie']).toBeUndefined();

      const [s] = await ds.query('SELECT * FROM staff WHERE id=$1', [IDS.ready]);
      expect(s).toMatchObject({
        email: 'n101-ready@t.kr', phone: '01055556666', email_verified: true, phone_verified: true, must_change_credentials: false,
      });
      expect(s.credentials_changed_at).not.toBeNull();
      expect(await bcrypt.compare(NEW_PW, s.password_hash)).toBe(true);
      expect((await rows(IDS.ready)).every((r) => r.consumed_at !== null)).toBe(true);

      const logs = await ds.query(`SELECT * FROM log WHERE entity='STAFF' AND entity_id=$1 AND action='password_recover'`, [IDS.ready]);
      expect(logs).toHaveLength(1);
      expect(Number(logs[0].actor_id)).toBe(IDS.ready);
      expect(logs[0].after).toEqual({ verified: ['email', 'sms'], sessionsCut: true });
      const logged = JSON.stringify([logs[0].before, logs[0].after]);
      for (const secret of [NEW_PW, PW, body.emailCode, body.phoneCode, '01055556666', 'n101-ready', s.password_hash]) {
        expect(logged).not.toContain(secret);
      }

      // 옛 세션은 끊긴다
      await request(server()).get('/probe-reset/any').set('Authorization', `Bearer ${old.access}`).expect(401);
      await request(server()).post('/auth/refresh').set('Cookie', old.cookies).expect(401);
      // 새 비밀번호로 들어가고 옛 것은 안 된다 · 쓴 코드는 다시 쓰지 못한다
      await login('n101-ready@t.kr', NEW_PW);
      await request(server()).post('/auth/login').send({ email: 'n101-ready@t.kr', password: PW }).expect(401);
      expect((await complete({ ...body, password: 'Another-pass-88' }).expect(409)).body.code).toBe('RESET_CODE_INVALID');
    });

    it('첫 설정이 걸린(관리자 초기화) 계정도 찾을 수 있지만 첫 설정은 건너뛰지 못한다', async () => {
      await ds.query('UPDATE staff SET must_change_credentials = true WHERE id=$1', [IDS.ready]);
      await complete(await prepared()).expect(204);
      const { body } = await login('n101-ready@t.kr', NEW_PW);
      expect(body.user.mustChangeCredentials).toBe(true);
    });

    it('해외 번호 계정도 두 코드로 마친다 (N-103)', async () => {
      await complete(await prepared('n101-abroad@t.kr')).expect(204);
      await login('n101-abroad@t.kr', NEW_PW);
    });
  });

  it('OpenAPI — 세 경로는 토큰 없이 부르고(security: {}) · 마치기는 204 본문 없음', () => {
    const doc = buildOpenApi(app);
    expect(doc.paths['/auth/password-reset']?.get?.security).toEqual([{}]);
    for (const path of ['/auth/password-reset/codes', '/auth/password-reset/complete']) {
      expect(doc.paths[path]?.post?.security).toEqual([{}]);
      expect(doc.paths[path]?.post?.responses['503']).toBeDefined();
    }
    expect(doc.paths['/auth/password-reset/codes']?.post?.responses['201']).toBeDefined();
    expect(doc.paths['/auth/password-reset/codes']?.post?.responses['429']).toBeUndefined();
    const done = doc.paths['/auth/password-reset/complete']?.post?.responses ?? {};
    expect(done['204']).toBeDefined();
    expect(done['409']).toBeDefined();
    expect(done['201']).toBeUndefined();
  });
});
