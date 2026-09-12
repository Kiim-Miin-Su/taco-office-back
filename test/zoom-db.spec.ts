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
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Zacc } from '../src/entities';
import { openSecret, sealSecret, secretKeyFrom } from '../src/lib/secret-box';
import { ZoomService } from '../src/modules/zoom/zoom.service';
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
  const makeSer = async (subKey: string): Promise<number> => {
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ('zoom_test','줌검증','#000000',4,'lesson',false)
       ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(`INSERT INTO sub (key,name,color) VALUES ($1,$1,'#000000') ON CONFLICT (key) DO NOTHING`, [subKey]);
    const [r] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, mode, start_min, end_min, rrule, from_date, to_date)
       VALUES ('zoom_test', $1, 'online', 600, 660, 'WEEKLY:MO,TU,WE,TH,FR,SA,SU',
               (now() AT TIME ZONE 'Asia/Seoul')::date, (now() AT TIME ZONE 'Asia/Seoul')::date + 3)
       RETURNING id`, [subKey],
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
});
