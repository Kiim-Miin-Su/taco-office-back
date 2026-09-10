/** @file-guide
 * 목적: auth.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 인증 · 권한 — 서버가 실제로 막는지 확인한다 (D-R39 · D-R41).
 *
 * 화면에서 버튼을 숨기는 것으로는 증명이 안 된다. HTTP 로 직접 두드려서
 * **강사는 403, 대표는 200** 이 나오는지 본다.
 *
 * DATABASE_URL 이 없으면 건너뛴다.
 */
import { INestApplication, ValidationPipe, Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Perm } from '../src/common/perm';
import { Public } from '../src/auth/public.decorator';
import * as jwt from 'jsonwebtoken';
import { buildOpenApi } from '../src/openapi';
import { Staff } from '../src/entities';
import { ApiErrorFilter } from '../src/common/filters/api-error.filter';
import { AuthService } from '../src/auth/auth.service';

/** 테스트용 엔드포인트 — 가드가 실제로 무엇을 막는지 보려고 만든다 */
@Controller('probe')
class ProbeController {
  @Public()
  @Get('open')
  open() {
    return { ok: true };
  }

  @Get('any')
  any() {
    return { ok: true };
  }

  @Perm('canCrudAll')
  @Get('crud')
  crud() {
    return { ok: true };
  }

  @Perm('canSeeProfit')
  @Get('profit')
  profit() {
    return { ok: true };
  }
}

const d = process.env.DATABASE_URL ? describe : describe.skip;
jest.setTimeout(40_000);

d('인증 · 권한 (D-R39 · D-R41)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const PW = 'test-password-1234';

  const PEOPLE = [
    { id: 901, name: '김강사', email: 'teacher@t.kr', role: 'teacher' },
    { id: 902, name: '이매니저', email: 'manager@t.kr', role: 'manager' },
    { id: 903, name: '박관리', email: 'admin@t.kr', role: 'admin' },
    { id: 904, name: '최대표', email: 'ceo@t.kr', role: 'ceo' },
  ];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiErrorFilter());
    await app.init();

    ds = app.get(DataSource);
    const hash = await bcrypt.hash(PW, 4);
    await ds.query('DELETE FROM staff WHERE id = ANY($1)', [PEOPLE.map((p) => p.id)]);
    for (const p of PEOPLE) {
      await ds.query(
        `INSERT INTO staff (id, name, email, role, password_hash, active)
         VALUES ($1,$2,$3,$4,$5,true)`,
        [p.id, p.name, p.email, p.role, hash],
      );
    }
  });

  afterAll(async () => {
    await ds?.query('DELETE FROM staff WHERE id = ANY($1)', [PEOPLE.map((p) => p.id)]);
    await app?.close();
  });

  const login = async (email: string) => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PW })
      .expect(201);
    return res;
  };

  const token = async (email: string) => (await login(email)).body.accessToken as string;

  describe('로그인', () => {
    it.each([
      { email: 'not-email', password: PW },
      { email: 'ceo@t.kr', password: 'short' },
      { email: 'ceo@t.kr', password: 12345678 },
      { email: 'ceo@t.kr', password: PW, extra: true },
    ])('잘못된 입력은 실제 오류 봉투400이고 로그인 서비스에 도달하지 않는다: %p', async (body) => {
      const spy = jest.spyOn(app.get(AuthService), 'login');
      try {
        const res = await request(app.getHttpServer()).post('/auth/login').send(body).expect(400);
        expect(res.body).toMatchObject({ code: 'BAD_REQUEST', message: expect.any(String) });
        expect(spy).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    });
    it('성공하면 Access 는 본문, Refresh 는 httpOnly 쿠키로 온다', async () => {
      const res = await login('ceo@t.kr');
      expect(typeof res.body.accessToken).toBe('string');
      const cookies = res.headers['set-cookie'] as unknown as string[];
      const rt = cookies.find((c) => c.startsWith('taco_rt='));
      expect(rt).toBeDefined();
      expect(rt).toContain('HttpOnly');
      // Refresh 는 본문에 실려 나가지 않는다
      expect(JSON.stringify(res.body)).not.toContain('taco_rt');
      expect(res.body.refreshToken).toBeUndefined();
    });

    it('없는 계정과 틀린 비밀번호가 **같은 문구**로 답한다', async () => {
      const a = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@t.kr', password: PW })
        .expect(401);
      const b = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'ceo@t.kr', password: 'wrong-password-x' })
        .expect(401);
      expect(a.body.message).toBe(b.body.message);
    });

    it('형식이 아니면 400 이고 사람 말로 알려 준다', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: '이메일아님', password: '짧음' })
        .expect(400);
      expect(res.body.message).toContain('이메일 형식이 아닙니다');
      expect(res.body.message).toContain('비밀번호는 8자 이상입니다');
    });
  });

  describe('/auth/me — 플래그를 서버가 내려준다 (D-R39)', () => {
    it.each([
      ['teacher@t.kr', false, false, false],
      ['manager@t.kr', true, true, false],
      ['admin@t.kr', true, true, false],
      ['ceo@t.kr', true, true, true],
    ])('%s → 진입 %s · CRUD %s · 지출 %s', async (email, page, crud, profit) => {
      const t = await token(email);
      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${t}`)
        .expect(200);
      expect(res.body.canAdminPage).toBe(page);
      expect(res.body.canCrudAll).toBe(crud);
      expect(res.body.canSeeProfit).toBe(profit);
    });

    it('토큰 없이 부르면 401', async () => {
      await request(app.getHttpServer()).get('/auth/me').expect(401);
    });
  });

  describe('가드가 서버에서 막는다', () => {
    it('@Public 은 토큰 없이 열린다', async () => {
      await request(app.getHttpServer()).get('/probe/open').expect(200);
    });

    it('기본은 잠겨 있다 — @Perm 이 없어도 인증은 필요하다', async () => {
      await request(app.getHttpServer()).get('/probe/any').expect(401);
      const t = await token('teacher@t.kr');
      await request(app.getHttpServer())
        .get('/probe/any')
        .set('Authorization', `Bearer ${t}`)
        .expect(200);
    });

    it('강사는 canCrudAll 에서 막힌다', async () => {
      const t = await token('teacher@t.kr');
      const res = await request(app.getHttpServer())
        .get('/probe/crud')
        .set('Authorization', `Bearer ${t}`)
        .expect(403);
      // 무엇이 없어서 막혔는지 말해 준다 — "권한 없음" 만으로는 운영에서 못 고친다
      expect(res.body.message).toContain('canCrudAll');
    });

    it('매니저부터는 canCrudAll 이 열린다', async () => {
      for (const email of ['manager@t.kr', 'admin@t.kr', 'ceo@t.kr']) {
        const t = await token(email);
        await request(app.getHttpServer())
          .get('/probe/crud')
          .set('Authorization', `Bearer ${t}`)
          .expect(200);
      }
    });

    it('⭐ 지출·총수입은 대표만 — 관리자도 막힌다', async () => {
      for (const email of ['teacher@t.kr', 'manager@t.kr', 'admin@t.kr']) {
        await request(app.getHttpServer())
          .get('/probe/profit')
          .set('Authorization', `Bearer ${await token(email)}`)
          .expect(403);
      }
      await request(app.getHttpServer())
        .get('/probe/profit')
        .set('Authorization', `Bearer ${await token('ceo@t.kr')}`)
        .expect(200);
    });

    it('옛 역할 이름(head · coord)이 든 토큰은 통과하지 못한다', async () => {
      const jwt = await import('jsonwebtoken');
      const stale = jwt.sign(
        { sub: 904, name: '최대표', role: 'head' },
        process.env.JWT_SECRET as string,
        { expiresIn: '5m' },
      );
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${stale}`)
        .expect(401);
    });
  });

  describe('재발급', () => {
    it('쿠키만 보고 새 Access 를 준다', async () => {
      const res = await login('manager@t.kr');
      const cookies = res.headers['set-cookie'] as unknown as string[];
      const out = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', cookies)
        .expect(201);
      expect(typeof out.body.accessToken).toBe('string');
    });

    it('쿠키가 없으면 401', async () => {
      await request(app.getHttpServer()).post('/auth/refresh').expect(401);
    });
  });

  describe.each(['access', 'refresh'] as const)('JWT 경계: %s', (kind) => {
    const call = (signed: string) => kind === 'access'
      ? request(app.getHttpServer()).get('/probe/any').set('Authorization', `Bearer ${signed}`)
      : request(app.getHttpServer()).post('/auth/refresh').set('Cookie', `taco_rt=${signed}`);
    const secret = () => process.env[kind === 'access' ? 'JWT_SECRET' : 'JWT_REFRESH_SECRET']!;
    it.each([undefined, null, 0, -1, 1.5, '904', [], {}, Number.MAX_SAFE_INTEGER + 1])(
      '서명돼도 잘못된 subject=%p는401이고 계정 조회 전 거절한다', async (sub) => {
        const signed = jwt.sign({ sub, name: '최대표', role: 'ceo' }, secret(), { expiresIn: '5m' });
        const spy = jest.spyOn(ds.getRepository(Staff), 'findOne');
        try {
          await call(signed).expect(401);
          expect(spy).not.toHaveBeenCalled();
        } finally { spy.mockRestore(); }
      },
    );
    it.each(['expired', 'other secret'])('%s 토큰은401', async (mode) => {
      const signed = jwt.sign({ sub: 904, name: '최대표', role: 'ceo' },
        mode === 'other secret' ? 'different-test-signature-key' : secret(),
        { expiresIn: mode === 'expired' ? -1 : '5m' });
      await call(signed).expect(401);
    });
  });

  it('비활성 계정의 로그인/쿠키 갱신과 me는401이다', async () => {
    const before = await login('manager@t.kr');
    await ds.query('UPDATE staff SET active=false WHERE id=902');
    try {
      await request(app.getHttpServer()).post('/auth/login').send({ email: 'manager@t.kr', password: PW }).expect(401);
      await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', before.headers['set-cookie']).expect(401);
      await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${before.body.accessToken}`).expect(401);
    } finally { await ds.query('UPDATE staff SET active=true WHERE id=902'); }
  });

  it('logout은 쿠키를 같은 경로로 만료시키고204/빈 본문을 반환한다', async () => {
    const res = await request(app.getHttpServer()).post('/auth/logout').expect(204);
    expect(res.text).toBe('');
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((cookie) => cookie.startsWith('taco_rt=;') && cookie.includes('Path=/') && cookie.includes('HttpOnly'))).toBe(true);
  });

  it('OpenAPI 로그인 입력과401/400/204 형상이 실제 auth 소비와 일치한다', () => {
    const doc = buildOpenApi(app);
    expect(doc.components?.schemas?.LoginDto).toMatchObject({ properties: {
      email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 },
    } });
    for (const [path, method] of [['/auth/login', 'post'], ['/auth/refresh', 'post'], ['/auth/me', 'get']] as const) {
      expect(doc.paths[path][method]?.responses['401']).toBeDefined();
    }
    expect(doc.paths['/auth/login'].post?.responses['400']).toBeDefined();
    expect(doc.paths['/auth/logout'].post?.responses['204']).toBeDefined();
  });
});
