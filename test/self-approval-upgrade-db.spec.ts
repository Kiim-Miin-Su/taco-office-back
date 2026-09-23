/** @file-guide
 * 목적: migration51→54가 기존 자기 결재 이력을 보존하며 현재 P1 스키마로 전환되는지 검증한다.
 * 책임/재사용: 실제 migration up과 blockedBy를 사용한다. 로컬 scratch의 세션 임시 표만 바꾸며 public 업무/ledger는 건드리지 않는다.
 * 검증/작업 지침: docs/AGENT.md · docs/contracts/FILE-GUIDE.md · TBO-52 운영 전환 검토
 */
import { DataSource, QueryRunner } from 'typeorm';
import { SelfApproval1761500000000 } from '../src/migrations/1761500000000-self-approval';
import { SelfApprovalOpen1761800000000 } from '../src/migrations/1761800000000-self-approval-open';
import { assertScratch, blockedBy, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
const beforePolicy = new SelfApproval1761500000000();
const currentPolicy = new SelfApprovalOpen1761800000000();
const guardNames = [
  'rep_no_self_review', 'rpt_no_self_review', 'plan_due_no_self_approve', 'gpa_use_no_self_approve',
];

d('51→54 업그레이드 — 기존 자기 결재는 원본이고 최종 정책은 P1이다', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let warning: jest.SpyInstance;

  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) {
      throw new Error('Migration upgrade tests require an explicit local scratch database');
    }
    ds = new DataSource({ type: 'postgres', url, synchronize: false, logging: false });
    await ds.initialize();
  });

  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // migration의 스키마 미지정 SQL은 세션 임시 표로 간다. public 업무 표/ledger는 수정하지 않는다.
    await q.query('SET LOCAL search_path TO pg_temp, public');
    await q.query(`CREATE TEMP TABLE staff (id bigint PRIMARY KEY) ON COMMIT DROP`);
    await q.query(`INSERT INTO staff VALUES (1),(2)`);
    await q.query(`CREATE TEMP TABLE rep (
      id bigint PRIMARY KEY, teacher_id bigint, reviewer_id bigint,
      reviewed_at timestamptz, body text
    ) ON COMMIT DROP`);
    await q.query(`CREATE TEMP TABLE rpt (
      id bigint PRIMARY KEY, sent_by bigint, reviewed_by bigint,
      sent_at timestamptz, reviewed_at timestamptz, memo jsonb
    ) ON COMMIT DROP`);
    await q.query(`CREATE TEMP TABLE plan (
      id bigint PRIMARY KEY, owner_id bigint, due_approved_by bigint,
      due_approved_at timestamptz, title text
    ) ON COMMIT DROP`);
    await q.query(`CREATE TEMP TABLE gpa_use (id bigint PRIMARY KEY, coord_id bigint) ON COMMIT DROP`);
    await q.query(`INSERT INTO gpa_use VALUES (1,1)`);
    await q.query(`CREATE TEMP TABLE expense (
      id bigint PRIMARY KEY, requester_id bigint, filed_by bigint, reviewer_id bigint,
      CONSTRAINT expense_no_self_review CHECK (reviewer_id IS NULL OR reviewer_id <> requester_id),
      CONSTRAINT expense_no_self_file_review CHECK (filed_by IS NULL OR reviewer_id IS NULL OR filed_by <> reviewer_id)
    ) ON COMMIT DROP`);
  });

  afterEach(async () => {
    warning?.mockRestore();
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  async function snapshots(): Promise<unknown[]> {
    return Promise.all(['rep', 'rpt', 'plan'].map(table => q.query(`SELECT * FROM ${table} ORDER BY id`)));
  }

  it.each(['rep', 'rpt', 'plan'] as const)('%s의 기존 자기 결재 6건을 바꾸지 않고 54에 도달한다', async table => {
    if (table === 'rep') {
      await q.query(`INSERT INTO rep SELECT i,1,1,'2026-08-21T01:00:00Z','원 리포트' FROM generate_series(1,6) i`);
    } else if (table === 'rpt') {
      await q.query(`INSERT INTO rpt SELECT i,1,1,'2026-08-20T01:00:00Z','2026-08-21T01:00:00Z','{"body":"원 보고"}'::jsonb FROM generate_series(1,6) i`);
    } else {
      await q.query(`INSERT INTO plan SELECT i,1,1,'2026-08-21T01:00:00Z','원 기획' FROM generate_series(1,6) i`);
    }
    const original = await snapshots();

    await beforePolicy.up(q);
    expect(await snapshots()).toEqual(original);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(`${table}:`));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('6건'));
    const intermediate = await q.query(
      `SELECT conname,convalidated FROM pg_constraint WHERE connamespace=pg_my_temp_schema() AND conname=ANY($1::text[])`,
      [guardNames],
    ) as Array<{ conname: string; convalidated: boolean }>;
    expect(intermediate.map(c => c.conname).sort()).toEqual([...guardNames].sort());
    expect(intermediate.every(c => !c.convalidated)).toBe(true);

    // 51만 있는 동안 새 쓰기를 검사하는 원래 계약도 보존한다. 54 전에는 앱을 열지 않는다.
    expect(await blockedBy(q, 'INSERT INTO rep (id,teacher_id,reviewer_id) VALUES (99,1,1)'))
      .toContain('rep_no_self_review');
    await currentPolicy.up(q);
    expect(await snapshots()).toEqual(original);
    const finalGuards = await q.query(
      `SELECT conname FROM pg_constraint WHERE connamespace=pg_my_temp_schema() AND conname=ANY($1::text[])`,
      [guardNames],
    );
    expect(finalGuards).toHaveLength(0);
    await expect(q.query('INSERT INTO rep (id,teacher_id,reviewer_id) VALUES (99,1,1)')).resolves.toBeDefined();
  });

  it('GPA 승인 도장/FK/짝과 지출 자기심사 방어는 최종 정책에도 남는다', async () => {
    await beforePolicy.up(q);
    await currentPolicy.up(q);
    expect(await q.query('SELECT id,coord_id,approved_by,approved_at FROM gpa_use'))
      .toEqual([{ id: '1', coord_id: '1', approved_by: null, approved_at: null }]);
    expect(await blockedBy(q, 'UPDATE gpa_use SET approved_by=1 WHERE id=1')).toContain('gpa_use_approve_pair');
    expect(await blockedBy(q, 'UPDATE gpa_use SET approved_by=999,approved_at=now() WHERE id=1'))
      .toContain('foreign key');
    await expect(q.query('UPDATE gpa_use SET approved_by=1,approved_at=now() WHERE id=1')).resolves.toBeDefined();
    expect(await blockedBy(q, 'INSERT INTO expense VALUES (1,1,NULL,1)')).toContain('expense_no_self_review');
    expect(await blockedBy(q, 'INSERT INTO expense VALUES (2,1,2,2)')).toContain('expense_no_self_file_review');
    expect(warning).not.toHaveBeenCalled();
  });

  it('후속 실패 시 이관 스키마를 함께 되돌리고 원 승인 행을 보존한다', async () => {
    await q.query(`INSERT INTO rep VALUES (1,1,1,'2026-08-21T01:00:00Z','원본')`);
    const original = await snapshots();
    await q.query('SAVEPOINT pending_batch');
    await beforePolicy.up(q);
    await currentPolicy.up(q);
    await expect(q.query('SELECT 1 / 0')).rejects.toThrow();
    await q.query('ROLLBACK TO SAVEPOINT pending_batch');
    expect(await snapshots()).toEqual(original);
    const added = await q.query(`SELECT attname FROM pg_attribute
      WHERE attrelid='gpa_use'::regclass AND attnum>0 AND NOT attisdropped
        AND attname IN ('approved_by','approved_at')`);
    expect(added).toHaveLength(0);
  });
});
