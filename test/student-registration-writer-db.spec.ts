/** @file-guide
 * 목적: BOC-03D-04b 신규 학생 preview/save writer의 실제 PostgreSQL 원자성·멱등·PII 회귀.
 * 책임/재사용: 격리 *_test DB의 outer transaction 안에서 service savepoint를 실행하고 모든 fixture를 rollback한다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-03-SCENARIOS-2026-10-06.md · docs/contracts/db/student-registration-target.dbml
 */
import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { todayKst } from '../src/lib/kst';
import { openSecret, secretKeyFrom } from '../src/lib/secret-box';
import type { StudentCreateDto } from '../src/modules/students/student-registration.dto';
import { StudentsService } from '../src/modules/students/students.service';
import { assertScratch, TEST_URL } from './db';

jest.setTimeout(60_000);
const url = assertScratch(TEST_URL);
const PII_KEY = 'student-writer-test-key-2026';

describe('BOC-03D-04b student registration writer persistence', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let service: StudentsService;
  let actor: number;
  let sibling: number;
  let school: number;
  let previousKey: string | undefined;
  let previousVersion: string | undefined;

  const period = () => ({ from: todayKst(), fromPrecision: 'day' as const, to: null, toPrecision: null, memo: undefined });
  const dto = (overrides: Partial<StudentCreateDto> = {}): StudentCreateDto => ({
    requestKey: randomUUID(), entrySource: 'students', leadId: null,
    name: `등록 학생 ${randomUUID().slice(0, 8)}`, englishName: 'Alex Kim', gender: 'female',
    schoolHistory: [{ ...period(), schoolId: school }],
    gradeHistory: [{ ...period(), educationSystem: 'KR', gradeCode: 'E6' }],
    residenceHistory: [{ ...period(), countryCode: 'KR', timezone: 'Asia/Seoul' }],
    textHistory: [{ ...period(), field: 'want', value: '영어 발표 향상' }],
    contacts: [{ kind: 'kakao', value: 'student-kakao', label: null }],
    birthDate: '2013-02-03', hasCitizenship: true,
    guardians: [{
      relation: 'mother', relationOther: null, name: null, countryCode: 'KR', isPrimary: true, isPayer: true,
      contacts: [
        { kind: 'email', value: 'parent@example.com', label: null },
        { kind: 'phone', value: '010-1234-5678', label: null },
      ],
    }],
    cashReceiptNumber: '01012345678', siblingIds: [sibling], source: 'referral', assigneeIds: [actor],
    notes: '알레르기 확인', allowSameName: false,
    ...overrides,
  });

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
    previousKey = process.env.STUDENT_PII_ENC_KEY;
    previousVersion = process.env.STUDENT_PII_KEY_VERSION;
    process.env.STUDENT_PII_ENC_KEY = PII_KEY;
    process.env.STUDENT_PII_KEY_VERSION = 'test-v1';
  });

  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query('SELECT pg_advisory_xact_lock(20261007,630)');
    const [staff] = await q.query(`INSERT INTO staff(name,login_id,role)
      VALUES ('신규 등록 시험자',$1,'admin') RETURNING id`, [`student-create-${randomUUID()}`]) as Array<{ id: string }>;
    actor = Number(staff.id);
    const [schoolRow] = await q.query(`INSERT INTO school(name,country_code,created_by)
      VALUES ($1,'KR',$2) RETURNING id`, [`등록 시험 학교 ${randomUUID()}`, actor]) as Array<{ id: string }>;
    school = Number(schoolRow.id);
    const [siblingRow] = await q.query(`INSERT INTO stu(name,grade,school)
      VALUES ($1,'E4','기존 학교') RETURNING id`, [`기존 형제 ${randomUUID().slice(0, 8)}`]) as Array<{ id: string }>;
    sibling = Number(siblingRow.id);

    const scoped = {
      createQueryRunner: () => savepointRunner(q),
      query: (sql: string, params?: unknown[]) => q.query(sql, params),
      transaction: async (callback: (manager: QueryRunner['manager']) => Promise<unknown>) => callback(q.manager),
    } as unknown as DataSource;
    service = new StudentsService(scoped);
  });

  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });

  afterAll(async () => {
    if (previousKey === undefined) delete process.env.STUDENT_PII_ENC_KEY;
    else process.env.STUDENT_PII_ENC_KEY = previousKey;
    if (previousVersion === undefined) delete process.env.STUDENT_PII_KEY_VERSION;
    else process.env.STUDENT_PII_KEY_VERSION = previousVersion;
    if (ds?.isInitialized) await ds.destroy();
  });

  it('preview는 실제 지연 제약까지 통과하고 requestKey·도메인 행을 남기지 않는다', async () => {
    const command = dto();
    const before = await rowCounts(q, command.name);
    const result = await service.previewCreate(actor, command);
    expect(result).toMatchObject({ saved: false, studentId: null, profileVersion: null,
      summary: { gradePeriods: 1, residencePeriods: 1, guardians: 1, siblingLinks: 1, assignees: 1 } });
    expect(await rowCounts(q, command.name)).toEqual(before);
    const [{ n }] = await q.query(`SELECT count(*)::int AS n FROM stu WHERE registration_request_key=$1`, [command.requestKey]) as Array<{ n: number }>;
    expect(n).toBe(0);
  });

  it('등록 선택지와 학교 검색·추가가 같은 정본 code와 bigint number 계약을 사용한다', async () => {
    const options = await service.registrationOptions();
    expect(options.educationGrades).toHaveLength(39);
    expect(options.educationGrades).toEqual(expect.arrayContaining([
      expect.objectContaining({ educationSystem: 'KR', code: 'E6' }),
      expect.objectContaining({ educationSystem: 'US', code: 'G5' }),
    ]));
    expect(options.countries).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'KR', timezones: expect.arrayContaining([
        expect.objectContaining({ timezone: 'Asia/Seoul' }),
      ]) }),
    ]));

    const requestKey = randomUUID();
    const name = `등록 선택 학교 ${randomUUID().slice(0, 8)}`;
    const command = { requestKey, name, countryCode: 'KR', region: null, campus: null };
    const created = await service.createSchool(actor, command);
    expect(created).toMatchObject({ name, countryCode: 'KR', active: true });
    expect(typeof created.id).toBe('number');
    expect(await service.createSchool(actor, command)).toEqual(created);
    await expect(service.createSchool(actor, { ...command, name: `${name} 변경` }))
      .rejects.toMatchObject({ response: { code: 'STUDENT_SCHOOL_REQUEST_KEY_REUSED' } });
    const found = await service.searchSchools({ q: name });
    expect(found).toEqual([created]);
    expect(typeof found[0].id).toBe('number');
    await expect(service.createSchool(actor, { ...command, requestKey: randomUUID(), name: `${name} 외국`, countryCode: 'ZZ' }))
      .rejects.toMatchObject({ response: { code: 'STUDENT_REGISTRATION_OPTION_INACTIVE' } });
  });

  it('15절 전체를 한 transaction에 저장하고 암호문만 보존하며 같은 요청은 replay한다', async () => {
    const command = dto();
    const first = await service.create(actor, command);
    expect(first).toMatchObject({ saved: true, profileVersion: '1', replayed: false,
      summary: { schoolPeriods: 1, gradePeriods: 1, residencePeriods: 1, textPeriods: 2,
        studentContacts: 1, guardians: 1, siblingLinks: 1, assignees: 1 } });
    const replay = await service.create(actor, command);
    expect(replay).toEqual({ ...first, replayed: true });

    const [saved] = await q.query(`SELECT s.profile_version,s.cash_receipt_encrypted,s.cash_receipt_key_version,
      (SELECT count(*)::int FROM stu_profile_period p WHERE p.student_id=s.id) AS periods,
      (SELECT count(*)::int FROM stu_contact c WHERE c.student_id=s.id) AS contacts,
      (SELECT count(*)::int FROM guardian g WHERE g.student_id=s.id) AS guardians,
      (SELECT count(*)::int FROM guardian_contact c JOIN guardian g ON g.id=c.guardian_id WHERE g.student_id=s.id) AS guardian_contacts,
      (SELECT count(*)::int FROM stu_staff x WHERE x.student_id=s.id) AS assignees,
      (SELECT count(*)::int FROM stu_sibling x WHERE x.student_low_id=s.id OR x.student_high_id=s.id) AS siblings,
      (SELECT count(*)::int FROM stu_status_event e WHERE e.student_id=s.id AND e.action='create') AS status_events,
      (SELECT count(*)::int FROM stu_profile_audit a WHERE a.student_id=s.id AND a.action='create') AS audits,
      (SELECT count(*)::int FROM log l WHERE l.entity='STU' AND l.entity_id=s.id AND l.action='create') AS logs
      FROM stu s WHERE s.id=$1`, [first.studentId]) as Array<Record<string, unknown>>;
    expect(saved).toMatchObject({ profile_version: '1', cash_receipt_key_version: 'test-v1', periods: 5, contacts: 1,
      guardians: 1, guardian_contacts: 2, assignees: 1, siblings: 1, status_events: 1, audits: 1, logs: 1 });
    const key = secretKeyFrom(PII_KEY)!;
    expect(openSecret(saved.cash_receipt_encrypted as Buffer, key)).toBe(command.cashReceiptNumber);
    const [pii] = await q.query(`SELECT
      (SELECT after::text FROM log WHERE entity='STU' AND entity_id=$1 AND action='create') AS log_text,
      (SELECT after_data::text FROM stu_profile_audit WHERE student_id=$1 AND action='create') AS audit_text`,
    [first.studentId]) as Array<{ log_text: string; audit_text: string }>;
    expect(`${pii.log_text}${pii.audit_text}`).not.toContain(command.cashReceiptNumber!);
    expect(`${pii.log_text}${pii.audit_text}`).not.toContain('parent@example.com');
    const [linked] = await q.query(`SELECT profile_version FROM stu WHERE id=$1`, [sibling]) as Array<{ profile_version: string }>;
    expect(linked.profile_version).toBe('1');
  });

  it('등록 계약 학생의 보호자 연락처를 직접 전부 지우는 우회 쓰기도 DB가 거절한다', async () => {
    const saved = await service.create(actor, dto({ siblingIds: [] }));
    const [guardian] = await q.query(`SELECT id FROM guardian WHERE student_id=$1`, [saved.studentId]) as Array<{ id: string }>;

    await q.query('SAVEPOINT guardian_contact_direct_write');
    await q.query('SET CONSTRAINTS ALL DEFERRED');
    await q.query(`DELETE FROM guardian_contact WHERE guardian_id=$1`, [guardian.id]);
    await expect(q.query('SET CONSTRAINTS ALL IMMEDIATE'))
      .rejects.toThrow(/guardian_active_contact_required/i);
    await q.query('ROLLBACK TO SAVEPOINT guardian_contact_direct_write');
    await q.query('RELEASE SAVEPOINT guardian_contact_direct_write');
    await q.query('SET CONSTRAINTS ALL DEFERRED');

    const [{ n }] = await q.query(`SELECT count(*)::int AS n FROM guardian_contact WHERE guardian_id=$1`, [guardian.id]) as Array<{ n: number }>;
    expect(n).toBe(2);
  });

  it('같은 key의 다른 본문과 명시 withdrawn 형제를 409로 막고 실패 행을 남기지 않는다', async () => {
    const command = dto({ siblingIds: [] });
    await service.create(actor, command);
    await expect(service.create(actor, { ...command, notes: '다른 내용' }))
      .rejects.toMatchObject({ response: { code: 'STUDENT_CREATE_REQUEST_KEY_REUSED' } });
    await q.query(`INSERT INTO stu_status_event(student_id,action,from_status,to_status,effective_on,actor_id)
      VALUES ($1,'withdraw',NULL,'withdrawn',$2::date,$3)`, [sibling, todayKst(), actor]);
    const rejected = dto({ name: `거절 학생 ${randomUUID().slice(0, 8)}` });
    await expect(service.create(actor, rejected))
      .rejects.toMatchObject({ response: { code: 'STUDENT_REGISTRATION_SIBLING_INACTIVE' } });
    const [{ n }] = await q.query(`SELECT count(*)::int AS n FROM stu WHERE name=$1`, [rejected.name]) as Array<{ n: number }>;
    expect(n).toBe(0);
  });

  it('intake 원천은 잠가 새 학생에 연결하고 이미 연결된 lead 재사용은 거절한다', async () => {
    const [lead] = await q.query(`INSERT INTO lead(name,stage) VALUES ('등록 상담','waiting') RETURNING id`) as Array<{ id: string }>;
    const first = dto({ entrySource: 'intake', leadId: Number(lead.id), siblingIds: [] });
    const result = await service.create(actor, first);
    const [linked] = await q.query(`SELECT student_id FROM lead WHERE id=$1`, [lead.id]) as Array<{ student_id: string }>;
    expect(Number(linked.student_id)).toBe(result.studentId);
    await expect(service.create(actor, dto({ entrySource: 'intake', leadId: Number(lead.id), siblingIds: [] })))
      .rejects.toMatchObject({ response: { code: 'STUDENT_REGISTRATION_LEAD_LINKED' } });
  });

  it('현금영수증 입력에 PII key가 없으면 503이고 학생을 만들지 않는다', async () => {
    delete process.env.STUDENT_PII_ENC_KEY;
    const command = dto({ siblingIds: [] });
    try {
      await expect(service.create(actor, command))
        .rejects.toMatchObject({ response: { code: 'STUDENT_PII_KEY_MISSING' } });
      const [{ n }] = await q.query(`SELECT count(*)::int AS n FROM stu WHERE name=$1`, [command.name]) as Array<{ n: number }>;
      expect(n).toBe(0);
    } finally {
      process.env.STUDENT_PII_ENC_KEY = PII_KEY;
    }
  });
});

function savepointRunner(outer: QueryRunner): QueryRunner {
  let active = false;
  const runner = {
    manager: outer.manager,
    get isTransactionActive() { return active; },
    get isReleased() { return false; },
    connect: async () => runner,
    startTransaction: async () => { await outer.query('SAVEPOINT student_create_writer'); active = true; },
    commitTransaction: async () => { await outer.query('RELEASE SAVEPOINT student_create_writer'); active = false; },
    rollbackTransaction: async () => {
      await outer.query('ROLLBACK TO SAVEPOINT student_create_writer');
      await outer.query('RELEASE SAVEPOINT student_create_writer');
      active = false;
    },
    release: async () => undefined,
    query: (sql: string, params?: unknown[]) => outer.query(sql, params),
  } as unknown as QueryRunner;
  return runner;
}

async function rowCounts(q: QueryRunner, studentName: string): Promise<Record<string, number>> {
  const [counts] = await q.query(`SELECT
    (SELECT count(*)::int FROM stu WHERE name=$1) AS students,
    (SELECT count(*)::int FROM stu_profile_audit a JOIN stu s ON s.id=a.student_id WHERE s.name=$1) AS audits,
    (SELECT count(*)::int FROM stu_status_event e JOIN stu s ON s.id=e.student_id WHERE s.name=$1) AS events,
    (SELECT count(*)::int FROM log l JOIN stu s ON s.id=l.entity_id WHERE l.entity='STU' AND s.name=$1) AS logs`,
  [studentName]) as Array<Record<string, number>>;
  return counts;
}
