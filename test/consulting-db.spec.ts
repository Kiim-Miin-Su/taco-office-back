/** @file-guide
 * 목적: consulting-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

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

  /**
   * 원본 §26 카드가 요구하는 낱말과 수 — C86-e.
   * **화면은 하나도 만들지 않는다**: 단계·종류·공개 범위·계약 단계·요청자 이름과
   * 「N일 지남」·받은 돈이 전부 서버에서 온다 (D-R18 · D-R37).
   */
  it('카드의 낱말과 수가 전부 서버에서 온다 — 금액쌍은 한 권한을 함께 탄다 (§26)', async () => {
    await q.query(
      `UPDATE cons SET cons_type='essay', contract_step=2, amount=900000, requester='mother', share='money_only' WHERE id=$1`,
      [id],
    );
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES (1,'검사자','c86e@t.kr','manager') ON CONFLICT (id) DO NOTHING`);
    await q.query(`INSERT INTO cons_pay (cons_id,amount,paid_on,by_id) VALUES ($1,400000,'2026-08-01',1)`, [id]);

    const seen = (await new ConsultingService(q.manager.getRepository(Lead)).all(1, true, true))
      .items.find((r) => r.id === id)!;
    expect(seen).toMatchObject({
      stageLabel: '계약', typeLabel: '에세이 지도', shareLabel: '수납만 공개',
      contractStepLabel: '피드백', requesterLabel: '어머니',
      amount: 900000, paidAmount: 400000,
    });
    expect(seen.ageDays).toBeGreaterThanOrEqual(0);

    // 금액을 못 보면 **둘 다** 가려진다 — 한쪽만 보이면 나머지가 빼기로 드러난다
    const hidden = (await new ConsultingService(q.manager.getRepository(Lead)).all(1, false, true))
      .items.find((r) => r.id === id)!;
    expect(hidden).toMatchObject({ amount: null, paidAmount: null, typeLabel: '에세이 지도' });
  });

  it('계약 단계가 미정이면 이름이 null 이다 — 없는 이름을 지어내지 않는다 (§26)', async () => {
    const { items, stages } = await new ConsultingService(q.manager.getRepository(Lead)).all(1, true, true);
    expect(items.find((r) => r.id === id)!.contractStepLabel).toBeNull();
    // 빈 칸도 이름과 한 줄을 갖는다
    expect(stages.map((v) => [v.key, v.label, v.sub])).toEqual([
      ['contract', '계약', '계약서 만들고 서명받기'],
      ['running', '진행', '회차별로 만나고 기록'],
      ['done', '종료', '마무리하고 안내'],
    ]);
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

  it('down/up은 레코드를 보존하며 현행 9개 제약과 entity metadata를 일치시킨다', async () => {
    await migration.down(q);
    await migration.up(q);
    const expected = [
      'cons_stage_check', 'cons_contract_step_check', 'cons_paid_stage_check', 'cons_sessions_check',
      'cons_requester_check', 'cons_dates_check', 'cons_deleted_pair_check',
      'cons_sess_seq_check', 'cons_sess_cons_seq_uniq',
    ].sort();
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

d('§31 항목 원장 — 체크/해제와 잠금 (47D-B · N-18 §4-17)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let consId: number;
  let itemId: number;

  const svc = () => new ConsultingService(q.manager.getRepository(Lead));

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
    // done_by FK 대상 — 스크래치 staff 는 비어 있다. 트랜잭션 안이라 각 테스트 뒤 롤백된다.
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES (1,'검사자','it1@t.kr','manager'), (9,'담당자','it9@t.kr','manager') ON CONFLICT (id) DO NOTHING`);
    const [c] = await q.query(`INSERT INTO cons (cons_type,stage,contract_step) VALUES ('future_type','running',5) RETURNING id`) as { id: string }[];
    consId = Number(c.id);
    const [i] = await q.query(`INSERT INTO cons_item (cons_id,seq,label) VALUES ($1,1,'지원서 작성') RETURNING id`, [consId]) as { id: string }[];
    itemId = Number(i.id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('체크는 처리자·처리일을 서버가 찍고, 해제는 함께 지운다', async () => {
    const done = await svc().toggleItem(1, false, consId, itemId, { done: true });
    expect(done).toMatchObject({ id: itemId, done: true, doneOn: expect.any(String) });
    const [row] = await q.query(`SELECT done, done_by, done_at FROM cons_item WHERE id = $1`, [itemId]);
    expect(row.done).toBe(true);
    expect(Number(row.done_by)).toBe(1);
    const undone = await svc().toggleItem(1, false, consId, itemId, { done: false });
    expect(undone).toMatchObject({ done: false, doneBy: null, doneOn: null });
    const [row2] = await q.query(`SELECT done, done_by, done_at FROM cons_item WHERE id = $1`, [itemId]);
    expect(row2).toMatchObject({ done: false, done_by: null, done_at: null });
  });

  it('종료된 건은 ITEM_LOCKED 로 잠긴다', async () => {
    await q.query(`UPDATE cons SET stage='done' WHERE id = $1`, [consId]);
    await expect(svc().toggleItem(1, false, consId, itemId, { done: true }))
      .rejects.toMatchObject({ response: { code: 'ITEM_LOCKED' } });
  });

  it('수납만 공개 건은 비담당에게 403 — 내용 접근이 없다', async () => {
    await q.query(`UPDATE cons SET share='money_only', owner_id=9 WHERE id = $1`, [consId]);
    await expect(svc().toggleItem(1, false, consId, itemId, { done: true })).rejects.toMatchObject({ status: 403 });
    // 담당은 쓴다
    await expect(svc().toggleItem(9, false, consId, itemId, { done: true })).resolves.toMatchObject({ done: true });
  });

  it('전체 비공개 건은 비담당에게 404 — 존재를 누출하지 않는다 (canHide=대표 전용·27N5)', async () => {
    await q.query(`UPDATE cons SET share='private', owner_id=9 WHERE id = $1`, [consId]);
    await expect(svc().toggleItem(1, false, consId, itemId, { done: true })).rejects.toMatchObject({ status: 404 });
    await expect(svc().toggleItem(1, true, consId, itemId, { done: true })).resolves.toMatchObject({ done: true });
  });

  it('done 이면 처리자·처리일이 함께 있어야 한다 — CHECK 가 직접 UPDATE 도 막는다', async () => {
    await expect(q.query(`UPDATE cons_item SET done = true WHERE id = $1`, [itemId]))
      .rejects.toMatchObject({ message: expect.stringContaining('cons_item_done_stamp_check') });
  });

  it('(cons_id, seq) 는 유일하다', async () => {
    await expect(q.query(`INSERT INTO cons_item (cons_id,seq,label) VALUES ($1,1,'중복')`, [consId]))
      .rejects.toMatchObject({ message: expect.stringContaining('cons_item_cons_seq') });
  });

  it('목록 응답의 items 는 회차와 같은 공개 규칙 — 잠기면 내려가지 않는다', async () => {
    await q.query(`UPDATE cons SET share='money_only', owner_id=9 WHERE id = $1`, [consId]);
    const view = (await svc().all(1, false, false)).items.find((r) => r.id === consId)!;
    expect(view.canOpen).toBe(false);
    expect(view.items).toEqual([]);
    const own = (await svc().all(9, false, false)).items.find((r) => r.id === consId)!;
    expect(own.items).toEqual([expect.objectContaining({ seq: 1, label: '지원서 작성', done: false, source: 'template' })]);
  });
});
