/** @file-guide
 * 목적: BOC-09D-03 강사 작성·관리자 전용 특이사항의 생성 계약을 정의한다. (contract)
 * 책임/재사용: 강사 write/receipt와 관리자 학생별 body projection을 분리하고 기존 NOTE DTO를 재사용하지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-09-SCENARIOS-2026-10-07.md · docs/contracts/CONTRACTS.md
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export class TeacherPrivateNoteWriteDto {
  @ApiProperty() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) studentId!: number;
  @ApiProperty() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) serId!: number;
  @ApiProperty({ description: '반복규칙의 원래 회차일 YYYY-MM-DD' })
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) onDate!: string;
  @ApiProperty({ minLength: 1, maxLength: 2000 }) @IsString() @MaxLength(2000) body!: string;
  @ApiProperty({ description: '0=create, 1 이상=현재 읽은 version' }) @IsInt() @Min(0) expectedVersion!: number;
  @ApiProperty({ format: 'uuid' }) @IsUUID() requestKey!: string;
}

/** 강사에게는 본문을 되돌려 주지 않고 전달 영수증 metadata만 제공한다. */
export class TeacherPrivateNoteReceiptDto {
  @ApiProperty() id!: number;
  @ApiProperty() studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiProperty() serId!: number;
  @ApiProperty() onDate!: string;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class TeacherPrivateNoteReceiptListDto {
  @ApiProperty({ type: [TeacherPrivateNoteReceiptDto] }) items!: TeacherPrivateNoteReceiptDto[];
}

/** 관리자 전용 학생별 모음. 다른 강사·학부모·검색·파일·알림 DTO에는 이 본문을 추가하지 않는다. */
export class AdminStudentPrivateNoteDto extends TeacherPrivateNoteReceiptDto {
  @ApiProperty() authorId!: number;
  @ApiProperty() authorName!: string;
  @ApiProperty() body!: string;
}

export class AdminStudentPrivateNoteListDto {
  @ApiProperty() studentId!: number;
  @ApiProperty({ type: [AdminStudentPrivateNoteDto] }) items!: AdminStudentPrivateNoteDto[];
}
