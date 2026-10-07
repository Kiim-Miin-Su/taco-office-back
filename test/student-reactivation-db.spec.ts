/** @file-guide
 * 목적: BOC-03D-03b 권위 상태·상담·profile audit 재활성화 transaction의 실제 PostgreSQL 회귀.
 * 책임/재사용: 스크래치 DB outer transaction 안에서 service와 지연 제약을 검증하고 모든 fixture를 rollback한다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-03-SCENARIOS-2026-10-06.md · docs/contracts/db/student-registration-target.dbml
 */

import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import type { StudentReactivationDto } from '../src/modules/students/student-registration.dto';
import { StudentsService } from '../src/modules/students/students.service';
import { assertScratch, blockedBy, TEST_URL } from './db';

jest.setTimeout(60_000);
const url = assertScratch(TEST_URL);

describe('BOC-03D-03b student reactivation persistence', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let service: StudentsService;
  let actor: number;
  let student: number;

  const dto = (overrides: Partial<StudentReactivationDto> = {}): StudentReactivationDto => ({
    requestKey: randomUUID(),
    studentId: student,
    expectedProfileVersion: '0',
    entrySource: 'students',
    leadId: null,
    reactivateOn: '2026-10-07',
    consultation: { channel: 'phone', content: '  복귀 상담\r\n다음 일정 확인  ', nextOn: '2026-10-10' },
    ...overrides,
  });

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
  });

  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query('SELECT pg_advisory_xact_lock(20261007, 620)');
    const [staff] = await q.query(`INSERT INTO staff(name,login_id,role)
      VALUES ('재활성화 시험자',$1,'admin') RETURNING id`, [`reactivate-${randomUUID()}`]) as Array<{ id: string }>;
    actor = Number(staff.id);
    const [stu] = await q.query(`INSERT INTO stu(name,grade,school)
      VALUES ('재활성화 학생','G3','시험 학교') RETURNING id`) as Array<{ id: string }>;
    student = Number(stu.id);
    const scoped = {
      query: (sql: string, params?: unknown[]) => q.query(sql, params),
      transaction: async (...args: unknown[]) => {
        const run = args.at(-1) as (manager: QueryRunner['manager']) => Promise<unknown>;
        return run(q.manager);
      },
    } as unknown as DataSource;
    service = new StudentsService(scoped);
  });

  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });

  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  async function withdraw(on = '2026-10-06'): Promise<void> {
    await q.query(`INSERT INTO stu_status_event
      (student_id,action,from_status,to_status,effective_on,actor_id)
      VALUES ($1,'withdraw',NULL,'withdrawn',$2::date,$3)`, [student, on, actor]);
  }

  it('event 없는 legacy 학생은 unknown이고 명시 withdrawn만 후보로 연다', async () => {
    const unknown = await service.reactivationCandidates({ q: '재활성화 학생' });
    expect(unknown.items[0]).toMatchObject({ studentId: student, status: 'unknown', reactivatable: false, blockedCode: 'STATUS_UNKNOWN', profileVersion: '0' });
    await withdraw();
    const candidate = await service.reactivationCandidates({ q: '재활성화 학생' });
    expect(candidate.items[0]).toMatchObject({ studentId: student, status: 'withdrawn', reactivatable: true, blockedCode: null, withdrawnOn: '2026-10-06' });
  });

  it('preview는 version 다음 값과 side effect 0을 돌려주고 어떤 원장도 쓰지 않는다', async () => {
    await withdraw();
    const command = dto();
    const out = await service.previewReactivation(actor, student, command);
    expect(out).toMatchObject({ saved: false, studentId: student, profileVersion: '1', consultationId: null });
    expect(Object.values(out.effects)).toEqual([false, false, false, false, false, false, false]);
    const [counts] = await q.query(`SELECT
      (SELECT count(*)::int FROM stu_reactivation_consultation WHERE student_id=$1) AS consultations,
      (SELECT count(*)::int FROM stu_profile_audit WHERE student_id=$1) AS audits,
      (SELECT count(*)::int FROM stu_status_event WHERE student_id=$1) AS events`, [student]) as Array<Record<string, number>>;
    expect(counts).toEqual({ consultations: 0, audits: 0, events: 1 });
  });

  it('같은 STU에 상담·profile audit·active event·LOG를 원자 저장하고 같은 요청은 replay한다', async () => {
    await withdraw();
    const command = dto();
    const first = await service.reactivate(actor, student, command);
    await q.query('SET CONSTRAINTS stu_reactivation_complete, stu_profile_audit_complete IMMEDIATE');
    expect(first).toMatchObject({ saved: true, studentId: student, profileVersion: '1', replayed: false });
    expect(Object.values(first.effects)).toEqual([false, false, false, false, false, false, false]);

    const replay = await service.reactivate(actor, student, command);
    expect(replay).toEqual({ ...first, replayed: true });
    const [row] = await q.query(`SELECT s.profile_version,
      (SELECT count(*)::int FROM stu_reactivation_consultation WHERE student_id=s.id) AS consultations,
      (SELECT count(*)::int FROM stu_profile_audit WHERE student_id=s.id AND action='reactivate') AS audits,
      (SELECT count(*)::int FROM stu_status_event WHERE student_id=s.id) AS events,
      (SELECT count(*)::int FROM log WHERE entity='STU' AND entity_id=s.id AND action='reactivate') AS logs,
      (SELECT status FROM student_status_current WHERE student_id=s.id) AS status
      FROM stu s WHERE s.id=$1`, [student]) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ profile_version: '1', consultations: 1, audits: 1, events: 2, logs: 1, status: 'active' });
  });

  it('같은 actor/requestKey의 다른 본문, active 상태와 stale version을 각각 409로 막는다', async () => {
    await withdraw();
    const command = dto();
    await service.reactivate(actor, student, command);
    await expect(service.reactivate(actor, student, {
      ...command,
      consultation: { ...command.consultation, content: '다른 상담' },
    })).rejects.toMatchObject({ response: { code: 'STUDENT_REACTIVATION_REQUEST_KEY_REUSED' } });
    await expect(service.reactivate(actor, student, dto({ expectedProfileVersion: '1' })))
      .rejects.toMatchObject({ response: { code: 'STUDENT_REACTIVATION_ACTIVE' } });

    await q.query(`INSERT INTO stu_status_event
      (student_id,action,from_status,to_status,effective_on,actor_id)
      VALUES ($1,'withdraw','active','withdrawn','2026-10-08',$2)`, [student, actor]);
    await expect(service.reactivate(actor, student, dto({ expectedProfileVersion: '0' })))
      .rejects.toMatchObject({ response: { code: 'STUDENT_PROFILE_VERSION_CONFLICT' } });
  });

  it('DB가 첫 active·고아 상담·원장 변조를 직접 SQL에서도 거절한다', async () => {
    expect(await blockedBy(q, `INSERT INTO stu_status_event
      (student_id,action,from_status,to_status,effective_on,actor_id,consultation_id,request_key,request_fingerprint,profile_version_before,profile_version_after)
      VALUES ($1,'reactivate',NULL,'active','2026-10-07',$2,1,$3,$4,0,1)`,
    [student, actor, randomUUID(), Buffer.alloc(32, 1)])).toMatch(/student_status_event|foreign key|invalid_reactivate/);

    await withdraw();
    expect(await blockedBy(q, `UPDATE stu_status_event SET effective_on='2026-10-01' WHERE student_id=$1`, [student]))
      .toMatch(/student_status_event_immutable/);

    await q.query('SAVEPOINT orphan_consultation');
    await q.query(`INSERT INTO stu_reactivation_consultation (
      student_id,entry_source,lead_id,reactivate_on,channel,content,next_on,created_by,
      request_key,request_fingerprint,profile_version_before,profile_version_after
    ) VALUES ($1,'students',NULL,'2026-10-07','phone','고아 상담',NULL,$2,$3,$4,0,1)`,
    [student, actor, randomUUID(), Buffer.alloc(32, 2)]);
    await expect(q.query('SET CONSTRAINTS stu_reactivation_complete IMMEDIATE'))
      .rejects.toThrow(/student_reactivation_transaction_incomplete/);
    await q.query('ROLLBACK TO SAVEPOINT orphan_consultation');
  });

  it('withdrawn 학생은 휴원일 이후 명단 배정을 DB 직접 쓰기에서도 거절한다', async () => {
    await withdraw();
    const kind = `R${randomUUID().slice(0, 8)}`;
    await q.query(`INSERT INTO kind(key,name,color,cap,grp,rep)
      VALUES ($1,'재활성화 시험','#123456',4,'lesson',false)`, [kind]);
    const [past, future] = await q.query(`INSERT INTO ser(kind_key,mode,start_min,end_min,rrule,from_date,title)
      VALUES ($1,'offline',600,660,'FREQ=WEEKLY','2026-01-01','과거 명단'),
             ($1,'offline',720,780,'FREQ=WEEKLY','2026-01-01','미래 명단')
      RETURNING id`, [kind]) as Array<{ id: string }>;

    await q.query(`INSERT INTO ser_stu(ser_id,student_id,from_date,to_date)
      VALUES ($1,$2,'2026-01-01','2026-10-06')`, [past.id, student]);
    expect(await blockedBy(q, `INSERT INTO ser_stu(ser_id,student_id,from_date,to_date)
      VALUES ($1,$2,'2026-01-01',NULL)`, [future.id, student]))
      .toMatch(/student_reactivation_required/);

    await service.reactivate(actor, student, dto());
    await q.query(`INSERT INTO ser_stu(ser_id,student_id,from_date,to_date)
      VALUES ($1,$2,'2026-10-07',NULL)`, [future.id, student]);
    const [{ n }] = await q.query(`SELECT count(*)::int AS n FROM ser_stu WHERE student_id=$1`, [student]) as Array<{ n: number }>;
    expect(n).toBe(2);
  });

  it('경로와 body 학생이 다르면 DB 조회 전에 400으로 거절한다', async () => {
    await withdraw();
    await expect(service.reactivate(actor, student + 1, dto()))
      .rejects.toMatchObject({ response: { code: 'STUDENT_ID_MISMATCH' } });
  });

  it('같은 학생 동시 재활성화는 STU 잠금 뒤 하나만 저장한다', async () => {
    // 실제 두 connection의 경합을 보려면 beforeEach의 단일 outer transaction 밖에 fixture가 있어야 한다.
    await q.rollbackTransaction();
    await q.release();
    const [staff] = await ds.query(`INSERT INTO staff(name,login_id,role)
      VALUES ('재활성화 경합 시험자',$1,'admin') RETURNING id`, [`reactivate-race-${randomUUID()}`]) as Array<{ id: string }>;
    const raceActor = Number(staff.id);
    const [stu] = await ds.query(`INSERT INTO stu(name,grade,school)
      VALUES ('재활성화 경합 학생','G3','시험 학교') RETURNING id`) as Array<{ id: string }>;
    const raceStudent = Number(stu.id);
    await ds.query(`INSERT INTO stu_status_event
      (student_id,action,from_status,to_status,effective_on,actor_id)
      VALUES ($1,'withdraw',NULL,'withdrawn','2026-10-06',$2)`, [raceStudent, raceActor]);
    const realService = new StudentsService(ds);
    const command = (requestKey: string): StudentReactivationDto => ({
      requestKey,
      studentId: raceStudent,
      expectedProfileVersion: '0',
      entrySource: 'students',
      leadId: null,
      reactivateOn: '2026-10-07',
      consultation: { channel: 'phone', content: '동시 복귀 상담', nextOn: null },
    });

    try {
      const results = await Promise.allSettled([
        realService.reactivate(raceActor, raceStudent, command(randomUUID())),
        realService.reactivate(raceActor, raceStudent, command(randomUUID())),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(rejected?.reason).toMatchObject({ response: { code: 'STUDENT_REACTIVATION_ACTIVE' } });
      const [saved] = await ds.query(`SELECT
        (SELECT count(*)::int FROM stu_reactivation_consultation WHERE student_id=$1) AS consultations,
        (SELECT count(*)::int FROM stu_profile_audit WHERE student_id=$1 AND action='reactivate') AS audits,
        (SELECT count(*)::int FROM stu_status_event WHERE student_id=$1 AND action='reactivate') AS activations`,
      [raceStudent]) as Array<Record<string, number>>;
      expect(saved).toEqual({ consultations: 1, audits: 1, activations: 1 });
    } finally {
      await ds.query('ALTER TABLE stu_status_event DISABLE TRIGGER stu_status_event_no_change');
      await ds.query('ALTER TABLE stu_reactivation_consultation DISABLE TRIGGER stu_reactivation_consultation_no_change');
      await ds.query('ALTER TABLE stu_profile_audit DISABLE TRIGGER stu_profile_audit_no_change');
      try {
        await ds.query(`DELETE FROM log WHERE entity='STU' AND entity_id=$1`, [raceStudent]);
        await ds.query('DELETE FROM stu_status_event WHERE student_id=$1', [raceStudent]);
        await ds.query('DELETE FROM stu_reactivation_consultation WHERE student_id=$1', [raceStudent]);
        await ds.query('DELETE FROM stu_profile_audit WHERE student_id=$1', [raceStudent]);
      } finally {
        await ds.query('ALTER TABLE stu_profile_audit ENABLE TRIGGER stu_profile_audit_no_change');
        await ds.query('ALTER TABLE stu_reactivation_consultation ENABLE TRIGGER stu_reactivation_consultation_no_change');
        await ds.query('ALTER TABLE stu_status_event ENABLE TRIGGER stu_status_event_no_change');
      }
      await ds.query('DELETE FROM stu WHERE id=$1', [raceStudent]);
      await ds.query('DELETE FROM staff WHERE id=$1', [raceActor]);
    }
  });
});
