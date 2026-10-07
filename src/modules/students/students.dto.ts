/** @file-guide
 * 목적: students.dto.ts — 학생 목록·상세의 제한된 읽기 계약(UX-C1)
 * 책임/재사용: 기존 StudentBrief/HTTP 정수 검증을 확장한다. 신규 등록/기간이력/전체 감사 계약의 완료를 주장하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { ID_SCHEMA, ToHttpInteger } from '../../common/validation';
import { EducationGradeOptionDto, StudentBriefDto } from '../meta/meta.dto';

export class StudentListQueryDto {
  @ApiPropertyOptional({ maxLength: 80, description: '현재 STU 이름·학교·학년의 literal 부분 검색. 미전환 LEAD 검색은 아직 포함하지 않는다.' })
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @ApiPropertyOptional({ maxLength: 10, description: 'STU.grade의 정확한 원문값. 선택지는 응답 educationGrades를 사용한다.' })
  @IsOptional() @IsString() @MaxLength(10) grade?: string;
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 1000000, default: 1 })
  @IsOptional() @ToHttpInteger() @IsInt() @Min(1) @Max(1000000) page?: number;
}
export class StudentReadParamsDto {
  @ApiProperty(ID_SCHEMA) @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) id!: number;
}
export class StudentDirectoryRowDto extends StudentBriefDto {
  @ApiProperty({ type: String, nullable: true, description: '정확히 대응되는 active 값이면 서버 listLabel, 아니면 legacy 원문. 자동 변환하지 않는다.' })
  gradeDisplay!: string | null;
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
  @ApiProperty({ type: [EducationGradeOptionDto], description: 'BOC-01D-02 활성 39개 학년 projection. 필터·등록·목록이 함께 쓴다.' })
  educationGrades!: EducationGradeOptionDto[];
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

/**
 * BOC-04D-01 권고안 채택(2026-10-08): 학생 10탭의 서버 집계는 학생 상세와 분리한
 * 읽기 계약으로 제공한다. 세 목록의 커서는 서로 바꿔 쓸 수 없는 불투명 keyset cursor다.
 * 정책 변경 시 StudentDetail, OpenAPI/generated schema, P-STUDENT-HUB, BOC-04 문서와
 * portfolio를 같은 청크에서 수정한다.
 */
export class StudentHubQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 50, default: 20, description: '리포트·코멘트·청구 각각의 페이지 크기' })
  @IsOptional() @ToHttpInteger() @IsInt() @Min(1) @Max(50) limit?: number;

  @ApiPropertyOptional({ type: String, maxLength: 256, description: '리포트 다음 페이지 불투명 커서' })
  @IsOptional() @IsString() @MaxLength(256) @Matches(/^[A-Za-z0-9_-]+$/) reportsCursor?: string;

  @ApiPropertyOptional({ type: String, maxLength: 256, description: '코멘트 다음 페이지 불투명 커서' })
  @IsOptional() @IsString() @MaxLength(256) @Matches(/^[A-Za-z0-9_-]+$/) commentsCursor?: string;

  @ApiPropertyOptional({ type: String, maxLength: 256, description: '청구 다음 페이지 불투명 커서' })
  @IsOptional() @IsString() @MaxLength(256) @Matches(/^[A-Za-z0-9_-]+$/) invoicesCursor?: string;
}

export class StudentHubNextActionDto {
  @ApiProperty({ enum: ['schedule', 'billing', 'consulting', 'books', 'guides', 'lead'] })
  key!: 'schedule' | 'billing' | 'consulting' | 'books' | 'guides' | 'lead';
  @ApiProperty() label!: string;
  @ApiProperty({ description: '서버가 exact studentId로 센 현재 건수' }) count!: number;
  @ApiProperty({ description: '0건도 숨기지 않는 서버 상태 문장' }) stateLabel!: string;
  @ApiProperty({ description: '기존 도메인 화면의 학생 문맥 deep link' }) href!: string;
}

export class StudentHubReportDto {
  @ApiProperty(ID_SCHEMA) id!: number;
  @ApiProperty() onDate!: string;
  @ApiProperty() kindName!: string;
  @ApiProperty({ type: String, nullable: true }) subjectName!: string | null;
  @ApiProperty({ type: String, nullable: true }) teacherName!: string | null;
  @ApiProperty({ enum: ['na', 'plan', 'none', 'draft', 'wait', 'ok', 'rej'] }) state!: string;
  @ApiProperty({ description: '서버 공용 리포트 상태 낱말' }) stateLabel!: string;
  @ApiProperty({ type: String, nullable: true }) submittedAt!: string | null;
}

export class StudentHubCommentDto {
  @ApiProperty(ID_SCHEMA) id!: number;
  @ApiProperty({ type: Number, nullable: true }) serId!: number | null;
  @ApiProperty(ID_SCHEMA) authorId!: number;
  @ApiProperty({ type: String, nullable: true }) authorName!: string | null;
  @ApiProperty() body!: string;
  @ApiProperty() createdAt!: string;
}

export class StudentHubInvoiceDto {
  @ApiProperty(ID_SCHEMA) id!: number;
  @ApiProperty() yearMonth!: string;
  @ApiProperty() invType!: string;
  @ApiProperty({ description: '서버 공용 청구 종류 낱말' }) invTypeLabel!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: ['draft', 'sent', 'unpaid', 'partial', 'paid', 'void'] }) state!: string;
  @ApiProperty({ description: '서버 공용 청구 상태 낱말' }) stateLabel!: string;
  @ApiProperty({ type: String, nullable: true }) dueOn!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'canMoney를 통과할 때만 값' }) amount!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'canMoney를 통과할 때만 값' }) paidAmount!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '서버 계산 amount-paidAmount. canMoney를 통과할 때만 값' }) remainingAmount!: number | null;
}

export class StudentHubReportPageDto {
  @ApiProperty({ type: [StudentHubReportDto] }) items!: StudentHubReportDto[];
  @ApiProperty() total!: number;
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class StudentHubCommentPageDto {
  @ApiProperty({ type: [StudentHubCommentDto] }) items!: StudentHubCommentDto[];
  @ApiProperty() total!: number;
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class StudentHubInvoicePageDto {
  @ApiProperty({ type: [StudentHubInvoiceDto] }) items!: StudentHubInvoiceDto[];
  @ApiProperty() total!: number;
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class StudentHubDto {
  @ApiProperty(ID_SCHEMA) studentId!: number;
  @ApiProperty({ description: '청구 금액 projection 권한' }) canSeeAmounts!: boolean;
  @ApiProperty({ type: [StudentHubNextActionDto] }) nextActions!: StudentHubNextActionDto[];
  @ApiProperty({ type: StudentHubReportPageDto }) reports!: StudentHubReportPageDto;
  @ApiProperty({ type: StudentHubCommentPageDto }) comments!: StudentHubCommentPageDto;
  @ApiProperty({ type: StudentHubInvoicePageDto }) invoices!: StudentHubInvoicePageDto;
}
