/** @file-guide
 * 목적: onboarding.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 계정 첫 설정 · 로그인 아이디 (W8 · W10 · 대표 지시 2026-09-26).
 *
 * W10 부터 아이디는 매니저가 만들 때 정하고(형식 자유) 첫 설정은 **휴대폰 · 이메일 확인 + 새 비밀번호**다 — 아이디는 바꾸지 않는다.
 *
 * 「첫 로그인 시 비밀번호 강제 변경 · phone · email 인증 필수 — 바꾸지 않으면 홈에 들어갈 수 없다」를
 * HTTP 로 직접 두드려 본다. 화면이 돌려보내는 것만으로는 증명이 안 된다 — **서버가 403 으로 막는지**,
 * 코드 거절이 전부 제 이름으로 나오는지, 틀린 횟수가 실패한 요청 뒤에도 남는지, 옛 세션이 끊기는지를 센다.
 *
 * 발송기는 가짜(`FakeSender`)로 갈아 끼운다 — 실제 SMTP · SENS 로 나가지 않는다.
 * DATABASE_URL 이 없으면 건너뛴다(auth.spec 과 같은 이유 · 고정 id 픽스처만 넣고 지운다).
 */
import { Controller, Get, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Public } from '../src/auth/public.decorator';
import { ApiErrorFilter } from '../src/common/filters/api-error.filter';
import { buildOpenApi } from '../src/openapi';
import { Staff } from '../src/entities';
import { SENDER, SMS_MAX_BYTES, smsBytes } from '../src/modules/notify/sender';
import { INITIAL_PASSWORD, PASSWORD_ISSUE_MESSAGE, PASSWORD_RULE_TEXT } from '../src/lib/account-policy';
import { PHONE_COUNTRIES } from '../src/lib/phone';
import { CODE_DAILY_LIMIT, SECRET_MISSING_REASON } from '../src/auth/auth-code';
import { FakeSender } from './fake-sender';

/** 가드가 무엇을 막는지 보려고 만든 끝점 — 인증만 요구하는 보통 API 와 공개 API */
@Controller('probe-onboarding')
class ProbeController {
  @Get('any')
  any() { return { ok: true }; }

  @Public()
  @Get('open')
  open() { return { ok: true }; }
}

const d = process.env.DATABASE_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('계정 첫 설정 · 로그인 아이디 (W8)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const fake = new FakeSender();
  const PW = 'Current-pass-1234';
  const NEW_PW = 'Brand-new-pass-77';
  const IDS = { must: 9_000_000_000_961, normal: 9_000_000_000_962, other: 9_000_000_000_963, noEmail: 9_000_000_000_964 } as const;
  // 앞의 셋은 옮겨 온 옛 계정 모양(아이디 = 그때의 이메일) · 넷째는 W10 에 이메일 없이 만든 계정.
  // `done` = 첫 설정을 마친 계정(두 인증 true) — AUTH-INIT-02 판정은 잠금이 꺼져 있어도 두 인증이 없으면 필수 설정 대상이다
  const PEOPLE = [
    { id: IDS.must, name: '첫설정', loginId: 'w8-must@t.kr', email: 'w8-must@t.kr', role: 'manager', must: true, done: false },
    { id: IDS.normal, name: '보통', loginId: 'W8-Mixed.Case@t.kr', email: 'W8-Mixed.Case@t.kr', role: 'manager', must: false, done: true },
    { id: IDS.other, name: '남의계정', loginId: 'w8-taken@t.kr', email: 'w8-taken@t.kr', role: 'teacher', must: false, done: true },
    { id: IDS.noEmail, name: '이메일없음', loginId: '새강사_01', email: null, role: 'teacher', must: true, done: false },
  ];
  const ALL = PEOPLE.map((p) => p.id);

  const server = () => app.getHttpServer();
  const reset = async () => {
    await ds.query('DELETE FROM auth_code WHERE staff_id = ANY($1)', [ALL]);
    await ds.query(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = ANY($1)`, [ALL]);
    const hash = await bcrypt.hash(PW, 4);
    for (const p of PEOPLE) {
      await ds.query(
        `UPDATE staff SET login_id=$2, email=$3, password_hash=$4, phone=NULL, must_change_credentials=$5, email_verified=$6,
                phone_verified=$6, credentials_changed_at=NULL, active=true WHERE id=$1`,
        [p.id, p.loginId, p.email, hash, p.must, p.done],
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
        `INSERT INTO staff (id, name, login_id, email, role, password_hash, active, must_change_credentials) VALUES ($1,$2,$3,$4,$5,'x',true,$6)`,
        [p.id, p.name, p.loginId, p.email, p.role, p.must],
      );
    }
  });

  beforeEach(reset);

  afterAll(async () => {
    await ds?.query(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = ANY($1)`, [ALL]);
    await ds?.query('DELETE FROM staff WHERE id = ANY($1)', [ALL]);
    await app?.close();
  });

  const login = async (loginId: string, password = PW) => {
    const res = await request(server()).post('/auth/login').send({ loginId, password }).expect(201);
    return { access: res.body.accessToken as string, cookies: res.headers['set-cookie'] as unknown as string[], body: res.body };
  };
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const askCode = (t: string, channel: string, target: string) =>
    request(server()).post('/auth/onboarding/codes').set(bearer(t)).send({ channel, target });
  /** 가짜 발송기가 받은 마지막 본문에서 여섯 자리 코드를 꺼낸다 — 사람이 메일·문자에서 읽는 것과 같다 */
  const lastCode = (channel: 'email' | 'sms') => {
    const call = [...fake.calls].reverse().find((c) => c.channel === channel);
    return /\d{6}/.exec(call?.body ?? '')?.[0] ?? '';
  };
  const complete = (t: string, body: Record<string, unknown>) =>
    request(server()).post('/auth/onboarding/complete').set(bearer(t)).send(body);
  /** 채널 하나 인증하기(2026-10-19) — 코드를 받은 곳과 그 코드 */
  const verify = (t: string, channel: string, target: string, code: string) =>
    request(server()).post('/auth/onboarding/verify').set(bearer(t)).send({ channel, target, code });
  /** 화면이 「인증하기」 아래에 보이는 남은 인증 문장 — 서버 한 곳(onboardingIncomplete)이 만든다 */
  const LEFT = (what: string) => `${what} 인증을 먼저 마쳐 주세요 — 각 칸의 「인증하기」를 눌러 주세요`;
  const codeRows = (channel: string) => ds.query(
    'SELECT id, attempts, consumed_at FROM auth_code WHERE staff_id=$1 AND channel=$2 ORDER BY id', [IDS.must, channel],
  ) as Promise<Array<{ id: string; attempts: number; consumed_at: Date | null }>>;

  describe('로그인 아이디 · 대소문자 구분 없음', () => {
    it('저장된 대소문자와 달라도 같은 계정으로 들어가고 틀린 비밀번호는 없는 계정과 같은 문구다', async () => {
      const ok = await login('w8-mixed.case@T.KR');
      expect(ok.body.user.id).toBe(IDS.normal);
      expect(ok.body.user.mustChangeCredentials).toBe(false);
      const wrong = await request(server()).post('/auth/login').send({ loginId: 'W8-MIXED.CASE@t.kr', password: 'wrong-pass-999' }).expect(401);
      const none = await request(server()).post('/auth/login').send({ loginId: 'w8-nobody@t.kr', password: PW }).expect(401);
      expect(wrong.body.message).toBe(none.body.message);
    });

    it('소문자로 같은 계정이 둘 이상이면 어느 쪽인지 말하지 않고 같은 실패 문구다', async () => {
      const two = await ds.getRepository(Staff).find({ where: [{ id: IDS.normal }, { id: IDS.other }] });
      const spy = jest.spyOn(ds.getRepository(Staff), 'find').mockResolvedValueOnce(two);
      try {
        const res = await request(server()).post('/auth/login').send({ loginId: 'w8-mixed.case@t.kr', password: PW }).expect(401);
        const none = await request(server()).post('/auth/login').send({ loginId: 'w8-nobody@t.kr', password: PW }).expect(401);
        expect(res.body.message).toBe(none.body.message);
      } finally { spy.mockRestore(); }
    });

    it('LoginResult · /auth/me 가 첫 설정 필요 여부를 늘 싣는다', async () => {
      const must = await login('w8-must@t.kr');
      expect(must.body.user.mustChangeCredentials).toBe(true);
      const me = await request(server()).get('/auth/me').set(bearer(must.access)).expect(200);
      expect(me.body.mustChangeCredentials).toBe(true);
    });
  });

  describe('첫 설정 잠금 — 서버가 막는다', () => {
    it('첫 설정 전 계정은 보통 API 가 403 CREDENTIALS_CHANGE_REQUIRED 이고 me · 첫 설정 · 공개 API 만 열린다', async () => {
      const { access, cookies } = await login('w8-must@t.kr');
      const blocked = await request(server()).get('/probe-onboarding/any').set(bearer(access)).expect(403);
      expect(blocked.body.code).toBe('CREDENTIALS_CHANGE_REQUIRED');
      expect(blocked.body.message).toContain('첫 설정');
      // 권한 가드(@Perm)보다 먼저 막는다 — 실제 업무 API 도 같은 답이다
      expect((await request(server()).get('/ops').set(bearer(access)).expect(403)).body.code).toBe('CREDENTIALS_CHANGE_REQUIRED');
      await request(server()).get('/auth/me').set(bearer(access)).expect(200);
      const info = await request(server()).get('/auth/onboarding').set(bearer(access)).expect(200);
      expect(info.body).toMatchObject({
        required: true, loginId: 'w8-must@t.kr', emailMasked: 'w8***@t.kr', phoneMasked: null, passwordRule: PASSWORD_RULE_TEXT,
        codeTtlMinutes: 10, resendAfterSeconds: 60,
      });
      expect(info.body.channels).toEqual([
        { channel: 'email', label: '메일', ready: true, notReadyReason: null },
        { channel: 'sms', label: '문자', ready: true, notReadyReason: null },
      ]);
      // 국가번호 목록은 서버 한 곳(lib/phone)의 표 그대로 — 첫 줄이 대한민국(N-103)
      expect(info.body.phoneCountries).toEqual(PHONE_COUNTRIES);
      expect(info.body.phoneCountries[0]).toEqual({ code: '82', label: '대한민국' });
      await request(server()).get('/probe-onboarding/open').expect(200);
      await request(server()).post('/auth/refresh').set('Cookie', cookies).expect(201);
      // 첫 설정 경로도 로그인은 필요하다
      await request(server()).get('/auth/onboarding').expect(401);
    });

    it('첫 설정이 필요 없는 계정은 보통 API 200 · 안내는 required=false · 코드/완료는 409', async () => {
      const { access } = await login('w8-mixed.case@t.kr');
      await request(server()).get('/probe-onboarding/any').set(bearer(access)).expect(200);
      expect((await request(server()).get('/auth/onboarding').set(bearer(access)).expect(200)).body.required).toBe(false);
      expect((await askCode(access, 'email', 'w8-new@t.kr').expect(409)).body.code).toBe('ONBOARDING_NOT_REQUIRED');
      const res = await complete(access, { password: NEW_PW }).expect(409);
      expect(res.body.code).toBe('ONBOARDING_NOT_REQUIRED');
      expect((await verify(access, 'email', 'w8-new@t.kr', '123456').expect(409)).body.code).toBe('ONBOARDING_NOT_REQUIRED');
      expect(fake.calls).toHaveLength(0);
    });

    it('안내의 채널은 발송기 준비 여부와 발송기 낱말을 그대로 싣는다', async () => {
      fake.readyMap = { email: false, sms: true };
      const { access } = await login('w8-must@t.kr');
      const info = await request(server()).get('/auth/onboarding').set(bearer(access)).expect(200);
      expect(info.body.channels[0]).toEqual({
        channel: 'email', label: '메일', ready: false, notReadyReason: '메일 발송 설정이 없어 보내지 못합니다',
      });
    });
  });

  describe('POST /auth/onboarding/codes', () => {
    it.each([
      [{ channel: 'fax', target: 'w8-new@t.kr' }],
      [{ channel: 'email', target: 'not-an-email' }],
      [{ channel: 'sms', target: '02-123-4567' }],
      [{ channel: 'email' }],
      [{ channel: 'email', target: 'w8-new@t.kr', extra: 1 }],
    ])('잘못된 입력은 400 이고 보내지 않는다: %p', async (body) => {
      const { access } = await login('w8-must@t.kr');
      const res = await request(server()).post('/auth/onboarding/codes').set(bearer(access)).send(body).expect(400);
      expect(res.body.code).toBeDefined();
      expect(fake.calls).toHaveLength(0);
      expect(await codeRows('email')).toHaveLength(0);
    });

    it('남의 계정 이메일은 대소문자가 달라도 409 EMAIL_TAKEN · 내 지금 이메일은 받을 수 있다', async () => {
      const { access } = await login('w8-must@t.kr');
      expect((await askCode(access, 'email', 'W8-TAKEN@t.kr').expect(409)).body.code).toBe('EMAIL_TAKEN');
      expect(fake.calls).toHaveLength(0);
      const own = await askCode(access, 'email', 'W8-Must@t.kr').expect(201);
      expect(own.body).toMatchObject({ channel: 'email', targetMasked: 'w8***@t.kr', resendAfterSeconds: 60 });
      expect(own.body.devCode).toBeUndefined();
      // 응답에 코드가 실리지 않는다 — 코드는 받는 곳으로만 간다
      expect(JSON.stringify(own.body)).not.toContain(lastCode('email'));
      expect(fake.calls[0]).toMatchObject({ channel: 'email', to: 'w8-must@t.kr' });
      expect(fake.calls[0].subject).toBeTruthy();
      expect(`${fake.calls[0].subject} ${fake.calls[0].body}`).not.toMatch(/CODE_|ONBOARDING|W8|D-R/);
    });

    it('원장에는 코드와 받는 곳 원문이 없다 — HMAC 과 가린 모양만', async () => {
      const { access } = await login('w8-must@t.kr');
      await askCode(access, 'sms', '010-2222-3333').expect(201);
      const code = lastCode('sms');
      expect(smsBytes(fake.calls[0].body)).toBeLessThanOrEqual(SMS_MAX_BYTES);
      expect(fake.calls[0].to).toBe('01022223333');
      const [row] = await ds.query('SELECT * FROM auth_code WHERE staff_id=$1', [IDS.must]);
      const raw = JSON.stringify(row);
      expect(raw).not.toContain(code);
      expect(raw).not.toContain('01022223333');
      expect(row.target_masked).toBe('010-****-3333');
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.target_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()).toBe(10 * 60 * 1000);
    });

    it('60초 안에 다시 받으면 429 CODE_TOO_SOON — 남은 초를 말한다', async () => {
      const { access } = await login('w8-must@t.kr');
      await askCode(access, 'email', 'w8-new@t.kr').expect(201);
      const res = await askCode(access, 'email', 'w8-new@t.kr').expect(429);
      expect(res.body.code).toBe('CODE_TOO_SOON');
      expect(res.body.message).toMatch(/\d+초/);
      // 채널이 다르면 따로 센다
      await askCode(access, 'sms', '01022223333').expect(201);
    });

    it('한 시간에 다섯 번을 넘기면 429 CODE_LIMIT (원장 기준 — 서버리스라 메모리 상태가 없다)', async () => {
      for (let i = 2; i <= 6; i += 1) {
        await ds.query(
          `INSERT INTO auth_code (staff_id, channel, target_hash, target_masked, code_hash, expires_at, created_at)
           VALUES ($1,'email',$2,'x***@t.kr',$2, now() - make_interval(mins => $3) + interval '10 minutes', now() - make_interval(mins => $3))`,
          [IDS.must, 'f'.repeat(64), i],
        );
      }
      const { access } = await login('w8-must@t.kr');
      const res = await askCode(access, 'email', 'w8-new@t.kr').expect(429);
      expect(res.body.code).toBe('CODE_LIMIT');
      expect(fake.calls).toHaveLength(0);
    });

    /** 지난 줄을 원장에 직접 넣는다 — `minsAgo` 분 전에 받은 코드(이미 만료) · 용도는 첫 설정 또는 비밀번호 찾기 */
    const pastRows = async (channel: 'email' | 'sms', minsAgo: number[], purpose = 'onboarding') => {
      for (const m of minsAgo) {
        await ds.query(
          `INSERT INTO auth_code (staff_id, channel, purpose, target_hash, target_masked, code_hash, expires_at, created_at)
           VALUES ($1,$2,$3,$4,'x***',$4, now() - make_interval(mins => $5) + interval '10 minutes', now() - make_interval(mins => $5))`,
          [IDS.must, channel, purpose, 'f'.repeat(64), m],
        );
      }
    };

    // N-105 (대표 결정 2026-09-26 「채널별 하루 10번 한도」) — 한 시간 한도에 걸리지 않게 한 시간보다 앞선 줄로 채운다
    it(`하루(24시간) ${CODE_DAILY_LIMIT}번을 넘기면 429 CODE_DAILY_LIMIT — 한 시간을 기다려도 소용없으니 먼저 말한다`, async () => {
      await pastRows('sms', Array.from({ length: CODE_DAILY_LIMIT }, (_, i) => 70 + i * 60));
      const { access } = await login('w8-must@t.kr');
      const res = await askCode(access, 'sms', '01022223333').expect(429);
      expect(res.body.code).toBe('CODE_DAILY_LIMIT');
      expect(res.body.message).toContain(`${CODE_DAILY_LIMIT}번`);
      expect(fake.calls).toHaveLength(0);
      // 채널이 다르면 따로 센다 · 24시간이 지난 줄은 세지 않는다
      await askCode(access, 'email', 'w8-new@t.kr').expect(201);
      await ds.query(`UPDATE auth_code SET created_at = created_at - interval '1 day' WHERE staff_id=$1 AND channel='sms'`, [IDS.must]);
      await askCode(access, 'sms', '01022223333').expect(201);
    });

    it('하루 한도는 용도와 무관하게 센다 — 비밀번호 찾기 코드도 같은 예산이다(문자 요금은 용도를 가리지 않는다)', async () => {
      await pastRows('sms', [70, 130, 190, 250, 310], 'onboarding');
      await pastRows('sms', [370, 430, 490, 550, 610], 'password_reset');
      const { access } = await login('w8-must@t.kr');
      expect((await askCode(access, 'sms', '01022223333').expect(429)).body.code).toBe('CODE_DAILY_LIMIT');
    });

    it('발송 설정이 없으면 503 SENDER_NOT_CONFIGURED 이고 쓸 수 있는 줄을 남기지 않는다', async () => {
      fake.readyMap = { email: false, sms: false };
      const { access } = await login('w8-must@t.kr');
      const res = await askCode(access, 'email', 'w8-new@t.kr').expect(503);
      expect(res.body.code).toBe('SENDER_NOT_CONFIGURED');
      expect(res.body.message).toContain('메일');
      expect(res.body.message).not.toContain('w8-new');
      expect(fake.calls).toHaveLength(0);
      expect(await codeRows('email')).toHaveLength(0);
    });

    describe('개발용 코드 되돌려 주기 — 운영이 아니고 AUTH_CODE_DEV_ECHO=on 일 때만', () => {
      const saved = { node: process.env.NODE_ENV, echo: process.env.AUTH_CODE_DEV_ECHO, secret: process.env.AUTH_CODE_SECRET };
      afterEach(() => {
        process.env.NODE_ENV = saved.node;
        if (saved.echo === undefined) delete process.env.AUTH_CODE_DEV_ECHO; else process.env.AUTH_CODE_DEV_ECHO = saved.echo;
        if (saved.secret === undefined) delete process.env.AUTH_CODE_SECRET; else process.env.AUTH_CODE_SECRET = saved.secret;
      });

      it('두 조건이 다 맞으면 보내지 않고 devCode 를 주며 그 코드가 실제로 맞는다', async () => {
        fake.readyMap = { email: false, sms: false };
        process.env.AUTH_CODE_DEV_ECHO = 'on';
        const { access } = await login('w8-must@t.kr');
        const info = await request(server()).get('/auth/onboarding').set(bearer(access)).expect(200);
        expect(info.body.channels.every((c: { ready: boolean }) => c.ready)).toBe(true);
        const email = await askCode(access, 'email', 'w8-dev@t.kr').expect(201);
        const sms = await askCode(access, 'sms', '01033334444').expect(201);
        expect(email.body.devCode).toMatch(/^\d{6}$/);
        expect(sms.body.devCode).toMatch(/^\d{6}$/);
        expect(fake.calls).toHaveLength(0);
        await verify(access, 'email', 'w8-dev@t.kr', email.body.devCode).expect(201);
        await verify(access, 'sms', '01033334444', sms.body.devCode).expect(201);
        await complete(access, { password: NEW_PW }).expect(201);
      });

      it.each([
        ['production', 'on'],
        ['test', 'off'],
        ['test', undefined],
      ])('NODE_ENV=%s · AUTH_CODE_DEV_ECHO=%s 이면 devCode 없이 503', async (node, echo) => {
        fake.readyMap = { email: false, sms: false };
        const { access } = await login('w8-must@t.kr');
        process.env.NODE_ENV = node;
        // 운영은 코드 비밀 값이 있어야 발급 판정까지 간다(N-105) — 여기서는 되돌려 주기 문만 본다
        process.env.AUTH_CODE_SECRET = 'test-code-secret';
        if (echo === undefined) delete process.env.AUTH_CODE_DEV_ECHO; else process.env.AUTH_CODE_DEV_ECHO = echo;
        const res = await askCode(access, 'email', 'w8-dev@t.kr').expect(503);
        expect(res.body.code).toBe('SENDER_NOT_CONFIGURED');
        expect(res.body.devCode).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toMatch(/\d{6}/);
        expect(await codeRows('email')).toHaveLength(0);
      });
    });

    describe('해외 번호 (N-103 · 대표 결정 2026-09-26 「해외 번호도 받기」)', () => {
      it('국가번호와 번호를 적으면 +국가번호 모양으로 받고 · 국제 문자 인증 문장(90바이트 안)으로 보내며 · 그 모양으로 저장한다', async () => {
        const { access } = await login('w8-must@t.kr');
        const sms = await askCode(access, 'sms', '+1 (415) 555-0123').expect(201);
        expect(sms.body.targetMasked).toBe('+1 ****0123');
        expect(fake.calls[0]).toMatchObject({ channel: 'sms', to: '+14155550123' });
        expect(fake.calls[0].body).toMatch(/^\[TN Academy\] verification: \d{6}$/);
        expect(smsBytes(fake.calls[0].body)).toBeLessThanOrEqual(SMS_MAX_BYTES);
        const [row] = await ds.query(`SELECT target_masked FROM auth_code WHERE staff_id=$1 AND channel='sms'`, [IDS.must]);
        expect(row.target_masked).toBe('+1 ****0123');
        await askCode(access, 'email', 'w8-abroad@t.kr').expect(201);
        // 같은 번호를 다른 모양(공백 · 괄호 없이)으로 적어도 같은 번호다
        await verify(access, 'sms', '+14155550123', lastCode('sms')).expect(201);
        await verify(access, 'email', 'w8-abroad@t.kr', lastCode('email')).expect(201);
        await complete(access, { password: NEW_PW }).expect(201);
        const [s] = await ds.query('SELECT phone, phone_verified FROM staff WHERE id=$1', [IDS.must]);
        expect(s).toEqual({ phone: '+14155550123', phone_verified: true });
      });

      it('+82 로 적은 한국 번호는 지금과 같은 숫자만 모양이다 — 010 으로 받은 코드와 같은 번호', async () => {
        const { access } = await login('w8-must@t.kr');
        await askCode(access, 'sms', '010-2222-3333').expect(201);
        await askCode(access, 'email', 'w8-kr@t.kr').expect(201);
        await verify(access, 'sms', '+82 10-2222-3333', lastCode('sms')).expect(201);
        await verify(access, 'email', 'w8-kr@t.kr', lastCode('email')).expect(201);
        await complete(access, { password: NEW_PW }).expect(201);
        expect((await ds.query('SELECT phone FROM staff WHERE id=$1', [IDS.must]))[0].phone).toBe('01022223333');
      });

      it.each([['+84 912 345 678'], ['+1 123-456-7890'], ['+44 123']])(
        '목록 밖 나라 · 모양이 아닌 번호(%s)는 400 INVALID_PHONE 이고 보내지 않는다', async (target) => {
          const { access } = await login('w8-must@t.kr');
          const res = await askCode(access, 'sms', target).expect(400);
          expect(res.body.code).toBe('INVALID_PHONE');
          expect(res.body.message).toContain('국가번호');
          expect(res.body.message).not.toContain(target.replace(/\D/g, ''));
          expect(fake.calls).toHaveLength(0);
        },
      );
    });

    describe('코드 비밀 값 (N-105 · 대표 결정 2026-09-26 「운영용 코드 비밀 값 분리」)', () => {
      const saved = { node: process.env.NODE_ENV, secret: process.env.AUTH_CODE_SECRET };
      afterEach(() => {
        process.env.NODE_ENV = saved.node;
        if (saved.secret === undefined) delete process.env.AUTH_CODE_SECRET; else process.env.AUTH_CODE_SECRET = saved.secret;
      });

      it('운영에 AUTH_CODE_SECRET 이 없으면 안내가 두 채널을 그 까닭으로 잠그고 · 코드 받기 · 마치기가 503 이며 줄을 남기지 않는다', async () => {
        const { access } = await login('w8-must@t.kr');
        process.env.NODE_ENV = 'production';
        delete process.env.AUTH_CODE_SECRET;
        const info = await request(server()).get('/auth/onboarding').set(bearer(access)).expect(200);
        expect(info.body.channels).toEqual([
          { channel: 'email', label: '메일', ready: false, notReadyReason: SECRET_MISSING_REASON },
          { channel: 'sms', label: '문자', ready: false, notReadyReason: SECRET_MISSING_REASON },
        ]);
        const res = await askCode(access, 'email', 'w8-new@t.kr').expect(503);
        expect(res.body.code).toBe('AUTH_CODE_SECRET_MISSING');
        expect(res.body.message).toContain('AUTH_CODE_SECRET');
        expect((await verify(access, 'email', 'w8-new@t.kr', '123456').expect(503)).body.code).toBe('AUTH_CODE_SECRET_MISSING');
        const done = await complete(access, { password: NEW_PW }).expect(503);
        expect(done.body.code).toBe('AUTH_CODE_SECRET_MISSING');
        expect(fake.calls).toHaveLength(0);
        expect(await codeRows('email')).toHaveLength(0);
      });

      it('AUTH_CODE_SECRET 을 두면 그 값으로 해시한다 — 값이 바뀌면 그 전 코드는 맞지 않는다', async () => {
        const { access } = await login('w8-must@t.kr');
        process.env.AUTH_CODE_SECRET = 'code-secret-A';
        await askCode(access, 'email', 'w8-new@t.kr').expect(201);
        await askCode(access, 'sms', '01012345678').expect(201);
        const emailCode = lastCode('email');
        const phoneCode = lastCode('sms');
        process.env.AUTH_CODE_SECRET = 'code-secret-B';
        expect((await verify(access, 'email', 'w8-new@t.kr', emailCode).expect(409)).body.code).toBe('CODE_NOT_REQUESTED');
        process.env.AUTH_CODE_SECRET = 'code-secret-A';
        await verify(access, 'email', 'w8-new@t.kr', emailCode).expect(201);
        await verify(access, 'sms', '01012345678', phoneCode).expect(201);
        await complete(access, { password: NEW_PW }).expect(201);
      });
    });

    it('발송이 실패하면 502 SEND_FAILED 이고 그 줄은 쓸 수 없게 닫힌다 · 공급자 문장을 되돌려 주지 않는다', async () => {
      fake.reply = (req) => ({ configured: true, ok: false, providerId: null, error: `rejected ${req.to}` });
      const { access } = await login('w8-must@t.kr');
      const res = await askCode(access, 'email', 'w8-new@t.kr').expect(502);
      expect(res.body.code).toBe('SEND_FAILED');
      expect(res.body.message).not.toContain('w8-new');
      const code = lastCode('email');
      const rows = await codeRows('email');
      expect(rows).toHaveLength(1);
      expect(rows[0].consumed_at).not.toBeNull();
      fake.reply = () => ({ configured: true, ok: true, providerId: 'fake-2', error: null });
      const out = await verify(access, 'email', 'w8-new@t.kr', code).expect(409);
      expect(out.body.code).toBe('CODE_NOT_REQUESTED');
      // 받지 못한 코드의 60초 간격은 그대로 센다 — 문장은 「방금 보냈다」가 아니라 「직전 요청」을 말한다(2026-10-19)
      const soon = await askCode(access, 'email', 'w8-new@t.kr').expect(429);
      expect(soon.body.code).toBe('CODE_TOO_SOON');
      expect(soon.body.message).toMatch(/^직전 코드 요청 뒤 60초가 지나야 다시 받을 수 있습니다 — \d+초 뒤에 다시 받아 주세요$/);
      expect(soon.body.message).not.toContain('보냈습니다');
    });
  });

  describe('POST /auth/onboarding/verify — 채널마다 인증하기 (2026-10-19 사용자 지시)', () => {
    /** 두 코드를 받아 둔다. 거절 시험은 한 칸씩 바꿔서 쓴다 */
    const prepared = async () => {
      const { access } = await login('w8-must@t.kr');
      await askCode(access, 'email', 'w8-new@t.kr').expect(201);
      await askCode(access, 'sms', '010-1234-5678').expect(201);
      return { access, emailCode: lastCode('email'), phoneCode: lastCode('sms') };
    };
    const staffRow = async () => (await ds.query(
      'SELECT email, phone, email_verified, phone_verified, must_change_credentials FROM staff WHERE id=$1', [IDS.must],
    ))[0];

    it('맞으면 그 주소가 계정에 적히고 안내가 「인증 완료」를 싣는다 — 두 인증 칸 · 잠금은 마치기 전까지 그대로다', async () => {
      const { access, emailCode } = await prepared();
      const before = await request(server()).get('/auth/onboarding').set(bearer(access)).expect(200);
      expect(before.body).toMatchObject({
        emailVerifiedMasked: null, phoneVerifiedMasked: null, completeBlockedReason: LEFT('이메일 · 휴대폰 번호'),
      });
      const res = await verify(access, 'email', ' W8-New@T.kr ', emailCode).expect(201);
      expect(res.body).toMatchObject({
        required: true, emailVerifiedMasked: 'w8***@t.kr', phoneVerifiedMasked: null, completeBlockedReason: LEFT('휴대폰 번호'),
      });
      expect(await staffRow()).toEqual({
        email: 'w8-new@t.kr', phone: null, email_verified: false, phone_verified: false, must_change_credentials: true,
      });
      // 증거 줄은 닫히지 않고 인증 시각이 찍힌다(마치기가 닫는다)
      const [row] = await ds.query(
        `SELECT consumed_at, verified_at FROM auth_code WHERE staff_id=$1 AND channel='email'`, [IDS.must],
      );
      expect(row.consumed_at).toBeNull();
      expect(row.verified_at).not.toBeNull();
      // 아직 첫 설정 전 — 보통 API 는 막힌다
      expect((await request(server()).get('/probe-onboarding/any').set(bearer(access)).expect(403)).body.code)
        .toBe('CREDENTIALS_CHANGE_REQUIRED');
      // 같은 코드로 다시 눌러도 같은 답이다(새로 고친 뒤 다시 누른 경우)
      await verify(access, 'email', 'w8-new@t.kr', emailCode).expect(201);
      // 새로 고쳐도 서버가 기억한다 — 안내가 다시 읽어 준다
      const again = await request(server()).get('/auth/onboarding').set(bearer(access)).expect(200);
      expect(again.body.emailVerifiedMasked).toBe('w8***@t.kr');
      // 감사 기록 — 채널과 가린 모양만
      const logs = await ds.query(
        `SELECT before, after FROM log WHERE entity='STAFF' AND entity_id=$1 AND action='onboarding_verify' ORDER BY id`, [IDS.must],
      );
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0]).toEqual({
        before: { channel: 'email', target: 'w8***@t.kr' }, after: { channel: 'email', target: 'w8***@t.kr', verified: true },
      });
      const logged = JSON.stringify(logs);
      for (const secret of [emailCode, 'w8-new@t.kr', 'w8-must@t.kr']) expect(logged).not.toContain(secret);
    });

    it('휴대폰 번호 인증도 번호를 계정에 적고 증거를 남긴다 — 둘 다 마치면 남은 까닭이 없다', async () => {
      const { access, emailCode, phoneCode } = await prepared();
      await verify(access, 'email', 'w8-new@t.kr', emailCode).expect(201);
      const res = await verify(access, 'sms', '01012345678', phoneCode).expect(201);
      expect(res.body).toMatchObject({
        emailVerifiedMasked: 'w8***@t.kr', phoneVerifiedMasked: '010-****-5678', completeBlockedReason: null,
      });
      expect(await staffRow()).toMatchObject({ phone: '01012345678', phone_verified: false, must_change_credentials: true });
    });

    it('다른 주소로 다시 인증하면 증거가 그 주소로 바뀌고 앞의 증거는 닫힌다', async () => {
      const { access } = await login('w8-must@t.kr');
      await askCode(access, 'email', 'ab-first@t.kr').expect(201);
      await verify(access, 'email', 'ab-first@t.kr', lastCode('email')).expect(201);
      // 60초 간격을 지난 것처럼 — 같은 채널로 다시 받는다
      await ds.query(
        `UPDATE auth_code SET created_at = created_at - interval '2 minutes', verified_at = verified_at - interval '2 minutes'
          WHERE staff_id=$1`, [IDS.must],
      );
      await askCode(access, 'email', 'cd-second@t.kr').expect(201);
      const res = await verify(access, 'email', 'cd-second@t.kr', lastCode('email')).expect(201);
      expect(res.body.emailVerifiedMasked).toBe('cd***@t.kr');
      const rows = await ds.query(
        `SELECT target_masked, consumed_at IS NULL AS open FROM auth_code WHERE staff_id=$1 AND channel='email' ORDER BY id`, [IDS.must],
      );
      expect(rows).toEqual([{ target_masked: 'ab***@t.kr', open: false }, { target_masked: 'cd***@t.kr', open: true }]);
      expect((await staffRow()).email).toBe('cd-second@t.kr');
    });

    it.each([
      [{ channel: 'email', target: 'not-email', code: '123456' }, '이메일'],
      [{ channel: 'sms', target: '1234', code: '123456' }, '휴대폰'],
      [{ channel: 'email', target: 'w8-new@t.kr', code: '12a456' }, '코드'],
      [{ channel: 'fax', target: 'w8-new@t.kr', code: '123456' }, '이메일'],
    ])('형식이 아니면 400: %p', async (body, word) => {
      const { access } = await prepared();
      const res = await request(server()).post('/auth/onboarding/verify').set(bearer(access)).send(body).expect(400);
      expect(res.body.message).toContain(word);
    });

    it('코드를 받은 뒤 다른 계정이 그 이메일을 가져갔으면 409 EMAIL_TAKEN 이고 계정은 그대로다', async () => {
      const { access, emailCode } = await prepared();
      await ds.query('UPDATE staff SET email = $2 WHERE id = $1', [IDS.other, 'W8-New@t.kr']);
      expect((await verify(access, 'email', 'w8-new@t.kr', emailCode).expect(409)).body.code).toBe('EMAIL_TAKEN');
      expect((await staffRow()).email).toBe('w8-must@t.kr');
    });

    it('받지 않은 주소 · 번호면 409 CODE_NOT_REQUESTED — 어느 쪽인지 말한다', async () => {
      const { access, emailCode, phoneCode } = await prepared();
      const email = await verify(access, 'email', 'w8-other@t.kr', emailCode).expect(409);
      expect(email.body).toEqual({ code: 'CODE_NOT_REQUESTED', message: '그 주소로 받은 코드가 없습니다 — 코드를 다시 받아 주세요' });
      const sms = await verify(access, 'sms', '01099998888', phoneCode).expect(409);
      expect(sms.body.code).toBe('CODE_NOT_REQUESTED');
      expect(sms.body.message).toContain('번호');
    });

    it('만료된 코드는 409 CODE_EXPIRED', async () => {
      const { access, emailCode } = await prepared();
      await ds.query(
        `UPDATE auth_code SET created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes'
          WHERE staff_id=$1 AND channel='email'`, [IDS.must],
      );
      expect((await verify(access, 'email', 'w8-new@t.kr', emailCode).expect(409)).body.code).toBe('CODE_EXPIRED');
    });

    it('다섯 번 틀린 코드는 맞게 적어도 409 CODE_LOCKED', async () => {
      const { access, phoneCode } = await prepared();
      await ds.query(`UPDATE auth_code SET attempts = 5 WHERE staff_id=$1 AND channel='sms'`, [IDS.must]);
      const res = await verify(access, 'sms', '010-1234-5678', phoneCode).expect(409);
      expect(res.body.code).toBe('CODE_LOCKED');
      expect(res.body.message).toContain('휴대폰');
    });

    it('틀리면 409 CODE_MISMATCH — 어느 코드인지 · 남은 횟수를 말하고 틀린 횟수는 실패한 요청 뒤에도 남는다', async () => {
      const { access, emailCode, phoneCode } = await prepared();
      const wrong = emailCode === '000000' ? '111111' : '000000';
      const first = await verify(access, 'email', 'w8-new@t.kr', wrong).expect(409);
      expect(first.body.code).toBe('CODE_MISMATCH');
      expect(first.body.message).toContain('이메일');
      expect(first.body.message).toContain('4번');
      expect((await codeRows('email'))[0].attempts).toBe(1);
      const second = await verify(access, 'email', 'w8-new@t.kr', wrong).expect(409);
      expect(second.body.message).toContain('3번');
      expect((await codeRows('email'))[0].attempts).toBe(2);
      const wrongPhone = phoneCode === '000000' ? '111111' : '000000';
      const phone = await verify(access, 'sms', '010-1234-5678', wrongPhone).expect(409);
      expect(phone.body.message).toContain('휴대폰');
      expect((await codeRows('sms'))[0].attempts).toBe(1);
      // 계정은 그대로다 — 틀린 인증은 아무것도 적지 않는다
      expect(await staffRow()).toEqual({
        email: 'w8-must@t.kr', phone: null, email_verified: false, phone_verified: false, must_change_credentials: true,
      });
    });
  });

  describe('POST /auth/onboarding/complete — 거절', () => {
    /** 두 채널을 인증해 두고 새 비밀번호만 바꿔 가며 쓴다 */
    const verified = async () => {
      const { access } = await login('w8-must@t.kr');
      await askCode(access, 'email', 'w8-new@t.kr').expect(201);
      await askCode(access, 'sms', '010-1234-5678').expect(201);
      await verify(access, 'email', 'w8-new@t.kr', lastCode('email')).expect(201);
      await verify(access, 'sms', '010-1234-5678', lastCode('sms')).expect(201);
      return access;
    };

    it.each([
      ['short1', 'TOO_SHORT'],
      ['onlyletters', 'NEEDS_LETTER_AND_DIGIT'],
      [INITIAL_PASSWORD, 'SAME_AS_INITIAL'],
    ] as const)('비밀번호 %s → 400 PASSWORD_RULE (%s 문장)', async (password, issue) => {
      const access = await verified();
      const res = await complete(access, { password }).expect(400);
      expect(res.body).toEqual({ code: 'PASSWORD_RULE', message: PASSWORD_ISSUE_MESSAGE[issue] });
    });

    it('지금 비밀번호와 같으면 409 SAME_AS_CURRENT', async () => {
      const access = await verified();
      expect((await complete(access, { password: PW }).expect(409)).body.code).toBe('SAME_AS_CURRENT');
    });

    it('옛 모양(이메일 · 휴대폰 · 두 코드를 함께)은 400 — 마치기는 새 비밀번호만 받는다', async () => {
      const access = await verified();
      await complete(access, {
        email: 'w8-new@t.kr', password: NEW_PW, phone: '01012345678', emailCode: '123456', phoneCode: '123456',
      }).expect(400);
    });

    it('인증을 마치지 않으면 409 CONTACT_NOT_VERIFIED — 남은 채널을 말하고 아무것도 저장하지 않는다', async () => {
      const { access } = await login('w8-must@t.kr');
      const none = await complete(access, { password: NEW_PW }).expect(409);
      expect(none.body).toEqual({ code: 'CONTACT_NOT_VERIFIED', message: LEFT('이메일 · 휴대폰 번호') });
      await askCode(access, 'email', 'w8-new@t.kr').expect(201);
      await verify(access, 'email', 'w8-new@t.kr', lastCode('email')).expect(201);
      const half = await complete(access, { password: NEW_PW }).expect(409);
      expect(half.body).toEqual({ code: 'CONTACT_NOT_VERIFIED', message: LEFT('휴대폰 번호') });
      const [s] = await ds.query(
        'SELECT must_change_credentials, email_verified, phone_verified, credentials_changed_at, password_hash FROM staff WHERE id=$1',
        [IDS.must],
      );
      expect(s).toMatchObject({ must_change_credentials: true, email_verified: false, phone_verified: false, credentials_changed_at: null });
      expect(await bcrypt.compare(PW, s.password_hash)).toBe(true);
    });

    it('관리자 초기화로 다시 잠긴 계정은 두 인증 칸이 true 여도 이번 차례에 다시 인증해야 마친다', async () => {
      // 마친 계정(두 인증 true)을 다시 잠근다 — 초기 비밀번호를 아는 사람이 이메일 · 휴대폰 증명 없이 새 비밀번호를 정하지 못한다
      await ds.query('UPDATE staff SET must_change_credentials = true, phone = $2 WHERE id = $1', [IDS.normal, '01077778888']);
      const { access } = await login('w8-mixed.case@t.kr');
      const info = await request(server()).get('/auth/onboarding').set(bearer(access)).expect(200);
      expect(info.body).toMatchObject({
        required: true, emailVerifiedMasked: null, phoneVerifiedMasked: null, completeBlockedReason: LEFT('이메일 · 휴대폰 번호'),
      });
      expect((await complete(access, { password: NEW_PW }).expect(409)).body.code).toBe('CONTACT_NOT_VERIFIED');
    });

    it('마지막 자격 변경 전의 인증은 이번 차례의 증거가 아니다', async () => {
      await verified();
      // 인증 뒤에 관리자가 자격을 다시 정한 것처럼 — 증거를 그 시각보다 앞으로 옮긴다.
      // 토큰은 자격 버전(cv)을 싣고 있어 자격이 바뀌면 끊긴다 — 바뀐 뒤 다시 로그인한 세션으로 마친다
      await ds.query(
        `UPDATE auth_code SET created_at = created_at - interval '1 hour', expires_at = expires_at - interval '1 hour',
                              verified_at = verified_at - interval '1 hour' WHERE staff_id=$1`, [IDS.must],
      );
      await ds.query(`UPDATE staff SET credentials_changed_at = now() - interval '30 minutes' WHERE id=$1`, [IDS.must]);
      const { access } = await login('w8-must@t.kr');
      expect((await complete(access, { password: NEW_PW }).expect(409)).body).toEqual({
        code: 'CONTACT_NOT_VERIFIED', message: LEFT('이메일 · 휴대폰 번호'),
      });
    });

    it('인증 뒤 계정의 이메일이 바뀌면(관리자 수정 등) 그 증거는 세지 않는다', async () => {
      const access = await verified();
      await ds.query('UPDATE staff SET email = $2 WHERE id = $1', [IDS.must, 'w8-elsewhere@t.kr']);
      expect((await complete(access, { password: NEW_PW }).expect(409)).body.message).toBe(LEFT('이메일'));
    });
  });

  describe('POST /auth/onboarding/complete — 성공', () => {
    it('두 채널을 인증한 뒤 새 비밀번호로 마치면 한 트랜잭션으로 바꾸고 새 토큰을 주며 옛 Access · Refresh 는 401 이다', async () => {
      const old = await login('w8-must@t.kr');
      // 다른 주소로 받아 둔 코드 — 인증과 함께 닫혀야 한다(다시 첫 설정이 걸려도 살아 있지 않게)
      await askCode(old.access, 'email', 'w8-first-try@t.kr').expect(201);
      await ds.query(`UPDATE auth_code SET created_at = now() - interval '2 minutes', expires_at = now() + interval '8 minutes' WHERE staff_id=$1`, [IDS.must]);
      await askCode(old.access, 'email', 'W8-New.Person@T.kr').expect(201);
      await askCode(old.access, 'sms', '010-1234-5678').expect(201);
      const emailCode = lastCode('email');
      const phoneCode = lastCode('sms');
      await verify(old.access, 'email', ' W8-New.Person@T.kr ', emailCode).expect(201);
      await verify(old.access, 'sms', '010-1234-5678', phoneCode).expect(201);
      expect((await codeRows('email')).filter((r) => r.consumed_at === null)).toHaveLength(1);
      // 토큰 발급 시각(iat)은 초 단위다 — 옛 토큰과 완료가 같은 초에 겹치지 않게 다음 초까지 기다린다
      await new Promise((r) => setTimeout(r, 1_050 - (Date.now() % 1_000)));

      const res = await complete(old.access, { password: NEW_PW }).expect(201);
      expect(typeof res.body.accessToken).toBe('string');
      expect(res.body.user).toMatchObject({ id: IDS.must, mustChangeCredentials: false });
      expect(res.body.refreshToken).toBeUndefined();
      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies.find((c) => c.startsWith('taco_rt='))).toContain('HttpOnly');

      const [s] = await ds.query('SELECT * FROM staff WHERE id=$1', [IDS.must]);
      expect(s).toMatchObject({
        email: 'w8-new.person@t.kr', phone: '01012345678', email_verified: true, phone_verified: true,
        must_change_credentials: false,
      });
      expect(s.credentials_changed_at).not.toBeNull();
      expect(await bcrypt.compare(NEW_PW, s.password_hash)).toBe(true);
      expect(await bcrypt.compare(PW, s.password_hash)).toBe(false);
      expect((await codeRows('email')).every((r) => r.consumed_at !== null)).toBe(true);
      expect((await codeRows('sms')).every((r) => r.consumed_at !== null)).toBe(true);

      const logs = await ds.query(`SELECT * FROM log WHERE entity='STAFF' AND entity_id=$1 AND action='onboarding'`, [IDS.must]);
      expect(logs).toHaveLength(1);
      expect(Number(logs[0].actor_id)).toBe(IDS.must);
      const logged = JSON.stringify([logs[0].before, logs[0].after]);
      for (const secret of [NEW_PW, PW, emailCode, phoneCode, '01012345678', '010-1234-5678', 'w8-new.person@t.kr', 'w8-must@t.kr', s.password_hash]) {
        expect(logged).not.toContain(secret);
      }
      expect(logs[0].after).toMatchObject({ email: 'w8***@t.kr', phone: '010-****-5678', mustChangeCredentials: false });

      // 옛 세션은 끊긴다 — 초기 비밀번호를 아는 만든 사람이 먼저 들어가 있었어도 남지 않는다
      await request(server()).get('/probe-onboarding/any').set(bearer(old.access)).expect(401);
      await request(server()).post('/auth/refresh').set('Cookie', old.cookies).expect(401);
      // 새 토큰으로는 잠금이 풀렸다
      await request(server()).get('/probe-onboarding/any').set(bearer(res.body.accessToken)).expect(200);
      await request(server()).post('/auth/refresh').set('Cookie', cookies).expect(201);
      // 아이디는 그대로다(W10 — 첫 설정은 아이디를 바꾸지 않는다) · 새 비밀번호로 다시 들어가고 옛 비밀번호는 안 된다
      expect(s.login_id).toBe('w8-must@t.kr');
      await login('w8-must@t.kr', NEW_PW);
      await request(server()).post('/auth/login').send({ loginId: 'w8-must@t.kr', password: PW }).expect(401);
      // 확인한 이메일은 연락처일 뿐 아이디가 아니다
      await request(server()).post('/auth/login').send({ loginId: 'w8-new.person@t.kr', password: NEW_PW }).expect(401);
      // 끝난 계정은 다시 첫 설정을 못 한다
      expect((await complete(res.body.accessToken, { password: 'Another-pass-88' }).expect(409)).body.code)
        .toBe('ONBOARDING_NOT_REQUIRED');
      expect((await verify(res.body.accessToken, 'email', 'w8-new.person@t.kr', emailCode).expect(409)).body.code)
        .toBe('ONBOARDING_NOT_REQUIRED');
    });

    it('이메일 없이 만든 계정(W10)도 첫 설정에서 이메일을 적고 코드로 확인한다 — 아이디는 매니저가 정한 그대로다', async () => {
      const first = await login('새강사_01');
      expect(first.body.user).toMatchObject({ id: IDS.noEmail, mustChangeCredentials: true });
      const info = await request(server()).get('/auth/onboarding').set(bearer(first.access)).expect(200);
      expect(info.body).toMatchObject({ required: true, loginId: '새강사_01', emailMasked: null, phoneMasked: null });
      await askCode(first.access, 'email', 'w10-teacher@t.kr').expect(201);
      await askCode(first.access, 'sms', '010-5555-6666').expect(201);
      await verify(first.access, 'email', 'w10-teacher@t.kr', lastCode('email')).expect(201);
      await verify(first.access, 'sms', '010-5555-6666', lastCode('sms')).expect(201);
      const done = await complete(first.access, { password: NEW_PW }).expect(201);
      expect(done.body.user).toMatchObject({ id: IDS.noEmail, mustChangeCredentials: false });
      const [s] = await ds.query('SELECT login_id, email, email_verified, phone_verified FROM staff WHERE id=$1', [IDS.noEmail]);
      expect(s).toEqual({ login_id: '새강사_01', email: 'w10-teacher@t.kr', email_verified: true, phone_verified: true });
      await login('새강사_01', NEW_PW);
    });

    it('자격이 다시 정해진 뒤(관리자 초기화 등)에는 그 전에 발급된 Access · Refresh 가 401 이다', async () => {
      const { access, cookies } = await login('w8-mixed.case@t.kr');
      await ds.query(`UPDATE staff SET credentials_changed_at = now() + interval '2 seconds' WHERE id=$1`, [IDS.normal]);
      const res = await request(server()).get('/probe-onboarding/any').set(bearer(access)).expect(401);
      expect(res.body.message).toBe('다시 로그인해 주세요');
      await request(server()).post('/auth/refresh').set('Cookie', cookies).expect(401);
    });
  });

  it('OpenAPI 에 첫 설정 네 경로와 Me.mustChangeCredentials 가 있다', () => {
    const doc = buildOpenApi(app);
    expect(doc.paths['/auth/onboarding']?.get?.responses['200']).toBeDefined();
    for (const path of ['/auth/onboarding/codes', '/auth/onboarding/verify', '/auth/onboarding/complete']) {
      expect(doc.paths[path]?.post?.responses['201']).toBeDefined();
      expect(doc.paths[path]?.post?.responses['409']).toBeDefined();
    }
    expect(doc.paths['/auth/onboarding/codes']?.post?.responses['429']).toBeDefined();
    expect(doc.paths['/auth/onboarding/codes']?.post?.responses['503']).toBeDefined();
    const me = doc.components?.schemas?.MeDto as { properties: Record<string, { type?: string }> };
    expect(me.properties.mustChangeCredentials?.type).toBe('boolean');
    const info = doc.components?.schemas?.OnboardingInfoDto as { required?: string[] };
    expect(info.required).toContain('phoneCountries');
    for (const key of ['emailVerifiedMasked', 'phoneVerifiedMasked', 'completeBlockedReason']) expect(info.required).toContain(key);
    const done = doc.components?.schemas?.OnboardingCompleteDto as { required?: string[]; properties: Record<string, unknown> };
    expect(Object.keys(done.properties)).toEqual(['password']);
    const tooMany = doc.paths['/auth/onboarding/codes']?.post?.responses['429'] as { description?: string } | undefined;
    expect(tooMany?.description).toContain('CODE_DAILY_LIMIT');
  });
});
