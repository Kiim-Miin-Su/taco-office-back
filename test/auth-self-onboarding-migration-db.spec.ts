/** @file-guide
 * 목적: auth-self-onboarding-migration-db.spec.ts — migration 1769700000000 의 preflight·제약·down 거절·재적용 회귀 (test)
 * 책임/재사용: 실제 migration 클래스를 스크래치 DB 의 한 transaction 안에서 내리고 올린 뒤 되돌린다. 제약 위반은 공용 blockedBy 로 본다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * AUTH-SELF-01 · AUTH-INIT-02 migration (2026-10-16).
 *   ① 초기 발급(account_provision) 뒤 첫 설정 기록 없이 「두 인증 + 잠금 해제」인 계정은 **세어서 멈춘다**(데이터를 고치지 않는다).
 *      그 뒤에 첫 설정 기록이 있거나 잠금이 켜져 있으면 통과한다.
 *   ② english_name 은 NULL 또는 빈 글자가 아닌 값만 · auth_code.purpose 는 contact_change 를 받고 목록 밖은 거절.
 *   ③ down 은 영어 이름 · 연락처 변경 코드가 남아 있으면 지우지 않고 멈춘다 · 비우면 내려가고 다시 올라간다.
 * 전부 한 transaction 안에서 하고 끝에 되돌린다(DDL 도 PostgreSQL 에서는 transaction 이다).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { AuthSelfOnboarding1769700000000 } from '../src/migrations/1769700000000-auth-self-onboarding';
import { assertScratch, blockedBy, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

d('migration 1769700000000 — 추정 보정 없이 세어서 멈춘다', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const mig = new AuthSelfOnboarding1769700000000();
  const ID = 9_000_000_001_901;

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
  });
  afterAll(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
    if (ds?.isInitialized) await ds.destroy();
  });

  it('완료처럼 보이는 초기 발급 계정은 멈추고 · 기록/잠금이 있으면 통과 · 제약 · down 거절 · 재적용', async () => {
    // 이미 적용된 스크래치 DB 를 이 transaction 안에서만 이전 상태로 내린다
    await mig.down(q);
    expect(await q.query(`SELECT 1 FROM information_schema.columns WHERE table_name='staff' AND column_name='english_name'`))
      .toHaveLength(0);

    await q.query(
      `INSERT INTO staff (id, name, login_id, role, active, must_change_credentials, email_verified, phone_verified)
       VALUES ($1,'발급뒤완료처럼','mig-provisioned','ceo',true,false,true,true)`, [ID],
    );
    await q.query(
      `INSERT INTO log (actor_id, entity, entity_id, action, before, after, at)
       VALUES ($1,'STAFF',$1,'onboarding','{}'::jsonb,'{}'::jsonb, now() - interval '2 days'),
              ($1,'STAFF',$1,'account_provision','{}'::jsonb,'{}'::jsonb, now() - interval '1 day')`, [ID],
    );
    // ① 첫 설정 기록이 발급보다 앞서기만 하면 증명이 안 된다 — 멈춘다(데이터는 그대로)
    await expect(mig.up(q)).rejects.toThrow(/1건/);
    expect((await q.query('SELECT must_change_credentials FROM staff WHERE id=$1', [ID]))[0].must_change_credentials).toBe(false);

    // 발급 뒤 첫 설정 기록이 있으면 통과한다(그 계정이 실제로 다시 마친 것이다)
    await q.query(
      `INSERT INTO log (actor_id, entity, entity_id, action, before, after, at) VALUES ($1,'STAFF',$1,'onboarding','{}'::jsonb,'{}'::jsonb, now())`,
      [ID],
    );
    await mig.up(q);

    // ② 제약
    await q.query(`UPDATE staff SET english_name='Kim' WHERE id=$1`, [ID]);
    expect(await blockedBy(q, `UPDATE staff SET english_name='   ' WHERE id=$1`, [ID])).toContain('staff_english_name_present');
    expect(await blockedBy(q, `UPDATE staff SET english_name=$2 WHERE id=$1`, [ID, 'A'.repeat(41)])).toMatch(/too long|value too long/);
    await q.query(
      `INSERT INTO auth_code (staff_id, channel, purpose, target_hash, target_masked, code_hash, expires_at)
       VALUES ($1,'email','contact_change','h','m***','c', now() + interval '10 minutes')`, [ID],
    );
    expect(await blockedBy(q,
      `INSERT INTO auth_code (staff_id, channel, purpose, target_hash, target_masked, code_hash, expires_at)
       VALUES ($1,'email','bogus','h','m***','c', now() + interval '10 minutes')`, [ID])).toContain('auth_code_purpose_words');

    // ③ down 은 데이터를 지우지 않고 멈춘다
    await expect(mig.down(q)).rejects.toThrow(/영어 이름 1건 · 연락처 변경 코드 1건/);
    await q.query(`UPDATE staff SET english_name=NULL WHERE id=$1`, [ID]);
    await q.query(`DELETE FROM auth_code WHERE staff_id=$1`, [ID]);
    await mig.down(q);
    // 잠금을 켜 둔 계정은 증명이 필요 없다 — 다시 올라간다
    await q.query(`DELETE FROM log WHERE entity_id=$1 AND action='onboarding' AND at > now() - interval '1 hour'`, [ID]);
    await q.query(`UPDATE staff SET must_change_credentials=true WHERE id=$1`, [ID]);
    await mig.up(q);
    expect(await q.query(`SELECT 1 FROM information_schema.columns WHERE table_name='staff' AND column_name='english_name'`))
      .toHaveLength(1);
  });
});
