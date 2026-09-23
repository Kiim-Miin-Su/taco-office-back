/** @file-guide
 * 목적: zoom-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 줌 계정 배정 — **새로 신설** (대표 결정 2026-09-12: 「줌 계정 배정은 새로 신설」).
 *
 * 지금까지 `ser_occ.zacc_id` 에 쓰는 코드가 저장소에 하나도 없어서, 현황판의 「줌」 칸은
 * 언제나 「안 붙었다」였고 §20 의 줌 변경 요청은 `applicable=false` 였다.
 *
 * 여기서 증명하는 것은 넷이다.
 *   ① 정본은 `zassign` 이고 `ser_occ.zacc_id` 는 그 **투영**이다
 *   ② 회차 하나만 다른 계정을 쓰면 그 회차가 이긴다
 *   ③ 같은 계정이 같은 시간에 두 수업에 붙지 않는다 — 마지막은 표(EXCLUDE)가 막는다
 *   ④ 비밀은 평문으로 저장하지 않고, 어느 응답에도 싣지 않는다
 */
import { ConfigService } from '@nestjs/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { DataSource, QueryRunner } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { dataSourceOptions } from '../src/data-source';
import { Zacc } from '../src/entities';
import { nowHourKst, todayKst } from '../src/lib/kst';
import { addD } from '../src/lib/recurrence';
import { monthClosedMessage } from '../src/lib/month-close';
import { openSecret, sealSecret, secretKeyFrom } from '../src/lib/secret-box';
import { ZoomService } from '../src/modules/zoom/zoom.service';
import { ZoomAccountCreateDto, ZoomAccountPatchDto } from '../src/modules/zoom/zoom.dto';
import * as stateRepo from '../src/modules/schedule/schedule.state.repo';
import { project } from '../src/modules/schedule/schedule.project';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions, url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

describe.each([ZoomAccountCreateDto, ZoomAccountPatchDto])('%s 선택 입력의 OpenAPI 계약', (dto) => {
  it.each([
    ['meetingId', 30],
    ['loginSecret', 200],
    ['meetingPw', 50],
  ])('%s의 길이 제한을 생성 계약에 공개한다', (field, maxLength) => {
    expect(Reflect.getMetadata('swagger/apiModelProperties', dto.prototype, field)).toMatchObject({
      type: String, required: false, maxLength,
    });
  });
});

describe('줌 비밀은 평문으로 두지 않는다 (AES-256-GCM)', () => {
  const key = secretKeyFrom('테스트 키')!;
  it('봉한 것을 열면 같은 값이 나오고, 봉한 모양은 평문이 아니다', () => {
    const sealed = sealSecret('taco1234!', key);
    expect(sealed.toString('utf8')).not.toContain('taco1234!');
    expect(openSecret(sealed, key)).toBe('taco1234!');
  });
  it('한 바이트만 건드려도 열리지 않는다 — 훼손을 알아챈다(GCM)', () => {
    const sealed = sealSecret('taco1234!', key);
    sealed[sealed.length - 1] ^= 0xff;
    expect(openSecret(sealed, key)).toBeNull();
  });
  it('키가 다르면 열리지 않는다', () => {
    expect(openSecret(sealSecret('x', key), secretKeyFrom('다른 키')!)).toBeNull();
  });
  it('키가 없으면 만들지 않는다 — 평문으로 흘려보내는 대비책을 두지 않는다', () => {
    expect(secretKeyFrom(undefined)).toBeNull();
    expect(secretKeyFrom('   ')).toBeNull();
  });
});

d('줌 배정 — 정본은 ZASSIGN, ser_occ 는 투영이다 (C48)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const ME = 72;
  const cfg = { get: (k: string) => (k === 'ZOOM_ENC_KEY' ? '테스트 키' : undefined) } as unknown as ConfigService;
  const svc = () => new ZoomService(q.manager.getRepository(Zacc), cfg);

  /** 같은 시간에 도는 수업 규칙 하나 — 겹침 실험에 쓴다 */
  const makeSer = async (subKey: string, startHour = 10): Promise<number> => {
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ('zoom_test','줌검증','#000000',4,'lesson',false)
       ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(`INSERT INTO sub (key,name,color) VALUES ($1,$1,'#000000') ON CONFLICT (key) DO NOTHING`, [subKey]);
    const [r] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, mode, start_min, end_min, rrule, from_date, to_date)
       VALUES ('zoom_test', $1, 'online', $2::int, $2::int + 60, 'WEEKLY:MO,TU,WE,TH,FR,SA,SU',
               (now() AT TIME ZONE 'Asia/Seoul')::date, (now() AT TIME ZONE 'Asia/Seoul')::date + 3)
       RETURNING id`, [subKey, startHour * 60],
    )) as { id: string }[];
    return Number(r.id);
  };

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES ($1,'줌 담당','zoom72@t.kr','admin') ON CONFLICT (id) DO NOTHING`, [ME],
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('계정을 만들면 비밀은 암호화돼 들어가고 응답에는 값이 없다', async () => {
    const out = await svc().create(ME, {
      label: 'TEST-A', loginEmail: 'a@tn.kr', joinUrl: 'https://zoom.us/j/1', loginSecret: 'pw1234',
    });
    expect(out).toMatchObject({ label: 'TEST-A', active: true, hasSecret: true, usedCount: 0 });
    expect(JSON.stringify(out)).not.toContain('pw1234');

    const [row] = (await q.query(`SELECT login_secret FROM zacc WHERE id = $1`, [out.id])) as { login_secret: Buffer }[];
    expect(row.login_secret.toString('utf8')).not.toContain('pw1234');
    expect(openSecret(row.login_secret, secretKeyFrom('테스트 키')!)).toBe('pw1234');
  });

  it('같은 이름은 두 번 만들지 않는다', async () => {
    await svc().create(ME, { label: 'TEST-B', loginEmail: 'b@tn.kr', joinUrl: 'https://zoom.us/j/2' });
    await expect(svc().create(ME, { label: 'TEST-B', loginEmail: 'c@tn.kr', joinUrl: 'https://zoom.us/j/3' }))
      .rejects.toMatchObject({ response: { code: 'ZACC_LABEL_TAKEN' } });
  });

  it('규칙에 붙이면 그 규칙의 **모든 회차**에 투영된다', async () => {
    const acc = await svc().create(ME, { label: 'TEST-C', loginEmail: 'c@tn.kr', joinUrl: 'https://zoom.us/j/4' });
    const serId = await makeSer('ap-chem');
    const out = await svc().assign(ME, { serId, zaccId: acc.id });
    expect(out.projected).toBeGreaterThan(0);
    const [{ n }] = (await q.query(
      `SELECT count(*)::int AS n FROM ser_occ WHERE ser_id = $1 AND zacc_id = $2`, [serId, acc.id],
    )) as { n: number }[];
    expect(n).toBe(out.projected);
  });

  it('회차 하나만 다른 계정을 쓰면 그 회차가 이긴다', async () => {
    const base = await svc().create(ME, { label: 'TEST-D', loginEmail: 'd@tn.kr', joinUrl: 'https://zoom.us/j/5' });
    const one = await svc().create(ME, { label: 'TEST-E', loginEmail: 'e@tn.kr', joinUrl: 'https://zoom.us/j/6' });
    const serId = await makeSer('writing');
    await svc().assign(ME, { serId, zaccId: base.id });
    const [{ d: day }] = (await q.query(
      `SELECT to_char(on_date,'YYYY-MM-DD') AS d FROM ser_occ WHERE ser_id = $1 ORDER BY on_date LIMIT 1`, [serId],
    )) as { d: string }[];
    await svc().assign(ME, { serId, onDate: day, zaccId: one.id });

    const rows = (await q.query(
      `SELECT to_char(on_date,'YYYY-MM-DD') AS d, zacc_id FROM ser_occ WHERE ser_id = $1 ORDER BY on_date`, [serId],
    )) as { d: string; zacc_id: string }[];
    expect(Number(rows.find((r) => r.d === day)!.zacc_id)).toBe(one.id);
    expect(rows.filter((r) => r.d !== day).every((r) => Number(r.zacc_id) === base.id)).toBe(true);
  });

  it('떼면 비워진다 — null 을 주면 배정이 사라진다', async () => {
    const acc = await svc().create(ME, { label: 'TEST-F', loginEmail: 'f@tn.kr', joinUrl: 'https://zoom.us/j/7' });
    const serId = await makeSer('sat-math');
    await svc().assign(ME, { serId, zaccId: acc.id });
    await svc().assign(ME, { serId, zaccId: null });
    const [{ n }] = (await q.query(
      `SELECT count(*)::int AS n FROM ser_occ WHERE ser_id = $1 AND zacc_id IS NOT NULL`, [serId],
    )) as { n: number }[];
    expect(n).toBe(0);
  });

  it('같은 계정이 같은 시간에 두 수업에 붙지 않는다 — 마지막은 표가 막는다', async () => {
    const acc = await svc().create(ME, { label: 'TEST-G', loginEmail: 'g@tn.kr', joinUrl: 'https://zoom.us/j/8' });
    const a = await makeSer('reading-lab');
    const b = await makeSer('vocabulary');
    await svc().assign(ME, { serId: a, zaccId: acc.id });
    await expect(svc().assign(ME, { serId: b, zaccId: acc.id })).rejects.toThrow();

    // 막힌 뒤에도 먼저 붙인 쪽은 그대로다 — 통째로 되돌아갔다
    const [{ n }] = (await q.query(
      `SELECT count(*)::int AS n FROM ser_occ WHERE ser_id = $1 AND zacc_id = $2`, [a, acc.id],
    )) as { n: number }[];
    expect(n).toBeGreaterThan(0);
  });

  it('꺼 둔 계정은 새로 배정하지 않는다 — 이미 붙은 회차는 건드리지 않는다', async () => {
    const acc = await svc().create(ME, { label: 'TEST-H', loginEmail: 'h@tn.kr', joinUrl: 'https://zoom.us/j/9' });
    await svc().patch(ME, acc.id, { active: false });
    const serId = await makeSer('map-math');
    await expect(svc().assign(ME, { serId, zaccId: acc.id }))
      .rejects.toMatchObject({ response: { code: 'ZACC_INACTIVE' } });
  });

  it('격자는 점유를 ser_occ 에서 센다 — 「지금 가능」도 같은 배열에서 나온다', async () => {
    const acc = await svc().create(ME, { label: 'TEST-I', loginEmail: 'i@tn.kr', joinUrl: 'https://zoom.us/j/10' });
    const serId = await makeSer('interview');
    await svc().assign(ME, { serId, zaccId: acc.id });
    const [{ d: today }] = (await q.query(
      `SELECT to_char(on_date,'YYYY-MM-DD') AS d FROM ser_occ WHERE ser_id = $1 ORDER BY on_date LIMIT 1`, [serId],
    )) as { d: string }[];

    const board = await svc().board(today);
    const row = board.rows.find((r) => r.zaccId === acc.id)!;
    expect(row.slots.find((s) => s.hour === 10)!.busy).toBe(1);
    expect(board.fromHour).toBe(8);
    expect(board.toHour).toBe(21);
    expect(JSON.stringify(board)).not.toContain('login_secret');
  });

  /**
   * 「지금 가능」이 묻는 것은 **그 시각에** 비었는가다 — 하루 내내 비었는가가 아니다.
   *
   * 전에는 하루 기준이었다. 원문 §21 은 다섯 계정 모두 낮에 붉은 칸이 있는데도
   * 「지금 가능 5」라고 적는다. 하루 기준이면 그 화면은 **0** 이 된다.
   * 그래서 지금 시각이 **아닌** 시간에 수업이 붙은 계정을 만들어, 그 계정이 여전히
   * 「지금 가능」에 들어오는지를 본다.
   */
  it('「지금 가능」은 그 시각 기준이다 — 다른 시간에 수업이 있어도 지금 비었으면 가능이다', async () => {
    const now = nowHourKst();
    const busyAt = now === 10 ? 11 : 10;          // 지금이 아닌 시각을 고른다 (둘 다 격자 안 8~21)
    const acc = await svc().create(ME, { label: 'TEST-NOW', loginEmail: 'n@tn.kr', joinUrl: 'https://zoom.us/j/11' });
    const serId = await makeSer('read_lab', busyAt);
    await svc().assign(ME, { serId, zaccId: acc.id });
    const [{ d: today }] = (await q.query(
      `SELECT to_char(on_date,'YYYY-MM-DD') AS d FROM ser_occ WHERE ser_id = $1 ORDER BY on_date LIMIT 1`, [serId],
    )) as { d: string }[];

    const board = await svc().board(today);
    expect(board.nowHour).toBe(now);
    const row = board.rows.find((r) => r.zaccId === acc.id)!;
    expect(row.slots.find((s) => s.hour === busyAt)!.busy).toBe(1);   // 그 시각에는 차 있고
    expect(board.freeLabels).toContain('TEST-NOW');                   // 지금은 비어 있다
  });

  it('수와 이름은 **한 배열**에서 나온다 — 「5개」인데 이름이 넷인 화면이 없다', async () => {
    const acc = await svc().create(ME, { label: 'TEST-PAIR', loginEmail: 'p@tn.kr', joinUrl: 'https://zoom.us/j/12' });
    const serId = await makeSer('vocab', nowHourKst() === 9 ? 14 : 9);
    await svc().assign(ME, { serId, zaccId: acc.id });
    const board = await svc().board();

    expect(board.freeNow).toBe(board.freeLabels.length);
    const busyNow = (r: { slots: Array<{ hour: number; busy: number }> }) =>
      r.slots.find((s) => s.hour === board.nowHour)?.busy ?? 0;
    expect(board.freeLabels).toEqual(board.rows.filter((r) => busyNow(r) === 0).map((r) => r.label));
  });

  it('오늘이 아니면 「지금」이 없다 — 셈을 지어내지 않고 비운다', async () => {
    await svc().create(ME, { label: 'TEST-FUT', loginEmail: 'f@tn.kr', joinUrl: 'https://zoom.us/j/13' });
    const [{ d: later }] = (await q.query(
      `SELECT to_char((now() AT TIME ZONE 'Asia/Seoul')::date + 3,'YYYY-MM-DD') AS d`,
    )) as { d: string }[];

    const board = await svc().board(later);
    expect(board.onDate).toBe(later);
    expect(board.nowHour).toBeNull();
    expect(board.freeNow).toBe(0);
    expect(board.freeLabels).toEqual([]);
    expect(board.rows.length).toBeGreaterThan(0);   // 격자는 그대로 그린다
  });
});

/**
 * S3-a — 실제 로그인/JWT → ValidationPipe/PermGuard → ZACC/ZLOG → 새 HTTP 조회.
 * 스크래치 DB만 쓰며 소유 행만 정리한다. 10/01은 STAFF에 없는 조합이므로
 * currentUser의 최종 projection만 주입하고 HTTP guard/service/DB는 실제 구현을 사용한다.
 */
d('S3-a 줌 계정 HTTP 입력·권한·영속화', () => {
  let app: INestApplication;
  let ds: DataSource;
  const ADMIN = 29871;
  const TEACHER = 29872;
  const ACCOUNT_EMAIL = 's3a-account@t.invalid';
  const PASSWORD = 's3a-local-login-only';
  const OLD_LOGIN_SECRET = 's3a-original-login';
  const OLD_MEETING_SECRET = 's3a-original-meeting';
  const tokens = new Map<number, string>();
  let accountId: number;
  const key = () => secretKeyFrom(process.env.ZOOM_ENC_KEY)!;
  const sql = <T = Record<string, unknown>>(statement: string, params: unknown[] = []): Promise<T[]> =>
    ds.query(statement, params) as Promise<T[]>;
  const http = (method: 'get' | 'post' | 'patch', path: string, actor = ADMIN) =>
    request(app.getHttpServer())[method](path)
      .set('Authorization', `Bearer ${tokens.get(actor)}`)
      .timeout({ response: 10000, deadline: 20000 });
  const valid = () => ({ label: 'S3A-created', loginEmail: ACCOUNT_EMAIL, joinUrl: 'https://zoom.us/j/123?pwd=sample' });
  const snapshot = async () => ({
    accounts: await sql('SELECT id,label,login_email,join_url,meeting_id,active,login_secret,meeting_pw_enc FROM zacc ORDER BY id'),
    logs: await sql('SELECT id,zacc_id,actor_id,action FROM zlog ORDER BY id'),
  });
  const readSecrets = async () => {
    const [row] = await sql<{ login_secret: Buffer; meeting_pw_enc: Buffer }>('SELECT login_secret,meeting_pw_enc FROM zacc WHERE id=$1', [accountId]);
    return { login: openSecret(row.login_secret, key()), meeting: openSecret(row.meeting_pw_enc, key()) };
  };

  beforeAll(async () => {
    // AppModule reads DATABASE_URL at import time. Explicitly rebind only its DB provider
    // to TEST_URL so this suite never mutates a seeded development or production DB.
    const scratch = scratchDataSource();
    await scratch.initialize();
    ds = scratch;
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource).useValue(ds).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const hash = await bcrypt.hash(PASSWORD, 4);
    await sql(`INSERT INTO staff(id,name,email,role,password_hash,active) VALUES
      ($1,'S3A 관리자','s3a-admin@t.invalid','admin',$3,true),
      ($2,'S3A 강사','s3a-teacher@t.invalid','teacher',$3,true)`, [ADMIN, TEACHER, hash]);
    for (const [actor, email] of [[ADMIN, 's3a-admin@t.invalid'], [TEACHER, 's3a-teacher@t.invalid']] as const) {
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD }).expect(201);
      tokens.set(actor, res.body.accessToken as string);
    }
  });

  beforeEach(async () => {
    const [made] = await sql<{ id: string }>(`INSERT INTO zacc(label,login_email,login_secret,join_url,meeting_id,meeting_pw_enc,active)
      VALUES ('S3A-base',$1,$2,'https://zoom.us/j/1','111 222',$3,true) RETURNING id`,
    [ACCOUNT_EMAIL, sealSecret(OLD_LOGIN_SECRET, key()), sealSecret(OLD_MEETING_SECRET, key())]);
    accountId = Number(made.id);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await sql(`DELETE FROM zlog WHERE zacc_id IN (SELECT id FROM zacc WHERE label LIKE 'S3A-%' OR login_email=$1)`, [ACCOUNT_EMAIL]);
    await sql(`DELETE FROM zacc WHERE label LIKE 'S3A-%' OR login_email=$1`, [ACCOUNT_EMAIL]);
    await sql(`UPDATE staff SET role='admin',active=true WHERE id=$1`, [ADMIN]);
  });
  afterAll(async () => {
    if (ds?.isInitialized) await sql('DELETE FROM staff WHERE id=ANY($1::bigint[])', [[ADMIN, TEACHER]]);
    if (app) await app.close();
    if (ds?.isInitialized) await ds.destroy();
  });

  it('정상 생성→새 GET/DB에서 trim·선택값과 비밀 비노출이 일치한다', async () => {
    const res = await http('post', '/zoom/accounts').send({ ...valid(), label: '  S3A-created  ', meetingId: '  333  ', loginSecret: ' s3a-new-secret ', meetingPw: ' s3a-new-meeting ' }).expect(201);
    const fresh = await http('get', '/zoom').expect(200);
    const [stored] = await sql<{ label: string; meeting_id: string; login_secret: Buffer; meeting_pw_enc: Buffer }>('SELECT label,meeting_id,login_secret,meeting_pw_enc FROM zacc WHERE id=$1', [res.body.id]);
    expect(stored.label).toBe('S3A-created');
    expect(stored.meeting_id).toBe('333');
    expect(openSecret(stored.login_secret, key())).toBe(' s3a-new-secret ');
    expect(openSecret(stored.meeting_pw_enc, key())).toBe(' s3a-new-meeting ');
    expect(fresh.body.accounts.find((a: { id: number }) => a.id === res.body.id)).toMatchObject({ label: 'S3A-created', meetingId: '333', hasSecret: true });
    for (const response of [res.body, fresh.body]) {
      expect(JSON.stringify(response)).not.toContain('s3a-new-secret');
      expect(JSON.stringify(response)).not.toContain('s3a-new-meeting');
    }
  });

  it.each([undefined, ''])('생성 비밀 %s는 DB형식을 유지하지만 새 조회에서도 hasSecret=false다', async (loginSecret) => {
    const res = await http('post', '/zoom/accounts').send({ ...valid(), loginSecret }).expect(201);
    const fresh = await http('get', '/zoom').expect(200);
    const [stored] = await sql<{ login_secret: Buffer }>('SELECT login_secret FROM zacc WHERE id=$1', [res.body.id]);
    expect(stored.login_secret).toHaveLength(28);
    expect({ created: res.body.hasSecret, read: fresh.body.accounts.find((a: { id: number }) => a.id === res.body.id).hasSecret }).toEqual({ created: false, read: false });
  });

  const invalidUrl = [
    'javascript:alert(1)', 'data:text/html,example', '//zoom.us/j/1', '/j/1', 'https://',
    'https://user:password@zoom.us/j/1', 'https://zoom.us/\n/j/1', 'https://zoom.us/\t/j/1',
    '\nhttps://zoom.us/j/1', 'https:///zoom.us/j/1', 'https://zoom.us\\j\\1',
  ];
  it.each(invalidUrl)('위험/비절대 URL %s 생성과 수정은400·ZACC/ZLOG불변', async (joinUrl) => {
    const before = await snapshot();
    const created = await http('post', '/zoom/accounts').send({ ...valid(), joinUrl });
    const patched = await http('patch', `/zoom/accounts/${accountId}`).send({ joinUrl });
    expect({ create: created.status, patch: patched.status, state: await snapshot() }).toEqual({ create: 400, patch: 400, state: before });
    expect(JSON.stringify(created.body)).toContain('참가 링크는 로그인 정보가 없는');
    expect(JSON.stringify(patched.body)).toContain('참가 링크는 로그인 정보가 없는');
  });

  it.each(['label', 'loginEmail', 'joinUrl'])('%s 공백은 생성/PATCH400이고 저장하지 않는다', async (field) => {
    const before = await snapshot();
    const created = await http('post', '/zoom/accounts').send({ ...valid(), [field]: '   ' });
    const patched = await http('patch', `/zoom/accounts/${accountId}`).send({ [field]: '   ' });
    expect({ create: created.status, patch: patched.status, state: await snapshot() }).toEqual({ create: 400, patch: 400, state: before });
  });

  it.each(['label', 'loginEmail', 'joinUrl', 'meetingId', 'loginSecret', 'meetingPw', 'active'])('PATCH %s null은400이며 동봉된 정상 수정도 rollback한다', async (field) => {
    const before = await snapshot();
    const res = await http('patch', `/zoom/accounts/${accountId}`).send({ label: 'S3A-rejected', [field]: null });
    expect({ status: res.status, state: await snapshot() }).toEqual({ status: 400, state: before });
  });

  it.each(['label', 'loginEmail', 'joinUrl', 'meetingId', 'loginSecret', 'meetingPw'])('생성 %s null은400·ZACC/ZLOG불변', async (field) => {
    const before = await snapshot();
    const res = await http('post', '/zoom/accounts').send({ ...valid(), [field]: null });
    expect({ status: res.status, state: await snapshot() }).toEqual({ status: 400, state: before });
  });

  it.each([
    ['label', 21], ['loginEmail', 121], ['joinUrl', 501], ['meetingId', 31], ['loginSecret', 201], ['meetingPw', 51],
  ] as const)('%s 길이 상한을 넘으면400·불변', async (field, length) => {
    const before = await snapshot();
    const res = await http('patch', `/zoom/accounts/${accountId}`).send({ [field]: 'a'.repeat(length) });
    expect({ status: res.status, state: await snapshot() }).toEqual({ status: 400, state: before });
  });

  it('meetingId 생략은유지, 빈문자열은NULL로 새 GET에 반영된다', async () => {
    await http('patch', `/zoom/accounts/${accountId}`).send({ label: 'S3A-renamed' }).expect(200);
    expect((await sql('SELECT meeting_id FROM zacc WHERE id=$1', [accountId]))[0].meeting_id).toBe('111 222');
    await http('patch', `/zoom/accounts/${accountId}`).send({ meetingId: '' }).expect(200);
    const res = await http('get', '/zoom').expect(200);
    expect(res.body.accounts.find((a: { id: number }) => a.id === accountId).meetingId).toBeNull();
  });

  it.each(['loginSecret', 'meetingPw'])('PATCH %s 빈문자열은 기존 암호문과 rotate 로그를 보존한다', async (field) => {
    const before = await snapshot();
    const res = await http('patch', `/zoom/accounts/${accountId}`).send({ label: 'S3A-base', [field]: '' });
    expect({ status: res.status, state: await snapshot() }).toEqual({ status: 200, state: before });
    expect(await readSecrets()).toEqual({ login: OLD_LOGIN_SECRET, meeting: OLD_MEETING_SECRET });
  });

  it('비밀 생략은유지, 공백을 포함한 실제 비밀 교체는 원문·로그만 바꾼다', async () => {
    await http('patch', `/zoom/accounts/${accountId}`).send({ meetingId: '444' }).expect(200);
    expect(await readSecrets()).toEqual({ login: OLD_LOGIN_SECRET, meeting: OLD_MEETING_SECRET });
    await http('patch', `/zoom/accounts/${accountId}`).send({ loginSecret: '  ', meetingPw: ' secret with spaces ' }).expect(200);
    expect(await readSecrets()).toEqual({ login: '  ', meeting: ' secret with spaces ' });
    expect(await sql('SELECT action FROM zlog WHERE zacc_id=$1', [accountId])).toEqual([{ action: 'rotate' }]);
  });

  it.each([{}, { loginSecret: '' }, { meetingPw: '' }, { loginSecret: '', meetingPw: '' }])('실효 변경이 없는 PATCH %j는400 NOTHING_TO_CHANGE·불변', async (body) => {
    const before = await snapshot();
    const res = await http('patch', `/zoom/accounts/${accountId}`).send(body);
    expect({ status: res.status, code: res.body.code, state: await snapshot() }).toEqual({ status: 400, code: 'NOTHING_TO_CHANGE', state: before });
  });

  it.each(['0', '-1', '1.5', '1e2', '0x10', '9007199254740993', "1 OR 1=1", "1;DELETE FROM zacc"])('잘못된 계정 path %s는400이며 기존 계정은 불변', async (id) => {
    const before = await snapshot();
    const res = await http('patch', `/zoom/accounts/${encodeURIComponent(id)}`).send({ active: false });
    expect({ status: res.status, state: await snapshot() }).toEqual({ status: 400, state: before });
  });

  it('정상 안전 정수지만 없는 계정은404다', async () => {
    await http('patch', '/zoom/accounts/9007199254740991').send({ active: false }).expect(404);
  });

  it.each(['2026-02-30', '2025-02-29', '2026-13-01', "2026-09-24' OR '1'='1", ''])('조회 날짜 %s는400이고 DB에 영향 없다', async (onDate) => {
    const before = await snapshot();
    const res = await http('get', '/zoom').query({ onDate });
    expect({ status: res.status, state: await snapshot() }).toEqual({ status: 400, state: before });
  });

  it('윤일과 생략 날짜는 정상이고 날짜 배열/알 수 없는 입력은400이다', async () => {
    await http('get', '/zoom').query({ onDate: '2028-02-29' }).expect(200);
    await http('get', '/zoom').expect(200);
    await http('get', '/zoom?onDate=2026-09-24&onDate=2026-09-25').expect(400);
    const before = await snapshot();
    const res = await http('patch', `/zoom/accounts/${accountId}`).send({ active: false, unexpected: true });
    expect({ status: res.status, state: await snapshot() }).toEqual({ status: 400, state: before });
  });

  it('실제 익명401/강사403은 읽기·생성·수정을 막고 DB를 보존한다', async () => {
    const before = await snapshot();
    for (const actor of [undefined, TEACHER]) {
      for (const [method, path, body] of [['get', '/zoom', undefined], ['post', '/zoom/accounts', valid()], ['patch', `/zoom/accounts/${accountId}`, { active: false }]] as const) {
        const call = actor === undefined ? request(app.getHttpServer())[method](path) : http(method, path, actor);
        const res = body ? await call.send(body) : await call;
        expect(res.status).toBe(actor === undefined ? 401 : 403);
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it.each([[false, false], [true, false], [false, true], [true, true]] as const)('최종 projection admin=%s/crud=%s: GET은admin·계정쓰기는둘다 필요', async (canAdminPage, canCrudAll) => {
    const auth = app.get(AuthService);
    const current = auth.currentUser.bind(auth);
    jest.spyOn(auth, 'currentUser').mockImplementation(async (id) => ({ ...await current(id), perms: { canAdminPage, canCrudAll } }));
    const before = await snapshot();
    const read = await http('get', '/zoom');
    const create = await http('post', '/zoom/accounts').send(valid());
    const patch = await http('patch', `/zoom/accounts/${accountId}`).send({ active: false });
    const allowed = canAdminPage && canCrudAll;
    const state = await snapshot();
    expect({ get: read.status, create: create.status, patch: patch.status, unchanged: allowed || JSON.stringify(state) === JSON.stringify(before) })
      .toEqual({ get: canAdminPage ? 200 : 403, create: allowed ? 201 : 403, patch: allowed ? 200 : 403, unchanged: true });
  });

  it('실제 JWT발급 뒤 역할/활성 권한 회수도 같은 토큰의 후속 요청을 막는다', async () => {
    const before = await snapshot();
    await sql("UPDATE staff SET role='teacher' WHERE id=$1", [ADMIN]);
    await http('patch', `/zoom/accounts/${accountId}`).send({ active: false }).expect(403);
    await sql('UPDATE staff SET active=false WHERE id=$1', [ADMIN]);
    await http('post', '/zoom/accounts').send(valid()).expect(401);
    expect(await snapshot()).toEqual(before);
  });

  it('동일 이름409·활성 변경 정상200을 새 조회로 확인한다', async () => {
    const before = await snapshot();
    await http('post', '/zoom/accounts').send({ ...valid(), label: 'S3A-base' }).expect(409);
    expect(await snapshot()).toEqual(before);
    await http('patch', `/zoom/accounts/${accountId}`).send({ active: false }).expect(200);
    const res = await http('get', '/zoom').expect(200);
    expect(res.body.accounts.find((a: { id: number }) => a.id === accountId).active).toBe(false);
  });
});

/**
 * S3-b: 실제 HTTP/JWT/guard → 공용 assignIn → EXC/ZASSIGN/ZLOG/SER_OCC.
 * 전용 scratch DB에만 소유 fixture를 만들고 삭제한다. 10/01 조합만 최종 권한 projection 대역이다.
 * 경합은 기존 schedule-write 시험처럼 첫 부모 snapshot을 멈추고 pg_blocking_pids로 확인한다.
 */
d('S3-b 회차 줌 배정 HTTP·월마감·외부 transaction', () => {
  let app: INestApplication;
  let ds: DataSource;
  const ADMIN = 29881;
  const TEACHER = 29882;
  const KIND = 's3b_zoom';
  const PASSWORD = 's3b-local-login-only';
  const DAY = addD(todayKst(), 2);
  const PREV = addD(`${todayKst().slice(0, 7)}-01`, -1).slice(0, 7);
  const PREV_DAY = `${PREV}-15`;
  const tokens = new Map<number, string>();
  const made: number[] = [];
  let accounts: number[] = [];
  let serId: number;

  const sql = <T = Record<string, unknown>>(statement: string, params: unknown[] = []): Promise<T[]> =>
    ds.query(statement, params) as Promise<T[]>;
  const http = (method: 'get' | 'post' | 'patch', path: string, actor = ADMIN) =>
    request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${tokens.get(actor)}`)
      .timeout({ response: 10000, deadline: 20000 });
  const body = () => ({ serId, onDate: DAY, zaccId: accounts[0] });
  const assign = (value: Record<string, unknown> = body()) => http('post', '/zoom/assign').send(value);
  const rebuild = (id: number) => ds.transaction(async (m) => {
    const q = m.queryRunner!;
    await project(q, await stateRepo.loadState(q, [id], { forWrite: true }), [id]);
  });
  const makeSeries = async (options: { mode?: 'online' | 'offline'; from?: string; to?: string; once?: boolean } = {}) => {
    const from = options.from ?? DAY;
    const [row] = await sql<{ id: string }>(`INSERT INTO ser(kind_key,mode,start_min,end_min,rrule,from_date,to_date,title)
      VALUES ($1,$2,600,660,$3,$4::date,$5::date,'S3B 배정 회차') RETURNING id`,
    [KIND, options.mode ?? 'online', options.once ? 'ONCE' : 'DAILY', from, options.to ?? (options.once ? from : addD(from, 2))]);
    const id = Number(row.id);
    made.push(id);
    await rebuild(id);
    return id;
  };
  const addException = async (id: number, onDate: string, options: { moved?: string; canceled?: boolean }) => {
    await sql(`INSERT INTO exc(ser_id,on_date,canceled,new_date,reason,by_id)
      VALUES ($1,$2::date,$3,$4::date,'S3B fixture',$5)`, [id, onDate, options.canceled ?? false, options.moved ?? null, ADMIN]);
    await rebuild(id);
  };
  const makeRequest = async (id = serId, onDate = DAY, zaccId = accounts[0], applyAll = false) => {
    const [row] = await sql<{ id: string }>(`INSERT INTO chreq(ser_id,on_date,req_type,payload,reason,by_id,apply_all)
      VALUES ($1,$2::date,'room',$3::jsonb,'S3B 줌 변경',$4,$5) RETURNING id`,
    [id, onDate, JSON.stringify({ zaccId }), TEACHER, applyAll]);
    return Number(row.id);
  };
  const approve = (id: number) => http('post', `/drawer/change-requests/${id}/review`).send({ decision: 'approve' });
  const closeMonth = (month: string) => sql('INSERT INTO month_close(year_month,closed_by) VALUES ($1,$2)', [month, ADMIN]);
  const snapshot = async () => ({
    series: await sql('SELECT * FROM ser WHERE id=ANY($1::bigint[]) ORDER BY id', [made]),
    exceptions: await sql('SELECT * FROM exc WHERE ser_id=ANY($1::bigint[]) ORDER BY id', [made]),
    assignments: await sql(`SELECT z.* FROM zassign z LEFT JOIN exc e ON e.id=z.exc_id
      WHERE z.ser_id=ANY($1::bigint[]) OR e.ser_id=ANY($1::bigint[]) ORDER BY z.id`, [made]),
    assignmentLogs: await sql('SELECT * FROM zlog WHERE zacc_id=ANY($1::bigint[]) ORDER BY id', [accounts]),
    occurrences: await sql('SELECT * FROM ser_occ WHERE ser_id=ANY($1::bigint[]) ORDER BY ser_id,on_date', [made]),
    requests: await sql('SELECT * FROM chreq WHERE ser_id=ANY($1::bigint[]) ORDER BY id', [made]),
    logs: await sql('SELECT * FROM log WHERE actor_id=$1 ORDER BY id', [ADMIN]),
    notifications: await sql('SELECT * FROM noti WHERE from_id=$1 ORDER BY id', [ADMIN]),
  });
  const expectUnchanged = async (run: () => PromiseLike<request.Response>, status: number, code?: string, message?: string) => {
    const before = await snapshot();
    const res = await run();
    expect({ status: res.status, ...(code ? { code: res.body.code } : {}), ...(message ? { message: res.body.message } : {}), state: await snapshot() })
      .toEqual({ status, ...(code ? { code } : {}), ...(message ? { message } : {}), state: before });
  };

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DataSource).useValue(ds).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    await sql(`INSERT INTO kind(key,name,color,cap,grp,rep) VALUES ($1,'S3B 배정','#000000',4,'lesson',false)`, [KIND]);
    await sql(`INSERT INTO staff(id,name,email,role,password_hash,active) VALUES
      ($1,'S3B 관리자','s3b-admin@t.invalid','admin',$3,true),
      ($2,'S3B 강사','s3b-teacher@t.invalid','teacher',$3,true)`, [ADMIN, TEACHER, await bcrypt.hash(PASSWORD, 4)]);
    for (const [id, email] of [[ADMIN, 's3b-admin@t.invalid'], [TEACHER, 's3b-teacher@t.invalid']] as const) {
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD }).expect(201);
      tokens.set(id, res.body.accessToken as string);
    }
  });
  beforeEach(async () => {
    accounts = (await sql<{ id: string }>(`INSERT INTO zacc(label,login_email,login_secret,join_url,active)
      VALUES ('S3B-A','s3b-a@t.invalid',$1,'https://zoom.us/j/31',true),
             ('S3B-B','s3b-b@t.invalid',$1,'https://zoom.us/j/32',true) RETURNING id`,
    [sealSecret('', secretKeyFrom(process.env.ZOOM_ENC_KEY)!)])).map((row) => Number(row.id));
    serId = await makeSeries();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await sql('DELETE FROM month_close WHERE closed_by=$1', [ADMIN]);
    await sql('DELETE FROM log WHERE actor_id=$1', [ADMIN]);
    await sql('DELETE FROM noti WHERE from_id=$1 OR to_id=ANY($2::bigint[])', [ADMIN, [ADMIN, TEACHER]]);
    await sql('DELETE FROM chreq WHERE ser_id=ANY($1::bigint[])', [made]);
    await sql('DELETE FROM zlog WHERE zacc_id=ANY($1::bigint[])', [accounts]);
    await sql('DELETE FROM zassign WHERE zacc_id=ANY($1::bigint[])', [accounts]);
    await sql('DELETE FROM ser_occ WHERE ser_id=ANY($1::bigint[])', [made]);
    await sql('DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id=ANY($1::bigint[]))', [made]);
    await sql('DELETE FROM exc WHERE ser_id=ANY($1::bigint[])', [made]);
    await sql('DELETE FROM ser WHERE id=ANY($1::bigint[])', [made]);
    await sql('DELETE FROM zacc WHERE id=ANY($1::bigint[])', [accounts]);
    await sql("UPDATE staff SET role='admin',active=true WHERE id=$1", [ADMIN]);
    made.length = 0;
  });
  afterAll(async () => {
    if (ds?.isInitialized) {
      await sql('DELETE FROM staff WHERE id=ANY($1::bigint[])', [[ADMIN, TEACHER]]);
      await sql('DELETE FROM kind WHERE key=$1', [KIND]);
    }
    await app?.close();
    if (ds?.isInitialized) await ds.destroy();
  });

  it.each(['serId', 'zaccId'].flatMap((field) =>
    [0, -1, 1.5, 9007199254740992, '1', '0x10', '1e2', '1 OR 1=1', []].map((value) => ({ field, value })),
  ))('$field=$value는400이며 거절 시 모든 표가 불변이다', async ({ field, value }) => {
    await expectUnchanged(() => assign({ ...body(), [field]: value }), 400);
  });
  it.each([null, '', '2026-02-30', '2025-02-29', '2026-13-01', '2026-09-24 OR 1=1', ['2026-09-24']].map((value) => [value]))(
    'onDate=%j는400이며 전체 배정으로 확대하지 않는다', async (onDate) => {
      await expectUnchanged(() => assign({ ...body(), onDate }), 400);
    },
  );
  it('필수 SER 누락/null·알 수 없는 body 키는400이고 안전정수의 없는 대상은404다', async () => {
    await expectUnchanged(() => assign({ zaccId: accounts[0] }), 400);
    await expectUnchanged(() => assign({ ...body(), serId: null }), 400);
    await expectUnchanged(() => assign({ ...body(), unsupported: true }), 400);
    await expectUnchanged(() => assign({ ...body(), serId: Number.MAX_SAFE_INTEGER }), 404);
    await expectUnchanged(() => assign({ ...body(), zaccId: Number.MAX_SAFE_INTEGER }), 404);
  });
  it.each([[false, false], [true, false], [false, true], [true, true]] as const)(
    '직접 HTTP 배정의 최종 admin=%s/crud=%s는 둘 다 있어야 저장한다', async (canAdminPage, canCrudAll) => {
      const auth = app.get(AuthService);
      const current = auth.currentUser.bind(auth);
      jest.spyOn(auth, 'currentUser').mockImplementation(async (id) => ({ ...await current(id), perms: { canAdminPage, canCrudAll } }));
      if (canAdminPage && canCrudAll) await assign().expect(201);
      else await expectUnchanged(() => assign(), 403);
    },
  );
  it('익명·강사와 로그인 뒤 권한 회수는 배정과 모든 부산물을 막는다', async () => {
    await expectUnchanged(() => request(app.getHttpServer()).post('/zoom/assign').send(body()), 401);
    await expectUnchanged(() => http('post', '/zoom/assign', TEACHER).send(body()), 403);
    await sql("UPDATE staff SET role='teacher' WHERE id=$1", [ADMIN]);
    await expectUnchanged(() => assign(), 403);
    await sql('UPDATE staff SET active=false WHERE id=$1', [ADMIN]);
    await expectUnchanged(() => assign(), 401);
  });
  it.each(['offline', 'canceled', 'missing'] as const)('%s 대상은 회차 배정과 EXC 생성을 거절한다', async (target) => {
    if (target === 'offline') await sql("UPDATE ser SET mode='offline' WHERE id=$1", [serId]);
    if (target === 'canceled') await addException(serId, DAY, { canceled: true });
    await expectUnchanged(() => assign({ ...body(), onDate: target === 'missing' ? addD(DAY, 40) : DAY }), target === 'missing' ? 404 : 409);
  });
  it('현장 규칙 전체 배정도 거절한다', async () => {
    await sql("UPDATE ser SET mode='offline' WHERE id=$1", [serId]);
    await expectUnchanged(() => assign({ serId, zaccId: accounts[0] }), 409);
  });
  it('비활성 계정은 새 배정에 쓰지 않는다', async () => {
    await sql('UPDATE zacc SET active=false WHERE id=$1', [accounts[0]]);
    await expectUnchanged(() => assign(), 409, 'ZACC_INACTIVE');
  });
  it('기본 배정·회차 우선·회차 null 해제의 기본 상속을 새 조회로 확인한다', async () => {
    await assign({ serId, zaccId: accounts[0] }).expect(201);
    await assign({ ...body(), zaccId: accounts[1] }).expect(201);
    expect(await sql('SELECT zacc_id FROM ser_occ WHERE ser_id=$1 AND on_date=$2::date', [serId, DAY])).toEqual([{ zacc_id: String(accounts[1]) }]);
    expect(await sql('SELECT DISTINCT zacc_id FROM ser_occ WHERE ser_id=$1 AND on_date<>$2::date', [serId, DAY])).toEqual([{ zacc_id: String(accounts[0]) }]);
    await assign({ ...body(), zaccId: null }).expect(201);
    expect(await sql('SELECT DISTINCT zacc_id FROM ser_occ WHERE ser_id=$1', [serId])).toEqual([{ zacc_id: String(accounts[0]) }]);
    const board = await http('get', '/zoom').query({ onDate: DAY }).expect(200);
    expect(board.body.accounts.find((a: { id: number }) => a.id === accounts[0]).usedCount).toBe(1);
  });
  it('옮긴 회차는 원래 onDate로 배정하고 표시 날짜의 다른 회차를 만들지 않는다', async () => {
    const movedTo = addD(DAY, 6);
    await addException(serId, DAY, { moved: movedTo });
    await assign().expect(201);
    const [stored] = await sql(`SELECT on_date::text, zacc_id, to_char(lower(span) AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS drawn
      FROM ser_occ WHERE ser_id=$1 AND on_date=$2::date`, [serId, DAY]);
    expect(stored).toEqual({ on_date: DAY, zacc_id: String(accounts[0]), drawn: movedTo });
    await expectUnchanged(() => assign({ ...body(), onDate: movedTo }), 404);
    const board = await http('get', '/zoom').query({ onDate: movedTo }).expect(200);
    expect(board.body.accounts.find((a: { id: number }) => a.id === accounts[0]).usedCount).toBe(1);
  });
  it('겹침409은 실패 EXC/ZASSIGN/ZLOG/SER_OCC 전부를 되돌리고 다른 계정 재시도는 된다', async () => {
    const rival = await makeSeries();
    await assign({ serId: rival, onDate: DAY, zaccId: accounts[0] }).expect(201);
    await expectUnchanged(() => assign(), 409, 'RESOURCE_CONFLICT');
    await assign({ ...body(), zaccId: accounts[1] }).expect(201);
  });
  it('기존 override 변경 충돌도 원래 배정과 감사 표를 보존한다', async () => {
    const rival = await makeSeries();
    await assign({ serId: rival, onDate: DAY, zaccId: accounts[0] }).expect(201);
    await assign({ ...body(), zaccId: accounts[1] }).expect(201);
    await expectUnchanged(() => assign(), 409, 'RESOURCE_CONFLICT');
  });
  it('외부 transaction이 실패하면 assignIn의 성공까지 모두 되돌린다', async () => {
    const before = await snapshot();
    await expect(ds.transaction(async (manager) => {
      await app.get(ZoomService).assignIn(manager, ADMIN, body());
      throw new Error('S3B external rollback');
    })).rejects.toThrow('S3B external rollback');
    expect(await snapshot()).toEqual(before);
  });
  it('줌 변경요청 승인 충돌도 pending·NOTI/LOG·배정을 모두 보존한다', async () => {
    const rival = await makeSeries();
    await assign({ serId: rival, onDate: DAY, zaccId: accounts[0] }).expect(201);
    const id = await makeRequest();
    await expectUnchanged(() => approve(id), 409, 'RESOURCE_CONFLICT');
  });
  it('같은 줌 변경요청을 동시에 승인해도 한 번만 반영하고 알린다', async () => {
    const id = await makeRequest();
    const results = await Promise.all([approve(id), approve(id)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await sql("SELECT state FROM chreq WHERE id=$1", [id])).toEqual([{ state: 'approved' }]);
    expect(await sql("SELECT action FROM log WHERE entity='chreq' AND entity_id=$1", [id])).toEqual([{ action: 'apply' }]);
    expect(await sql('SELECT id FROM noti WHERE from_id=$1', [ADMIN])).toHaveLength(1);
    expect(await sql("SELECT id FROM zlog WHERE zacc_id=$1 AND action='assign'", [accounts[0]])).toHaveLength(1);
  });
  it.each(['occurrence', 'whole', 'clear', 'approval'] as const)('마감 달 %s 배정 변경은409이며 모든 부산물을 되돌린다', async (scope) => {
    const id = await makeSeries({ from: PREV_DAY, to: DAY });
    if (scope === 'clear') await assign({ serId: id, zaccId: accounts[0] }).expect(201);
    const requestId = scope === 'approval' ? await makeRequest(id, PREV_DAY) : undefined;
    await closeMonth(PREV);
    await expectUnchanged(() => requestId === undefined
      ? assign({ serId: id, ...(['whole', 'clear'].includes(scope) ? {} : { onDate: PREV_DAY }), zaccId: scope === 'clear' ? null : accounts[1] })
      : approve(requestId), 409, 'MONTH_CLOSED');
  });
  it('마감이 있어도 같은 SER의 열린 달 배정은 되고 해제 뒤 과거 회차도 된다', async () => {
    const id = await makeSeries({ from: PREV_DAY, to: DAY });
    await closeMonth(PREV);
    await assign({ serId: id, onDate: DAY, zaccId: accounts[0] }).expect(201);
    await sql('UPDATE month_close SET reopened_at=now(),reopened_by=$1,reopen_reason=$2 WHERE closed_by=$1', [ADMIN, 'S3B 재검수']);
    await assign({ serId: id, onDate: PREV_DAY, zaccId: accounts[1] }).expect(201);
  });
  it('열린 달의 줌 변경요청 승인은 같은 SER의 마감 회차를 바꾸지 않는다', async () => {
    const id = await makeSeries({ from: PREV_DAY, to: DAY });
    const before = await sql('SELECT * FROM ser_occ WHERE ser_id=$1 AND on_date<$2::date ORDER BY on_date', [id, `${todayKst().slice(0, 7)}-01`]);
    await closeMonth(PREV);
    const req = await makeRequest(id, DAY);
    await approve(req).expect(201);
    // 재투영의 surrogate id는 바뀔 수 있다. 보호 대상인 날짜·시각·자원·휴강은 그대로다.
    const after = await sql('SELECT * FROM ser_occ WHERE ser_id=$1 AND on_date<$2::date ORDER BY on_date', [id, `${todayKst().slice(0, 7)}-01`]);
    const withoutId = (rows: Record<string, unknown>[]) => rows.map(({ id: _id, ...row }) => row);
    expect(withoutId(after)).toEqual(withoutId(before));
  });
  it.each(['original', 'drawn'] as const)('이동 회차의 %s 월이 마감되어도 배정 변경은409다', async (closedSide) => {
    const original = closedSide === 'original' ? PREV_DAY : DAY;
    const moved = closedSide === 'original' ? DAY : PREV_DAY;
    const id = await makeSeries({ from: original, once: true });
    await addException(id, original, { moved });
    await closeMonth(PREV);
    await expectUnchanged(() => assign({ serId: id, onDate: original, zaccId: accounts[0] }), 409, 'MONTH_CLOSED', monthClosedMessage(PREV));
  });

  it('같은 SER의 일정 수정과 배정은 부모부터 직렬화하고 예외·시간을 모두 보존한다', async () => {
    let release!: () => void, ready!: () => void, consumerReady!: (pid: number) => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { ready = resolve; });
    const started = new Promise<number>((resolve) => { consumerReady = resolve; });
    let writer: QueryRunner | undefined;
    let consumerSeen = false;
    let childBeforeParent = false;
    const originalLoad = stateRepo.loadState;
    const stateSpy = jest.spyOn(stateRepo, 'loadState').mockImplementation(async (q, ids, options) => {
      const state = await originalLoad(q, ids, options);
      if (!writer && ids.includes(serId) && options?.forWrite) {
        writer = q;
        ready();
        await hold;
      }
      return state;
    });
    const createRunner = ds.createQueryRunner.bind(ds);
    const runnerSpy = jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
      const q = createRunner(...args);
      const originalQuery = q.query.bind(q);
      jest.spyOn(q, 'query').mockImplementation(async (statement: string, parameters?: unknown[], structured?: boolean) => {
        if (writer && writer !== q && q.isTransactionActive) {
          if (!consumerSeen && /(?:INSERT INTO exc|DELETE FROM zassign|INSERT INTO zassign|INSERT INTO zlog)/.test(statement)) childBeforeParent = true;
          if (!consumerSeen && statement.includes('FROM ser ') && /FOR (NO KEY UPDATE|UPDATE)/.test(statement)) {
            consumerSeen = true;
            const [{ pid }] = await originalQuery('SELECT pg_backend_pid() AS pid');
            consumerReady(pid);
          }
        }
        return structured ? originalQuery(statement, parameters, true) : originalQuery(statement, parameters);
      });
      return q;
    });
    const first = Promise.resolve(http('patch', `/schedule/${serId}`).send({ scope: 'all', onDate: DAY, startMin: 630, endMin: 690 }));
    let second: Promise<request.Response> | undefined;
    try {
      await Promise.race([paused, first.then(() => { throw new Error('일정의 첫 부모 snapshot에 도달하지 못함'); })]);
      second = Promise.resolve(assign());
      const pid = await Promise.race([started, second.then(() => { throw new Error('배정의 부모 잠금에 도달하지 못함'); })]);
      let blocked = false;
      const deadline = Date.now() + 4000;
      while (!blocked) {
        [{ blocked }] = await sql<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid]);
        if (Date.now() > deadline) throw new Error('배정의 실제 부모 잠금 관측 시간 초과');
      }
      release();
      const results = await Promise.all([first, second]);
      expect({ status: results.map((r) => r.status), blocked, childBeforeParent }).toEqual({ status: [200, 201], blocked: true, childBeforeParent: false });
      expect(await sql(`SELECT zacc_id, EXTRACT(MINUTE FROM lower(span) AT TIME ZONE 'Asia/Seoul')::int AS minute
        FROM ser_occ WHERE ser_id=$1 AND on_date=$2::date`, [serId, DAY])).toEqual([{ zacc_id: String(accounts[0]), minute: 30 }]);
    } finally {
      release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      stateSpy.mockRestore();
      runnerSpy.mockRestore();
    }
  });

  it('계정 비활성화는 진행 중 배정의 활성 확인 잠금이 끝날 때까지 기다린다', async () => {
    let release!: () => void, ready!: () => void, patchReady!: (pid: number) => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { ready = resolve; });
    const started = new Promise<number>((resolve) => { patchReady = resolve; });
    const createRunner = ds.createQueryRunner.bind(ds);
    let assigning: QueryRunner | undefined;
    let patchSeen = false;
    const spy = jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
      const q = createRunner(...args);
      const originalQuery = q.query.bind(q);
      jest.spyOn(q, 'query').mockImplementation(async (statement: string, parameters?: unknown[], structured?: boolean) => {
        const run = () => structured ? originalQuery(statement, parameters, true) : originalQuery(statement, parameters);
        if (!assigning && q.isTransactionActive && statement.includes('FROM zacc') && statement.includes('active')) {
          assigning = q;
          const result = await run();
          ready();
          await hold;
          return result;
        }
        if (assigning && assigning !== q && !patchSeen && statement.includes('FROM zacc') && statement.includes('FOR UPDATE')) {
          patchSeen = true;
          const [{ pid }] = await originalQuery('SELECT pg_backend_pid() AS pid');
          patchReady(pid);
        }
        return run();
      });
      return q;
    });
    const first = Promise.resolve(assign());
    let second: Promise<request.Response> | undefined;
    try {
      await Promise.race([paused, first.then(() => { throw new Error('배정의 활성 확인에 도달하지 못함'); })]);
      let patchDone = false;
      second = Promise.resolve(http('patch', `/zoom/accounts/${accounts[0]}`).send({ active: false }))
        .then((res) => { patchDone = true; return res; });
      const pid = await Promise.race([started, second.then(() => { throw new Error('계정 수정 잠금에 도달하지 못함'); })]);
      let blocked = false;
      const deadline = Date.now() + 4000;
      while (!blocked && !patchDone) {
        [{ blocked }] = await sql<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid]);
        if (Date.now() > deadline) throw new Error('계정 수정의 실제 잠금 관측 시간 초과');
      }
      release();
      const results = await Promise.all([first, second]);
      expect({ status: results.map((r) => r.status), blocked }).toEqual({ status: [201, 200], blocked: true });
      expect(await sql('SELECT active FROM zacc WHERE id=$1', [accounts[0]])).toEqual([{ active: false }]);
      expect(await sql('SELECT zacc_id FROM ser_occ WHERE ser_id=$1 AND on_date=$2::date', [serId, DAY])).toEqual([{ zacc_id: String(accounts[0]) }]);
    } finally {
      release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      spy.mockRestore();
    }
  });
});
