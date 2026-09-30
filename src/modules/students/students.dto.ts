/** @file-guide
 * 목적: students.dto.ts — 학생 목록·상세의 제한된 읽기 계약(UX-C1)
 * 책임/재사용: 기존 StudentBrief/HTTP 정수 검증을 확장한다. 신규 등록/기간이력/전체 감사 계약의 완료를 주장하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ID_SCHEMA, ToHttpInteger } from '../../common/validation';
import { StudentBriefDto } from '../meta/meta.dto';

export class StudentListQueryDto {
  @ApiPropertyOptional({ maxLength: 80, description: '현재 STU 이름·학교·학년의 literal 부분 검색. 미전환 LEAD 검색은 아직 포함하지 않는다.' })
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @ApiPropertyOptional({ maxLength: 10, description: '현행 STU.grade의 정확한 값. 교육체계별 학년 카탈로그는 후속 계약이다.' })
  @IsOptional() @IsString() @MaxLength(10) grade?: string;
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 1000000, default: 1 })
  @IsOptional() @ToHttpInteger() @IsInt() @Min(1) @Max(1000000) page?: number;
}
export class StudentReadParamsDto {
  @ApiProperty(ID_SCHEMA) @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) id!: number;
}
export class StudentDirectoryRowDto extends StudentBriefDto {
  @ApiProperty({ type: String, nullable: true, description: 'STU.created_at 그대로(KST). 등록 확정/첫 수업 시각으로 추정하지 않는다.' }) createdAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) genderLabel!: string | null;
  @ApiProperty({ type: [String], description: '현재 활성 보호자 이름. 연락처/납부 정보는 포함하지 않는다.' }) guardianNames!: string[];
}
export class StudentDirectoryDto {
  @ApiProperty({ type: [StudentDirectoryRowDto] }) items!: StudentDirectoryRowDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty({ description: '한 페이지10명' }) pageSize!: number;
  @ApiProperty({ type: [String], description: '현재 학생 DB의 학년 값. 검색 결과와 별개이며 미상값을 만들지 않는다.' }) grades!: string[];
}
export class StudentGuardianSummaryDto {
  @ApiProperty(ID_SCHEMA) id!: number;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) relation!: string | null;
  @ApiProperty() active!: boolean;
  @ApiProperty() isPrimary!: boolean;
}
export class StudentEnrollmentSummaryDto {
  @ApiProperty(ID_SCHEMA) id!: number;
  @ApiProperty() kindName!: string;
  @ApiProperty({ type: String, nullable: true }) subjectName!: string | null;
  @ApiProperty({ type: Number, nullable: true }) sessions!: number | null;
  @ApiProperty({ type: String, nullable: true }) startedOn!: string | null;
  @ApiProperty({ type: String, nullable: true }) endedOn!: string | null;
}
export class StudentAuditSummaryDto {
  @ApiProperty(ID_SCHEMA) id!: number;
  @ApiProperty({ enum: ['STU', 'LEAD', 'GUARDIAN'], description: '직접 학생 또는 명시적 student_id FK로 연결된 기존 LOG만' }) entity!: 'STU' | 'LEAD' | 'GUARDIAN';
  @ApiProperty(ID_SCHEMA) entityId!: number;
  @ApiProperty() action!: string;
  @ApiProperty() actionLabel!: string;
  @ApiProperty(ID_SCHEMA) actorId!: number;
  @ApiProperty({ type: String, nullable: true, description: 'LOG.actor_id에 연결된 현재 STAFF 표시 이름. 당시 이름을 복원하지 않는다.' }) actorName!: string | null;
  @ApiProperty() at!: string;
}
export class StudentReadDto extends StudentDirectoryRowDto {
  @ApiProperty({ type: String, nullable: true, description: '기존 STU.started_on. 학생 생성 시각과 다르다.' }) startedOn!: string | null;
  @ApiProperty({ type: String, nullable: true }) targetExam!: string | null;
  @ApiProperty({ type: String, nullable: true }) guidance!: string | null;
  @ApiProperty({ type: String, nullable: true }) lang!: string | null;
  @ApiProperty({ type: [StudentGuardianSummaryDto] }) guardians!: StudentGuardianSummaryDto[];
  @ApiProperty() guardianTotal!: number;
  @ApiProperty({ type: [StudentEnrollmentSummaryDto] }) enrollments!: StudentEnrollmentSummaryDto[];
  @ApiProperty() enrollmentTotal!: number;
  @ApiProperty({ type: [StudentAuditSummaryDto], description: '직접 학생/현재 연결 상담/보호자의 기존 감사 metadata 최근50건. 전체 CRUD/변경값/학교·학년 기간 이력이 아니다.' }) history!: StudentAuditSummaryDto[];
  @ApiProperty() historyTotal!: number;
  @ApiProperty({ description: '보호자/수강/감사 각 최대50건' }) historyLimit!: number;
}
