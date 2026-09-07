import { DataSource, QueryRunner } from 'typeorm';
import { SUBS } from '../src/seed/base';
import { SubjectMeetingColors1757600000000 } from '../src/migrations/1757600000000-subject-meeting-colors';

/** 원본 v2 §89. migration의 변경 가능한 구현이나 seed에서 기대값을 가져오지 않는다. */
const CORRECTIONS = [
  ['mt-mk', '#5C7A9E', '#9A5B71'],
  ['mt-dv', '#4F7F6B', '#546FA2'],
  ['mt-pg', '#7A7A8C', '#856C4A'],
] as const;

describe('§89 과목색 정본', () => {
  it.each(CORRECTIONS)('%s의 신규 seed 색은 원본과 같다', (key, _old, expected) => {
    expect(SUBS.find((item) => item.key === key)?.color).toBe(expected);
  });
});

// .env를 읽지 않는다. 명시적으로 선택한 로컬 scratch DB에서만 SQL 회귀를 실행한다.
const testUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = testUrl ? describe : describe.skip;

d('§89 migration 12 — 기존 오색만 조건부 교정', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const migration = new SubjectMeetingColors1757600000000();
  const rows = () => q.query('SELECT key, color, name FROM sub ORDER BY key');

  beforeAll(async () => {
    const target = new URL(testUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
      || !/_test$/.test(target.pathname) || /prod|production/i.test(target.pathname)) {
      throw new Error('Subject color migration tests require an explicit local scratch *_test database');
    }
    ds = new DataSource({ type: 'postgres', url: testUrl, synchronize: false, logging: false });
    await ds.initialize();
  });

  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    // 세션 전용 임시 표가 public.sub를 가린다. 실제 코드표·migration 이력은 건드리지 않는다.
    await q.query(`CREATE TEMPORARY TABLE sub (
      key varchar(20) PRIMARY KEY, color varchar(7) NOT NULL, name varchar(40) NOT NULL
    ) ON COMMIT DROP`);
    await q.query('SET LOCAL search_path TO pg_temp, public');
  });

  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('정확한 key+기존 오색 3행만 바꾸고 다른 key·이름과 public 원장을 보존한다', async () => {
    const original = await q.query('SELECT key, color, name FROM public.sub ORDER BY key');
    for (const [key, old] of CORRECTIONS) {
      await q.query('INSERT INTO sub VALUES ($1,$2,$3),($4,$2,$3)', [key, old, '원래 이름', `other-${key}`]);
    }

    await migration.up(q);

    expect(await rows()).toEqual([
      ...CORRECTIONS.map(([key, , color]) => ({ key, color, name: '원래 이름' })),
      ...CORRECTIONS.map(([key, color]) => ({ key: `other-${key}`, color, name: '원래 이름' })),
    ].sort((a, b) => a.key.localeCompare(b.key)));
    expect(await q.query('SELECT key, color, name FROM public.sub ORDER BY key')).toEqual(original);
  });

  it('같은 key의 사용자 지정 색과 이미 정확한 색은 바꾸지 않는다', async () => {
    for (const [key, old, expected] of CORRECTIONS) {
      for (const color of ['#123ABC', old.toLowerCase(), expected]) {
        await q.query('INSERT INTO sub VALUES ($1,$2,$3)', [key, color, '사용자 이름']);
        const before = await rows();
        await migration.up(q);
        expect(await rows()).toEqual(before);
        await q.query('DELETE FROM sub WHERE key=$1', [key]);
      }
    }
  });

  it('빈 코드표에서 행을 만들지 않고, 교정 재실행 후에도 사용자 변경을 보존한다', async () => {
    await migration.up(q);
    expect(await rows()).toEqual([]);
    await q.query("INSERT INTO sub VALUES ('mt-mk','#5C7A9E','이름')");
    await migration.up(q);
    const corrected = await rows();
    expect(corrected).toEqual([{ key: 'mt-mk', color: '#9A5B71', name: '이름' }]);
    await migration.up(q);
    expect(await rows()).toEqual(corrected);
    await q.query("UPDATE sub SET color='#123ABC' WHERE key='mt-mk'");
    await migration.up(q);
    expect(await rows()).toEqual([{ key: 'mt-mk', color: '#123ABC', name: '이름' }]);
  });

  it('down은 원래부터 정확했던 색까지 되돌리지 않고 명시적으로 거절한다', async () => {
    await q.query("INSERT INTO sub VALUES ('mt-mk','#9A5B71','원래 정색'),('mt-dv','#123ABC','사용자 색')");
    const before = await rows();
    await expect(migration.down()).rejects.toThrow('forward-only');
    expect(await rows()).toEqual(before);
  });
});
