/** @file-guide
 * 목적: students.service.ts — 현재 학생 데이터의 목록·상세 읽기 소유자
 * 책임/재사용: studentTagSql/studentLabel/kstAt를 재사용한다. 학생 쓰기·전체 이력 추정·금융/연락처 노출은 하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { kstAt } from '../../lib/sql';
import { studentLabel, studentTagSql } from '../../lib/student-label';
import { educationGradeDisplay, projectEducationGrades, type EducationGradeProjection, type EducationGradeSourceRow } from '../../lib/education-grade-projection';
import { STU_GENDER_LABEL, type StuGender } from '../meta/meta.dto';
import type {
  StudentReactivationCandidateQueryDto,
  StudentReactivationCandidatesDto,
  StudentReactivationDto,
  StudentReactivationPreviewDto,
  StudentReactivationResultDto,
} from './student-registration.dto';
import {
  normalizeStudentReactivationCommand,
  studentReactivationFingerprint,
  studentReactivationNoEffects,
  studentReactivationRequestIssue,
  studentReactivationStatusIssue,
  studentReactivationVersionIssue,
} from './student-reactivation.rules';
import type { StudentDirectoryDto, StudentDirectoryRowDto, StudentListQueryDto, StudentReadDto, StudentReadParamsDto } from './students.dto';

type Row = Record<string, unknown>;
const PAGE_SIZE = 10;
const DETAIL_LIMIT = 50;
const SUMMARY = `s.id, s.name, s.grade, s.school, s.gender, ${studentTagSql('s')} AS tag,
  ${kstAt('s.created_at')} AS created_at,
  ARRAY(SELECT g.name FROM guardian g WHERE g.student_id = s.id AND g.active ORDER BY g.is_primary DESC, g.id) AS guardian_names`;
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

  async detail({ id: studentId }: StudentReadParamsDto): Promise<StudentReadDto> {
    return this.ds.transaction('REPEATABLE READ', async (manager) => {
      const [student] = await manager.query(`SELECT ${SUMMARY}, to_char(s.started_on,'YYYY-MM-DD') AS started_on,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('educationSystem', education_system, 'code', code, 'active', active)
          ORDER BY education_system, sort), '[]'::jsonb) FROM education_grade) AS education_grades,
        s.target_exam, s.guidance, s.lang FROM stu s WHERE s.id = $1`, [studentId]) as Row[];
      if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다' });
      const educationGrades = projectEducationGrades((student.education_grades ?? []) as EducationGradeSourceRow[]);
      if (educationGrades.length !== 39) throw new InternalServerErrorException('교육 학년 카탈로그 무결성 오류');
      const guardians = await manager.query(`SELECT id, name, relation, active, is_primary, count(*) OVER() AS total
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
