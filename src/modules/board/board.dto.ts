import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { BOARD_MARK_KEYS } from './board.rules';

const S = { type: String, nullable: true } as const;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export class BoardQueryDto {
  @ApiProperty({ example: '2026-08-01' })
  @Matches(ISO)
  from!: string;

  @ApiProperty({ example: '2026-08-31' })
  @Matches(ISO)
  to!: string;

  @ApiPropertyOptional({
    minimum: 1,
    description: '매니저 이상용 강사 필터. 강사는 본인 id로 강제한다',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teacherId?: number;

  @ApiPropertyOptional({ maxLength: 20, description: 'SUB.key 과목 필터' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  subKey?: string;
}

/**
 * §34 수업 현황판 — 마크 하나.
 *
 * `done` 은 **저장된 값이 아니다.** 요청이 올 때마다 원장 표를 보고 판정한다 (D-R4 · `clChk()`).
 * 저장해 두면 원장이 바뀌었는데 마크는 그대로인 상태가 반드시 생긴다.
 */
export class CheckMarkDto {
  @ApiProperty({ enum: BOARD_MARK_KEYS }) key!: string;
  @ApiProperty({ description: '지금 이 순간의 판정' }) done!: boolean;
  @ApiProperty({ description: '해당 없음이면 판정하지 않는다 — 오프라인 수업의 줌 같은 것' })
  na!: boolean;
  @ApiPropertyOptional({ ...S, description: '왜 이렇게 판정했는지 한 줄' }) note?: string | null;
}

/** §34 현황판 한 줄 — 회차 하나 */
export class BoardRowDto {
  @ApiProperty() occId!: number;
  @ApiProperty() serId!: number;
  @ApiProperty({ description: '회차 span의 실제 날짜. 이동 예외 뒤 화면·집계에 사용한다' })
  date!: string;
  @ApiProperty({ description: 'SER_OCC/EXC 식별자인 원래 날짜' }) onDate!: string;
  @ApiProperty({ description: 'HH:MM' }) startAt!: string;
  @ApiProperty({ description: 'HH:MM' }) endAt!: string;
  @ApiPropertyOptional({ type: Number, nullable: true }) teacherId!: number | null;
  @ApiPropertyOptional(S) teacherName?: string | null;
  @ApiPropertyOptional(S) roomName?: string | null;
  @ApiProperty({ enum: ['offline', 'online'] }) mode!: string;
  @ApiProperty() kindKey!: string;
  @ApiPropertyOptional(S) kindName?: string | null;
  @ApiPropertyOptional(S) subKey?: string | null;
  @ApiPropertyOptional(S) subName?: string | null;
  @ApiProperty({ type: [String] }) studentNames!: string[];
  @ApiProperty() canceled!: boolean;
  @ApiProperty({ type: [CheckMarkDto], description: '교재 · 안내 · 줌 · 리포트' })
  marks!: CheckMarkDto[];
  @ApiProperty({ description: '판정 대상 중 덜 된 개수. 0이면 다 됐다' }) missing!: number;
}

export class BoardMarkCountDto {
  @ApiProperty({ enum: BOARD_MARK_KEYS }) key!: string;
  @ApiProperty() done!: number;
  @ApiProperty() total!: number;
  @ApiProperty() missing!: number;
}

export class BoardSummaryDto {
  @ApiProperty({ description: '취소를 제외한 수업 수' }) lessons!: number;
  @ApiProperty({ type: [BoardMarkCountDto] }) marks!: BoardMarkCountDto[];
  @ApiProperty({ description: '네 축의 미완료 마크 합계' }) missing!: number;
  @ApiProperty({ description: 'N/A를 뺀 완료 마크 비율, 정수 반올림' }) completionRate!: number;
}

export class BoardTeacherDayDto {
  @ApiProperty({ description: '회차 span의 실제 날짜. 원래 회차 키 onDate와 구분한다' })
  date!: string;
  @ApiProperty() lessons!: number;
  @ApiProperty({ type: [CheckMarkDto] }) marks!: CheckMarkDto[];
  @ApiProperty() missing!: number;
}

export class BoardTeacherRowDto {
  @ApiPropertyOptional({ type: Number, nullable: true }) teacherId!: number | null;
  @ApiProperty() teacherName!: string;
  @ApiProperty({ type: [BoardTeacherDayDto] }) days!: BoardTeacherDayDto[];
  @ApiProperty() missing!: number;
}

export class BoardWeekDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty() label!: string;
  @ApiProperty() lessons!: number;
  @ApiProperty({ type: [BoardMarkCountDto] }) marks!: BoardMarkCountDto[];
  @ApiProperty() missing!: number;
}

export class BoardDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ type: [BoardRowDto] }) rows!: BoardRowDto[];
  @ApiProperty({ description: '덜 된 수업 수 — 화면 위 배지' }) missingCount!: number;
  @ApiProperty({ type: BoardSummaryDto }) summary!: BoardSummaryDto;
  @ApiProperty({ type: [BoardTeacherRowDto] }) teacherRows!: BoardTeacherRowDto[];
  @ApiProperty({ type: [BoardWeekDto] }) weeks!: BoardWeekDto[];
  @ApiProperty({ description: '저장하지 않는다는 사실을 화면이 그대로 적을 수 있게 (D-R4)' })
  computedAt!: string;
}
