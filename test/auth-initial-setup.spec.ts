/** @file-guide
 * 목적: auth-initial-setup.spec.ts — AUTH-INIT-02 필수 초기설정 판정의 HTTP·DB 회귀 (test)
 * 책임/재사용: AuthService의 판정 함수 하나가 로그인·Me·가드·첫 설정 경로에 같은 답을 주는지 실제 앱으로 센다. 판정 규칙을 시험에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * AUTH-INIT-02 (사용자 결정 2026-10-16) — 관리자·매니저·대표를 포함한 **모든 역할**이 초기 로그인에서
 * 휴대폰 인증 · 이메일 인증 · 비밀번호 교체를 마쳐야 업무 화면/API 에 들어간다.
 *
 * 이 파일이 지키는 것:
 *   ① 완료 증거(두 인증 + 첫 설정 잠금 해제) 없이 `must_change_credentials=false` 로 면제된 계정(초기3계정 재현)도
 *      다음 요청부터 403 CREDENTIALS_CHANGE_REQUIRED 이고, 첫 설정 경로로 실제로 마칠 수 있다(교착이 없다).
 *   ② 하나만 인증한 조합 · 관리자 초기화(must=true) 조합도 같은 답이다 — 역할 · 로그인 ID 로 면제하지 않는다.
 *   ③ 정상으로 마친 계정은 다시 인증하라고 잡지 않는다.
 *   ④ 비밀번호 찾기로 비밀번호만 바꿔도 필수 설정은 풀리지 않는다.
 *
 * 발송기는 가짜(`FakeSender`)다 — 실제 SMTP · SENS 로 나가지 않는다. DATABASE_URL 이 없으면 건너뛴다.
 * 고정 id 픽스처만 넣고 지운다(다른 스위트의 행을 건드리지 않는다).
 */
import { Controller, Get, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ApiErrorFilter } from '../src/common/filters/api-error.filter';
import { SENDER } from '../src/modules/notify/sender';
import { FakeSender } from './fake-sender';

@Controller('probe-initial-setup')
class ProbeController {
  @Get('any')
  any() { return { ok: true }; }
}

const d = process.env.DATABASE_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('AUTH-INIT-02 필수 초기설정 판정', () => {
  let app: INestApplication;
  let ds: DataSource;
  const fake = new FakeSender();
  const PW = 'Initial-shared-77';
  const NEW_PW = 'Own-new-pass-2026';
  const IDS = {
    legacy: 9_000_000_001_701, emailOnly: 9_000_000_001_702, phoneOnly: 9_000_000_001_703,
    done: 9_000_000_001_704, reset: 9_000_000_001_705,
  } as const;
  // 초기3계정 재현(대표 · 매니저 · 관리자)과 강사 — 역할마다 면제 없이 같은 판정을 받는지 본다
  const PEOPLE = [
    { id: IDS.legacy, loginId: 'auth-init-legacy', role: 'ceo', must: false, ev: false, pv: false, email: null, phone: null },
    { id: IDS.emailOnly, loginId: 'auth-init-email-only', role: 'admin', must: false, ev: true, pv: false, email: 'auth-init-e1@t.kr', phone: null },
    { id: IDS.phoneOnly, loginId: 'auth-init-phone-only', role: 'manager', must: false, ev: false, pv: true, email: null, phone: '01077770003' },
    { id: IDS.done, loginId: 'auth-init-done', role: 'teacher', must: false, ev: true, pv: true, email: 'auth-init-done@t.kr', phone: '01077770004' },
    { id: IDS.reset, loginId: 'auth-init-reset', role: 'manager', must: true, ev: true, pv: true, email: 'auth-init-reset@t.kr', phone: '01077770005' },
  ] as const;
  const ALL = PEOPLE.map((p) => p.id);

  const server = () => app.getHttpServer();
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = async (loginId: string, password = PW) => {
    const res = await request(server()).post('/auth/login').send({ loginId, password }).expect(201);
    return { access: res.body.accessToken as string, body: res.body };
  };
  const lastCode = (channel: 'email' | 'sms') => {
    const call = [...fake.calls].reverse().find((c) => c.channel === channel);
    return /\d{6}/.exec(call?.body ?? '')?.[0] ?? '';
  };

  const reset = async () => {
    await ds.query('DELETE FROM auth_code WHERE staff_id = ANY($1)', [ALL]);
    await ds.query(`DELETE FROM log WHERE entity = 'STAFF' AND entity_id = ANY($1)`, [ALL]);
    const hash = await bcrypt.hash(PW, 4);
    for (const p of PEOPLE) {
      await ds.query(
        `UPDATE staff SET login_id=$2, email=$3, phone=$4, password_hash=$5, must_change_credentials=$6,
                email_verified=$7, phone_verified=$8, credentials_changed_at=NULL, active=true WHERE id=$1`,
        [p.id, p.loginId, p.email, p.phone, hash, p.must, p.ev, p.pv],
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
    await ds.query('DELETE FROM auth_code WHERE staff_id = ANY($1)', [ALL]);
    await ds.query('DELETE FROM staff WHERE id = ANY($1)', [ALL]);
    for (const p of PEOPLE) {
      await ds.query(
        `INSERT INTO staff (id, name, login_id, role, password_hash, active) VALUES ($1,$2,$3,$4,'x',true)`,
        [p.id, `필수설정${p.role}`, p.loginId, p.role],
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

  describe('완료 증거가 없거나 일부만 있으면 모든 역할이 필수 설정 대상이다', () => {
    it.each([
      ['초기3계정 재현 — must=false · 두 인증 없음(대표)', 'auth-init-legacy'],
      ['이메일만 인증(관리자)', 'auth-init-email-only'],
      ['휴대폰만 인증(매니저)', 'auth-init-phone-only'],
      ['관리자 초기화로 다시 잠김 — 두 인증은 있음(매니저)', 'auth-init-reset'],
    ])('%s: 로그인 결과 · Me · 가드 · 첫 설정 안내가 같은 답이다', async (_label, loginId) => {
      const { access, body } = await login(loginId);
      expect(body.user.mustChangeCredentials).toBe(true);
      expect((await request(server()).get('/auth/me').set(bearer(access)).expect(200)).body.mustChangeCredentials).toBe(true);
      const blocked = await request(server()).get('/probe-initial-setup/any').set(bearer(access)).expect(403);
      expect(blocked.body.code).toBe('CREDENTIALS_CHANGE_REQUIRED');
      // 실제 업무 API 도 권한 문장보다 먼저 첫 설정으로 막는다
      expect((await request(server()).get('/ops').set(bearer(access)).expect(403)).body.code).toBe('CREDENTIALS_CHANGE_REQUIRED');
      const info = await request(server()).get('/auth/onboarding').set(bearer(access)).expect(200);
      expect(info.body.required).toBe(true);
    });

    it('정상으로 마친 계정은 다시 잡지 않는다 — 업무 200 · 안내 required=false', async () => {
      const { access, body } = await login('auth-init-done');
      expect(body.user.mustChangeCredentials).toBe(false);
      await request(server()).get('/probe-initial-setup/any').set(bearer(access)).expect(200);
      expect((await request(server()).get('/auth/onboarding').set(bearer(access)).expect(200)).body.required).toBe(false);
    });
  });

  describe('면제돼 있던 계정도 첫 설정 경로로 실제로 마친다 — 교착이 없다', () => {
    it('코드 두 개 · 새 비밀번호로 마치면 새 세션은 업무 200 이고 DB 는 두 인증 true · 잠금 false', async () => {
      const { access } = await login('auth-init-legacy');
      await request(server()).post('/auth/onboarding/codes').set(bearer(access))
        .send({ channel: 'email', target: 'auth-init-legacy@t.kr' }).expect(201);
      await request(server()).post('/auth/onboarding/codes').set(bearer(access))
        .send({ channel: 'sms', target: '010-7777-0001' }).expect(201);
      const done = await request(server()).post('/auth/onboarding/complete').set(bearer(access)).send({
        email: 'auth-init-legacy@t.kr', password: NEW_PW, phone: '010-7777-0001',
        emailCode: lastCode('email'), phoneCode: lastCode('sms'),
      }).expect(201);
      expect(done.body.user.mustChangeCredentials).toBe(false);
      await request(server()).get('/probe-initial-setup/any').set(bearer(done.body.accessToken)).expect(200);
      // 마치기 전에 받은 토큰은 끊긴다(credentials_changed_at)
      await request(server()).get('/auth/me').set(bearer(access)).expect(401);
      const [row] = await ds.query(
        'SELECT must_change_credentials, email_verified, phone_verified FROM staff WHERE id=$1', [IDS.legacy],
      );
      expect(row).toEqual({ must_change_credentials: false, email_verified: true, phone_verified: true });
    });
  });

  describe('비밀번호 찾기는 필수 설정을 풀지 않는다', () => {
    it('관리자 초기화로 잠긴 계정이 비밀번호 찾기를 마쳐도 다음 로그인은 여전히 필수 설정 대상이다', async () => {
      const codes = async (channel: 'email' | 'sms') => {
        await request(server()).post('/auth/password-reset/codes').send({ loginId: 'auth-init-reset', channel }).expect(201);
        return lastCode(channel);
      };
      const emailCode = await codes('email');
      const phoneCode = await codes('sms');
      await request(server()).post('/auth/password-reset/complete')
        .send({ loginId: 'auth-init-reset', password: NEW_PW, emailCode, phoneCode }).expect(204);
      const { access, body } = await login('auth-init-reset', NEW_PW);
      expect(body.user.mustChangeCredentials).toBe(true);
      expect((await request(server()).get('/probe-initial-setup/any').set(bearer(access)).expect(403)).body.code)
        .toBe('CREDENTIALS_CHANGE_REQUIRED');
    });

    it('두 인증이 없는 면제 계정은 비밀번호 찾기 대상이 아니다 — 같은 201 · 아무것도 보내지 않는다', async () => {
      await request(server()).post('/auth/password-reset/codes').send({ loginId: 'auth-init-legacy', channel: 'email' }).expect(201);
      expect(fake.calls).toHaveLength(0);
    });
  });
});
