/** @file-guide
 * 목적: onboarding.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 계정 첫 설정 · 로그인 아이디 (W8 · 대표 지시 2026-09-26).
 *
 * 「첫 로그인 시 아이디 및 비밀번호 강제 변경 · phone · email 인증 필수 — 바꾸지 않으면 홈에 들어갈 수 없다」를
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
  const IDS = { must: 9_000_000_000_961, normal: 9_000_000_000_962, other: 9_000_000_000_963 } as const;
  const PEOPLE = [
    { id: IDS.must, name: '첫설정', email: 'w8-must@t.kr', role: 'manager', must: true },
    { id: IDS.normal, name: '보통', email: 'W8-Mixed.Case@t.kr', role: 'manager', must: false },
    { id: IDS.other, name: '남의계정', email: 'w8-taken@t.kr', role: 'teacher', must: false },
  ];
  const ALL = PEOPLE.map((p) => p.id);

  const server = () => app.getHttpServer();
  const reset = async () => {
    await ds.query('DELETE FROM auth_code WHERE staff_id = ANY($1)', [ALL]);
    await ds.query(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = ANY($1)`, [ALL]);
    const hash = await bcrypt.hash(PW, 4);
    for (const p of PEOPLE) {
      await ds.query(
        `UPDATE staff SET email=$2, password_hash=$3, phone=NULL, must_change_credentials=$4, email_verified=false,
                phone_verified=false, credentials_changed_at=NULL, active=true WHERE id=$1`,
        [p.id, p.email, hash, p.must],
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
        `INSERT INTO staff (id, name, email, role, password_hash, active, must_change_credentials) VALUES ($1,$2,$3,$4,'x',true,$5)`,
        [p.id, p.name, p.email, p.role, p.must],
      );
    }
  });

  beforeEach(reset);

  afterAll(async () => {
    await ds?.query(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = ANY($1)`, [ALL]);
    await ds?.query('DELETE FROM staff WHERE id = ANY($1)', [ALL]);
    await app?.close();
  });

  const login = async (email: string, password = PW) => {
    const res = await request(server()).post('/auth/login').send({ email, password }).expect(201);
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
  const codeRows = (channel: string) => ds.query(
    'SELECT id, attempts, consumed_at FROM auth_code WHERE staff_id=$1 AND channel=$2 ORDER BY id', [IDS.must, channel],
  ) as Promise<Array<{ id: string; attempts: number; consumed_at: Date | null }>>;

  describe('로그인 아이디 = 이메일 · 대소문자 구분 없음', () => {
    it('저장된 대소문자와 달라도 같은 계정으로 들어가고 틀린 비밀번호는 없는 계정과 같은 문구다', async () => {
      const ok = await login('w8-mixed.case@T.KR');
      expect(ok.body.user.id).toBe(IDS.normal);
      expect(ok.body.user.mustChangeCredentials).toBe(false);
      const wrong = await request(server()).post('/auth/login').send({ email: 'W8-MIXED.CASE@t.kr', password: 'wrong-pass-999' }).expect(401);
      const none = await request(server()).post('/auth/login').send({ email: 'w8-nobody@t.kr', password: PW }).expect(401);
      expect(wrong.body.message).toBe(none.body.message);
    });

    it('소문자로 같은 계정이 둘 이상이면 어느 쪽인지 말하지 않고 같은 실패 문구다', async () => {
      const two = await ds.getRepository(Staff).find({ where: [{ id: IDS.normal }, { id: IDS.other }] });
      const spy = jest.spyOn(ds.getRepository(Staff), 'find').mockResolvedValueOnce(two);
      try {
        const res = await request(server()).post('/auth/login').send({ email: 'w8-mixed.case@t.kr', password: PW }).expect(401);
        const none = await request(server()).post('/auth/login').send({ email: 'w8-nobody@t.kr', password: PW }).expect(401);
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
        required: true, loginId: 'w8-must@t.kr', phoneMasked: null, passwordRule: PASSWORD_RULE_TEXT,
        codeTtlMinutes: 10, resendAfterSeconds: 60,
      });
      expect(info.body.channels).toEqual([
        { channel: 'email', label: '메일', ready: true, notReadyReason: null },
        { channel: 'sms', label: '문자', ready: true, notReadyReason: null },
      ]);
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
      const res = await complete(access, { email: 'w8-new@t.kr', password: NEW_PW, phone: '01012345678', emailCode: '123456', phoneCode: '123456' }).expect(409);
      expect(res.body.code).toBe('ONBOARDING_NOT_REQUIRED');
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
      const saved = { node: process.env.NODE_ENV, echo: process.env.AUTH_CODE_DEV_ECHO };
      afterEach(() => {
        process.env.NODE_ENV = saved.node;
        if (saved.echo === undefined) delete process.env.AUTH_CODE_DEV_ECHO; else process.env.AUTH_CODE_DEV_ECHO = saved.echo;
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
        await complete(access, {
          email: 'w8-dev@t.kr', password: NEW_PW, phone: '01033334444', emailCode: email.body.devCode, phoneCode: sms.body.devCode,
        }).expect(201);
      });

      it.each([
        ['production', 'on'],
        ['test', 'off'],
        ['test', undefined],
      ])('NODE_ENV=%s · AUTH_CODE_DEV_ECHO=%s 이면 devCode 없이 503', async (node, echo) => {
        fake.readyMap = { email: false, sms: false };
        const { access } = await login('w8-must@t.kr');
        process.env.NODE_ENV = node;
        if (echo === undefined) delete process.env.AUTH_CODE_DEV_ECHO; else process.env.AUTH_CODE_DEV_ECHO = echo;
        const res = await askCode(access, 'email', 'w8-dev@t.kr').expect(503);
        expect(res.body.devCode).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toMatch(/\d{6}/);
        expect(await codeRows('email')).toHaveLength(0);
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
      await askCode(access, 'sms', '01012345678').expect(201);
      const out = await complete(access, {
        email: 'w8-new@t.kr', password: NEW_PW, phone: '01012345678', emailCode: code, phoneCode: lastCode('sms'),
      }).expect(409);
      expect(out.body.code).toBe('CODE_NOT_REQUESTED');
    });
  });

  describe('POST /auth/onboarding/complete — 거절', () => {
    /** 두 코드를 받아 두고 맞는 본문을 만든다. 거절 시험은 한 칸씩 바꿔서 쓴다 */
    const prepared = async () => {
      const { access } = await login('w8-must@t.kr');
      await askCode(access, 'email', 'w8-new@t.kr').expect(201);
      await askCode(access, 'sms', '010-1234-5678').expect(201);
      return {
        access,
        body: { email: 'w8-new@t.kr', password: NEW_PW, phone: '010-1234-5678', emailCode: lastCode('email'), phoneCode: lastCode('sms') },
      };
    };

    it.each([
      ['short1', 'TOO_SHORT'],
      ['onlyletters', 'NEEDS_LETTER_AND_DIGIT'],
      [INITIAL_PASSWORD, 'SAME_AS_INITIAL'],
    ] as const)('비밀번호 %s → 400 PASSWORD_RULE (%s 문장)', async (password, issue) => {
      const { access, body } = await prepared();
      const res = await complete(access, { ...body, password }).expect(400);
      expect(res.body).toEqual({ code: 'PASSWORD_RULE', message: PASSWORD_ISSUE_MESSAGE[issue] });
    });

    it('지금 비밀번호와 같으면 409 SAME_AS_CURRENT', async () => {
      const { access, body } = await prepared();
      expect((await complete(access, { ...body, password: PW }).expect(409)).body.code).toBe('SAME_AS_CURRENT');
    });

    it('남의 계정 이메일이면 409 EMAIL_TAKEN', async () => {
      const { access, body } = await prepared();
      expect((await complete(access, { ...body, email: 'W8-Taken@t.kr' }).expect(409)).body.code).toBe('EMAIL_TAKEN');
    });

    it.each([
      [{ email: 'not-email' }, '이메일'],
      [{ phone: '1234' }, '휴대폰'],
      [{ emailCode: '12a456' }, '코드'],
    ])('형식이 아니면 400: %p', async (patch, word) => {
      const { access, body } = await prepared();
      const res = await complete(access, { ...body, ...patch }).expect(400);
      expect(res.body.message).toContain(word);
    });

    it('받지 않은 주소 · 번호면 409 CODE_NOT_REQUESTED — 어느 쪽인지 말한다', async () => {
      const { access, body } = await prepared();
      const email = await complete(access, { ...body, email: 'w8-other@t.kr' }).expect(409);
      expect(email.body).toEqual({ code: 'CODE_NOT_REQUESTED', message: '그 주소로 받은 코드가 없습니다 — 코드를 다시 받아 주세요' });
      const sms = await complete(access, { ...body, phone: '01099998888' }).expect(409);
      expect(sms.body.code).toBe('CODE_NOT_REQUESTED');
      expect(sms.body.message).toContain('번호');
    });

    it('만료된 코드는 409 CODE_EXPIRED', async () => {
      const { access, body } = await prepared();
      await ds.query(
        `UPDATE auth_code SET created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes'
          WHERE staff_id=$1 AND channel='email'`, [IDS.must],
      );
      expect((await complete(access, body).expect(409)).body.code).toBe('CODE_EXPIRED');
    });

    it('다섯 번 틀린 코드는 맞게 적어도 409 CODE_LOCKED', async () => {
      const { access, body } = await prepared();
      await ds.query(`UPDATE auth_code SET attempts = 5 WHERE staff_id=$1 AND channel='sms'`, [IDS.must]);
      const res = await complete(access, body).expect(409);
      expect(res.body.code).toBe('CODE_LOCKED');
      expect(res.body.message).toContain('휴대폰');
    });

    it('틀리면 409 CODE_MISMATCH — 어느 코드인지 · 남은 횟수를 말하고 틀린 횟수는 실패한 요청 뒤에도 남는다', async () => {
      const { access, body } = await prepared();
      const wrong = body.emailCode === '000000' ? '111111' : '000000';
      const first = await complete(access, { ...body, emailCode: wrong }).expect(409);
      expect(first.body.code).toBe('CODE_MISMATCH');
      expect(first.body.message).toContain('이메일');
      expect(first.body.message).toContain('4번');
      expect((await codeRows('email'))[0].attempts).toBe(1);
      const second = await complete(access, { ...body, emailCode: wrong }).expect(409);
      expect(second.body.message).toContain('3번');
      expect((await codeRows('email'))[0].attempts).toBe(2);
      const wrongPhone = body.phoneCode === '000000' ? '111111' : '000000';
      const phone = await complete(access, { ...body, phoneCode: wrongPhone }).expect(409);
      expect(phone.body.message).toContain('휴대폰');
      expect((await codeRows('sms'))[0].attempts).toBe(1);
      // 계정은 그대로 첫 설정 전이다
      const [s] = await ds.query('SELECT must_change_credentials, email FROM staff WHERE id=$1', [IDS.must]);
      expect(s).toEqual({ must_change_credentials: true, email: 'w8-must@t.kr' });
    });
  });

  describe('POST /auth/onboarding/complete — 성공', () => {
    it('한 트랜잭션으로 바꾸고 새 토큰을 주며 옛 Access · Refresh 는 401 이다', async () => {
      const old = await login('w8-must@t.kr');
      // 다른 주소로 받아 둔 코드 — 완료와 함께 닫혀야 한다(다시 첫 설정이 걸려도 살아 있지 않게)
      await askCode(old.access, 'email', 'w8-first-try@t.kr').expect(201);
      await ds.query(`UPDATE auth_code SET created_at = now() - interval '2 minutes', expires_at = now() + interval '8 minutes' WHERE staff_id=$1`, [IDS.must]);
      await askCode(old.access, 'email', 'W8-New.Person@T.kr').expect(201);
      await askCode(old.access, 'sms', '010-1234-5678').expect(201);
      const emailCode = lastCode('email');
      const phoneCode = lastCode('sms');
      // 토큰 발급 시각(iat)은 초 단위다 — 옛 토큰과 완료가 같은 초에 겹치지 않게 다음 초까지 기다린다
      await new Promise((r) => setTimeout(r, 1_050 - (Date.now() % 1_000)));

      const res = await complete(old.access, {
        email: ' W8-New.Person@T.kr ', password: NEW_PW, phone: '010-1234-5678', emailCode, phoneCode,
      }).expect(201);
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
      // 새 아이디 · 새 비밀번호로 다시 들어가고 옛 것은 안 된다
      await login('W8-NEW.PERSON@t.kr', NEW_PW);
      await request(server()).post('/auth/login').send({ email: 'w8-must@t.kr', password: PW }).expect(401);
      // 끝난 계정은 다시 첫 설정을 못 한다
      expect((await complete(res.body.accessToken, {
        email: 'w8-new.person@t.kr', password: 'Another-pass-88', phone: '01012345678', emailCode, phoneCode,
      }).expect(409)).body.code).toBe('ONBOARDING_NOT_REQUIRED');
    });

    it('자격이 다시 정해진 뒤(관리자 초기화 등)에는 그 전에 발급된 Access · Refresh 가 401 이다', async () => {
      const { access, cookies } = await login('w8-mixed.case@t.kr');
      await ds.query(`UPDATE staff SET credentials_changed_at = now() + interval '2 seconds' WHERE id=$1`, [IDS.normal]);
      const res = await request(server()).get('/probe-onboarding/any').set(bearer(access)).expect(401);
      expect(res.body.message).toBe('다시 로그인해 주세요');
      await request(server()).post('/auth/refresh').set('Cookie', cookies).expect(401);
    });
  });

  it('OpenAPI 에 첫 설정 세 경로와 Me.mustChangeCredentials 가 있다', () => {
    const doc = buildOpenApi(app);
    expect(doc.paths['/auth/onboarding']?.get?.responses['200']).toBeDefined();
    for (const path of ['/auth/onboarding/codes', '/auth/onboarding/complete']) {
      expect(doc.paths[path]?.post?.responses['201']).toBeDefined();
      expect(doc.paths[path]?.post?.responses['409']).toBeDefined();
    }
    expect(doc.paths['/auth/onboarding/codes']?.post?.responses['429']).toBeDefined();
    expect(doc.paths['/auth/onboarding/codes']?.post?.responses['503']).toBeDefined();
    const me = doc.components?.schemas?.MeDto as { properties: Record<string, { type?: string }> };
    expect(me.properties.mustChangeCredentials?.type).toBe('boolean');
  });
});
