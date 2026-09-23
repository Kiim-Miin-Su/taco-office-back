/** @file-guide
 * 목적: migration33이 기존 교재 반납 이력을 보존하고 실제 활성 중복·날짜 역전은 거절하는지 검증한다.
 * 책임/재사용: 실제 BookWorkflow.up을 로컬 scratch의 시험 전용 schema에서 실행하고 전부 rollback한다.
 * 검증/작업 지침: docs/AGENT.md · docs/contracts/FILE-GUIDE.md · TBO-52 운영 전환 검토
 */
import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { BookWorkflow1759700000000 } from '../src/migrations/1759700000000-book-workflow';
import { assertScratch, TEST_URL } from './db';
import { GpapackLegacyState1762100000000 } from '../src/migrations/1762100000000-gpapack-legacy-state';

const d = TEST_URL ? describe : describe.skip;
const migration = new BookWorkflow1759700000000();

d('33 업그레이드 — 기존 배부·반납 원본과 활성 제약', () => {
  let ds: DataSource;
  let q: QueryRunner;

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
    // migration 자체의 CREATE TABLE/FUNCTION도 격리한다. 이름은 난수뿐이며 public/ledger 쓰기는 없다.
    const schema = `book_upgrade_${randomUUID().replaceAll('-', '')}`;
    await q.query(`CREATE SCHEMA "${schema}"`);
    await q.query(`SET LOCAL search_path TO "${schema}", public`);
    await q.query('CREATE TABLE sub (key varchar(20) PRIMARY KEY)');
    await q.query('CREATE TABLE stu (id bigint PRIMARY KEY)');
    await q.query('CREATE TABLE staff (id bigint PRIMARY KEY)');
    await q.query(`CREATE TABLE "file" (
      id bigint PRIMARY KEY, bytes integer NOT NULL, kind varchar(24) NOT NULL,
      CONSTRAINT file_size_cap CHECK (bytes > 0 AND bytes <= 8388608)
    )`);
    await q.query('CREATE TABLE lib (id bigint PRIMARY KEY, sub_key varchar(20))');
    await q.query(`CREATE TABLE vers (
      id bigint PRIMARY KEY, lib_id bigint NOT NULL, edition varchar(20) NOT NULL
    )`);
    await q.query(`CREATE TABLE issue (
      id bigint PRIMARY KEY, lib_id bigint NOT NULL, vers_id bigint,
      student_id bigint NOT NULL, issued_on date NOT NULL, returned_on date
    )`);
    await q.query('CREATE TABLE req (id bigint PRIMARY KEY)');
    await q.query(`CREATE TABLE gpapack (
      id bigint PRIMARY KEY, student_id bigint NOT NULL, pack_type varchar(12) NOT NULL,
      detail text, state varchar(12) NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`INSERT INTO sub VALUES ('math')`);
    await q.query('INSERT INTO stu VALUES (1)');
    await q.query('INSERT INTO staff VALUES (1)');
    await q.query(`INSERT INTO lib VALUES (1,'math')`);
    await q.query(`INSERT INTO vers VALUES (1,1,'1판')`);
    // 원래 승인/대기를 보존하고 전달 사실과 구분하는 실제 업그레이드 fixture다.
    await q.query(`INSERT INTO gpapack VALUES
      (1,1,'self','기존 자습 요청','approved','2026-08-20T01:00:00Z'),
      (2,1,'exam','기존 시험 요청','pending','2026-08-21T01:00:00Z')`);
  });

  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  async function issues(): Promise<unknown[]> {
    return q.query(`SELECT id,lib_id,vers_id,student_id,issued_on,returned_on FROM issue ORDER BY id`);
  }

  it('옛 승인과 대기 원문은 보존하고 전달 시각을 만들지 않는다', async () => {
    await migration.up(q);
    expect(await q.query(`SELECT id,legacy_state,state,delivered_at,received_at FROM gpapack ORDER BY id`))
      .toEqual([
        { id: '1', legacy_state: 'approved', state: 'pending', delivered_at: null, received_at: null },
        { id: '2', legacy_state: 'pending', state: 'pending', delivered_at: null, received_at: null },
      ]);
    await migration.down(q);
    expect(await q.query('SELECT id,state FROM gpapack ORDER BY id'))
      .toEqual([{ id: '1', state: 'approved' }, { id: '2', state: 'pending' }]);
  });

  it('57은 보존된 원문을 덮어쓰지 않고 이를 지우는 down을 거절한다', async () => {
    await migration.up(q);
    const forward = new GpapackLegacyState1762100000000();
    const before = await q.query('SELECT id,legacy_state FROM gpapack ORDER BY id');
    await forward.up(q);
    expect(await q.query('SELECT id,legacy_state FROM gpapack ORDER BY id')).toEqual(before);
    await q.query('SAVEPOINT no_loss');
    await expect(forward.down(q)).rejects.toThrow('GPAPACK original states must be preserved');
    await q.query('ROLLBACK TO SAVEPOINT no_loss');
    expect(await q.query('SELECT id,legacy_state FROM gpapack ORDER BY id')).toEqual(before);
  });

  it('이미 옛33을 지난 DB는 원문 미상으로 맞추며 상태·전달 시각을 바꾸지 않는다', async () => {
    await migration.up(q);
    await q.query('ALTER TABLE gpapack DROP COLUMN legacy_state');
    const before = await q.query('SELECT * FROM gpapack ORDER BY id');
    const forward = new GpapackLegacyState1762100000000();
    await forward.up(q);
    expect(await q.query('SELECT legacy_state FROM gpapack')).toEqual([{ legacy_state: null }, { legacy_state: null }]);
    await forward.down(q);
    expect(await q.query('SELECT * FROM gpapack ORDER BY id')).toEqual(before);
  });

  it('반려 등 의미가 다른 옛 상태는 조용히 다시 열지 않는다', async () => {
    await q.query("UPDATE gpapack SET state='rejected' WHERE id=1");
    await q.query('SAVEPOINT unsupported_state');
    await expect(migration.up(q)).rejects.toThrow('GPAPACK legacy state requires explicit migration');
    await q.query('ROLLBACK TO SAVEPOINT unsupported_state');
    expect(await q.query('SELECT state FROM gpapack WHERE id=1')).toEqual([{ state: 'rejected' }]);
  });

  it('기존 반납과 같은 학생·책의 현재 배부를 모두 보존한다', async () => {
    await q.query(`INSERT INTO issue VALUES
      (101,1,1,1,'2026-07-01','2026-07-31'),
      (102,1,1,1,'2026-08-01',NULL)`);
    const original = await issues();
    const packs = await q.query('SELECT id,student_id,detail,created_at FROM gpapack ORDER BY id');

    await migration.up(q);

    expect(await issues()).toEqual(original);
    expect(await q.query('SELECT id,state FROM issue ORDER BY id'))
      .toEqual([{ id: '101', state: 'returned' }, { id: '102', state: 'ok' }]);
    expect(await q.query(`SELECT g.id,s.student_id,g.memo AS detail,g.created_at
      FROM gpapack g JOIN gpapack_student s ON s.gpapack_id=g.id ORDER BY g.id`)).toEqual(packs);
  });

  it('같은 학생·책을 여러 번 반납한 이력은 활성 중복이 아니다', async () => {
    await q.query(`INSERT INTO issue VALUES
      (101,1,1,1,'2026-07-01','2026-07-31'),
      (102,1,1,1,'2026-08-01','2026-08-01')`);
    const original = await issues();

    await migration.up(q);

    expect(await issues()).toEqual(original);
    expect(await q.query('SELECT state FROM issue ORDER BY id'))
      .toEqual([{ state: 'returned' }, { state: 'returned' }]);
  });

  it.each([
    ['실제 활성 중복', "(101,1,1,1,'2026-07-01',NULL),(102,1,1,1,'2026-08-01',NULL)", 'issue_active_book_unique'],
    ['반납일이 배부일보다 이른 경우', "(101,1,1,1,'2026-08-01','2026-07-31')", 'issue_return_order'],
  ])('%s: 거절 후 배치 rollback으로 원본과 앞선 DDL을 복원한다', async (_label, rows, constraint) => {
    await q.query(`INSERT INTO issue VALUES ${rows}`);
    const original = await issues();
    const packs = await q.query('SELECT * FROM gpapack ORDER BY id');
    await q.query('SAVEPOINT pending_batch');

    await expect(migration.up(q)).rejects.toThrow(constraint);
    await q.query('ROLLBACK TO SAVEPOINT pending_batch');

    expect(await issues()).toEqual(original);
    expect(await q.query('SELECT * FROM gpapack ORDER BY id')).toEqual(packs);
    expect(await q.query(`SELECT attname FROM pg_attribute
      WHERE attrelid='issue'::regclass AND attnum>0 AND NOT attisdropped AND attname='state'`))
      .toHaveLength(0);
    expect(await q.query(`SELECT attname FROM pg_attribute
      WHERE attrelid='vers'::regclass AND attnum>0 AND NOT attisdropped AND attname='activated_at'`))
      .toHaveLength(0);
    const constraints = await q.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='file'::regclass AND conname='file_size_cap'`) as Array<{ definition: string }>;
    expect(constraints[0].definition).toContain('8388608');
    expect(await q.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname='gpapack_student'`)).toHaveLength(0);
  });
});
