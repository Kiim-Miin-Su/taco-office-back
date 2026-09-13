/** @file-guide
 * 목적: books.dto.ts — BookDto, BookVersionCreateDto, BookVersionDto, BookHistoryRowDto, BooksDto (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { HIST_ACTIONS } from '../../lib/history';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;

/** §36 교재 카드 — 코드 · 쪽수 · 과목 · SE/TE */
export class BookDto {
  @ApiProperty({ description: '교재 코드 — 카드에 그대로 보인다' }) code!: string;
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiPropertyOptional(S) subKey?: string | null;
  @ApiPropertyOptional(S) subName?: string | null;
  @ApiPropertyOptional(S) level?: string | null;
  @ApiPropertyOptional(S) grade?: string | null;
  @ApiPropertyOptional(N) pages?: number | null;
  @ApiPropertyOptional({ ...S, description: 'SE 학생용 · TE 교사용' }) seTe?: string | null;

  /* ── 판(VERS) — §39 카드의 판 배지 (C52) ───────────────────────────────── */

  /** 지금 쓰는 판 — 시작일이 오늘 이하인 것 중 가장 나중 것. 판이 없으면 null */
  @ApiPropertyOptional({ ...S, description: '지금 쓰는 판 (예: v2026.03)' }) edition?: string | null;
  /** 저장소에 있는 가장 나중 판. 아직 시작 안 한 판이 있으면 edition 과 다르다 */
  @ApiPropertyOptional({ ...S, description: '가장 나중 판' }) latestEdition?: string | null;
  /**
   * 「더 최신 판이 있다」 — 원본 §39 의 ⇧ 배지와 머리 띠가 이 값 하나를 본다.
   * **화면이 두 낱말을 비교하지 않는다** — 비교가 두 곳에 살면 배지와 띠가 갈린다 (D-R39).
   */
  @ApiProperty({ description: '더 나중 판이 있는가 — 판단은 서버가 한다' }) hasNewer!: boolean;
  @ApiPropertyOptional({ ...N, description: '지금 쓰는 판의 id' }) versId?: number | null;
  /**
   * 가장 나중 판의 id — ⇧ 를 누르면 **이 판으로** 간다.
   * 화면이 「가장 나중 것」을 스스로 고르면 서버가 판정한 `hasNewer` 와 갈릴 수 있다.
   */
  @ApiPropertyOptional({ ...N, description: '가장 나중 판의 id — ⇧ 가 가는 곳' }) latestVersId?: number | null;
  /** TE 파일이 없는 교재 — 원본 §39 의 「강사에게 보낼 파일이 없습니다」 띠 */
  @ApiProperty({ description: '지금 쓰는 판에 파일이 붙어 있는가' }) hasFile!: boolean;
}

/** §39 「+ 판 올리기」 — 새 판을 저장소에 넣는다 */
export class BookVersionCreateDto {
  @ApiProperty({ description: '판 이름 — 원본 배지 모양 그대로 (예: v2026.08)', example: 'v2026.08' })
  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/, { message: '판 이름은 영문·숫자·. _ - 로 20자까지입니다' })
  edition!: string;

  @ApiPropertyOptional({ description: '파일 주소 — POST /files 가 돌려준 것. 없으면 파일 없는 판이다' })
  @IsOptional() @IsString() @MaxLength(300) fileUrl?: string;

  @ApiPropertyOptional({ description: '이 판을 언제부터 쓰는가 — 비우면 오늘부터', type: String })
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '날짜는 YYYY-MM-DD 입니다' })
  fromDate?: string;
}

export class BookVersionDto {
  @ApiProperty() id!: number;
  @ApiProperty() libId!: number;
  @ApiProperty() edition!: string;
  @ApiPropertyOptional(S) fileUrl?: string | null;
  @ApiPropertyOptional(S) fromDate?: string | null;
  @ApiProperty({ description: '지금 쓰는 판인가 — 판단은 서버가 한다' }) inUse!: boolean;
}

/** §40 교재 이력 한 줄 — **쓰는 화면이 없다.** 다른 쓰기의 부수효과로 쌓인다 */
export class BookHistoryRowDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: HIST_ACTIONS }) action!: string;
  @ApiProperty({ description: '칩과 줄에 쓰는 이름 — 낱말은 서버가 만든다 (D-R18)' }) actionLabel!: string;
  @ApiProperty({ description: '어느 표를 가리키는가' }) entity!: string;
  @ApiProperty() refId!: number;
  @ApiPropertyOptional({ ...S, description: '무엇에 대한 일인가 — 읽을 때 원본 표에서 이어 붙인다' }) subject?: string | null;
  @ApiPropertyOptional(S) byName?: string | null;
  @ApiProperty({ description: 'KST ISO' }) at!: string;
}

export class BooksDto {
  @ApiProperty({ type: [BookDto] }) items!: BookDto[];
  /** 과목 이름 → 권수. 키가 정해져 있지 않으므로 additionalProperties 로 적는다.
   *  이걸 빼면 front 타입이 Record<string, never> 로 내려간다 (생성기 게이트가 잡는다). */
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: '과목별 권수 — 필터 칩에 쓴다',
  })
  bySub!: Record<string, number>;

  /** 더 나중 판이 있는 교재 수 — 원본 §39 머리 띠의 「N종」. 화면이 다시 세지 않는다 */
  @ApiProperty({ description: '더 나중 판이 있는 교재 수' }) newerCount!: number;
  /** 지금 쓰는 판에 파일이 없는 교재 수 — 「강사에게 보낼 파일이 없습니다」 띠 */
  @ApiProperty({ description: '파일 없는 교재 수' }) noFileCount!: number;
}
