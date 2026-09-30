/** @file-guide
 * 목적: ST1-b2 학생 기간·감사 원장의 실제 PostgreSQL 불변식과 KST 현재값 회귀.
 * 책임/재사용: 독립 *_test DB에서 이력·정정·legacy/gap을 직접 SQL로 검증한다. HTTP writer/권한을 대신하지 않는다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md §3·§6 · docs/contracts/db/student-registration-target.dbml
 */

import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { todayKst } from '../src/lib/kst';
import { StudentProfile1765700000000 } from '../src/migrations/1765700000000-student-profile';
import { assertScratch, blockedBy, TEST_URL } from './db';

jest.setTimeout(60_000);
const url = assertScratch(TEST_URL);

describe('ST1-b2 student profile persistence', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let actor: string;
  let student: string;

  async function audit(
    action: string, field: string | null, versionBefore: number, options: { studentId?: string; reason?: string | null; requestKey?: string } = {},
  ): Promise<string> {
    const [row] = await q.query(`INSERT INTO stu_profile_audit
      (student_id,action,field,request_key,request_fingerprint,version_before,version_after,reason,recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [
      options.studentId ?? student, action, field, options.requestKey ?? randomUUID(), Buffer.alloc(32, 7),
      versionBefore, versionBefore + 1, options.reason ?? null, actor,
    ]) as Array<{ id: string }>;
    return row.id;
  }

  async function period(input: {
    auditId: string; field?: string; from: string; to?: string | null;
    fromPrecision?: string; toPrecision?: string | null; fromDerived?: boolean; toDerived?: boolean;
    educationSystem?: string | null; gradeCode?: string | null; schoolId?: string | null;
    countryCode?: string | null; timezone?: string | null; textValue?: string | null;
    studentId?: string;
  }): Promise<string> {
    const [row] = await q.query(`INSERT INTO stu_profile_period (
      student_id,field,valid_from,valid_to,from_precision,to_precision,from_derived,to_derived,
      education_system,grade_code,school_id,residence_country_code,residence_timezone,text_value,created_audit_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [
      input.studentId ?? student, input.field ?? 'grade', input.from, input.to ?? null,
      input.fromPrecision ?? 'day', input.to === undefined || input.to === null ? null : (input.toPrecision ?? 'day'),
      input.fromDerived ?? false, input.toDerived ?? false,
      input.educationSystem ?? null, input.gradeCode ?? null, input.schoolId ?? null,
      input.countryCode ?? null, input.timezone ?? null, input.textValue ?? null, input.auditId,
    ]) as Array<{ id: string }>;
    return row.id;
  }

  async function finishDeferred(): Promise<void> {
    await q.query('SET CONSTRAINTS stu_profile_audit_complete, stu_profile_period_no_overlap IMMEDIATE');
    await q.query('SET CONSTRAINTS stu_profile_audit_complete, stu_profile_period_no_overlap DEFERRED');
  }

  async function blockedDeferred(write: () => Promise<void>): Promise<string> {
    await q.query('SAVEPOINT invalid_profile');
    try {
      await write();
      await q.query('SET CONSTRAINTS stu_profile_audit_complete, stu_profile_period_no_overlap IMMEDIATE');
    } catch (e) {
      await q.query('ROLLBACK TO SAVEPOINT invalid_profile');
      return e instanceof Error ? e.message : String(e);
    }
    await q.query('ROLLBACK TO SAVEPOINT invalid_profile');
    throw new Error('invalid profile write unexpectedly passed');
  }

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query('SELECT pg_advisory_xact_lock(20260930, 570)');
    const [staff] = await q.query(`INSERT INTO staff(name,login_id,role)
      VALUES ('기간 시험자',$1,'admin') RETURNING id`, [`st1b2-${randomUUID()}`]) as Array<{ id: string }>;
    actor = staff.id;
    const [stu] = await q.query(`INSERT INTO stu(name,grade,school)
      VALUES ('기간 학생','G2','옛 학교') RETURNING id`, []) as Array<{ id: string }>;
    student = stu.id;
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('학생의 기간·감사 표와 시점별 현재값 읽기 함수가 존재한다', async () => {
    const rows = await q.query(`SELECT to_regclass('stu_profile_audit') AS audit,
      to_regclass('stu_profile_period') AS period,
      to_regclass('student_profile_current') AS current_view`) as Array<{ audit: string | null; period: string | null; current_view: string | null }>;
    expect(rows[0]).toEqual({ audit: 'stu_profile_audit', period: 'stu_profile_period', current_view: 'student_profile_current' });
  });

  it('legacy 원문은 유효시점 미상으로만 노출하고, 기간의 과거·현재·공백은 자동 결정한다', async () => {
    const legacy = await q.query(`SELECT source,legacy_text,period_id FROM student_profile_at('2019-01-01')
      WHERE student_id=$1 AND field='grade'`, [student]) as Array<{ source: string; legacy_text: string | null; period_id: string | null }>;
    expect(legacy[0]).toEqual({ source: 'legacy_unknown', legacy_text: null, period_id: null });
    const [currentLegacy] = await q.query(`SELECT source,legacy_text FROM student_profile_at($1)
      WHERE student_id=$2 AND field='grade'`, [todayKst(), student]) as Array<{ source: string; legacy_text: string | null }>;
    expect(currentLegacy).toEqual({ source: 'legacy_unknown', legacy_text: 'G2' });
    const [futureLegacy] = await q.query(`SELECT source,legacy_text FROM student_profile_at('2030-01-01')
      WHERE student_id=$1 AND field='grade'`, [student]) as Array<{ source: string; legacy_text: string | null }>;
    expect(futureLegacy).toEqual({ source: 'legacy_unknown', legacy_text: null });

    const a = await audit('period_append', 'grade', 0);
    const p = await period({ auditId: a, from: '2020-01-01', to: '2021-12-31', fromPrecision: 'year', toPrecision: 'year', educationSystem: 'US', gradeCode: 'G3' });
    await finishDeferred();
    const rows = await q.query(`SELECT field,source,period_id,grade_code,legacy_text,profile_version,from_precision,to_precision
      FROM student_profile_at('2020-07-01') WHERE student_id=$1 AND field='grade'`, [student]) as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ field: 'grade', source: 'period', period_id: p, grade_code: 'G3', legacy_text: null, profile_version: '1', from_precision: 'year', to_precision: 'year' });
    const gaps = await q.query(`SELECT source,legacy_text FROM student_profile_at('2022-01-01')
      WHERE student_id=$1 AND field='grade'`, [student]) as Array<{ source: string; legacy_text: string | null }>;
    expect(gaps[0]).toEqual({ source: 'gap', legacy_text: null });
    const old = await q.query(`SELECT grade,school FROM stu WHERE id=$1`, [student]) as Array<{ grade: string; school: string }>;
    expect(old[0]).toEqual({ grade: 'G2', school: '옛 학교' });
  });

  it('현재 view는 세션 타임존과 무관하게 서울 날짜의 기간을 읽는다', async () => {
    const today = todayKst();
    const a = await audit('period_append', 'grade', 0);
    const p = await period({ auditId: a, from: today, educationSystem: 'US', gradeCode: 'G5' });
    await finishDeferred();
    await q.query(`SET LOCAL TIME ZONE 'Pacific/Honolulu'`);
    const [row] = await q.query(`SELECT as_of::text AS as_of,source,period_id,grade_code FROM student_profile_current
      WHERE student_id=$1 AND field='grade'`, [student]) as Array<{ as_of: string; source: string; period_id: string; grade_code: string }>;
    expect(row).toMatchObject({ as_of: today, source: 'period', period_id: p, grade_code: 'G5' });
    expect(await blockedBy(q, `SELECT * FROM student_profile_at(NULL) LIMIT 1`)).toMatch(/student_profile_as_of_invalid/);
  });

  it('같은 학생·field inclusive 기간의 겹침은 deferred EXCLUDE가 막고, 다른 field는 독립이다', async () => {
    const first = await audit('period_append', 'grade', 0);
    await period({ auditId: first, from: '2020-01-01', to: '2021-12-31', educationSystem: 'US', gradeCode: 'G3' });
    await finishDeferred();
    const failure = await blockedDeferred(async () => {
      const second = await audit('period_append', 'grade', 1);
      await period({ auditId: second, from: '2021-12-31', to: '2023-12-31', educationSystem: 'US', gradeCode: 'G5' });
    });
    expect(failure).toMatch(/stu_profile_period_no_overlap/);
    const schoolAudit = await audit('period_append', 'school', 1);
    const [school] = await q.query(`SELECT resolve_school($1,$2,$3,$4,$5) AS id`, [`ST1-b2-${randomUUID()}`, 'US', null, null, actor]) as Array<{ id: string }>;
    await period({ auditId: schoolAudit, field: 'school', from: '2021-12-31', to: '2023-12-31', schoolId: school.id });
    await finishDeferred();
    const [count] = await q.query(`SELECT count(*)::int AS n FROM stu_profile_period WHERE student_id=$1 AND superseded_at IS NULL`, [student]) as Array<{ n: number }>;
    expect(count.n).toBe(2);
  });

  it('학년·거주국·학교의 typed payload, precision, 활성 사전과 복수 시간대 선택을 DB에서 검사한다', async () => {
    const a = await audit('period_append', 'grade', 0);
    const base = { auditId: a, from: '2020-01-01', to: '2020-12-31', educationSystem: 'US', gradeCode: 'G3' };
    expect(await blockedBy(q, `INSERT INTO stu_profile_period(student_id,field,valid_from,valid_to,from_precision,to_precision,
      education_system,grade_code,created_audit_id) VALUES ($1,'grade','2020-02-02','2020-12-31','month','year','US','G3',$2)`, [student, a])).toMatch(/stu_profile_period_precision/);
    expect(await blockedBy(q, `INSERT INTO stu_profile_period(student_id,field,valid_from,valid_to,
      education_system,grade_code,text_value,created_audit_id) VALUES ($1,'grade','2020-01-01','2020-12-31','US','G3','duplicate',$2)`, [student, a])).toMatch(/stu_profile_period_payload/);
    await q.query(`UPDATE education_grade SET active=false WHERE education_system='US' AND code='G3'`);
    expect(await blockedBy(q, `INSERT INTO stu_profile_period(student_id,field,valid_from,valid_to,
      education_system,grade_code,created_audit_id) VALUES ($1,'grade','2020-01-01','2020-12-31','US','G3',$2)`, [student, a])).toMatch(/student_profile_grade_inactive/);
    await q.query(`UPDATE education_grade SET active=true WHERE education_system='US' AND code='G3'`);
    await period(base);
    await finishDeferred();
  });

  it('거주국 복수 시간대는 명시 선택하고 비활성 국가·시간대·학교를 참조하지 않는다', async () => {
    const countryAudit = await audit('period_append', 'residence', 0);
    const residenceSql = `INSERT INTO stu_profile_period
      (student_id,field,valid_from,residence_country_code,residence_timezone,created_audit_id)
      VALUES ($1,'residence','2020-01-01',$2,$3,$4)`;
    expect(await blockedBy(q, residenceSql, [student, 'US', null, countryAudit])).toMatch(/student_profile_timezone_required/);
    expect(await blockedBy(q, residenceSql, [student, 'US', 'Asia/Seoul', countryAudit])).toMatch(/student_profile_timezone_inactive/);
    await q.query(`UPDATE country SET active=false WHERE code='US'`);
    expect(await blockedBy(q, residenceSql, [student, 'US', 'America/New_York', countryAudit])).toMatch(/student_profile_country_inactive/);
    await q.query(`UPDATE country SET active=true WHERE code='US'`);
    await q.query(`UPDATE country_timezone SET active=false WHERE country_code='US' AND timezone='America/New_York'`);
    expect(await blockedBy(q, residenceSql, [student, 'US', 'America/New_York', countryAudit])).toMatch(/student_profile_timezone_inactive/);
    await q.query(`UPDATE country_timezone SET active=true WHERE country_code='US' AND timezone='America/New_York'`);
    const residence = await period({ auditId: countryAudit, field: 'residence', from: '2020-01-01', countryCode: 'US', timezone: 'America/New_York' });
    await finishDeferred();
    const [country] = await q.query(`SELECT residence_country_code,residence_timezone,period_id FROM student_profile_at('2022-01-01')
      WHERE student_id=$1 AND field='residence'`, [student]) as Array<Record<string, unknown>>;
    expect(country).toMatchObject({ residence_country_code: 'US', residence_timezone: 'America/New_York', period_id: residence });

    const schoolAudit = await audit('period_append', 'school', 1);
    const [school] = await q.query(`SELECT resolve_school($1,$2,$3,$4,$5) AS id`, [`ST1-b2-inactive-${randomUUID()}`, 'US', null, null, actor]) as Array<{ id: string }>;
    await q.query(`UPDATE school SET active=false WHERE id=$1`, [school.id]);
    expect(await blockedBy(q, `INSERT INTO stu_profile_period(student_id,field,valid_from,school_id,created_audit_id)
      VALUES ($1,'school','2020-01-01',$2,$3)`, [student, school.id, schoolAudit])).toMatch(/student_profile_school_inactive/);
  });

  it('client가 기록시각·작성자를 조작해도 audit 실제 시각과 인증 actor 식별자를 period에 고정한다', async () => {
    const [auditRow] = await q.query(`INSERT INTO stu_profile_audit
      (student_id,action,field,request_key,request_fingerprint,version_before,version_after,recorded_by,recorded_at,write_txid)
      VALUES ($1,'period_append','grade',$2,$3,0,1,$4,'1900-01-01',0)
      RETURNING id,recorded_at,write_txid`, [student, randomUUID(), Buffer.alloc(32, 3), actor]) as Array<{ id: string; recorded_at: Date; write_txid: string }>;
    const [periodRow] = await q.query(`INSERT INTO stu_profile_period
      (student_id,field,valid_from,education_system,grade_code,created_audit_id,recorded_by,recorded_at)
      VALUES ($1,'grade','2020-01-01','US','G3',$2,999999,'1900-01-01')
      RETURNING id,recorded_by,recorded_at`, [student, auditRow.id]) as Array<{ id: string; recorded_by: string; recorded_at: Date }>;
    await finishDeferred();
    expect(auditRow.recorded_at.getUTCFullYear()).toBeGreaterThan(2020);
    expect(auditRow.write_txid).not.toBe('0');
    expect(periodRow.recorded_by).toBe(actor);
    expect(periodRow.recorded_at).toEqual(auditRow.recorded_at);
  });

  it('정정 원본·작성자·기록시각은 불변이고 감사도 수정·삭제할 수 없다', async () => {
    const first = await audit('period_append', 'grade', 0);
    const original = await period({ auditId: first, from: '2020-01-01', to: '2023-12-31', educationSystem: 'US', gradeCode: 'G3' });
    await finishDeferred();
    const before = await q.query(`SELECT student_id,field,valid_from,valid_to,grade_code,created_audit_id,recorded_by,recorded_at
      FROM stu_profile_period WHERE id=$1`, [original]) as Array<Record<string, unknown>>;
    const correction = await audit('period_correct', 'grade', 1, { reason: '학년 정정' });
    await q.query(`UPDATE stu_profile_period SET superseded_by_audit_id=$1 WHERE id=$2`, [correction, original]);
    const replacement = await period({ auditId: correction, from: '2020-01-01', to: '2023-12-31', educationSystem: 'US', gradeCode: 'G5' });
    await finishDeferred();
    const after = await q.query(`SELECT student_id,field,valid_from,valid_to,grade_code,created_audit_id,recorded_by,recorded_at
      FROM stu_profile_period WHERE id=$1`, [original]) as Array<Record<string, unknown>>;
    expect(after).toEqual(before);
    expect(await blockedBy(q, `UPDATE stu_profile_period SET grade_code='G7' WHERE id=$1`, [original])).toMatch(/student_profile_period_immutable/);
    expect(await blockedBy(q, `UPDATE stu_profile_period SET superseded_by_audit_id=$1 WHERE id=$2`, [correction, original])).toMatch(/student_profile_period_immutable/);
    expect(await blockedBy(q, `DELETE FROM stu_profile_period WHERE id=$1`, [original])).toMatch(/student_profile_period_immutable/);
    expect(await blockedBy(q, `UPDATE stu_profile_audit SET reason='변조' WHERE id=$1`, [first])).toMatch(/student_profile_audit_immutable/);
    expect(await blockedBy(q, `DELETE FROM stu_profile_audit WHERE id=$1`, [first])).toMatch(/student_profile_audit_immutable/);
    const [resolved] = await q.query(`SELECT period_id,grade_code,profile_version,source FROM student_profile_at('2021-01-01')
      WHERE student_id=$1 AND field='grade'`, [student]) as Array<Record<string, unknown>>;
    expect(resolved).toMatchObject({ period_id: replacement, grade_code: 'G5', profile_version: '2', source: 'period' });
  });

  it('중간 분할은 원본을 보존하고 앞/변경/뒤 기간의 자동 현재값을 날짜별로 선택한다', async () => {
    const first = await audit('period_append', 'grade', 0);
    const original = await period({ auditId: first, from: '2020-01-01', to: '2023-12-31', educationSystem: 'US', gradeCode: 'G3' });
    await finishDeferred();
    const split = await audit('period_split', 'grade', 1, { reason: '2021년에만 변경' });
    await q.query(`UPDATE stu_profile_period SET superseded_by_audit_id=$1 WHERE id=$2`, [split, original]);
    await period({ auditId: split, from: '2020-01-01', to: '2020-12-31', educationSystem: 'US', gradeCode: 'G3', toDerived: true });
    await period({ auditId: split, from: '2021-01-01', to: '2021-12-31', educationSystem: 'US', gradeCode: 'G5' });
    await period({ auditId: split, from: '2022-01-01', to: '2023-12-31', educationSystem: 'US', gradeCode: 'G3', fromDerived: true });
    await finishDeferred();
    for (const [date, expected] of [['2020-06-01', 'G3'], ['2021-06-01', 'G5'], ['2022-06-01', 'G3']]) {
      const [row] = await q.query(`SELECT grade_code,source FROM student_profile_at($1) WHERE student_id=$2 AND field='grade'`, [date, student]) as Array<{ grade_code: string; source: string }>;
      expect(row).toEqual({ grade_code: expected, source: 'period' });
    }
    const [row] = await q.query(`SELECT grade_code,superseded_by_audit_id,created_audit_id FROM stu_profile_period WHERE id=$1`, [original]) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ grade_code: 'G3', superseded_by_audit_id: split, created_audit_id: first });
  });

  it('분할 앞/뒤 누락, 버전 재사용, 다른 학생 audit 재사용은 원자적으로 거절한다', async () => {
    const first = await audit('period_append', 'grade', 0);
    const original = await period({ auditId: first, from: '2020-01-01', to: '2023-12-31', educationSystem: 'US', gradeCode: 'G3' });
    await finishDeferred();
    expect(await blockedDeferred(async () => {
      const split = await audit('period_split', 'grade', 1, { reason: '뒤 범위 누락' });
      await q.query(`UPDATE stu_profile_period SET superseded_by_audit_id=$1 WHERE id=$2`, [split, original]);
      await period({ auditId: split, from: '2020-01-01', to: '2020-12-31', educationSystem: 'US', gradeCode: 'G3' });
      await period({ auditId: split, from: '2021-01-01', to: '2021-12-31', educationSystem: 'US', gradeCode: 'G5' });
    })).toMatch(/student_profile_audit_revision_tail/);
    expect(await blockedBy(q, `INSERT INTO stu_profile_audit
      (student_id,action,field,request_key,request_fingerprint,version_before,version_after,recorded_by)
      VALUES ($1,'static_patch',NULL,$2,$3,0,1,$4)`, [student, randomUUID(), Buffer.alloc(32, 1), actor])).toMatch(/student_profile_stale_version/);
    const [other] = await q.query(`INSERT INTO stu(name) VALUES ('다른 학생') RETURNING id`) as Array<{ id: string }>;
    const otherAudit = await audit('period_append', 'grade', 0, { studentId: other.id });
    expect(await blockedBy(q, `INSERT INTO stu_profile_period(student_id,field,valid_from,education_system,grade_code,created_audit_id)
      VALUES ($1,'grade','2020-01-01','US','G3',$2)`, [student, otherAudit])).toMatch(/student_profile_created_audit_invalid/);
  });

  it('분할의 대체 범위 밖 앞·뒤 값과 메모는 원본을 변경하지 않는다', async () => {
    const first = await audit('period_append', 'grade', 0);
    const original = await period({ auditId: first, from: '2020-01-01', to: '2023-12-31', educationSystem: 'US', gradeCode: 'G3' });
    await finishDeferred();
    const error = await blockedDeferred(async () => {
      const split = await audit('period_split', 'grade', 1, { reason: '가운데만 변경' });
      await q.query(`UPDATE stu_profile_period SET superseded_by_audit_id=$1 WHERE id=$2`, [split, original]);
      await period({ auditId: split, from: '2020-01-01', to: '2020-12-31', educationSystem: 'US', gradeCode: 'G7', toDerived: true });
      await period({ auditId: split, from: '2021-01-01', to: '2021-12-31', educationSystem: 'US', gradeCode: 'G3' });
      await period({ auditId: split, from: '2022-01-01', to: '2023-12-31', educationSystem: 'US', gradeCode: 'G3', fromDerived: true });
    });
    expect(error).toMatch(/student_profile_audit_split_side_changed/);
    const [row] = await q.query(`SELECT grade_code,superseded_at FROM stu_profile_period WHERE id=$1`, [original]) as Array<{ grade_code: string; superseded_at: Date | null }>;
    expect(row).toEqual({ grade_code: 'G3', superseded_at: null });
  });

  it('학생 profile_version은 감사 원장을 거치지 않고 직접 지정할 수 없다', async () => {
    expect(await blockedBy(q, `UPDATE stu SET profile_version=9 WHERE id=$1`, [student])).toMatch(/student_profile_version_audit_required/);
    expect(await blockedBy(q, `INSERT INTO stu(name,profile_version) VALUES ('허위 버전',9)`)).toMatch(/student_profile_version_audit_required/);
    const a = await audit('static_patch', null, 0);
    await finishDeferred();
    const [row] = await q.query(`SELECT profile_version FROM stu WHERE id=$1`, [student]) as Array<{ profile_version: string }>;
    expect(row.profile_version).toBe('1');
    expect(await blockedBy(q, `UPDATE stu SET profile_version=2 WHERE id=$1`, [student])).toMatch(/student_profile_version_audit_required/);
    expect(a).toMatch(/^\d+$/);
  });

  it('create 감사는 첫 version=0에서만 허용하고 이후 재생성으로 이력을 덮지 않는다', async () => {
    await audit('static_patch', null, 0);
    await finishDeferred();
    expect(await blockedBy(q, `INSERT INTO stu_profile_audit
      (student_id,action,request_key,request_fingerprint,version_before,version_after,recorded_by)
      VALUES ($1,'create',$2,$3,1,2,$4)`, [student, randomUUID(), Buffer.alloc(32, 2), actor]))
      .toMatch(/stu_profile_audit_create_initial/);
    const [row] = await q.query(`SELECT profile_version FROM stu WHERE id=$1`, [student]) as Array<{ profile_version: string }>;
    expect(row.profile_version).toBe('1');
  });

  it('down은 한 건의 감사라도 있으면 이력 삭제를 거절한다', async () => {
    await audit('static_patch', null, 0);
    await finishDeferred();
    await q.query('SAVEPOINT no_history_drop');
    try {
      await new StudentProfile1765700000000().down(q);
      throw new Error('down unexpectedly passed');
    } catch (e) {
      expect(String(e)).toMatch(/StudentProfile down would discard student history/);
    } finally {
      await q.query('ROLLBACK TO SAVEPOINT no_history_drop');
    }
    const [row] = await q.query(`SELECT to_regclass('stu_profile_audit') AS audit`) as Array<{ audit: string }>;
    expect(row.audit).toBe('stu_profile_audit');
  });

  it('기록이 하나도 없을 때만 down은 schema를 되돌릴 수 있다', async () => {
    await q.query('SAVEPOINT empty_profile_drop');
    try {
      await new StudentProfile1765700000000().down(q);
      const [row] = await q.query(`SELECT to_regclass('stu_profile_audit') AS audit`) as Array<{ audit: string | null }>;
      expect(row.audit).toBeNull();
    } finally {
      await q.query('ROLLBACK TO SAVEPOINT empty_profile_drop');
    }
    const [restored] = await q.query(`SELECT to_regclass('stu_profile_audit') AS audit`) as Array<{ audit: string | null }>;
    expect(restored.audit).toBe('stu_profile_audit');
  });
});
