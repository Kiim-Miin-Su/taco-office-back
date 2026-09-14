/** @file-guide
 * 목적: files.dto.ts — FILE_KINDS, FileKind, FILE_MAX_BYTES, FileUploadDto, FileRefDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, MaxLength, Min } from 'class-validator';

/**
 * 파일이 어디에 쓰이나 — **열람 권한이 이 낱말로 갈린다** (D6: 담당 강사와 매니저만 열람).
 * 낱말을 늘리는 것은 그 쓰임을 실제로 붙일 때다. 지금 없는 쓰임을 미리 적지 않는다.
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
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/**
 * Vercel Function 4.5MB 요청 한도와 API JSON parser 4MiB 아래에서 base64 본문이 실제로 통과하는 원본 바이트 상한.
 * 표의 `file_size_cap`과 **같은 수**여야 한다. 한 판의 SE+TE도 합계가 이 값을 넘지 않는다.
 */
export const FILE_MAX_BYTES = 3_000_000;

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
  @ApiProperty({ description: '내려받는 자리. `/files/{id}` 면 Neon, `https://` 면 레거시 외부 저장소다' }) url!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) uploaderName?: string | null;
  @ApiProperty() uploadedAt!: string;
}

export class FileIdParamDto {
  @ApiProperty()
  @IsInt() @Min(1)
  id!: number;
}
