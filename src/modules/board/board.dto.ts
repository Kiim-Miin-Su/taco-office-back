import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const S = { type: String, nullable: true } as const;

/**
 * §34 수업 현황판 — 마크 하나.
 *
 * `done` 은 **저장된 값이 아니다.** 요청이 올 때마다 원장 표를 보고 판정한다 (D-R4 · `clChk()`).
 * 저장해 두면 원장이 바뀌었는데 마크는 그대로인 상태가 반드시 생긴다.
 */
export class CheckMarkDto {
  @ApiProperty({ enum: ['book', 'guide', 'zoom', 'report'] }) key!: string;
  @ApiProperty({ description: '지금 이 순간의 판정' }) done!: boolean;
  @ApiProperty({ description: '해당 없음이면 판정하지 않는다 — 오프라인 수업의 줌 같은 것' }) na!: boolean;
  @ApiPropertyOptional({ ...S, description: '왜 이렇게 판정했는지 한 줄' }) note?: string | null;
}

/** §34 현황판 한 줄 — 회차 하나 */
export class BoardRowDto {
  @ApiProperty() occId!: number;
  @ApiProperty() serId!: number;
  @ApiProperty() onDate!: string;
  @ApiProperty({ description: 'HH:MM' }) startAt!: string;
  @ApiProperty({ description: 'HH:MM' }) endAt!: string;
  @ApiPropertyOptional(S) teacherName?: string | null;
  @ApiPropertyOptional(S) roomName?: string | null;
  @ApiProperty({ enum: ['offline', 'online'] }) mode!: string;
  @ApiProperty() kindKey!: string;
  @ApiPropertyOptional(S) kindName?: string | null;
  @ApiProperty({ type: [String] }) studentNames!: string[];
  @ApiProperty() canceled!: boolean;
  @ApiProperty({ type: [CheckMarkDto], description: '교재 · 안내 · 줌 · 리포트' }) marks!: CheckMarkDto[];
  @ApiProperty({ description: '판정 대상 중 덜 된 개수. 0이면 다 됐다' }) missing!: number;
}

export class BoardDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ type: [BoardRowDto] }) rows!: BoardRowDto[];
  @ApiProperty({ description: '덜 된 수업 수 — 화면 위 배지' }) missingCount!: number;
  @ApiProperty({ description: '저장하지 않는다는 사실을 화면이 그대로 적을 수 있게 (D-R4)' }) computedAt!: string;
}
