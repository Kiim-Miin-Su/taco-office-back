/** @file-guide
 * 목적: students.service.ts — 현재 학생 데이터의 목록·상세 읽기 소유자
 * 책임/재사용: studentTagSql/studentLabel/kstAt를 재사용한다. 학생 쓰기·전체 이력 추정·금융/연락처 노출은 하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { kstAt } from '../../lib/sql';
import { studentLabel, studentTagSql } from '../../lib/student-label';
import { STU_GENDER_LABEL, type StuGender } from '../meta/meta.dto';
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
function summary(row: Row): StudentDirectoryRowDto {
  const gender = row.gender === 'female' || row.gender === 'male' ? row.gender as StuGender : null;
  const name = String(row.name), tag = nullableText(row.tag);
  return { id: id(row.id), name, tag, label: studentLabel(name, tag), grade: nullableText(row.grade),
    school: nullableText(row.school), gender, genderLabel: gender ? STU_GENDER_LABEL[gender] : null,
    createdAt: nullableText(row.created_at), guardianNames: (row.guardian_names ?? []) as string[] };
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
      COALESCE((SELECT jsonb_agg(p ORDER BY p.sort_created_at DESC NULLS LAST, p.id DESC) FROM page_rows p), '[]'::jsonb) AS items`,
    [input.q?.trim() ?? '', input.grade?.trim() || null, PAGE_SIZE, (page - 1) * PAGE_SIZE]) as Row[];
    return { items: ((result.items ?? []) as Row[]).map(summary), total: Number(result.total), page, pageSize: PAGE_SIZE,
      grades: result.grades as string[] };
  }

  async detail({ id: studentId }: StudentReadParamsDto): Promise<StudentReadDto> {
    return this.ds.transaction('REPEATABLE READ', async (manager) => {
      const [student] = await manager.query(`SELECT ${SUMMARY}, to_char(s.started_on,'YYYY-MM-DD') AS started_on,
        s.target_exam, s.guidance, s.lang FROM stu s WHERE s.id = $1`, [studentId]) as Row[];
      if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다' });
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
      return { ...summary(student), startedOn: nullableText(student.started_on), targetExam: nullableText(student.target_exam),
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
