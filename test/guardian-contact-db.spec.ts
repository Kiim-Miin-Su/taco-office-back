/** @file-guide
 * 목적: ST1-b3a guardian_contact의 정확 백필·단방향 FK·선택 수신처 DB 불변식 회귀.
 * 책임/재사용: 독립 *_test PostgreSQL에서 transaction rollback으로만 검사한다. 새 연락처 API/최후 연락처 정책은 후속 청크다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/contracts/db/student-registration-target.dbml
 */

import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { syncLegacyGuardianContacts } from '../src/lib/guardian-contact-bridge';
import { GuardianContact1765900000000 } from '../src/migrations/1765900000000-guardian-contact';
import { assertScratch, blockedBy, TEST_URL } from './db';

const url = assertScratch(TEST_URL);
jest.setTimeout(60_000);

describe('ST1-b3a guardian contact additive bridge', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let actor: string;
  let student: string;
  const migration = new GuardianContact1765900000000();

  const guardian = async (email: string | null, phone: string | null, receiveEmail: boolean, receiveSms: boolean) => {
    const [row] = await q.query(`INSERT INTO guardian
      (student_id,name,email,phone,receive_email,receive_sms,created_by)
      VALUES ($1,'기존 보호자',$2,$3,$4,$5,$6) RETURNING id`,
    [student, email, phone, receiveEmail, receiveSms, actor]) as Array<{ id: string }>;
    return row.id;
  };

  /** public 표를 DROP하지 않고 이 트랜잭션 전용 schema에서 migration SQL 자체를 검증한다. */
  const migrationSchema = async () => {
    const schema = `st1b3a_${randomUUID().replaceAll('-', '')}`;
    await q.query(`CREATE SCHEMA "${schema}"`);
    await q.query(`CREATE TABLE "${schema}".guardian (
      id bigint PRIMARY KEY, email varchar(254), phone varchar(11), receive_email boolean, receive_sms boolean)`);
    await q.query(`CREATE TABLE "${schema}".staff (id bigint PRIMARY KEY)`);
    await q.query(`SET LOCAL search_path TO "${schema}"`);
  };

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query('SELECT pg_advisory_xact_lock(20261001, 590)');
    const [staff] = await q.query(`INSERT INTO staff(name,login_id,role)
      VALUES ('연락처 시험자',$1,'admin') RETURNING id`, [`st1b3a-${randomUUID()}`]) as Array<{ id: string }>;
    actor = staff.id;
    const [stu] = await q.query(`INSERT INTO stu(name) VALUES ('연락처 시험 학생') RETURNING id`) as Array<{ id: string }>;
    student = stu.id;
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('legacy 주소는 동의가 꺼져도 정확히 복사·선택하고 원장과 동의는 그대로 둔다', async () => {
    await migrationSchema();
    const id = '1';
    await q.query(`INSERT INTO guardian(id,email,phone,receive_email,receive_sms)
      VALUES (1,'Legacy.Mom@Example.com','01012345678',false,false)`);
    await q.query(`CREATE TABLE guardian_send (
      id bigint PRIMARY KEY, request_key uuid, guardian_id bigint, channel text, to_masked text, status text)`);
    const key = randomUUID();
    await q.query(`INSERT INTO guardian_send
      (id,request_key,guardian_id,channel,to_masked,status)
      VALUES (1,$1,$2,'sms','010-****-5678','not_configured')`, [key, id]);
    const [before] = await q.query(`SELECT email,phone,receive_email,receive_sms FROM guardian WHERE id=$1`, [id]);
    const [ledgerBefore] = await q.query(`SELECT md5(row_to_json(s)::text) AS digest FROM guardian_send s WHERE request_key=$1`, [key]);

    await migration.up(q);
    const rows = await q.query(`SELECT kind,value,active,is_delivery_selected,origin,created_by
      FROM guardian_contact WHERE guardian_id=$1 ORDER BY kind`, [id]);
    expect(rows).toEqual([
      { kind: 'email', value: 'Legacy.Mom@Example.com', active: true, is_delivery_selected: true, origin: 'legacy_copy', created_by: null },
      { kind: 'phone', value: '01012345678', active: true, is_delivery_selected: true, origin: 'legacy_copy', created_by: null },
    ]);
    const [after] = await q.query(`SELECT email,phone,receive_email,receive_sms FROM guardian WHERE id=$1`, [id]);
    const [ledgerAfter] = await q.query(`SELECT md5(row_to_json(s)::text) AS digest FROM guardian_send s WHERE request_key=$1`, [key]);
    expect(after).toEqual(before);
    expect(ledgerAfter).toEqual(ledgerBefore);
  });

  it('선택은 email/phone의 활성 행에만, 보호자별 종류마다 하나만 허용한다', async () => {
    const id = await guardian('first@example.com', null, false, false);
    await q.query(`INSERT INTO guardian_contact(guardian_id,kind,value,is_delivery_selected,origin)
      VALUES ($1,'email','first@example.com',true,'legacy_copy')`, [id]);
    expect(await blockedBy(q, `INSERT INTO guardian_contact(guardian_id,kind,value,is_delivery_selected,created_by)
      VALUES ($1,'email','second@example.com',true,$2)`, [id, actor])).toMatch(/guardian_contact_one_selected_kind/);
    expect(await blockedBy(q, `INSERT INTO guardian_contact(guardian_id,kind,value,is_delivery_selected,created_by)
      VALUES ($1,'kakao','id123',true,$2)`, [id, actor])).toMatch(/guardian_contact_selected/);
    expect(await blockedBy(q, `INSERT INTO guardian_contact(guardian_id,kind,value,active,is_delivery_selected,created_by)
      VALUES ($1,'phone','01012345678',false,true,$2)`, [id, actor])).toMatch(/guardian_contact_selected/);
    expect(await blockedBy(q, `INSERT INTO guardian_contact(guardian_id,kind,value,origin)
      VALUES ($1,'email','unknown@example.com','user')`, [id])).toMatch(/guardian_contact_origin/);
    expect(await blockedBy(q, `INSERT INTO guardian_contact(guardian_id,kind,value,origin)
      VALUES (999999999,'email','unknown@example.com','legacy_copy')`)).toMatch(/foreign key/);
  });

  it('사용자 입력 행이 있으면 down migration은 손실 없이 거절한다', async () => {
    await migrationSchema();
    const id = '1';
    await q.query(`INSERT INTO staff(id) VALUES ($1)`, [actor]);
    await q.query(`INSERT INTO guardian(id,email,phone,receive_email,receive_sms)
      VALUES (1,'preserve@example.com',NULL,true,false)`);
    await migration.up(q);
    await q.query(`INSERT INTO guardian_contact(guardian_id,kind,value,is_delivery_selected,created_by)
      VALUES ($1,'kakao','preserve-id',false,$2)`, [id, actor]);
    await expect(migration.down(q)).rejects.toThrow(/would lose data/);
    const [row] = await q.query(`SELECT value FROM guardian_contact WHERE guardian_id=$1 AND kind='kakao'`, [id]);
    expect(row.value).toBe('preserve-id');
  });

  it('구버전 writer가 migration 후 child 없이 만든 보호자가 있으면 down을 거절한다', async () => {
    await migrationSchema();
    await migration.up(q);
    await q.query(`INSERT INTO guardian(id,email,phone,receive_email,receive_sms)
      VALUES (1,'late@example.com',NULL,false,false)`);
    await expect(migration.down(q)).rejects.toThrow(/would lose data/);
  });

  it('구버전 writer가 기존 scalar를 child 없이 바꾸어도 down을 거절한다', async () => {
    await migrationSchema();
    await q.query(`INSERT INTO guardian(id,email,phone,receive_email,receive_sms)
      VALUES (1,'before@example.com',NULL,false,false)`);
    await migration.up(q);
    await q.query(`UPDATE guardian SET email='after@example.com' WHERE id=1`);
    await expect(migration.down(q)).rejects.toThrow(/would lose data/);
  });

  it('현재 scalar와 정확히 같은 legacy_copy 행만 있으면 down할 수 있다', async () => {
    await migrationSchema();
    await q.query(`INSERT INTO guardian(id,email,phone,receive_email,receive_sms)
      VALUES (1,'same@example.com','01012345678',false,false)`);
    await migration.up(q);
    await migration.down(q);
    const [row] = await q.query(`SELECT to_regclass('guardian_contact') AS table_name`) as Array<{ table_name: string | null }>;
    expect(row.table_name).toBeNull();
  });

  it('구버전 writer의 A→B 변경을 새 bridge가 복구해도 A 이력을 down으로 잃지 않는다', async () => {
    await migrationSchema();
    await q.query(`INSERT INTO staff(id) VALUES ($1)`, [actor]);
    await q.query(`INSERT INTO guardian(id,email,phone,receive_email,receive_sms)
      VALUES (1,'old@example.com',NULL,false,false)`);
    await migration.up(q);
    await q.query(`UPDATE guardian SET email='new@example.com' WHERE id=1`);
    await syncLegacyGuardianContacts(q, 1,
      { email: 'new@example.com', phone: null }, { email: 'new@example.com', phone: null }, Number(actor));
    expect(await q.query(`SELECT value,active,is_delivery_selected,origin FROM guardian_contact ORDER BY id`)).toEqual([
      { value: 'old@example.com', active: false, is_delivery_selected: false, origin: 'legacy_copy' },
      { value: 'new@example.com', active: true, is_delivery_selected: true, origin: 'legacy_copy' },
    ]);
    await expect(migration.down(q)).rejects.toThrow(/would lose data/);
  });

  it('구버전 A→B 뒤 신형 B→C 수정은 관찰한 B도 작성자 미상 이력으로 보존한다', async () => {
    const id = await guardian('a@example.com', null, false, false);
    await q.query(`INSERT INTO guardian_contact(guardian_id,kind,value,is_delivery_selected,origin)
      VALUES ($1,'email','a@example.com',true,'legacy_copy')`, [id]);
    // 구버전 인스턴스는 scalar만 변경한다. 신형 patch는 UPDATE 전 B를 읽은 뒤 C를 저장한다.
    await q.query(`UPDATE guardian SET email='b@example.com' WHERE id=$1`, [id]);
    await q.query(`UPDATE guardian SET email='c@example.com' WHERE id=$1`, [id]);
    await syncLegacyGuardianContacts(q, Number(id),
      { email: 'b@example.com', phone: null }, { email: 'c@example.com', phone: null }, Number(actor));
    expect(await q.query(`SELECT value,active,is_delivery_selected,origin,created_by
      FROM guardian_contact WHERE guardian_id=$1 ORDER BY id`, [id])).toEqual([
      { value: 'a@example.com', active: false, is_delivery_selected: false, origin: 'legacy_copy', created_by: null },
      { value: 'b@example.com', active: false, is_delivery_selected: false, origin: 'legacy_copy', created_by: null },
      { value: 'c@example.com', active: true, is_delivery_selected: true, origin: 'user', created_by: actor },
    ]);
  });

  it('구버전 A→B 뒤 신형이 A로 되돌려도 조기 반환 전에 B를 보존한다', async () => {
    const id = await guardian('a@example.com', null, false, false);
    await q.query(`INSERT INTO guardian_contact(guardian_id,kind,value,is_delivery_selected,origin)
      VALUES ($1,'email','a@example.com',true,'legacy_copy')`, [id]);
    await q.query(`UPDATE guardian SET email='b@example.com' WHERE id=$1`, [id]);
    await q.query(`UPDATE guardian SET email='a@example.com' WHERE id=$1`, [id]);
    await syncLegacyGuardianContacts(q, Number(id),
      { email: 'b@example.com', phone: null }, { email: 'a@example.com', phone: null }, Number(actor));
    expect(await q.query(`SELECT value,active,is_delivery_selected,origin,created_by
      FROM guardian_contact WHERE guardian_id=$1 ORDER BY id`, [id])).toEqual([
      { value: 'a@example.com', active: true, is_delivery_selected: true, origin: 'legacy_copy', created_by: null },
      { value: 'b@example.com', active: false, is_delivery_selected: false, origin: 'legacy_copy', created_by: null },
    ]);
  });

  it('구버전이 만든 child 없는 보호자를 수정할 때도 기존 주소를 보존한다', async () => {
    const id = await guardian('b@example.com', null, false, false);
    await q.query(`UPDATE guardian SET email='c@example.com' WHERE id=$1`, [id]);
    await syncLegacyGuardianContacts(q, Number(id),
      { email: 'b@example.com', phone: null }, { email: 'c@example.com', phone: null }, Number(actor));
    expect(await q.query(`SELECT value,active,is_delivery_selected,origin,created_by
      FROM guardian_contact WHERE guardian_id=$1 ORDER BY id`, [id])).toEqual([
      { value: 'b@example.com', active: false, is_delivery_selected: false, origin: 'legacy_copy', created_by: null },
      { value: 'c@example.com', active: true, is_delivery_selected: true, origin: 'user', created_by: actor },
    ]);
  });

  it('구버전 B를 그대로 저장하면 bridge가 B를 선택하고 비활성 중복은 만들지 않는다', async () => {
    const id = await guardian('a@example.com', null, false, false);
    await q.query(`INSERT INTO guardian_contact(guardian_id,kind,value,is_delivery_selected,origin)
      VALUES ($1,'email','a@example.com',true,'legacy_copy')`, [id]);
    await q.query(`UPDATE guardian SET email='b@example.com' WHERE id=$1`, [id]);
    await syncLegacyGuardianContacts(q, Number(id),
      { email: 'b@example.com', phone: null }, { email: 'b@example.com', phone: null }, Number(actor));
    expect(await q.query(`SELECT value,active,is_delivery_selected,origin,created_by
      FROM guardian_contact WHERE guardian_id=$1 ORDER BY id`, [id])).toEqual([
      { value: 'a@example.com', active: false, is_delivery_selected: false, origin: 'legacy_copy', created_by: null },
      { value: 'b@example.com', active: true, is_delivery_selected: true, origin: 'legacy_copy', created_by: null },
    ]);
  });
});
