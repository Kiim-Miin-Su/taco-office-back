/** @file-guide
 * 목적: migration56의 legacy 서명 보존과 실제 대표 보고 승인·반려·재제출 흐름을 검증한다.
 * 책임/재사용: 실제39·56/ExecService/blockedBy를 로컬 scratch 전용 schema에서 실행하고 rollback한다.
 * 검증/작업 지침: docs/AGENT.md · docs/contracts/FILE-GUIDE.md · TBO-52 운영 전환
 */
import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { Lead } from '../src/entities/lead.entity';
import { ExecReportSign1760300000000 } from '../src/migrations/1760300000000-exec-report-sign';
import { LegacyRptSignature1762000000000 } from '../src/migrations/1762000000000-legacy-rpt-signature';
import { BoardService } from '../src/modules/board/board.service';
import { ExecService } from '../src/modules/exec/exec.service';
import { assertScratch, blockedBy, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
const previous = new ExecReportSign1760300000000();
const migration = new LegacyRptSignature1762000000000();

d('56 legacy RPT — 미상 과거 서명 보존과 현재 실제 서명', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const service = () => {
    const repo = q.manager.getRepository(Lead);
    return new ExecService(repo, new BoardService(repo));
  };

  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) {
      throw new Error('Migration upgrade tests require an explicit local scratch database');
    }
    ds = new DataSource({ type: 'postgres', url, entities: [Lead], synchronize: false, logging: false });
    await ds.initialize();
  });

  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const schema = `rpt_upgrade_${randomUUID().replaceAll('-', '')}`;
    await q.query(`CREATE SCHEMA "${schema}"`);
    await q.query(`SET LOCAL search_path TO "${schema}", public`);
    await q.query(`CREATE TABLE staff (
      id bigint PRIMARY KEY, name text NOT NULL, role text NOT NULL, active boolean NOT NULL DEFAULT true
    )`);
    await q.query(`INSERT INTO staff (id,name,role) VALUES (1,'올린이','manager'),(2,'결재자','ceo')`);
    await q.query(`CREATE TABLE rpt (
      id bigserial PRIMARY KEY, rpt_type varchar(12) NOT NULL, on_date date NOT NULL,
      state varchar(12) NOT NULL DEFAULT 'draft', memo jsonb NOT NULL DEFAULT '{}',
      sent_at timestamptz, reviewed_at timestamptz, reject_reason text,
      UNIQUE (rpt_type,on_date)
    )`);
    await q.query(`CREATE TABLE log (
      id bigserial PRIMARY KEY, actor_id bigint NOT NULL REFERENCES staff(id),
      entity varchar(24), entity_id bigint, action varchar(24), after jsonb
    )`);
    await q.query(`CREATE TABLE noti (
      id bigserial PRIMARY KEY, to_id bigint REFERENCES staff(id), from_id bigint REFERENCES staff(id),
      body text, link text, category varchar(24)
    )`);
    // 서명자 컬럼 이전의 합성 원본이다. 운영 복제본이나 public 업무/ledger를 읽거나 수정하지 않는다.
    await q.query(`INSERT INTO rpt (id,rpt_type,on_date,state,memo,sent_at)
      SELECT 100+i,'day','2026-08-01'::date+i-1,'sent','{"money":"원본 메모"}',
        '2026-08-06T01:00:00Z'::timestamptz FROM generate_series(1,4) i`);
    await q.query(`INSERT INTO rpt (id,rpt_type,on_date,state,memo,sent_at,reviewed_at,reject_reason)
      VALUES (105,'day','2026-08-05','rej','{"money":"원본 메모"}',
        '2026-08-06T01:00:00Z','2026-08-07T01:00:00Z','기존 반려 사유')`);
    await previous.up(q);
  });

  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const rows = () => q.query('SELECT * FROM rpt ORDER BY id');
  const sentSignatures = () => q.query('SELECT id,sent_at,sent_by FROM rpt WHERE id BETWEEN 101 AND 104 ORDER BY id');

  it.each(['ok', 'rej'])('원래 sent 4행을 %s 처리하면서 과거 발송 서명을 바꾸지 않는다', async action => {
    const original = await rows();
    await migration.up(q);
    expect(await rows()).toEqual(original);
    const sent = await sentSignatures();

    for (const id of [101, 102, 103, 104]) {
      const out = await service().review(id, { action, ...(action === 'rej' ? { reason: '실제 반려 사유' } : {}) }, 2);
      expect(out).toMatchObject({ id, state: action, sentByName: null, reviewedByName: '결재자' });
    }

    expect(await sentSignatures()).toEqual(sent);
    expect(await q.query(`SELECT state,reviewed_by,reviewed_at IS NOT NULL AS signed,reject_reason
      FROM rpt WHERE id BETWEEN 101 AND 104 ORDER BY id`)).toEqual(Array.from({ length: 4 }, () => ({
      state: action, reviewed_by: '2', signed: true, reject_reason: action === 'rej' ? '실제 반려 사유' : null,
    })));
    expect(await q.query('SELECT actor_id,entity,entity_id,action,after FROM log ORDER BY entity_id')).toEqual(
      [101, 102, 103, 104].map(id => ({ actor_id: '2', entity: 'rpt', entity_id: String(id), action,
        after: { state: action, reason: action === 'rej' ? '실제 반려 사유' : null } })),
    );
  });

  it('양쪽 서명자가 미상인 옛 반려 보고를 편집하고 현재 배우로 다시 제출한다', async () => {
    await migration.up(q);
    const original = await q.query('SELECT sent_at,sent_by,reviewed_at,reviewed_by FROM rpt WHERE id=105');
    const key = { rptType: 'day', onDate: '2026-08-05' };
    const edited = await service().saveMemo({ ...key, memos: [{ key: 'money', memo: '보완한 메모' }] }, 1);
    expect(edited).toMatchObject({ id: 105, state: 'rej', sentByName: null, reviewedByName: null });
    expect(await q.query('SELECT sent_at,sent_by,reviewed_at,reviewed_by FROM rpt WHERE id=105')).toEqual(original);

    const submitted = await service().submit(key, 1);
    expect(submitted).toMatchObject({ id: 105, state: 'sent', sentByName: '올린이', reviewedByName: null });
    expect(await q.query(`SELECT sent_at=transaction_timestamp() AS current_time,sent_by,
      reviewed_at,reviewed_by,reject_reason,memo FROM rpt WHERE id=105`)).toEqual([{
      current_time: true, sent_by: '1', reviewed_at: null, reviewed_by: null,
      reject_reason: null, memo: { money: '보완한 메모' },
    }]);
    expect(await q.query('SELECT action,actor_id FROM log ORDER BY id'))
      .toEqual([{ action: 'memo', actor_id: '1' }, { action: 'submit', actor_id: '1' }]);
    expect(await q.query('SELECT to_id,from_id,category FROM noti'))
      .toEqual([{ to_id: '2', from_id: '1', category: 'request' }]);
  });

  it.each([
    ['sent_at', 'sent_by', 'now()', 'NULL'], ['sent_at', 'sent_by', 'NULL', '1'],
    ['reviewed_at', 'reviewed_by', 'now()', 'NULL'], ['reviewed_at', 'reviewed_by', 'NULL', '2'],
  ])('INSERT의 %s/%s 불완전 쌍(%s,%s)은 거절한다', async (at, by, atValue, byValue) => {
    await migration.up(q);
    expect(await blockedBy(q, `INSERT INTO rpt (id,rpt_type,on_date,${at},${by})
      VALUES (201,'day','2099-01-01',${atValue},${byValue})`)).toContain('rpt_sign_pair');
  });

  it.each(['sent_at', 'sent_by', 'reviewed_at', 'reviewed_by'])('정상 서명의 %s 한쪽만 지우는 변경은 거절한다', async column => {
    await migration.up(q);
    await q.query(`INSERT INTO rpt (id,rpt_type,on_date,sent_at,sent_by,reviewed_at,reviewed_by)
      VALUES (201,'day','2099-01-01',now(),1,now(),2)`);
    const original = await rows();
    expect(await blockedBy(q, `UPDATE rpt SET ${column}=NULL WHERE id=201`)).toContain('rpt_sign_pair');
    expect(await rows()).toEqual(original);
  });

  it('미상 서명을 둔 채 시각만 바꾸는 것은 새 불완전 서명이므로 거절한다', async () => {
    await migration.up(q);
    expect(await blockedBy(q, `UPDATE rpt SET sent_at=sent_at+interval '1 minute' WHERE id=101`))
      .toContain('rpt_sign_pair');
    expect(await blockedBy(q, `UPDATE rpt SET reviewed_at=reviewed_at+interval '1 minute' WHERE id=105`))
      .toContain('rpt_sign_pair');
    expect(await blockedBy(q, `UPDATE rpt SET sent_by=999 WHERE id=101`)).toContain('foreign key');
  });

  it('빈 두 쌍과 완전한 두 쌍의 새 행을 허용하고 FK는 유지한다', async () => {
    await migration.up(q);
    await q.query(`INSERT INTO rpt (id,rpt_type,on_date) VALUES (201,'day','2099-01-01')`);
    // P1 정책에 따라 같은 배우의 발송/승인도 서명 완전성과는 별개다.
    await q.query(`INSERT INTO rpt (id,rpt_type,on_date,sent_at,sent_by,reviewed_at,reviewed_by)
      VALUES (202,'day','2099-01-02',now(),2,now(),2)`);
    expect(await blockedBy(q, 'DELETE FROM staff WHERE id=2')).toContain('foreign key');
    expect(await q.query('SELECT count(*)::int AS n FROM rpt WHERE id>=201')).toEqual([{ n: 2 }]);
  });

  it('서명 거절은 공용 API 필터가 아는 기존 SQLSTATE와 제약 이름을 유지한다', async () => {
    await migration.up(q);
    await q.query('SAVEPOINT signature_error');
    await expect(q.query(`INSERT INTO rpt (id,rpt_type,on_date,sent_at)
      VALUES (201,'day','2099-01-01',now())`))
      .rejects.toMatchObject({ code: '23514', constraint: 'rpt_sign_pair' });
    await q.query('ROLLBACK TO SAVEPOINT signature_error');
  });

  it('후속 실패를 rollback하면 원본 행·LOG와 이전 CHECK까지 복원한다', async () => {
    const original = await rows();
    await q.query('SAVEPOINT pending_batch');
    await migration.up(q);
    await service().review(101, { action: 'ok' }, 2);
    await expect(q.query('SELECT 1 / 0')).rejects.toThrow();
    await q.query('ROLLBACK TO SAVEPOINT pending_batch');
    expect(await rows()).toEqual(original);
    expect(await q.query('SELECT * FROM log')).toHaveLength(0);
    expect(await q.query(`SELECT convalidated FROM pg_constraint
      WHERE conrelid='rpt'::regclass AND conname='rpt_sign_pair'`)).toEqual([{ convalidated: false }]);
    expect(await q.query(`SELECT tgname FROM pg_trigger
      WHERE tgrelid='rpt'::regclass AND tgname='rpt_signature_transition_trigger'`)).toHaveLength(0);
    expect(await q.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=current_schema() AND p.proname='rpt_signature_transition_guard'`)).toHaveLength(0);
  });

  it('down은 행 보정 없이 원래 NOT VALID CHECK와 쓰기 제한으로 돌아간다', async () => {
    const original = await rows();
    await migration.up(q);
    await migration.down(q);
    expect(await rows()).toEqual(original);
    expect(await q.query(`SELECT convalidated FROM pg_constraint
      WHERE conrelid='rpt'::regclass AND conname='rpt_sign_pair'`)).toEqual([{ convalidated: false }]);
    expect(await q.query(`SELECT tgname FROM pg_trigger
      WHERE tgrelid='rpt'::regclass AND tgname='rpt_signature_transition_trigger'`)).toHaveLength(0);
    expect(await q.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=current_schema() AND p.proname='rpt_signature_transition_guard'`)).toHaveLength(0);
    expect(await blockedBy(q, `UPDATE rpt SET reviewed_at=now(),reviewed_by=2 WHERE id=101`))
      .toContain('rpt_sign_pair');
  });
});
