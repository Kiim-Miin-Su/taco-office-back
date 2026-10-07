/** @file-guide
 * 목적: students.service.ts — 학생 목록·상세와 BOC-03 신규 등록/재활성화 transaction 소유자
 * 책임/재사용: 공용 표시 함수와 생성 규칙을 재사용한다. PII 원문은 응답·일반 로그에 노출하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import {
  BadRequestException, ConflictException, Injectable, InternalServerErrorException, NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager, type QueryRunner } from 'typeorm';
import { todayKst } from '../../lib/kst';
import { sealSecret, secretKeyFrom } from '../../lib/secret-box';
import { kstAt } from '../../lib/sql';
import { csCan, effectiveRepStateFromEnded, REP_STATE_LABEL_DB, type ConsShare, type ConsViewer, type RepStateDb } from '../../lib/rules';
import { studentLabel, studentTagSql } from '../../lib/student-label';
import { educationGradeDisplay, educationGradeSourceCode, projectEducationGrades, type EducationGradeProjection, type EducationGradeSourceRow } from '../../lib/education-grade-projection';
import { INV_STATE_LABEL, INV_TYPE_LABEL } from '../accounting/accounting.dto';
import { STU_GENDER_LABEL, type StuGender } from '../meta/meta.dto';
import type {
  StudentCreateDto,
  StudentCreatePreviewDto,
  StudentCreateResultDto,
  StudentRegistrationOptionsDto,
  StudentSchoolCreateDto,
  StudentSchoolOptionDto,
  StudentSchoolSearchQueryDto,
  StudentReactivationCandidateQueryDto,
  StudentReactivationCandidatesDto,
  StudentReactivationDto,
  StudentReactivationPreviewDto,
  StudentReactivationResultDto,
} from './student-registration.dto';
import {
  normalizeStudentCreateCommand,
  studentCreateFingerprint,
  studentCreateSummary,
  type NormalizedRegistrationPeriod,
  type NormalizedStudentCreateCommand,
} from './student-registration.rules';
import {
  normalizeStudentReactivationCommand,
  studentReactivationFingerprint,
  studentReactivationNoEffects,
  studentReactivationRequestIssue,
  studentReactivationStatusIssue,
  studentReactivationVersionIssue,
} from './student-reactivation.rules';
import type {
  StudentDirectoryDto, StudentDirectoryRowDto, StudentHubDto, StudentHubInvoiceDto,
  StudentHubNextActionDto, StudentHubQueryDto, StudentHubReportDto, StudentListQueryDto,
  StudentReadDto, StudentReadParamsDto,
} from './students.dto';

type Row = Record<string, unknown>;
const PAGE_SIZE = 10;
const DETAIL_LIMIT = 50;
const HUB_PAGE_SIZE = 20;
const SUMMARY = `s.id, s.name, s.grade, s.school, s.gender, ${studentTagSql('s')} AS tag,
  ${kstAt('s.created_at')} AS created_at,
  ARRAY(SELECT COALESCE(g.name,g.relation_other,CASE g.relation_code
      WHEN 'mother' THEN '어머니' WHEN 'father' THEN '아버지' WHEN 'aunt' THEN '이모/고모'
      WHEN 'driver' THEN '기사님' ELSE NULL END,g.relation,'보호자')
    FROM guardian g WHERE g.student_id = s.id AND g.active ORDER BY g.is_primary DESC, g.id) AS guardian_names`;
const ACTION_LABEL: Readonly<Record<string, string>> = {
  create: '추가', edit: '수정', update: '수정', patch: '수정', deactivate: '사용 중지',
  enroll: '등록 확정', stage: '단계 변경', fail: '등록 실패', resume: '재개', diag: '진단 추가', withdraw: '퇴원 처리',
};
function id(value: unknown): number {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) throw new InternalServerErrorException('학생 데이터 무결성 오류');
  return number;
}
const nullableText = (value: unknown): string | null => value == null ? null : String(value);
const total = (rows: Row[]): number => Number(rows[0]?.total ?? 0);

type StudentHubCursorKind = 'reports' | 'comments' | 'invoices';
type StudentHubCursor = { v: 1; k: StudentHubCursorKind; d: string; i: number };
function parseStudentHubCursor(raw: string | undefined, kind: StudentHubCursorKind): StudentHubCursor | null {
  if (!raw) return null;
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    if (Buffer.from(text).toString('base64url') !== raw) throw new Error('noncanonical');
    const value = JSON.parse(text) as Partial<StudentHubCursor>;
    const dateOk = kind === 'reports' ? /^\d{4}-\d{2}-\d{2}$/.test(value.d ?? '')
      : kind === 'invoices' ? /^\d{4}-(0[1-9]|1[0-2])$/.test(value.d ?? '')
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.d ?? '');
    if (value.v !== 1 || value.k !== kind || !dateOk || !Number.isSafeInteger(value.i) || value.i! < 1) {
      throw new Error('invalid');
    }
    return value as StudentHubCursor;
  } catch {
    throw new BadRequestException({ code: 'STUDENT_HUB_CURSOR_INVALID', message: '학생 허브 커서가 올바르지 않습니다' });
  }
}
const studentHubCursor = (kind: StudentHubCursorKind, row: Row): string => Buffer.from(JSON.stringify({
  v: 1, k: kind, d: String(row.cursor_date), i: id(row.id),
} satisfies StudentHubCursor)).toString('base64url');
function summary(row: Row, educationGrades: readonly EducationGradeProjection[]): StudentDirectoryRowDto {
  const gender = row.gender === 'female' || row.gender === 'male' ? row.gender as StuGender : null;
  const name = String(row.name), tag = nullableText(row.tag);
  const grade = nullableText(row.grade);
  return { id: id(row.id), name, tag, label: studentLabel(name, tag), grade,
    gradeDisplay: educationGradeDisplay(grade, educationGrades),
    school: nullableText(row.school), gender, genderLabel: gender ? STU_GENDER_LABEL[gender] : null,
    createdAt: nullableText(row.created_at), guardianNames: (row.guardian_names ?? []) as string[] };
}

interface ReactivationLockedStudent {
  id: string;
  profile_version: string;
  status: unknown;
}

interface ReactivationReplayRow {
  student_id: string;
  request_fingerprint: Buffer;
  profile_version_after: string;
  consultation_id: string;
  created_at: Date;
}

interface StudentCreateReplayRow {
  student_id: string;
  recorded_by: string;
  request_fingerprint: Buffer;
  after_data: { summary?: StudentCreateResultDto['summary'] } | null;
  created_at: Date;
}

interface StudentCreateLockedSibling {
  id: string;
  profile_version: string;
  status: unknown;
}

class StudentCreatePreviewRollback extends Error {
  constructor(public readonly result: StudentCreatePreviewDto) { super('student-create-preview'); }
}

function throwReactivationIssue(issue: ReturnType<typeof studentReactivationStatusIssue>): void {
  if (issue) throw new ConflictException(issue);
}

@Injectable()
export class StudentsService {
  constructor(private readonly ds: DataSource) {}

  async list(input: StudentListQueryDto): Promise<StudentDirectoryDto> {
    const page = input.page ?? 1;
    // count와 page를 한 SQL snapshot에서 읽는다. 페이지 범위를 벗어나도 total은 유지한다.
    const [result] = await this.ds.query(`WITH matched AS (
      SELECT s.* FROM stu s WHERE ($1::text = '' OR strpos(lower(concat_ws(' ',s.name,s.school,s.grade)), lower($1)) > 0)
        AND ($2::text IS NULL OR s.grade = $2)
    ), page_rows AS (
      SELECT ${SUMMARY}, s.created_at AS sort_created_at FROM matched s ORDER BY s.created_at DESC NULLS LAST, s.id DESC LIMIT $3 OFFSET $4
    ) SELECT (SELECT count(*)::int FROM matched) AS total,
      ARRAY(SELECT DISTINCT grade FROM stu WHERE grade IS NOT NULL AND btrim(grade) <> '' ORDER BY grade) AS grades,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('educationSystem', education_system, 'code', code, 'active', active)
        ORDER BY education_system, sort), '[]'::jsonb) FROM education_grade) AS education_grades,
      COALESCE((SELECT jsonb_agg(p ORDER BY p.sort_created_at DESC NULLS LAST, p.id DESC) FROM page_rows p), '[]'::jsonb) AS items`,
    [input.q?.trim() ?? '', input.grade?.trim() || null, PAGE_SIZE, (page - 1) * PAGE_SIZE]) as Row[];
    const educationGrades = projectEducationGrades((result.education_grades ?? []) as EducationGradeSourceRow[]);
    // 권고안 채택(BOC-01D-02): 불완전 카탈로그를 정상 선택지로 보이지 않는다. 기존 grade 원문은 그대로 보존한다.
    if (educationGrades.length !== 39) throw new InternalServerErrorException('교육 학년 카탈로그 무결성 오류');
    return { items: ((result.items ?? []) as Row[]).map((row) => summary(row, educationGrades)), total: Number(result.total), page, pageSize: PAGE_SIZE,
      grades: result.grades as string[], educationGrades };
  }

  async registrationOptions(): Promise<StudentRegistrationOptionsDto> {
    const [result] = await this.ds.query(`SELECT
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'code',c.code,'label',c.name_ko,'timezones',COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'timezone',z.timezone,'label',z.label_ko,'representative',z.is_representative)
          ORDER BY z.is_representative DESC,z.label_ko,z.timezone)
          FROM country_timezone z WHERE z.country_code=c.code AND z.active),'[]'::jsonb))
        ORDER BY c.sort,c.code) FROM country c WHERE c.active),'[]'::jsonb) AS countries,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'educationSystem',g.education_system,'code',g.code,'label',g.label_ko,'sort',g.sort)
        ORDER BY CASE g.education_system WHEN 'US' THEN 1 WHEN 'GB' THEN 2 WHEN 'KR' THEN 3 ELSE 4 END,g.sort,g.code)
        FROM education_grade g WHERE g.active),'[]'::jsonb) AS grades`) as Array<{
      countries: StudentRegistrationOptionsDto['countries'];
      grades: StudentRegistrationOptionsDto['educationGrades'];
    }>;
    if (!result) throw new InternalServerErrorException('교육 학년 카탈로그 무결성 오류');
    const projection = projectEducationGrades(result.grades.map(row => ({
      educationSystem: row.educationSystem, code: row.code, active: true,
    })));
    if (projection.length !== 39) throw new InternalServerErrorException('교육 학년 카탈로그 무결성 오류');
    const canonicalKeys = new Set(projection.map(row => `${row.system}:${educationGradeSourceCode(row.system, row.sort)}`));
    const educationGrades = result.grades.filter(row => canonicalKeys.has(`${row.educationSystem}:${row.code}`));
    return {
      countries: result.countries,
      educationGrades,
      guardianRelations: [
        { key: 'mother', label: '어머니' }, { key: 'father', label: '아버지' },
        { key: 'aunt', label: '이모님' }, { key: 'driver', label: '기사님' }, { key: 'other', label: '기타' },
      ],
      sources: [
        { key: 'kakao', label: '카카오' }, { key: 'phone', label: '전화' }, { key: 'blog', label: '블로그' },
        { key: 'instagram', label: '인스타그램' }, { key: 'referral', label: '소개' }, { key: 'walkin', label: '방문' },
      ],
    };
  }

  async searchSchools(input: StudentSchoolSearchQueryDto): Promise<StudentSchoolOptionDto[]> {
    const rows = await this.ds.query(`SELECT id,name,country_code AS "countryCode",
      (SELECT name_ko FROM country WHERE code=school.country_code) AS "countryLabel",
      region,campus,active FROM school
      WHERE active AND strpos(name_key,normalize_school_identity($1))>0
      ORDER BY CASE WHEN name_key=normalize_school_identity($1) THEN 0 ELSE 1 END,name,id LIMIT 20`,
    [input.q]) as Array<StudentSchoolOptionDto & { id: string | number }>;
    return rows.map(row => ({ ...row, id: id(row.id) }));
  }

  async createSchool(actorId: number, dto: StudentSchoolCreateDto): Promise<StudentSchoolOptionDto> {
    const normalized = {
      name: dto.name.trim(), countryCode: dto.countryCode,
      region: dto.region?.trim() || null, campus: dto.campus?.trim() || null,
    };
    const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    return this.ds.transaction(async manager => {
      // BOC-03D-04b 권고안 채택(2026-10-07): 학교 추가도 등록 선택지와 같은 active 국가 정본을 사용한다.
      // 정책 변경 시 P-STU15, Front SchoolSelector, DBML의 school identity와 함께 수정한다.
      if (normalized.countryCode !== null) {
        const [country] = await manager.query(`SELECT code FROM country WHERE code=$1 AND active FOR SHARE`, [normalized.countryCode]);
        if (!country) {
          throw new ConflictException({ code: 'STUDENT_REGISTRATION_OPTION_INACTIVE', message: '사용할 수 없는 학교 국가입니다' });
        }
      }
      await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`student-school:${dto.requestKey}`]);
      const [replay] = await manager.query(`SELECT l.actor_id,l.entity_id,l.after->>'fingerprint' AS fingerprint
        FROM log l WHERE l.entity='SCHOOL' AND l.action='create'
          AND l.after->>'requestKey'=$1 ORDER BY l.id DESC LIMIT 1`, [dto.requestKey]) as Array<{
        actor_id: string; entity_id: string; fingerprint: string;
      }>;
      if (replay) {
        if (Number(replay.actor_id) !== actorId || replay.fingerprint !== fingerprint) {
          throw new ConflictException({ code: 'STUDENT_SCHOOL_REQUEST_KEY_REUSED', message: '이미 사용한 학교 추가 요청 키입니다' });
        }
        return this.schoolById(manager, Number(replay.entity_id));
      }
      const [resolved] = await manager.query(`SELECT resolve_school($1,$2,$3,$4,$5) AS id`, [
        normalized.name, normalized.countryCode, normalized.region, normalized.campus, actorId,
      ]) as Array<{ id: string }>;
      const school = await this.schoolById(manager, Number(resolved.id));
      await manager.query(`INSERT INTO log(actor_id,entity,entity_id,action,before,after)
        VALUES ($1,'SCHOOL',$2,'create',NULL,$3::jsonb)`, [actorId, school.id,
        JSON.stringify({ requestKey: dto.requestKey, fingerprint, resolved: true })]);
      return school;
    });
  }

  private async schoolById(manager: EntityManager, schoolId: number): Promise<StudentSchoolOptionDto> {
    const [row] = await manager.query(`SELECT s.id,s.name,s.country_code AS "countryCode",c.name_ko AS "countryLabel",
      s.region,s.campus,s.active FROM school s LEFT JOIN country c ON c.code=s.country_code WHERE s.id=$1`, [schoolId]) as StudentSchoolOptionDto[];
    if (!row) throw new NotFoundException({ code: 'STUDENT_REGISTRATION_REFERENCE_NOT_FOUND', message: '학교를 찾을 수 없습니다' });
    return { ...row, id: id(row.id) };
  }

  previewCreate(actorId: number, dto: StudentCreateDto): Promise<StudentCreatePreviewDto> {
    return this.runCreate(actorId, dto, true) as Promise<StudentCreatePreviewDto>;
  }

  create(actorId: number, dto: StudentCreateDto): Promise<StudentCreateResultDto> {
    return this.runCreate(actorId, dto, false) as Promise<StudentCreateResultDto>;
  }

  private async runCreate(
    actorId: number, dto: StudentCreateDto, preview: boolean,
  ): Promise<StudentCreatePreviewDto | StudentCreateResultDto> {
    let command: NormalizedStudentCreateCommand;
    try {
      command = normalizeStudentCreateCommand(dto);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      const separator = error.message.indexOf(': ');
      throw new BadRequestException({
        code: separator < 0 ? 'STUDENT_REGISTRATION_INVALID' : error.message.slice(0, separator),
        message: separator < 0 ? error.message : error.message.slice(separator + 2),
      });
    }
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const result = await this.createBody(q, actorId, command, preview);
      // writer가 만든 최종 상태를 preview에서도 commit과 동일하게 검증한다. 새 지연 제약이 추가돼도 이 경계가 빠뜨리지 않는다.
      await q.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      if (preview) {
        throw new StudentCreatePreviewRollback({
          saved: false,
          requestKey: command.requestKey,
          studentId: null,
          profileVersion: null,
          summary: result.summary,
        });
      }
      await q.commitTransaction();
      return result;
    } catch (error) {
      if (q.isTransactionActive) await q.rollbackTransaction();
      if (error instanceof StudentCreatePreviewRollback) return error.result;
      throw error;
    } finally {
      await q.release();
    }
  }

  /**
   * BOC-03D-04b 권고안 채택(2026-10-07): 15절 신규 등록의 모든 write와 검증은 이 transaction에 모은다.
   * 정책 변경 시 StudentCreateDto/rules, 176630 migration, P-STU15·BOC-03, 생성 Front 계약을 함께 수정한다.
   */
  private async createBody(
    q: QueryRunner, actorId: number, command: NormalizedStudentCreateCommand, preview: boolean,
  ): Promise<StudentCreateResultDto> {
    const m = q.manager;
    const fingerprint = studentCreateFingerprint(command);
    const fingerprintBytes = Buffer.from(fingerprint, 'hex');
    const registrationSummary = studentCreateSummary(command);
    await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      [`student-create:${command.requestKey}`]);
    const replay = await this.studentCreateReplay(m, command.requestKey);
    if (replay) {
      if (preview || Number(replay.recorded_by) !== actorId || replay.request_fingerprint.toString('hex') !== fingerprint) {
        throw new ConflictException({
          code: 'STUDENT_CREATE_REQUEST_KEY_REUSED',
          message: '이미 사용한 요청 키입니다. 등록 화면을 다시 열어 주세요',
        });
      }
      return {
        saved: true,
        requestKey: command.requestKey,
        studentId: id(replay.student_id),
        profileVersion: '1',
        replayed: true,
        createdAt: new Date(replay.created_at).toISOString(),
        summary: replay.after_data?.summary ?? registrationSummary,
      };
    }

    await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      [`student-create-name:${command.name.toLocaleLowerCase('ko-KR')}`]);
    await this.assertStudentCreateReferences(m, actorId, command);
    const siblingRows = await this.lockStudentCreateSiblings(m, command.siblingIds);
    await this.assertStudentCreateDuplicate(m, command);

    let cashReceiptEncrypted: Buffer | null = null;
    let cashReceiptKeyVersion: string | null = null;
    if (command.cashReceiptNumber !== null) {
      const key = secretKeyFrom(process.env.STUDENT_PII_ENC_KEY);
      cashReceiptKeyVersion = process.env.STUDENT_PII_KEY_VERSION?.trim() || null;
      if (!key || !cashReceiptKeyVersion) {
        throw new ServiceUnavailableException({
          code: 'STUDENT_PII_KEY_MISSING',
          message: '현금영수증 번호를 저장할 암호화 키가 설정되지 않았습니다',
        });
      }
      cashReceiptEncrypted = sealSecret(command.cashReceiptNumber, key);
    }

    const [student] = await m.query(`INSERT INTO stu (
      name,english_name,gender,birth_date,has_citizenship,source,cash_receipt_encrypted,
      cash_receipt_key_version,created_by,registration_contract_version,registration_request_key
    ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,1,$10::uuid) RETURNING id,created_at`, [
      command.name, command.englishName, command.gender, command.birthDate, command.hasCitizenship,
      command.source, cashReceiptEncrypted, cashReceiptKeyVersion, actorId, command.requestKey,
    ]) as Array<{ id: string; created_at: Date }>;
    const studentId = id(student.id);

    const [audit] = await m.query(`INSERT INTO stu_profile_audit (
      student_id,action,field,request_key,request_fingerprint,version_before,version_after,
      before_data,after_data,recorded_by
    ) VALUES ($1,'create',NULL,$2::uuid,$3,0,1,NULL,$4::jsonb,$5) RETURNING id`, [
      studentId, command.requestKey, fingerprintBytes,
      JSON.stringify({
        entrySource: command.entrySource,
        cashReceiptConfigured: command.cashReceiptNumber !== null,
        summary: registrationSummary,
      }),
      actorId,
    ]) as Array<{ id: string }>;
    await this.insertStudentCreatePeriods(q, studentId, audit.id, command);

    for (const contact of command.contacts) {
      await m.query(`INSERT INTO stu_contact(student_id,kind,value,label,created_by)
        VALUES ($1,$2,$3,$4,$5)`, [studentId, contact.kind, contact.value, contact.label, actorId]);
    }
    for (const guardian of command.guardians) {
      const email = guardian.contacts.find(contact => contact.kind === 'email')?.value ?? null;
      const phone = guardian.contacts.find(contact => contact.kind === 'phone')?.value ?? null;
      /*
       * 권고안: 생성 DTO에는 수신 동의 칸이 없으므로 기존 createGuardianWithin과 같이 첫 email만 기본 수신으로 둔다.
       * phone은 저장/선택하되 SMS 동의를 추정하지 않는다. 계약을 바꾸면 DTO·Front·guardian_contact bridge를 함께 수정한다.
       */
      const [made] = await m.query(`INSERT INTO guardian (
        student_id,name,relation,email,phone,receive_email,receive_sms,is_primary,active,
        relation_code,relation_other,residence_country_code,is_payer,created_by
      ) VALUES ($1,$2,NULL,$3,$4,$5,false,$6,true,$7,$8,$9,$10,$11) RETURNING id`, [
        studentId, guardian.name, email, phone, email !== null, guardian.isPrimary,
        guardian.relation, guardian.relationOther, guardian.countryCode, guardian.isPayer, actorId,
      ]) as Array<{ id: string }>;
      for (const contact of guardian.contacts) {
        const selected = contact.kind === 'email' ? contact.value === email
          : contact.kind === 'phone' ? contact.value === phone : false;
        await m.query(`INSERT INTO guardian_contact (
          guardian_id,kind,value,label,is_delivery_selected,origin,created_by
        ) VALUES ($1,$2,$3,$4,$5,'user',$6)`, [
          made.id, contact.kind, contact.value, contact.label, selected, actorId,
        ]);
      }
    }
    for (const staffId of command.assigneeIds) {
      await m.query(`INSERT INTO stu_staff(student_id,staff_id,assigned_by) VALUES ($1,$2,$3)`,
        [studentId, staffId, actorId]);
    }
    for (const sibling of siblingRows) {
      const versionAfter = (BigInt(sibling.profile_version) + 1n).toString();
      await m.query(`INSERT INTO stu_profile_audit (
        student_id,action,field,request_key,request_fingerprint,version_before,version_after,
        before_data,after_data,recorded_by
      ) VALUES ($1,'sibling_change',NULL,$2::uuid,$3,$4,$5,NULL,$6::jsonb,$7)`, [
        sibling.id, command.requestKey, fingerprintBytes, sibling.profile_version, versionAfter,
        JSON.stringify({ linkedStudentId: studentId, active: true }), actorId,
      ]);
      await m.query(`INSERT INTO stu_sibling(student_low_id,student_high_id,linked_by)
        VALUES (LEAST($1::bigint,$2::bigint),GREATEST($1::bigint,$2::bigint),$3)`,
        [studentId, sibling.id, actorId]);
    }
    await m.query(`INSERT INTO stu_status_event (
      student_id,action,from_status,to_status,effective_on,actor_id,consultation_id,
      request_key,request_fingerprint,profile_version_before,profile_version_after
    ) VALUES ($1,'create',NULL,'active',(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date,$2,NULL,$3::uuid,$4,0,1)`,
    [studentId, actorId, command.requestKey, fingerprintBytes]);
    if (command.entrySource === 'intake' && command.leadId !== null) {
      await m.query(`UPDATE lead SET student_id=$1 WHERE id=$2`, [studentId, command.leadId]);
    }
    await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,before,after)
      VALUES ($1,'STU',$2,'create',NULL,$3::jsonb)`, [
      actorId, studentId, JSON.stringify({
        profileVersion: '1', entrySource: command.entrySource, leadId: command.leadId,
        cashReceiptConfigured: command.cashReceiptNumber !== null, summary: registrationSummary,
      }),
    ]);
    return {
      saved: true,
      requestKey: command.requestKey,
      studentId,
      profileVersion: '1',
      replayed: false,
      createdAt: new Date(student.created_at).toISOString(),
      summary: registrationSummary,
    } as StudentCreateResultDto;
  }

  private async studentCreateReplay(
    manager: EntityManager, requestKey: string,
  ): Promise<StudentCreateReplayRow | undefined> {
    const [row] = await manager.query(`SELECT a.student_id,a.recorded_by,a.request_fingerprint,a.after_data,s.created_at
      FROM stu s JOIN stu_profile_audit a ON a.student_id=s.id AND a.action='create'
      WHERE s.registration_request_key=$1::uuid`, [requestKey]) as StudentCreateReplayRow[];
    return row;
  }

  private async assertStudentCreateReferences(
    manager: EntityManager, actorId: number, command: NormalizedStudentCreateCommand,
  ): Promise<void> {
    const [actor] = await manager.query(`SELECT id FROM staff WHERE id=$1 AND active FOR SHARE`, [actorId]);
    if (!actor) throw new BadRequestException({ code: 'STUDENT_REGISTRATION_ACTOR_INACTIVE', message: '등록할 수 없는 사용자입니다' });
    if (command.entrySource === 'intake' && command.leadId !== null) {
      const [lead] = await manager.query(`SELECT student_id FROM lead WHERE id=$1 FOR UPDATE`, [command.leadId]) as Array<{ student_id: string | null }>;
      if (!lead) throw new NotFoundException({ code: 'STUDENT_REGISTRATION_REFERENCE_NOT_FOUND', message: '상담 건을 찾을 수 없습니다' });
      if (lead.student_id !== null) {
        throw new ConflictException({ code: 'STUDENT_REGISTRATION_LEAD_LINKED', message: '이미 학생에 연결된 상담 건입니다' });
      }
    }
    if (command.assigneeIds.length) {
      const rows = await manager.query(`SELECT id FROM staff WHERE id=ANY($1::bigint[]) AND active ORDER BY id FOR SHARE`,
        [command.assigneeIds]) as Array<{ id: string }>;
      if (rows.length !== command.assigneeIds.length) {
        throw new BadRequestException({ code: 'STUDENT_REGISTRATION_REFERENCE_NOT_FOUND', message: '사용 중인 담당자를 모두 찾을 수 없습니다' });
      }
    }
    if (command.schoolHistory.length) {
      const schoolIds = [...new Set(command.schoolHistory.map(row => row.schoolId))];
      const rows = await manager.query(`SELECT id FROM school WHERE id=ANY($1::bigint[]) AND active ORDER BY id FOR SHARE`,
        [schoolIds]) as Array<{ id: string }>;
      if (rows.length !== schoolIds.length) {
        throw new ConflictException({ code: 'STUDENT_REGISTRATION_OPTION_INACTIVE', message: '사용할 수 없는 학교가 포함되어 있습니다' });
      }
    }
    const gradeKeys = [...new Map(command.gradeHistory.map(row => [
      `${row.educationSystem}\u0000${row.gradeCode}`,
      { educationSystem: row.educationSystem, gradeCode: row.gradeCode },
    ])).values()];
    if (gradeKeys.length) {
      const rows = await manager.query(`SELECT g.education_system,g.code FROM education_grade g
        JOIN jsonb_to_recordset($1::jsonb) x(education_system text,grade_code text)
          ON x.education_system=g.education_system AND x.grade_code=g.code
        WHERE g.active ORDER BY g.education_system,g.code FOR SHARE OF g`, [JSON.stringify(gradeKeys.map(row => ({
          education_system: row.educationSystem, grade_code: row.gradeCode,
        })))]) as Array<{ education_system: string; code: string }>;
      if (rows.length !== gradeKeys.length) {
        throw new ConflictException({ code: 'STUDENT_REGISTRATION_OPTION_INACTIVE', message: '사용할 수 없는 학년이 포함되어 있습니다' });
      }
    }
    const residenceKeys = [...new Map(command.residenceHistory.map(row => [
      `${row.countryCode}\u0000${row.timezone ?? ''}`,
      { countryCode: row.countryCode, timezone: row.timezone },
    ])).values()];
    for (const row of residenceKeys) {
      const [country] = await manager.query(`SELECT code FROM country WHERE code=$1 AND active FOR SHARE`, [row.countryCode]);
      if (!country) {
        throw new ConflictException({ code: 'STUDENT_REGISTRATION_OPTION_INACTIVE', message: '사용할 수 없는 거주 국가가 포함되어 있습니다' });
      }
      const zones = await manager.query(`SELECT timezone FROM country_timezone
        WHERE country_code=$1 AND active ORDER BY timezone FOR SHARE`, [row.countryCode]) as Array<{ timezone: string }>;
      if (!zones.length || row.timezone === null && zones.length !== 1
        || row.timezone !== null && !zones.some(zone => zone.timezone === row.timezone)) {
        throw new ConflictException({ code: 'STUDENT_REGISTRATION_OPTION_INACTIVE', message: '거주 국가의 시간대를 다시 선택해 주세요' });
      }
    }
    const guardianCountries = [...new Set(command.guardians.map(row => row.countryCode).filter((code): code is string => code !== null))];
    if (guardianCountries.length) {
      const rows = await manager.query(`SELECT code FROM country WHERE code=ANY($1::text[]) AND active ORDER BY code FOR SHARE`,
        [guardianCountries]) as Array<{ code: string }>;
      if (rows.length !== guardianCountries.length) {
        throw new ConflictException({ code: 'STUDENT_REGISTRATION_OPTION_INACTIVE', message: '사용할 수 없는 보호자 거주 국가가 포함되어 있습니다' });
      }
    }
  }

  private async lockStudentCreateSiblings(
    manager: EntityManager, siblingIds: readonly number[],
  ): Promise<StudentCreateLockedSibling[]> {
    if (!siblingIds.length) return [];
    const rows = await manager.query(`SELECT s.id,s.profile_version,
      COALESCE((SELECT e.to_status FROM stu_status_event e WHERE e.student_id=s.id ORDER BY e.id DESC LIMIT 1),'unknown') AS status
      FROM stu s WHERE s.id=ANY($1::bigint[]) ORDER BY s.id FOR NO KEY UPDATE OF s`,
    [siblingIds]) as StudentCreateLockedSibling[];
    if (rows.length !== siblingIds.length) {
      throw new BadRequestException({ code: 'STUDENT_REGISTRATION_REFERENCE_NOT_FOUND', message: '형제·자매 학생을 모두 찾을 수 없습니다' });
    }
    if (rows.some(row => row.status === 'withdrawn')) {
      throw new ConflictException({ code: 'STUDENT_REGISTRATION_SIBLING_INACTIVE', message: '퇴원한 학생은 활성 형제·자매 관계에 연결할 수 없습니다' });
    }
    return rows;
  }

  private async assertStudentCreateDuplicate(
    manager: EntityManager, command: NormalizedStudentCreateCommand,
  ): Promise<void> {
    const currentGrade = command.gradeHistory.find(row => this.periodIncludesToday(row))!;
    const currentSchool = command.schoolHistory.find(row => this.periodIncludesToday(row));
    let schoolName: string | null = null;
    if (currentSchool) {
      const [school] = await manager.query(`SELECT name FROM school WHERE id=$1 AND active FOR SHARE`, [currentSchool.schoolId]) as Array<{ name: string }>;
      if (!school) throw new ConflictException({ code: 'STUDENT_REGISTRATION_OPTION_INACTIVE', message: '현재 학교를 사용할 수 없습니다' });
      schoolName = school.name;
    }
    const same = await manager.query(`SELECT s.id,
      COALESCE((SELECT COALESCE(p.grade_code,p.legacy_text) FROM student_profile_current p
        WHERE p.student_id=s.id AND p.field='grade'),s.grade) AS grade,
      COALESCE((SELECT COALESCE(sc.name,p.legacy_text) FROM student_profile_current p
        LEFT JOIN school sc ON sc.id=p.school_id WHERE p.student_id=s.id AND p.field='school'),s.school) AS school
      FROM stu s WHERE s.name=$1 ORDER BY s.id FOR SHARE OF s`, [command.name]) as Array<{ id: string; grade: string | null; school: string | null }>;
    if (!same.length) return;
    const twin = same.find(row => (row.grade ?? '') === currentGrade.gradeCode && (row.school ?? '') === (schoolName ?? ''));
    if (twin) {
      throw new ConflictException({
        code: 'STUDENT_DUPLICATE',
        message: `같은 이름·학년·학교의 학생(#${twin.id})이 이미 있습니다`,
      });
    }
    if (!command.allowSameName) {
      throw new ConflictException({
        code: 'STUDENT_SAME_NAME',
        message: `이름이 같은 학생이 ${same.length}명 있습니다. 다른 사람이 맞으면 동명이인을 확인하고 다시 저장해 주세요`,
      });
    }
  }

  private periodIncludesToday(period: NormalizedRegistrationPeriod): boolean {
    const today = todayKst();
    return period.from <= today && (period.to === null || period.to >= today);
  }

  private async insertStudentCreatePeriods(
    q: QueryRunner, studentId: number, auditId: string, command: NormalizedStudentCreateCommand,
  ): Promise<void> {
    const insert = async (
      field: string, period: NormalizedRegistrationPeriod, payload: {
        educationSystem?: string; gradeCode?: string; schoolId?: number;
        countryCode?: string; timezone?: string | null; textValue?: string;
      },
    ) => q.query(`INSERT INTO stu_profile_period (
      student_id,field,valid_from,valid_to,from_precision,to_precision,
      education_system,grade_code,school_id,residence_country_code,residence_timezone,text_value,memo,created_audit_id
    ) VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [
      studentId, field, period.from, period.to, period.fromPrecision, period.toPrecision,
      payload.educationSystem ?? null, payload.gradeCode ?? null, payload.schoolId ?? null,
      payload.countryCode ?? null, payload.timezone ?? null, payload.textValue ?? null, period.memo, auditId,
    ]);
    for (const row of command.schoolHistory) await insert('school', row, { schoolId: row.schoolId });
    for (const row of command.gradeHistory) await insert('grade', row, { educationSystem: row.educationSystem, gradeCode: row.gradeCode });
    for (const row of command.residenceHistory) await insert('residence', row, { countryCode: row.countryCode, timezone: row.timezone });
    for (const row of command.textHistory) await insert(row.field, row, { textValue: row.value });
    if (command.notes) {
      const today = todayKst();
      await insert('notes', { from: today, fromPrecision: 'day', to: null, toPrecision: null, memo: null }, { textValue: command.notes });
    }
  }

  async reactivationCandidates(input: StudentReactivationCandidateQueryDto): Promise<StudentReactivationCandidatesDto> {
    const page = input.page ?? 1;
    // BOC-03D-03b 권고안 채택(2026-10-07): 후보 상태는 append-only status event만 읽고 legacy 사실을 추정하지 않는다.
    const [result] = await this.ds.query(`WITH matched AS (
      SELECT s.id, s.name, NULLIF(to_jsonb(s)->>'english_name','') AS english_name,
        s.grade, s.school, s.profile_version, s.created_at,
        COALESCE(current_status.status, 'unknown') AS status,
        CASE WHEN current_status.status = 'withdrawn' THEN to_char(current_status.effective_on,'YYYY-MM-DD') ELSE NULL END AS withdrawn_on,
        (SELECT max(c.created_at) FROM stu_reactivation_consultation c WHERE c.student_id = s.id) AS last_consultation_at
      FROM stu s
      LEFT JOIN student_status_current current_status ON current_status.student_id = s.id
      WHERE ($1::text = '' OR strpos(lower(concat_ws(' ', s.name, to_jsonb(s)->>'english_name')), lower($1)) > 0)
    ), page_rows AS (
      SELECT * FROM matched ORDER BY created_at DESC NULLS LAST, id DESC LIMIT $2 OFFSET $3
    ) SELECT (SELECT count(*)::int FROM matched) AS total,
      COALESCE((SELECT jsonb_agg(p ORDER BY p.created_at DESC NULLS LAST, p.id DESC) FROM page_rows p), '[]'::jsonb) AS items`,
    [input.q?.trim() ?? '', PAGE_SIZE, (page - 1) * PAGE_SIZE]) as Row[];
    const items = ((result.items ?? []) as Row[]).map((row) => {
      const status: 'active' | 'withdrawn' | 'unknown' =
        row.status === 'active' || row.status === 'withdrawn' ? row.status : 'unknown';
      return {
        studentId: id(row.id),
        name: String(row.name),
        englishName: nullableText(row.english_name),
        gradeLabel: nullableText(row.grade),
        schoolLabel: nullableText(row.school),
        status,
        reactivatable: status === 'withdrawn',
        blockedCode: status === 'active' ? 'ACTIVE_STUDENT' as const : status === 'unknown' ? 'STATUS_UNKNOWN' as const : null,
        profileVersion: String(row.profile_version),
        lastConsultationAt: row.last_consultation_at == null ? null
          : new Date(row.last_consultation_at as string | number | Date).toISOString(),
        withdrawnOn: nullableText(row.withdrawn_on),
      };
    });
    return { items, total: Number(result.total), page, pageSize: PAGE_SIZE };
  }

  async previewReactivation(
    actorId: number, pathStudentId: number, dto: StudentReactivationDto,
  ): Promise<StudentReactivationPreviewDto> {
    this.assertReactivationIdentity(pathStudentId, dto);
    const command = normalizeStudentReactivationCommand(dto);
    return this.ds.transaction('REPEATABLE READ', async (manager) => {
      const student = await this.lockReactivationStudent(manager, command.studentId);
      await this.assertReactivationLead(manager, command.entrySource, command.leadId, command.studentId);
      throwReactivationIssue(studentReactivationStatusIssue(student.status));
      throwReactivationIssue(studentReactivationVersionIssue(command.expectedProfileVersion, student.profile_version));
      const existing = await this.reactivationReplay(manager, actorId, command.requestKey);
      if (existing) {
        throw new ConflictException({
          code: 'STUDENT_REACTIVATION_REQUEST_KEY_REUSED',
          message: '이미 저장된 요청 키입니다. 후보를 다시 조회해 주세요',
        });
      }
      return {
        saved: false,
        requestKey: command.requestKey,
        studentId: command.studentId,
        profileVersion: (BigInt(student.profile_version) + 1n).toString(),
        consultationId: null,
        effects: studentReactivationNoEffects(),
      };
    });
  }

  async reactivate(
    actorId: number, pathStudentId: number, dto: StudentReactivationDto,
  ): Promise<StudentReactivationResultDto> {
    this.assertReactivationIdentity(pathStudentId, dto);
    const command = normalizeStudentReactivationCommand(dto);
    const fingerprint = studentReactivationFingerprint(command);
    return this.ds.transaction(async (manager) => {
      // 같은 actor/requestKey는 먼저 직렬화한다. 권한은 controller guard가 replay 때도 다시 검사한다.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`student-reactivate:${actorId}:${command.requestKey}`]);
      const replay = await this.reactivationReplay(manager, actorId, command.requestKey);
      if (replay) {
        const previous = replay.request_fingerprint.toString('hex');
        const issue = studentReactivationRequestIssue(previous, fingerprint);
        if (issue) throw new ConflictException(issue);
        if (Number(replay.student_id) !== command.studentId) {
          throw new ConflictException({
            code: 'STUDENT_REACTIVATION_REQUEST_KEY_REUSED',
            message: '같은 요청 키가 다른 학생에게 사용되었습니다',
          });
        }
        return this.reactivationResult(command.requestKey, replay, true);
      }

      const student = await this.lockReactivationStudent(manager, command.studentId);
      await this.assertReactivationLead(manager, command.entrySource, command.leadId, command.studentId);
      throwReactivationIssue(studentReactivationStatusIssue(student.status));
      throwReactivationIssue(studentReactivationVersionIssue(command.expectedProfileVersion, student.profile_version));
      const versionAfter = (BigInt(student.profile_version) + 1n).toString();
      const fingerprintBytes = Buffer.from(fingerprint, 'hex');

      const [consultation] = await manager.query(`INSERT INTO stu_reactivation_consultation (
        student_id, entry_source, lead_id, reactivate_on, channel, content, next_on,
        created_by, request_key, request_fingerprint, profile_version_before, profile_version_after
      ) VALUES ($1,$2,$3,$4::date,$5,$6,$7::date,$8,$9,$10,$11,$12)
      RETURNING id, created_at`, [
        command.studentId, command.entrySource, command.leadId, command.reactivateOn,
        command.consultation.channel, command.consultation.content, command.consultation.nextOn,
        actorId, command.requestKey, fingerprintBytes, student.profile_version, versionAfter,
      ]) as Array<{ id: string; created_at: Date }>;

      await manager.query(`INSERT INTO stu_profile_audit (
        student_id, action, field, request_key, request_fingerprint, version_before, version_after,
        before_data, after_data, recorded_by
      ) VALUES ($1,'reactivate',NULL,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`, [
        command.studentId, command.requestKey, fingerprintBytes, student.profile_version, versionAfter,
        JSON.stringify({ status: 'withdrawn' }),
        JSON.stringify({ status: 'active', reactivateOn: command.reactivateOn, consultationId: Number(consultation.id) }),
        actorId,
      ]);
      await manager.query(`INSERT INTO stu_status_event (
        student_id, action, from_status, to_status, effective_on, actor_id, consultation_id,
        request_key, request_fingerprint, profile_version_before, profile_version_after
      ) VALUES ($1,'reactivate','withdrawn','active',$2::date,$3,$4,$5,$6,$7,$8)`, [
        command.studentId, command.reactivateOn, actorId, consultation.id, command.requestKey,
        fingerprintBytes, student.profile_version, versionAfter,
      ]);
      await manager.query(`INSERT INTO log (actor_id, entity, entity_id, action, before, after)
        VALUES ($1,'STU',$2,'reactivate',$3::jsonb,$4::jsonb)`, [
        actorId, command.studentId,
        JSON.stringify({ status: 'withdrawn', profileVersion: student.profile_version }),
        JSON.stringify({ status: 'active', profileVersion: versionAfter, reactivateOn: command.reactivateOn, consultationId: Number(consultation.id) }),
      ]);
      return {
        saved: true,
        requestKey: command.requestKey,
        studentId: command.studentId,
        profileVersion: versionAfter,
        consultationId: id(consultation.id),
        replayed: false,
        reactivatedAt: new Date(consultation.created_at).toISOString(),
        effects: studentReactivationNoEffects(),
      };
    });
  }

  private assertReactivationIdentity(pathStudentId: number, dto: StudentReactivationDto): void {
    if (pathStudentId !== dto.studentId) {
      throw new BadRequestException({ code: 'STUDENT_ID_MISMATCH', message: '경로와 요청 본문의 학생이 다릅니다' });
    }
  }

  private async lockReactivationStudent(manager: EntityManager, studentId: number): Promise<ReactivationLockedStudent> {
    const [student] = await manager.query(`SELECT s.id, s.profile_version,
      COALESCE((SELECT e.to_status FROM stu_status_event e WHERE e.student_id=s.id ORDER BY e.id DESC LIMIT 1), 'unknown') AS status
      FROM stu s WHERE s.id=$1 FOR NO KEY UPDATE OF s`, [studentId]) as ReactivationLockedStudent[];
    if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다' });
    return student;
  }

  private async assertReactivationLead(
    manager: EntityManager, entrySource: StudentReactivationDto['entrySource'], leadId: number | null, studentId: number,
  ): Promise<void> {
    if (entrySource !== 'intake' || leadId === null) return;
    const [lead] = await manager.query(`SELECT student_id FROM lead WHERE id=$1 FOR SHARE`, [leadId]) as Array<{ student_id: string | null }>;
    if (!lead || lead.student_id !== null && Number(lead.student_id) !== studentId) {
      throw new BadRequestException({
        code: 'STUDENT_REACTIVATION_LEAD_INVALID',
        message: '상담 진입 정보가 없거나 다른 학생에 연결되어 있습니다',
      });
    }
  }

  private async reactivationReplay(
    manager: EntityManager, actorId: number, requestKey: string,
  ): Promise<ReactivationReplayRow | undefined> {
    const [row] = await manager.query(`SELECT e.student_id, e.request_fingerprint, e.profile_version_after,
      e.consultation_id, c.created_at
      FROM stu_status_event e JOIN stu_reactivation_consultation c ON c.id=e.consultation_id
      WHERE e.actor_id=$1 AND e.request_key=$2::uuid AND e.action='reactivate'`, [actorId, requestKey]) as ReactivationReplayRow[];
    return row;
  }

  private reactivationResult(requestKey: string, replay: ReactivationReplayRow, replayed: boolean): StudentReactivationResultDto {
    return {
      saved: true,
      requestKey,
      studentId: id(replay.student_id),
      profileVersion: replay.profile_version_after,
      consultationId: id(replay.consultation_id),
      replayed,
      reactivatedAt: new Date(replay.created_at).toISOString(),
      effects: studentReactivationNoEffects(),
    };
  }

  /**
   * BOC-04D-01·02 권고안 채택(2026-10-08): 학생 허브는 이름 검색이나 Front 합계 대신
   * exact studentId와 같은 REPEATABLE READ snapshot에서 도메인 원장을 읽는다. 리포트 본문,
   * 보호자 연락처, 감사 before/after, 계좌·파일 URL은 이 projection에 넣지 않는다.
   * comments의 NOTE는 관리자→담당 강사 인수인계다. 강사 작성·관리자 전용 특이사항은 별도 계약이며
   * NOTE나 이 projection에 합치지 않는다. 변경 시 BOC-04D-02·BOC-09D-03과 두 수정사항 대조표를 함께 고친다.
   */
  async hub(
    { id: studentId }: StudentReadParamsDto,
    query: StudentHubQueryDto,
    viewerId: number,
    canSeeAmounts: boolean,
    canHideConsulting: boolean,
  ): Promise<StudentHubDto> {
    const limit = query.limit ?? HUB_PAGE_SIZE;
    const cursors = {
      reports: parseStudentHubCursor(query.reportsCursor, 'reports'),
      comments: parseStudentHubCursor(query.commentsCursor, 'comments'),
      invoices: parseStudentHubCursor(query.invoicesCursor, 'invoices'),
    };
    return this.ds.transaction('REPEATABLE READ', async manager => {
      const [facts] = await manager.query(`SELECT s.id,
        (SELECT count(*)::int FROM ser_occ o JOIN ser_stu ss ON ss.ser_id=o.ser_id
          WHERE ss.student_id=s.id AND ss.from_date<=o.on_date AND (ss.to_date IS NULL OR ss.to_date>=o.on_date)
            AND NOT o.canceled AND lower(o.span)>=now()
            AND NOT EXISTS (SELECT 1 FROM exc e JOIN exc_stu_out xo ON xo.exc_id=e.id
              WHERE e.ser_id=o.ser_id AND e.on_date=o.on_date AND xo.student_id=s.id)) AS schedule_count,
        (SELECT count(*)::int FROM inv i WHERE i.student_id=s.id AND i.state IN ('draft','sent','unpaid','partial')) AS billing_count,
        (SELECT count(*)::int FROM issue i WHERE i.student_id=s.id AND i.state='ok') AS book_count,
        (SELECT count(*)::int FROM guide g WHERE g.student_id=s.id AND g.state IN ('draft','ready','sent')) AS guide_count,
        (SELECT count(*)::int FROM lead l WHERE l.student_id=s.id) AS lead_count
        FROM stu s WHERE s.id=$1`, [studentId]) as Row[];
      if (!facts) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다' });

      const consultingRows = await manager.query(`SELECT c.id,c.share,c.owner_id,
          EXISTS (SELECT 1 FROM cons_pick p WHERE p.cons_id=c.id AND p.staff_id=$2) AS is_picked
        FROM cons_stu cs JOIN cons c ON c.id=cs.cons_id
        WHERE cs.student_id=$1 AND c.deleted_at IS NULL AND c.stage<>'done'`, [studentId, viewerId]) as Row[];
      const consultingCount = consultingRows.filter(row => csCan(String(row.share) as ConsShare, {
        isOwner: row.owner_id != null && Number(row.owner_id) === viewerId,
        isPicked: row.is_picked === true,
        canHide: canHideConsulting,
        canMoney: canSeeAmounts,
      } satisfies ConsViewer)).length;

      const reports = await this.studentHubReports(manager, studentId, limit, cursors.reports);
      const comments = await this.studentHubComments(manager, studentId, limit, cursors.comments);
      const invoices = await this.studentHubInvoices(manager, studentId, limit, cursors.invoices, canSeeAmounts);
      const action = (
        key: StudentHubNextActionDto['key'], label: string, count: number, empty: string, unit: string, href: string,
      ): StudentHubNextActionDto => ({ key, label, count, stateLabel: count > 0 ? `${count}${unit}` : empty, href });
      const nextActions: StudentHubNextActionDto[] = [
        action('schedule', '스케줄', Number(facts.schedule_count), '예정 수업 없음', '회 예정', `/schedule?studentId=${studentId}`),
        action('billing', '회계', Number(facts.billing_count), '처리할 청구 없음', '건 처리 중', `/students/${studentId}?tab=billing`),
        action('consulting', '컨설팅', consultingCount, '진행 중 컨설팅 없음', '건 진행 중', `/consulting?studentId=${studentId}`),
        action('books', '교재', Number(facts.book_count), '배부 교재 없음', '종 사용 중', `/books?tab=tracking&studentId=${studentId}`),
        action('guides', '안내', Number(facts.guide_count), '대기 안내 없음', '건 확인 필요', `/guides?tab=students&studentId=${studentId}`),
        action('lead', '상담 카드', Number(facts.lead_count), '연결 상담 없음', '건 연결', '/intake'),
      ];
      return { studentId, canSeeAmounts, nextActions, reports, comments, invoices };
    });
  }

  private async studentHubReports(
    manager: EntityManager, studentId: number, limit: number, cursor: StudentHubCursor | null,
  ): Promise<StudentHubDto['reports']> {
    const [countRow] = await manager.query(`SELECT count(*)::int AS total FROM rep_stu WHERE student_id=$1`, [studentId]) as Row[];
    const rows = await manager.query(`SELECT r.id,
        to_char(COALESCE((lower(o.span) AT TIME ZONE 'Asia/Seoul')::date,r.on_date),'YYYY-MM-DD') AS on_date,
        to_char(COALESCE((lower(o.span) AT TIME ZONE 'Asia/Seoul')::date,r.on_date),'YYYY-MM-DD') AS cursor_date,
        k.name AS kind_name,COALESCE(sb.name,s.title,k.name) AS subject_name,t.name AS teacher_name,
        r.state::text AS stored_state,k.rep AS reportable,COALESCE(upper(o.span)<=now(),false) AS ended,
        to_char(r.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at
      FROM rep_stu rs JOIN rep r ON r.id=rs.rep_id JOIN ser s ON s.id=r.ser_id
      JOIN kind k ON k.key=COALESCE(r.kind_key,s.kind_key)
      LEFT JOIN sub sb ON sb.key=s.sub_key
      LEFT JOIN ser_occ o ON o.ser_id=r.ser_id AND o.on_date=r.on_date
      LEFT JOIN staff t ON t.id=COALESCE(o.teacher_id,r.teacher_id)
      WHERE rs.student_id=$1
        AND ($2::date IS NULL OR (COALESCE((lower(o.span) AT TIME ZONE 'Asia/Seoul')::date,r.on_date),r.id)<($2::date,$3::bigint))
      ORDER BY COALESCE((lower(o.span) AT TIME ZONE 'Asia/Seoul')::date,r.on_date) DESC,r.id DESC LIMIT $4`,
    [studentId, cursor?.d ?? null, cursor?.i ?? null, limit + 1]) as Row[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const items: StudentHubReportDto[] = page.map(row => {
      const state = effectiveRepStateFromEnded(String(row.stored_state), row.reportable === true, row.ended === true);
      return {
        id: id(row.id), onDate: String(row.on_date), kindName: String(row.kind_name),
        subjectName: nullableText(row.subject_name), teacherName: nullableText(row.teacher_name),
        state, stateLabel: REP_STATE_LABEL_DB[state as RepStateDb], submittedAt: nullableText(row.submitted_at),
      };
    });
    return { items, total: Number(countRow?.total ?? 0), nextCursor: hasMore && page.length ? studentHubCursor('reports', page[page.length - 1]!) : null };
  }

  private async studentHubComments(
    manager: EntityManager, studentId: number, limit: number, cursor: StudentHubCursor | null,
  ): Promise<StudentHubDto['comments']> {
    const [countRow] = await manager.query(`SELECT count(*)::int AS total FROM note WHERE student_id=$1`, [studentId]) as Row[];
    const rows = await manager.query(`SELECT n.id,n.ser_id,n.author_id,w.name AS author_name,n.body,
        to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_date,
        to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
      FROM note n LEFT JOIN staff w ON w.id=n.author_id
      WHERE n.student_id=$1 AND ($2::timestamptz IS NULL OR (n.created_at,n.id)<($2::timestamptz,$3::bigint))
      ORDER BY n.created_at DESC,n.id DESC LIMIT $4`,
    [studentId, cursor?.d ?? null, cursor?.i ?? null, limit + 1]) as Row[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const items = page.map(row => ({
      id: id(row.id), serId: row.ser_id == null ? null : id(row.ser_id), authorId: id(row.author_id),
      authorName: nullableText(row.author_name), body: String(row.body), createdAt: String(row.created_at),
    }));
    return { items, total: Number(countRow?.total ?? 0), nextCursor: hasMore && page.length ? studentHubCursor('comments', page[page.length - 1]!) : null };
  }

  private async studentHubInvoices(
    manager: EntityManager, studentId: number, limit: number, cursor: StudentHubCursor | null, canSeeAmounts: boolean,
  ): Promise<StudentHubDto['invoices']> {
    const [countRow] = await manager.query(`SELECT count(*)::int AS total FROM inv WHERE student_id=$1`, [studentId]) as Row[];
    const rows = await manager.query(`SELECT i.id,i.year_month AS cursor_date,i.year_month,i.inv_type,i.title,i.state::text,
        to_char(i.due_on,'YYYY-MM-DD') AS due_on,i.amount,i.paid_amount
      FROM inv i WHERE i.student_id=$1 AND ($2::text IS NULL OR (i.year_month,i.id)<($2::text,$3::bigint))
      ORDER BY i.year_month DESC,i.id DESC LIMIT $4`,
    [studentId, cursor?.d ?? null, cursor?.i ?? null, limit + 1]) as Row[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const money = (value: unknown): number | null => canSeeAmounts ? Number(value) : null;
    const items: StudentHubInvoiceDto[] = page.map(row => ({
      id: id(row.id), yearMonth: String(row.year_month), invType: String(row.inv_type),
      invTypeLabel: INV_TYPE_LABEL[String(row.inv_type)] ?? String(row.inv_type), title: String(row.title),
      state: String(row.state), stateLabel: INV_STATE_LABEL[String(row.state)] ?? String(row.state),
      dueOn: nullableText(row.due_on), amount: money(row.amount), paidAmount: money(row.paid_amount),
      remainingAmount: canSeeAmounts ? Math.max(0, Number(row.amount) - Number(row.paid_amount)) : null,
    }));
    return { items, total: Number(countRow?.total ?? 0), nextCursor: hasMore && page.length ? studentHubCursor('invoices', page[page.length - 1]!) : null };
  }

  async detail({ id: studentId }: StudentReadParamsDto): Promise<StudentReadDto> {
    return this.ds.transaction('REPEATABLE READ', async (manager) => {
      const [student] = await manager.query(`SELECT ${SUMMARY}, to_char(s.started_on,'YYYY-MM-DD') AS started_on,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('educationSystem', education_system, 'code', code, 'active', active)
          ORDER BY education_system, sort), '[]'::jsonb) FROM education_grade) AS education_grades,
        s.target_exam, s.guidance, s.lang FROM stu s WHERE s.id = $1`, [studentId]) as Row[];
      if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다' });
      const educationGrades = projectEducationGrades((student.education_grades ?? []) as EducationGradeSourceRow[]);
      if (educationGrades.length !== 39) throw new InternalServerErrorException('교육 학년 카탈로그 무결성 오류');
      const guardians = await manager.query(`SELECT id,
          COALESCE(name,relation_other,CASE relation_code
            WHEN 'mother' THEN '어머니' WHEN 'father' THEN '아버지' WHEN 'aunt' THEN '이모/고모'
            WHEN 'driver' THEN '기사님' ELSE NULL END,relation,'보호자') AS name,
          relation, active, is_primary, count(*) OVER() AS total
        FROM guardian WHERE student_id = $1 ORDER BY active DESC, is_primary DESC, id DESC LIMIT $2`, [studentId, DETAIL_LIMIT]) as Row[];
      const enrollments = await manager.query(`SELECT e.id, k.name AS kind_name, sub.name AS sub_name, e.sessions,
        to_char(e.started_on,'YYYY-MM-DD') AS started_on, to_char(e.ended_on,'YYYY-MM-DD') AS ended_on, count(*) OVER() AS total
        FROM enr e JOIN kind k ON k.key = e.kind_key LEFT JOIN sub ON sub.key = e.sub_key
        WHERE e.student_id = $1 ORDER BY e.started_on DESC NULLS LAST, e.id DESC LIMIT $2`, [studentId, DETAIL_LIMIT]) as Row[];
      // LOG.before/after는 연락처·메모·금융값을 포함할 수 있다. metadata만 명시적으로 SELECT한다.
      // HIST는 book/guide 전용이므로 학생의 전체 변경 원장으로 가장하지 않는다.
      const history = await manager.query(`SELECT a.id, a.entity, a.entity_id, a.action, a.actor_id, w.name AS actor_name,
        ${kstAt('a.at')} AS at, count(*) OVER() AS total FROM log a LEFT JOIN staff w ON w.id = a.actor_id
        WHERE (a.entity = 'STU' AND a.entity_id = $1)
          OR (a.entity = 'LEAD' AND EXISTS (SELECT 1 FROM lead l WHERE l.id = a.entity_id AND l.student_id = $1))
          OR (a.entity = 'GUARDIAN' AND EXISTS (SELECT 1 FROM guardian g WHERE g.id = a.entity_id AND g.student_id = $1))
        ORDER BY a.at DESC, a.id DESC LIMIT $2`, [studentId, DETAIL_LIMIT]) as Row[];
      return { ...summary(student, educationGrades), startedOn: nullableText(student.started_on), targetExam: nullableText(student.target_exam),
        guidance: nullableText(student.guidance), lang: nullableText(student.lang),
        guardians: guardians.map(row => ({ id: id(row.id), name: String(row.name), relation: nullableText(row.relation), active: row.active === true, isPrimary: row.is_primary === true })),
        guardianTotal: total(guardians),
        enrollments: enrollments.map(row => ({ id: id(row.id), kindName: String(row.kind_name), subjectName: nullableText(row.sub_name),
          sessions: row.sessions == null ? null : Number(row.sessions), startedOn: nullableText(row.started_on), endedOn: nullableText(row.ended_on) })),
        enrollmentTotal: total(enrollments),
        history: history.map(row => ({ id: id(row.id), entity: row.entity as 'STU' | 'LEAD' | 'GUARDIAN', entityId: id(row.entity_id),
          action: String(row.action), actionLabel: ACTION_LABEL[String(row.action)] ?? '변경 기록', actorId: id(row.actor_id), actorName: nullableText(row.actor_name), at: String(row.at) })),
        historyTotal: total(history), historyLimit: DETAIL_LIMIT };
    });
  }
}
