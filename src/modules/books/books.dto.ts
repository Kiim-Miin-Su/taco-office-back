import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
}
