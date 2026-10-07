/** @file-guide
 * 목적: BO-09E-01 학생 Kinder 표식 append-only 조회·쓰기 HTTP 계약.
 * 책임/재사용: marker version·미래 효력·사유 입력과 응답을 Swagger/OpenAPI SSOT로 공개한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsISO8601, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class StudentKinderMarkerCreateDto {
  @ApiProperty({ description: 'true=Kinder, false=일반. 학년·나이에서 파생하지 않는 명시 표식' })
  @IsBoolean()
  marked!: boolean;

  @ApiProperty({ description: '미래 실제 수업 시작부터 적용할 timezone 포함 ISO 시각' })
  @IsISO8601({ strict: true })
  effectiveFrom!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 500, description: '정책 변경 사유. 공백만 보낼 수 없음' })
  @IsOptional()
  @Transform(({ value }) => value === null ? undefined : value)
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiProperty({ minimum: 0, description: '현재 마지막 version. 최초 표식은 0' })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class StudentKinderMarkerDto {
  @ApiProperty() id!: number;
  @ApiProperty() studentId!: number;
  @ApiProperty() version!: number;
  @ApiProperty() marked!: boolean;
  @ApiProperty() effectiveFrom!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty() setBy!: number;
  @ApiProperty() setByName!: string;
  @ApiProperty() createdAt!: string;
}

export class StudentKinderMarkerHistoryDto {
  @ApiProperty() studentId!: number;
  @ApiProperty({ description: '현재 마지막 append version. 이력 없음은 0' }) currentVersion!: number;
  @ApiPropertyOptional({ nullable: true, type: StudentKinderMarkerDto, description: '지금 효력이 있는 마지막 표식' })
  current!: StudentKinderMarkerDto | null;
  @ApiProperty({ type: [StudentKinderMarkerDto], description: 'version 오름차순 전체 이력. 미래 예약도 포함' })
  items!: StudentKinderMarkerDto[];
}

export class StudentKinderMarkerConflictDto {
  @ApiProperty({ enum: ['KINDER_GROUP_CONFLICT', 'KINDER_MARKER_VERSION_CONFLICT', 'KINDER_MARKER_NOT_FUTURE'] }) code!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional() serId?: number;
  @ApiPropertyOptional() onDate?: string;
  @ApiPropertyOptional() date?: string;
  @ApiPropertyOptional() conflictFrom?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) conflictTo?: string | null;
  @ApiPropertyOptional({ type: [Number] }) studentIds?: number[];
  @ApiPropertyOptional() currentVersion?: number;
}
