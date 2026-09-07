import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { ConsultingContract1757500000000 } from '../src/migrations/1757500000000-consulting-contract';
import { ConsultingService } from '../src/modules/consulting/consulting.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('§26 DB 제약과 migration 11', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let id: number;
  const migration = new ConsultingContract1757500000000();

  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const [row] = await q.query(`INSERT INTO cons (cons_type,stage) VALUES ('future_type','contract') RETURNING id`) as { id: string }[];
    id = Number(row.id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('실 DB→서비스→DTO에서 null 날짜와 시드 밖 종류를 보존한다', async () => {
    await q.query(`INSERT INTO cons_sess (cons_id,seq) VALUES ($1,1)`, [id]);
    const { items } = await new ConsultingService(q.manager.getRepository(Lead)).all(1, false, false);
    expect(items.find((r) => r.id === id)).toMatchObject({ consType: 'future_type', stage: 'contract', contractStep: null,
      sessions: null, sessionsLog: [expect.objectContaining({ seq: 1, onDate: null })] });
  });

  it.each([
    ["stage='other',contract_step=5", 'cons_stage_check'],
    ["contract_step=0", 'cons_contract_step_check'],
    ["contract_step=6", 'cons_contract_step_check'],
    ["stage='running',contract_step=NULL", 'cons_paid_stage_check'],
    ["stage='done',contract_step=4", 'cons_paid_stage_check'],
    ['sessions=0', 'cons_sessions_check'],
    ['sessions=-1', 'cons_sessions_check'],
  ])('직접 SQL %s도 차단한다', async (set, constraint) => {
    await expect(q.query(`UPDATE cons SET ${set} WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23514', constraint });
  });

  it.each([0, -1])('회차 순번 %s를 차단한다', async (seq) => {
    await expect(q.query(`INSERT INTO cons_sess (cons_id,seq) VALUES ($1,$2)`, [id, seq]))
      .rejects.toMatchObject({ code: '23514', constraint: 'cons_sess_seq_check' });
  });

  it('회차 중복은 UNIQUE로 차단한다', async () => {
    await q.query(`INSERT INTO cons_sess (cons_id,seq) VALUES ($1,1)`, [id]);
    await expect(q.query(`INSERT INTO cons_sess (cons_id,seq) VALUES ($1,1)`, [id]))
      .rejects.toMatchObject({ code: '23505', constraint: 'cons_sess_cons_seq_uniq' });
  });

  it('다른 건의 같은 순번, 양수 smallint 상한, 수납 이후 단계를 허용한다', async () => {
    await q.query(`UPDATE cons SET stage='done',contract_step=5,sessions=32767 WHERE id=$1`, [id]);
    const [other] = await q.query(`INSERT INTO cons (cons_type,stage) VALUES ('essay','contract') RETURNING id`) as { id: string }[];
    await q.query(`INSERT INTO cons_sess (cons_id,seq) VALUES ($1,32767),($2,32767)`, [id, other.id]);
    expect(Object.values(await migration.preflight(q)).every((n) => n === 0)).toBe(true);
  });

  it('down/up은 레코드를 보존하며 6개 제약과 entity metadata를 일치시킨다', async () => {
    await migration.down(q);
    await migration.up(q);
    const expected = ['cons_stage_check','cons_contract_step_check','cons_paid_stage_check','cons_sessions_check','cons_sess_seq_check','cons_sess_cons_seq_uniq'].sort();
    const constraints = await q.query(`SELECT conname FROM pg_constraint WHERE conname = ANY($1)`, [expected]) as { conname: string }[];
    expect(constraints.map((r) => r.conname).sort()).toEqual(expected);
    const metadata = ds.entityMetadatas.filter((m) => ['cons','cons_sess'].includes(m.tableName));
    expect(metadata.flatMap((m) => [...m.checks, ...m.uniques].map((c) => c.name)).sort()).toEqual(expected);
    expect(await q.query(`SELECT id FROM cons WHERE id=$1`, [id])).toHaveLength(1);
  });

  it('오염 preflight는 보정/삭제 없이 제약 적용 전에 실패한다', async () => {
    await migration.down(q);
    await q.query(`UPDATE cons SET stage='running',contract_step=NULL,sessions=0 WHERE id=$1`, [id]);
    await q.query(`INSERT INTO cons_sess (cons_id,seq) VALUES ($1,0),($1,0)`, [id]);
    expect(await migration.preflight(q)).toMatchObject({ unpaid_stage: 1, invalid_sessions: 1, invalid_seq: 2, duplicate_seq: 1 });
    await expect(migration.up(q)).rejects.toThrow('Consulting contract preflight failed');
    expect(await q.query(`SELECT id FROM cons_sess WHERE cons_id=$1`, [id])).toHaveLength(2);
    expect(await q.query(`SELECT conname FROM pg_constraint WHERE conname='cons_stage_check'`)).toHaveLength(0);
    // afterEach transaction rollback으로 기존 제약/행을 원복한다. 운영에서는 실행하지 않는다.
  });
});
