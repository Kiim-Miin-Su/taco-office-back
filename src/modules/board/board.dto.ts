/** @file-guide
 * 목적: board.dto.ts — BoardQueryDto, CheckMarkDto, BoardRowDto, BoardSummaryDto, BoardDayDto, BoardFacetsDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

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
  @ApiPropertyOptional({
    ...S,
    description: '온라인 회차에 붙은 줌 계정 이름 — 장소 배지 「온라인 {이름}」(§34). 없으면 null',
  })
  zaccLabel?: string | null;
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

  /*
   * 원본 §34~§36 의 머리 여섯 칸 — 「3/20 다 됐음 · 16 교재 안 됨 · 3 안내 안 됨 ·
   * 2 줌 없음 · 0 리포트 안 씀 · 0 휴강」. 가운데 넷은 `marks[].missing` 이 이미 그 값이고,
   * 양 끝 둘만 여기서 센다 — **화면이 rows 를 다시 훑지 않는다** (D-R37 · N-19).
   */
  @ApiProperty({ description: '네 축이 **다 된** 수업 수 — 「3/20」의 3. 취소는 빼고 센다' })
  doneLessons!: number;

  @ApiProperty({ description: '휴강·취소한 수업 수 — 「0 휴강」. lessons 에는 안 들어 있다' })
  canceled!: number;
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

/** §35 요일 머리 「월 17 · 6 남음」 · §36 달력 칸 — 날짜 하나 (화면이 rows 를 다시 세지 않는다 · D-R37) */
export class BoardDayDto {
  @ApiProperty({ description: '회차 span의 실제 날짜' }) date!: string;
  @ApiProperty({ description: '휴강을 뺀 수업 수' }) lessons!: number;
  @ApiProperty({ description: '네 축 중 하나라도 덜 된 수업 수 — 「N 남음」' }) remaining!: number;
  @ApiProperty({ description: '그날 휴강한 수업 수' }) canceled!: number;
  @ApiProperty({ type: [String], description: '그날 수업의 과목 키 — 시각 순 처음 나온 순서, 겹치지 않게(달력 칸 색 점)' })
  subKeys!: string[];
}

/** 필터 칩 하나 — 과목 */
export class BoardFacetSubjectDto {
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: '그 기간의 (휴강 아닌) 수업 수' }) lessons!: number;
}

/** 필터 칩 하나 — 강사 */
export class BoardFacetTeacherDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiProperty({ description: '그 기간의 (휴강 아닌) 수업 수' }) lessons!: number;
}

/**
 * §34 필터 칩 줄 두 줄 — 「그 기간에 나온 과목·강사만 선다」.
 * 과목·강사 필터를 **걸기 전**의 그 기간을 센다 — 거른 결과로 세면 하나를 고르는 순간 나머지 칩이 사라진다.
 * 강사 본인 범위(강사 계정)는 그대로 지킨다.
 */
export class BoardFacetsDto {
  @ApiProperty({ type: [BoardFacetSubjectDto], description: '과목 코드표 순서(sort) → 이름' })
  subjects!: BoardFacetSubjectDto[];
  @ApiProperty({ type: [BoardFacetTeacherDto], description: '이름 순' })
  teachers!: BoardFacetTeacherDto[];
}

export class BoardDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ type: [BoardRowDto] }) rows!: BoardRowDto[];
  @ApiProperty({ description: '덜 된 수업 수 — 화면 위 배지' }) missingCount!: number;
  @ApiProperty({ type: BoardSummaryDto }) summary!: BoardSummaryDto;
  @ApiProperty({ type: [BoardTeacherRowDto] }) teacherRows!: BoardTeacherRowDto[];
  @ApiProperty({ type: [BoardWeekDto] }) weeks!: BoardWeekDto[];
  @ApiProperty({ type: [BoardDayDto], description: '날짜별 집계 — §35 요일 머리 · §36 달력 칸' })
  days!: BoardDayDto[];
  @ApiProperty({ type: BoardFacetsDto }) facets!: BoardFacetsDto;
  @ApiProperty({ description: '저장하지 않는다는 사실을 화면이 그대로 적을 수 있게 (D-R4)' })
  computedAt!: string;
}
