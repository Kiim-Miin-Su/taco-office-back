/**
 * 스케줄 — 탭 01 의 여섯 화면(§07~§12)이 전부 이 한 모양을 쓴다.
 * 일간·주간·월간·학생별·선생님별이 다른 DTO 를 쓰면 색과 상태가 갈린다.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class OccStudentDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) grade?: string | null;
  @ApiProperty({ description: '그날만 빠진 학생인가 (D-R21)' }) droppedOnce!: boolean;
}

export class OccurrenceDto {
  @ApiProperty({ description: '반복 규칙 id' }) serId!: number;
  @ApiProperty({ example: '2026-08-28', description: '화면에 그려질 날짜' }) date!: string;

  @ApiProperty({
    example: '2026-08-28',
    description: '규칙상 원래 날짜 — **EXC 의 키**다. 쓰기(PATCH·DELETE)는 이 값으로 회차를 찾는다',
  })
  onDate!: string;
  @ApiProperty({ description: '자정부터 분' }) startMin!: number;
  @ApiProperty() endMin!: number;
  @ApiProperty() kindKey!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) subKey?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) title?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) teacherId?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) teacherName?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) roomId?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) roomName?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) zaccId?: number | null;
  @ApiProperty({ enum: ['offline', 'online'] }) mode!: string;
  @ApiProperty() canceled!: boolean;
  @ApiProperty({ description: '이 회차에 예외가 붙었는가' }) hasException!: boolean;

  @ApiProperty({
    description:
      '편집할 때 범위를 물어야 하는가 — rrule≠ONCE 이고 남은 회차≥2 (CALENDAR §5A.0). 판정은 서버 한 곳이다',
  })
  recurring!: boolean;

  @ApiProperty({
    enum: ['na', 'plan', 'none', 'draft', 'wait', 'ok', 'rej'],
    description:
      '현재 시각 기준 유효 리포트 상태. 비대상 na · 종료 전 plan · 종료 후 none이며 캘린더 블록 색이 이 값에서 나온다 (D-R7 · V26 §2.3)',
  })
  repState!: string;

  @ApiProperty({ description: '리포트를 썼는가 — 정산에 들어가는 조건 하나 (D-R7)' })
  written!: boolean;

  @ApiProperty({ type: [OccStudentDto] }) students!: OccStudentDto[];
}

export class OccurrenceListDto {
  @ApiProperty({ example: '2026-08-24' }) from!: string;
  @ApiProperty({ example: '2026-08-30' }) to!: string;
  @ApiProperty({ type: [OccurrenceDto] }) items!: OccurrenceDto[];
}

/* ══ 쓰기 ═══════════════════════════════════════════════════════════════
   저장은 **자원 + scope** 한 형태로만 받는다. 엔드포인트를 동작마다 만들면
   같은 3범위 판정이 여러 곳에 흩어진다 (D-R16 · D-R21).                     */

import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString,
  Matches, Max, Min, ValidateNested,
} from 'class-validator';
import { PASTE_MAX } from '../../lib/recurrence';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** 반복 편집 범위 — 단발이면 화면이 묻지 않고 'this' 를 보낸다 */
export const SCOPES = ['this', 'future', 'all'] as const;

export class OccurrencePatchDto {
  @ApiProperty({ enum: SCOPES, description: '이번만 · 향후 · 모두 (D-R16). 첫 회차의 future 는 all 로 강등된다 (D-R17)' })
  @IsIn(SCOPES as unknown as string[])
  scope!: 'this' | 'future' | 'all';

  @ApiProperty({ description: '규칙상 원래 날짜 — EXC 의 키다. 옮긴 회차도 이 값으로 찾는다' })
  @Matches(ISO)
  onDate!: string;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '0~1439' })
  @IsOptional() @IsInt() @Min(0) @Max(1439)
  startMin?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional() @IsInt() @Min(0) @Max(1440)
  endMin?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional() @IsInt() @Min(1)
  teacherId?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional() @IsInt() @Min(1)
  roomId?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: '다른 날로 옮길 때만' })
  @IsOptional() @Matches(ISO)
  date?: string | null;

}

export class OccurrenceCreateDto {
  @ApiProperty() @IsString() kindKey!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @IsString() subKey?: string | null;

  @ApiProperty({ enum: ['offline', 'online'] })
  @IsIn(['offline', 'online']) mode!: string;

  @ApiProperty({ description: '첫 회차 날짜' }) @Matches(ISO) fromDate!: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: '없으면 열린 반복' })
  @IsOptional() @Matches(ISO) toDate?: string | null;

  @ApiProperty({ description: "ONCE | DAILY[/n] | WEEKLY:MO,WE[/n] — formatRule() 이 정한 형식만 받는다" })
  @IsString() rrule!: string;

  @ApiProperty() @IsInt() @Min(0) @Max(1439) startMin!: number;
  @ApiProperty() @IsInt() @Min(0) @Max(1440) endMin!: number;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional() @IsInt() teacherId?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional() @IsInt() roomId?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @IsString() title?: string | null;

  @ApiPropertyOptional({ type: [Number], description: '정식 명단' })
  @IsOptional() @IsArray() studentIds?: number[];
}

/** 붙여넣기 원본은 식별자만 받는다. 원본 내용은 트랜잭션 안에서 occ()로 다시 읽는다. */
export class OccurrenceRefDto {
  @ApiProperty() @IsInt() @Min(1) serId!: number;
  @ApiProperty({ description: '화면에 보이던 날짜. 이동 EXC를 찾고 상대 날짜 간격을 보존한다' })
  @Matches(ISO) date!: string;
  @ApiProperty({ description: '규칙상 원래 날짜 — EXC 키' }) @Matches(ISO) onDate!: string;
}

/** Ctrl+드래그와 Ctrl/⌘+C/X/V가 공유하는 일괄 복제 계약 (D-R19). */
export class OccurrencePasteDto {
  @ApiProperty({ type: [OccurrenceRefDto], maxItems: PASTE_MAX })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(PASTE_MAX)
  @ValidateNested({ each: true }) @Type(() => OccurrenceRefDto)
  sources!: OccurrenceRefDto[];

  @ApiProperty({ enum: SCOPES }) @IsIn(SCOPES as unknown as string[])
  scope!: 'this' | 'future' | 'all';

  @ApiProperty() @Matches(ISO) targetDate!: string;
  @ApiProperty({ description: '붙여넣기 기준 시각 — 자정부터 분' })
  @IsInt() @Min(0) @Max(1439) targetStartMin!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '대상 강사 축이면 덮어쓴다' })
  @IsOptional() @IsInt() teacherId?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '대상 강의실 축이면 덮어쓴다' })
  @IsOptional() @IsInt() roomId?: number | null;

  @ApiPropertyOptional({ default: false, description: 'true면 붙여넣기 성공과 같은 트랜잭션에서 원본 회차를 취소한다' })
  @IsOptional() @IsBoolean() cut?: boolean;
}

/** 다중 이동 한 건 — 원본 참조와 바뀐 위치를 분리해 원본 식별자를 덮어쓰지 않는다. */
export class OccurrenceMoveItemDto {
  @ApiProperty({ type: OccurrenceRefDto })
  @ValidateNested() @Type(() => OccurrenceRefDto)
  source!: OccurrenceRefDto;

  @ApiProperty() @Matches(ISO) date!: string;
  @ApiProperty() @IsInt() @Min(0) @Max(1439) startMin!: number;
  @ApiProperty() @IsInt() @Min(1) @Max(1440) endMin!: number;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional() @IsInt() teacherId?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional() @IsInt() roomId?: number | null;
}

/** 다중 선택 드래그를 한 트랜잭션으로 저장한다 (C-7). */
export class OccurrenceMoveDto {
  @ApiProperty({ type: [OccurrenceMoveItemDto], maxItems: PASTE_MAX })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(PASTE_MAX)
  @ValidateNested({ each: true }) @Type(() => OccurrenceMoveItemDto)
  items!: OccurrenceMoveItemDto[];

  @ApiProperty({ enum: SCOPES }) @IsIn(SCOPES as unknown as string[])
  scope!: 'this' | 'future' | 'all';
}

export class OccurrenceDeleteDto {
  @ApiProperty({ enum: SCOPES }) @IsIn(SCOPES as unknown as string[])
  scope!: 'this' | 'future' | 'all';

  @ApiProperty() @Matches(ISO) onDate!: string;
}

/** §12 수강 학생 — 넣고 빼기도 3범위다 (D-R21) */
export class RosterPatchDto {
  @ApiProperty({ enum: ['add', 'dropOnce', 'undoOnce', 'dropAll'] })
  @IsIn(['add', 'dropOnce', 'undoOnce', 'dropAll'])
  op!: 'add' | 'dropOnce' | 'undoOnce' | 'dropAll';

  @ApiProperty() @Matches(ISO) onDate!: string;
  @ApiProperty() @IsInt() @Min(1) studentId!: number;
}

export class WriteResultDto {
  @ApiProperty({ description: '실제로 적용된 범위 — 「향후」가 「모두」로 강등되면 여기서 드러난다 (D-R17)' })
  effScope!: string;

  @ApiProperty({ type: [String], description: '사람이 읽는 변경 기록. 화면이 그대로 보여 준다' })
  log!: string[];

  @ApiProperty({ description: '다시 펼친 회차 수' }) projected!: number;

  @ApiProperty({ type: [Number], description: '영향받은 규칙 — 화면은 이 범위만 다시 읽으면 된다' })
  serIds!: number[];
}

/** 명단 변경 직후 서버가 같은 트랜잭션 스냅숏에서 계산한 후속 작업 (D-R22). */
export class RosterResultDto extends WriteResultDto {
  @ApiProperty({ description: '그 회차의 변경 후 실제 인원' })
  count!: number;

  @ApiProperty({ description: 'KIND.cap — 정원' })
  cap!: number;

  @ApiProperty({ type: [String], description: '아직 발송된 수업 안내가 없는 학생' })
  needGuide!: string[];

  @ApiProperty({ type: [String], description: '해당 과목의 활성 배부 교재가 없는 학생' })
  needBook!: string[];
}

export class HorizonDto {
  @ApiProperty({ description: '펼쳐 둔 기간의 시작' }) from!: string;
  @ApiProperty({ description: '펼쳐 둔 기간의 끝' }) to!: string;
  @ApiProperty({ description: '요청 범위가 이 밖으로 나갔는가 — 화면이 「비었다」와 「아직 안 펼쳤다」를 구분한다' })
  clamped!: boolean;
}
