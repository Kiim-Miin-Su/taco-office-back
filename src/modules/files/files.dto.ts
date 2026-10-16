/** @file-guide
 * 목적: files.dto.ts — FILE_KINDS, FileKind, FILE_MAX_BYTES, FileUploadDto, FileRefDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDefined, IsIn, IsInt, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';

/**
 * 파일이 어디에 쓰이나 — **열람 권한이 이 낱말로 갈린다** (D6: 담당 강사와 매니저만 열람).
 * 낱말을 늘리는 것은 그 쓰임을 실제로 붙일 때다. 지금 없는 쓰임을 미리 적지 않는다.
 * BOC-04D-02 권고안: 인수인계 NOTE와 강사 작성·관리자 전용 특이사항은 파일 kind가 아니며,
 * 후속 첨부 요구가 생기기 전에는 raw FILE API로 본문이나 첨부를 만들지 않는다.
 */
export const FILE_KINDS = [
  'cons-contract',   // §30 계약서 초안·수정본
  'cons-item',       // §31 해야 할 항목의 증빙
  'lib-se',          // §39 교재 SE
  'lib-te',          // §39 교재 TE
  'expense-receipt', // §56 지출 영수증
  'guide-png',       // §43 안내문 PNG
  'report-png',      // §50 리포트 전문 PNG (기존 경로가 옮겨 올 자리)
  'meet-brief',      // §66 회의 사전 자료
  'material-request', // BOC-08D-02 일반 자료요청의 요청·전달 첨부
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/**
 * Vercel Function 4.5MB 요청 한도와 API JSON parser 4MiB 아래에서 base64 본문이 실제로 통과하는 원본 바이트 상한.
 * 표의 `file_size_cap`과 **같은 수**여야 한다. 한 판의 SE+TE도 합계가 이 값을 넘지 않는다.
 */
export const FILE_MAX_BYTES = 3_000_000;
/** 대용량 교재는 API JSON이 아닌 private Blob 직접 업로드로 보낸다. 1GB는 decimal bytes다. */
export const BOOK_PDF_MAX_BYTES = 1_000_000_000;
export const BOOK_PDF_EDITION_MAX_BYTES = BOOK_PDF_MAX_BYTES * 2;

/** PDF 파일 본문은 API로 보내지 않고, 서버가 발급한 경로에 직접 올린다. */
export class BookPdfUploadIntentDto {
  @ApiProperty({ enum: ['lib-se', 'lib-te'] }) @IsIn(['lib-se', 'lib-te']) kind!: 'lib-se' | 'lib-te';
  @ApiProperty() @IsString() @MaxLength(200) name!: string;
  @ApiProperty({ minimum: 1, maximum: BOOK_PDF_MAX_BYTES }) @IsInt() @Min(1) @Max(BOOK_PDF_MAX_BYTES) bytes!: number;
}

export class BookPdfUploadUrlDto {
  @ApiProperty() uploadId!: string;
  @ApiProperty({ description: '서버가 선택한 정확한 Blob 경로. SDK 업로드에서도 이 경로를 그대로 사용한다.' }) pathname!: string;
  @ApiProperty({ description: '구형 클라이언트 호환용 단일 PUT URL. 2시간 유효하며 대용량은 multipart를 사용한다.' }) uploadUrl!: string;
}

/** 정식 Blob SDK가 보내는 발급 요청. clientPayload는 서버가 발급한 업로드 의도 ID다. */
export class BookPdfPresignedPayloadDto {
  @ApiProperty() @IsString() @MaxLength(300) pathname!: string;
  @ApiProperty({ format: 'uuid', description: '현재 사용자의 미사용 PDF uploadId' }) @IsUUID() clientPayload!: string;
  @ApiProperty({ description: '정식 SDK의 multipart 선택' }) @IsBoolean() multipart!: boolean;
}

export class BookPdfPresignedRequestDto {
  @ApiProperty({ enum: ['blob.generate-presigned-url'] }) @IsIn(['blob.generate-presigned-url']) type!: 'blob.generate-presigned-url';
  @ApiProperty({ type: BookPdfPresignedPayloadDto }) @IsDefined() @ValidateNested() @Type(() => BookPdfPresignedPayloadDto)
  payload!: BookPdfPresignedPayloadDto;
}

export class BookPdfPresignedUrlPayloadDto {
  @ApiProperty() delegationToken!: string;
  @ApiProperty() signature!: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) params!: Record<string, string>;
}

export class BookPdfPresignedResultDto {
  @ApiProperty({ enum: ['blob.generate-presigned-url'] }) type!: 'blob.generate-presigned-url';
  @ApiProperty({ type: BookPdfPresignedUrlPayloadDto }) presignedUrlPayload!: BookPdfPresignedUrlPayloadDto;
}

export class FileDownloadTargetDto {
  @ApiProperty({ enum: ['database', 'blob'] }) storage!: 'database' | 'blob';
  @ApiPropertyOptional() url?: string;
  @ApiProperty() name!: string;
}

/**
 * 업로드 — 본문은 **base64** 로 온다.
 *
 * multipart 를 새로 들이지 않는 이유: 리포트 PNG 가 이미 data URL(base64)로 들어오고 있어
 * 경로가 하나면 방어도 한 벌이다. 원본 3MB는 base64 JSON에서 약 4MB다.
 */
export class FileUploadDto {
  @ApiProperty({ enum: FILE_KINDS, description: '어디에 쓰이는 파일인가 — 열람 권한이 여기서 갈린다' })
  @IsIn(FILE_KINDS as unknown as string[])
  kind!: FileKind;

  @ApiProperty({ description: '원래 파일 이름 — 내려받을 때 그대로 쓴다' })
  @IsString() @MaxLength(200)
  name!: string;

  @ApiProperty({ description: 'base64 본문 (data URL 접두사는 붙여도 되고 안 붙여도 된다)' })
  @IsString()
  base64!: string;

}

/** 올린 파일을 가리키는 짧은 모양 — 본문은 싣지 않는다 */
export class FileRefDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: FILE_KINDS }) kind!: string;
  @ApiProperty() name!: string;
  @ApiProperty() mime!: string;
  @ApiProperty({ description: '바이트 수 — 표가 실제 길이와 같은지 지킨다' }) bytes!: number;
  @ApiProperty({ description: '인증과 권한 확인을 거치는 파일 API 주소. 실제 다운로드 방식은 파일 저장소에 따라 다르다' }) url!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) uploaderName?: string | null;
  @ApiProperty() uploadedAt!: string;
}

export class FileIdParamDto {
  @ApiProperty()
  @IsInt() @Min(1)
  id!: number;
}
