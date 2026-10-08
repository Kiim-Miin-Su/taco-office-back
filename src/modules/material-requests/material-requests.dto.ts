/** @file-guide
 * 목적: 일반 강사 자료요청의 생성·목록·상태 전이·파일·이력 HTTP 계약을 정의한다.
 * 책임/재사용: Swagger/class-validator 정본이며 DB entity나 화면 임시 상태를 노출하지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-08D2-MATERIAL-REQUEST-PERSISTENCE-2026-10-09.md · docs/contracts/CONTRACTS.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID,
  MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { DATE_SCHEMA, IsCalendarDate } from '../../common/validation';
import { FileRefDto, FileUploadDto } from '../files/files.dto';

export const MATERIAL_REQUEST_KINDS = ['book_pdf', 'worksheet', 'test_paper', 'other'] as const;
export const MATERIAL_REQUEST_STATES = ['received', 'preparing', 'delivered', 'rejected'] as const;
export const MATERIAL_REQUEST_ACTIONS = ['created', 'preparing', 'delivered', 'rejected', 'acknowledged'] as const;
export const MATERIAL_REQUEST_TRANSITIONS = ['preparing', 'delivered', 'rejected'] as const;
export const MATERIAL_REQUEST_KIND_LABEL: Record<(typeof MATERIAL_REQUEST_KINDS)[number], string> = {
  book_pdf: '교재 PDF', worksheet: '워크시트', test_paper: '시험지', other: '기타',
};

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;

export class MaterialRequestStudentDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional(S) grade?: string | null;
  @ApiProperty() label!: string;
}

export class MaterialRequestOptionsDto {
  @ApiProperty({ type: [MaterialRequestStudentDto], description: '서버 KST 오늘 이후 담당이 남아 있는 전체 학생' })
  students!: MaterialRequestStudentDto[];
}

export class MaterialRequestCreateDto {
  @ApiProperty({ enum: MATERIAL_REQUEST_KINDS })
  @IsIn(MATERIAL_REQUEST_KINDS) kind!: (typeof MATERIAL_REQUEST_KINDS)[number];

  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) studentId!: number;
  @ApiProperty(DATE_SCHEMA) @IsCalendarDate() neededOn!: string;
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(2000) body!: string;
  @ApiProperty({ format: 'uuid', description: '더블클릭·네트워크 재시도를 같은 요청으로 수렴시키는 키' })
  @IsUUID('4') requestKey!: string;
  @ApiPropertyOptional({ type: [FileUploadDto], maxItems: 3, description: '요청을 설명하는 선택 첨부. kind=material-request' })
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => FileUploadDto)
  files?: FileUploadDto[];
}

export class MaterialRequestTransitionDto {
  @ApiProperty({ enum: MATERIAL_REQUEST_TRANSITIONS })
  @IsIn(MATERIAL_REQUEST_TRANSITIONS) action!: (typeof MATERIAL_REQUEST_TRANSITIONS)[number];
  @ApiProperty({ minimum: 1, description: '화면이 읽은 현재 version' })
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') requestKey!: string;
  @ApiPropertyOptional({ maxLength: 500, description: '반려일 때 필수인 사유' })
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MaxLength(500) reason?: string;
  @ApiPropertyOptional({ type: [FileUploadDto], maxItems: 3, description: '전달 완료일 때 1개 이상 필수. kind=material-request' })
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => FileUploadDto)
  files?: FileUploadDto[];
}

export class MaterialRequestAcknowledgeDto {
  @ApiProperty({ minimum: 1 }) @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') requestKey!: string;
}

export class MaterialRequestQueryDto {
  @ApiPropertyOptional({ enum: MATERIAL_REQUEST_STATES })
  @IsOptional() @IsIn(MATERIAL_REQUEST_STATES) state?: (typeof MATERIAL_REQUEST_STATES)[number];
}

export class MaterialRequestFileDto extends FileRefDto {
  @ApiProperty({ enum: ['request', 'delivery'] }) purpose!: 'request' | 'delivery';
  @ApiPropertyOptional(S) addedByName?: string | null;
}

export class MaterialRequestEventDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: MATERIAL_REQUEST_ACTIONS }) action!: string;
  @ApiProperty() actionLabel!: string;
  @ApiPropertyOptional(S) fromState?: string | null;
  @ApiProperty({ enum: MATERIAL_REQUEST_STATES }) toState!: string;
  @ApiPropertyOptional(S) reason?: string | null;
  @ApiProperty() actorId!: number;
  @ApiProperty() actorName!: string;
  @ApiProperty() resultVersion!: number;
  @ApiProperty() at!: string;
}

export class MaterialRequestItemDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: MATERIAL_REQUEST_KINDS }) kind!: string;
  @ApiProperty() kindLabel!: string;
  @ApiProperty() studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiProperty() teacherId!: number;
  @ApiProperty() teacherName!: string;
  @ApiProperty(DATE_SCHEMA) neededOn!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ enum: MATERIAL_REQUEST_STATES }) state!: string;
  @ApiProperty() stateLabel!: string;
  @ApiProperty() version!: number;
  @ApiPropertyOptional(N) assignedTo?: number | null;
  @ApiPropertyOptional(S) assignedToName?: string | null;
  @ApiPropertyOptional(N) deliveredBy?: number | null;
  @ApiPropertyOptional(S) deliveredByName?: string | null;
  @ApiPropertyOptional(S) rejectReason?: string | null;
  @ApiPropertyOptional(S) deliveredAt?: string | null;
  @ApiPropertyOptional(S) rejectedAt?: string | null;
  @ApiPropertyOptional(S) acknowledgedAt?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiProperty({ description: '기한이 지났고 아직 전달·반려되지 않았는가' }) overdue!: boolean;
  @ApiProperty({ type: [MaterialRequestFileDto] }) files!: MaterialRequestFileDto[];
  @ApiProperty({ type: [MaterialRequestEventDto] }) events!: MaterialRequestEventDto[];
}

export class MaterialRequestCountsDto {
  @ApiProperty() received!: number;
  @ApiProperty() preparing!: number;
  @ApiProperty() delivered!: number;
  @ApiProperty() rejected!: number;
}

export class MaterialRequestsDto {
  @ApiProperty({ type: [MaterialRequestItemDto] }) items!: MaterialRequestItemDto[];
  @ApiProperty({ type: MaterialRequestCountsDto }) counts!: MaterialRequestCountsDto;
}

export class MaterialRequestWriteResultDto {
  @ApiProperty({ type: MaterialRequestItemDto }) item!: MaterialRequestItemDto;
  @ApiProperty({ description: '같은 actor·requestKey·payload의 재시도인가' }) replayed!: boolean;
}
