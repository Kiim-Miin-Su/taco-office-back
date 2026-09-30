/** @file-guide
 * 목적: ST1-b3b 구형 보호자 scalar와 선택 연락처 복구 CLI의 안전 경계 회귀.
 * 책임/재사용: 독립 *_test PostgreSQL만 쓰고, 전용 fixture만 지운다. 운영 실행 증빙은 이 테스트가 대신하지 않는다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/contracts/db/student-registration-target.dbml
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DataSource, type QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import * as bridge from '../src/lib/guardian-contact-bridge';
import {
  assertApplyGate, assertConnectedTarget, assertReconcileSchema, parseReconcileArgs,
  parseReconcileTarget, reconcileGuardianContacts,
} from '../src/lib/guardian-contact-reconcile';
import { assertScratch, TEST_URL } from './db';

const url = assertScratch(TEST_URL);
const parsed = new URL(url);
const acknowledge = `${decodeURIComponent(parsed.username)}@${parsed.hostname}:${parsed.port || '5432'}/${decodeURIComponent(parsed.pathname.slice(1))}`;
const cli = 'scripts/guardian-contact-reconcile.ts';
jest.setTimeout(60_000);

function run(args: string[] = [], target = url) {
  const env = { ...process.env, DATABASE_URL: target, LOG_LEVEL: 'error' };
  const result = spawnSync(process.execPath, ['-r', 'ts-node/register', cli, ...args], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

describe('ST1-b3b guardian contact reconciliation safety CLI', () => {
  let ds: DataSource;
  let actor: string;
  let student: string;
  let guardian: string;
  let extraGuardian: string | null;
  const oldValue = 'observed.a@example.com';
  const currentValue = 'observed.b@example.com';

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    extraGuardian = null;
    const suffix = randomUUID();
    const [staff] = await ds.query(`INSERT INTO staff(name,login_id,role)
      VALUES ('복구 검증자',$1,'admin') RETURNING id`, [`reconcile-${suffix}`]) as Array<{ id: string }>;
    actor = staff.id;
    const [stu] = await ds.query(`INSERT INTO stu(name) VALUES ('복구 검증 학생') RETURNING id`) as Array<{ id: string }>;
    student = stu.id;
    const [g] = await ds.query(`INSERT INTO guardian
      (student_id,name,email,phone,receive_email,receive_sms,created_by)
      VALUES ($1,'복구 검증 보호자',$2,NULL,false,false,$3) RETURNING id`,
    [student, oldValue, actor]) as Array<{ id: string }>;
    guardian = g.id;
    await ds.query(`INSERT INTO guardian_contact(guardian_id,kind,value,is_delivery_selected,origin)
      VALUES ($1,'email',$2,true,'legacy_copy')`, [guardian, oldValue]);
    // 구형 writer는 scalar만 B로 바꿨다. child에는 A만 남는다.
    await ds.query(`UPDATE guardian SET email=$2 WHERE id=$1`, [guardian, currentValue]);
  });
  afterEach(async () => {
    if (extraGuardian) await ds.query(`DELETE FROM guardian_contact WHERE guardian_id=$1`, [extraGuardian]);
    if (extraGuardian) await ds.query(`DELETE FROM guardian WHERE id=$1`, [extraGuardian]);
    if (guardian) await ds.query(`DELETE FROM guardian_contact WHERE guardian_id=$1`, [guardian]);
    if (guardian) await ds.query(`DELETE FROM guardian WHERE id=$1`, [guardian]);
    if (student) await ds.query(`DELETE FROM stu WHERE id=$1`, [student]);
    if (actor) await ds.query(`DELETE FROM staff WHERE id=$1`, [actor]);
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('기본 dry-run은 불일치 건수만 보이고 PII/URL/DB 변경을 남기지 않는다', async () => {
    const before = await ds.query(`SELECT id,value,active,is_delivery_selected FROM guardian_contact WHERE guardian_id=$1`, [guardian]);
    const result = run();
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/email.*1/);
    expect(result.output).not.toContain(oldValue);
    expect(result.output).not.toContain(currentValue);
    expect(result.output).not.toContain(url);
    expect(await ds.query(`SELECT id,value,active,is_delivery_selected FROM guardian_contact WHERE guardian_id=$1`, [guardian])).toEqual(before);
  });

  it('명시 대상·writer drain·backup 확인 없이는 apply를 거절한다', () => {
    const missingUrl = run([], '');
    expect(missingUrl.status).not.toBe(0);
    expect(missingUrl.output).toMatch(/DATABASE_URL/);
    expect(run(['--apply']).status).not.toBe(0);
    expect(run(['--apply', `--confirm=${acknowledge}`, '--writers-drained']).status).not.toBe(0);
    expect(run(['--apply', '--confirm=wrong@127.0.0.1:56361/wrong', '--writers-drained', '--backup=receipt']).status).not.toBe(0);
    const managed = run(['--apply', '--confirm=taco@ep-a.neon.tech:5432/taco', '--writers-drained', '--backup=receipt'],
      'postgresql://taco@ep-a.neon.tech/taco?sslmode=require');
    expect(managed.status).not.toBe(0);
    expect(managed.output).not.toContain('postgresql://');
  });

  it('local URL이어도 실제 서버 주소가 비-loopback 또는 NULL이면 apply identity를 거절한다', async () => {
    const target = parseReconcileTarget(url);
    for (const loopback of [false, null]) {
      const q = { query: jest.fn().mockResolvedValue([{
        database: target.database, db_user: target.dbUser, port: target.port, loopback,
      }]) } as unknown as QueryRunner;
      await expect(assertConnectedTarget(q, target, true)).rejects.toMatchObject({ code: 'LOCAL_SERVER_ADDRESS_REQUIRED' });
    }
  });

  it('local URL의 pg host override와 암묵적 기본 포트는 apply 전에 거절한다', () => {
    const localWithOptions = parseReconcileTarget(`${url}?host=remote.example`);
    const args = parseReconcileArgs(['--apply', `--confirm=${localWithOptions.acknowledgement}`,
      '--writers-drained', '--backup=synthetic-test-backup']);
    expect(() => assertApplyGate(localWithOptions, args)).toThrow('APPLY_EXPLICIT_PLAIN_TCP_URL_REQUIRED');
    const implicitPort = parseReconcileTarget(`postgresql://${parsed.username}@127.0.0.1/${parsed.pathname.slice(1)}`);
    const implicitArgs = parseReconcileArgs(['--apply', `--confirm=${implicitPort.acknowledgement}`,
      '--writers-drained', '--backup=synthetic-test-backup']);
    expect(() => assertApplyGate(implicitPort, implicitArgs)).toThrow('APPLY_EXPLICIT_PLAIN_TCP_URL_REQUIRED');
  });

  it('선택 유니크 인덱스가 없으면 모호한 복구를 시작하지 않는다', async () => {
    const q = { query: jest.fn()
      .mockResolvedValueOnce([{ total: 92, bridge: 1 }])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce(['kind', 'value', 'label', 'origin', 'selected', 'email_shape', 'phone_shape', 'guardian_id_fkey']
        .map((suffix) => ({ conname: `guardian_contact_${suffix}` })))
      .mockResolvedValueOnce([]) } as unknown as QueryRunner;
    await expect(assertReconcileSchema(q)).rejects.toMatchObject({ code: 'GUARDIAN_CONTACT_UNIQUE_INDEX_REQUIRED' });
  });

  it('한 트랜잭션 복구는 A 이력을 남기고 B를 unknown legacy_copy로 선택하며 두 번째 실행은 0건이다', async () => {
    const args = ['--apply', `--confirm=${acknowledge}`, '--writers-drained', '--backup=synthetic-test-backup'];
    const first = run(args);
    expect(first.status).toBe(0);
    expect(first.output).not.toContain(oldValue);
    expect(first.output).not.toContain(currentValue);
    expect(first.output).not.toContain(url);
    expect(await ds.query(`SELECT value,active,is_delivery_selected,origin,created_by
      FROM guardian_contact WHERE guardian_id=$1 ORDER BY id`, [guardian])).toEqual([
      { value: oldValue, active: false, is_delivery_selected: false, origin: 'legacy_copy', created_by: null },
      { value: currentValue, active: true, is_delivery_selected: true, origin: 'legacy_copy', created_by: null },
    ]);
    const [countBefore] = await ds.query(`SELECT count(*)::int AS n FROM guardian_contact WHERE guardian_id=$1`, [guardian]);
    const second = run(args);
    expect(second.status).toBe(0);
    expect(second.output).toMatch(/applied.*0/);
    const [countAfter] = await ds.query(`SELECT count(*)::int AS n FROM guardian_contact WHERE guardian_id=$1`, [guardian]);
    expect(countAfter.n).toBe(countBefore.n);
  });

  it('선택된 user-origin 행과 scalar가 다르면 전체 apply를 거절하고 원본을 보존한다', async () => {
    await ds.query(`UPDATE guardian_contact SET origin='user',created_by=$2 WHERE guardian_id=$1`, [guardian, actor]);
    const before = await ds.query(`SELECT id,value,active,is_delivery_selected,origin,created_by
      FROM guardian_contact WHERE guardian_id=$1`, [guardian]);
    const result = run(['--apply', `--confirm=${acknowledge}`, '--writers-drained', '--backup=synthetic-test-backup']);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/USER_SELECTED_CONFLICT/);
    expect(result.output).not.toContain(oldValue);
    expect(result.output).not.toContain(currentValue);
    expect(await ds.query(`SELECT id,value,active,is_delivery_selected,origin,created_by
      FROM guardian_contact WHERE guardian_id=$1`, [guardian])).toEqual(before);
  });

  it('migration 뒤 child 없이 생긴 보호자의 현재 scalar도 작성자 추정 없이 복구한다', async () => {
    await ds.query(`DELETE FROM guardian_contact WHERE guardian_id=$1`, [guardian]);
    const result = run(['--apply', `--confirm=${acknowledge}`, '--writers-drained', '--backup=synthetic-test-backup']);
    expect(result.status).toBe(0);
    expect(await ds.query(`SELECT value,active,is_delivery_selected,origin,created_by
      FROM guardian_contact WHERE guardian_id=$1`, [guardian])).toEqual([
      { value: currentValue, active: true, is_delivery_selected: true, origin: 'legacy_copy', created_by: null },
    ]);
  });

  it('scalar NULL은 선택된 옛 주소를 삭제하지 않고 비활성 이력으로 남긴다', async () => {
    await ds.query(`UPDATE guardian SET email=NULL,phone='01012345678' WHERE id=$1`, [guardian]);
    const result = run(['--apply', `--confirm=${acknowledge}`, '--writers-drained', '--backup=synthetic-test-backup']);
    expect(result.status).toBe(0);
    expect(await ds.query(`SELECT kind,value,active,is_delivery_selected,origin
      FROM guardian_contact WHERE guardian_id=$1 ORDER BY id`, [guardian])).toEqual([
      { kind: 'email', value: oldValue, active: false, is_delivery_selected: false, origin: 'legacy_copy' },
      { kind: 'phone', value: '01012345678', active: true, is_delivery_selected: true, origin: 'legacy_copy' },
    ]);
  });

  it('bigint guardian id가 MAX_SAFE_INTEGER를 넘어도 정확한 행만 고친다', async () => {
    extraGuardian = (9_007_199_254_740_993n + BigInt(Number.parseInt(randomUUID().slice(0, 7), 16))).toString();
    await ds.query(`INSERT INTO guardian
      (id,student_id,name,email,phone,receive_email,receive_sms,created_by)
      VALUES ($1,$2,'큰 ID 보호자',$3,NULL,false,false,$4)`, [extraGuardian, student, currentValue, actor]);
    await ds.query(`INSERT INTO guardian_contact(guardian_id,kind,value,is_delivery_selected,origin)
      VALUES ($1,'email',$2,true,'legacy_copy')`, [extraGuardian, oldValue]);
    const result = run(['--apply', `--confirm=${acknowledge}`, '--writers-drained', '--backup=synthetic-test-backup']);
    expect(result.status).toBe(0);
    const rows = await ds.query(`SELECT value,is_delivery_selected FROM guardian_contact WHERE guardian_id=$1 ORDER BY id`, [extraGuardian]);
    expect(rows).toEqual([
      { value: oldValue, is_delivery_selected: false },
      { value: currentValue, is_delivery_selected: true },
    ]);
  });

  it('중간 bridge 실패는 트랜잭션 rollback으로 모든 child 변경을 되돌린다', async () => {
    const before = await ds.query(`SELECT id,value,active,is_delivery_selected FROM guardian_contact WHERE guardian_id=$1`, [guardian]);
    const q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const original = bridge.syncLegacyGuardianContacts;
    const fault = jest.spyOn(bridge, 'syncLegacyGuardianContacts').mockImplementation(async (...args) => {
      await original(...args);
      throw new Error('synthetic failpoint');
    });
    try {
      await expect(reconcileGuardianContacts(q, parseReconcileTarget(url))).rejects.toThrow('synthetic failpoint');
      await q.rollbackTransaction();
    } finally {
      fault.mockRestore();
      if (q.isTransactionActive) await q.rollbackTransaction();
      await q.release();
    }
    expect(await ds.query(`SELECT id,value,active,is_delivery_selected FROM guardian_contact WHERE guardian_id=$1`, [guardian])).toEqual(before);
  });

  it('guardian table 잠금 대기가 2초를 넘으면 쓰기 없이 rollback한다', async () => {
    const before = await ds.query(`SELECT id,value,active,is_delivery_selected FROM guardian_contact WHERE guardian_id=$1`, [guardian]);
    const locker = ds.createQueryRunner();
    await locker.connect();
    await locker.startTransaction();
    try {
      await locker.query('LOCK TABLE public.guardian IN ACCESS EXCLUSIVE MODE');
      const result = run(['--apply', `--confirm=${acknowledge}`, '--writers-drained', '--backup=synthetic-test-backup']);
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/55P03/);
    } finally {
      await locker.rollbackTransaction();
      await locker.release();
    }
    expect(await ds.query(`SELECT id,value,active,is_delivery_selected FROM guardian_contact WHERE guardian_id=$1`, [guardian])).toEqual(before);
  });
});
