/** @file-guide
 * 목적: gpa.dto.ts — GpaServiceDto, GpaCycleDto, GpaStudentDto, GpaUseDto, GpaBoardQueryDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const S = { type: String, nullable: true } as const;

/* ══ GPA 관리 (v2 §4.5·§82 · N-13 채택 ① — 4주 사이클 · 포인트제 · 학부모 비공개 D-R30) ══ */

export class GpaServiceDto {
  @ApiProperty({ description: 'hw · prj · quiz · test · self (원문 5종)' }) key!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: '회차마다 배정량에서 깎이는 포인트 (D-R29)' }) point!: number;
}

export class GpaCycleDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: '«N차 사이클» 표기용 순번' }) no!: number;
  @ApiProperty({ description: '시작 YYYY-MM-DD' }) from!: string;
  @ApiProperty({ description: '끝 YYYY-MM-DD — 4주. 이월 없음, 닫히면 소멸 (D-R29)' }) to!: string;
  @ApiProperty({ description: '닫힘 — 닫힌 사이클은 모든 쓰기가 잠긴다' }) closed!: boolean;
}

/**
 * 한 학생이 이 사이클에 쓴 **서비스 한 갈래** — 원본 §82 카드의 「숙제 지원 4·4p」 칩.
 * 앞의 수는 **회수**, 뒤는 **포인트 합**이다. 규정(`services`) 순서를 따르고 0 인 갈래는 오지 않는다.
 * 승인 대기도 포함한다 — 잔여에서 이미 빠져 있으므로 카드에서만 빼면 두 수가 갈린다 (N-19).
 */
export class GpaStudentSvcDto {
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: '회수' }) count!: number;
  @ApiProperty({ description: '포인트 합' }) points!: number;
}

export class GpaStudentDto {
  @ApiProperty() studentId!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional(S) grade?: string | null;
  @ApiPropertyOptional({ ...S, description: '담당 코디네이터 이름 (배정 기준)' }) coordName?: string | null;
  @ApiProperty({ description: '이 사이클 배정량 (배정 없이 소비만 있으면 0)' }) alloc!: number;
  @ApiProperty({ description: '승인(ok) 소비 합' }) used!: number;
  @ApiProperty({ description: '승인 대기(wait) 합 — 타임라인 점선' }) wait!: number;
  @ApiProperty({ description: 'gpaByStudent() = 배정 − 사용 − 대기' }) remain!: number;
  @ApiProperty({ description: '배정 초과 — 붉게 표시하고 추가 결제/다음 사이클 조정을 안내한다' }) over!: boolean;
  @ApiProperty({ type: [GpaStudentSvcDto], description: '§82 카드의 서비스 칩 — 0 인 갈래는 없다' })
  svcs!: GpaStudentSvcDto[];
}

export class GpaUseDto {
  @ApiProperty() id!: number;
  @ApiProperty() studentId!: number;
  @ApiProperty() svcKey!: string;
  @ApiProperty({ description: '기록 당시 GPASVC.point 스냅샷' }) points!: number;
  @ApiProperty({ description: 'YYYY-MM-DD' }) onDate!: string;
  @ApiPropertyOptional({ type: Number, nullable: true }) startMin?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: "kind='gpa' 회차 연결" }) serId?: number | null;
  @ApiPropertyOptional(S) coordName?: string | null;
  @ApiPropertyOptional(S) noteUrl?: string | null;
  @ApiProperty({ enum: ['wait', 'ok'], description: 'wait 는 점선 — 승인되면 ok' }) state!: string;
}

export class GpaBoardQueryDto {
  @ApiPropertyOptional({ description: '조회할 사이클 안의 아무 날짜 YYYY-MM-DD — 없으면 오늘(KST)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'anchor는 YYYY-MM-DD 형식입니다' })
  anchor?: string;
}

/** GET /gpa — §82 한 화면 분량. 학부모 비공개(내부 자료) — 발송 경로에 싣지 않는다. */
export class GpaBoardDto {
  @ApiPropertyOptional({ type: GpaCycleDto, nullable: true, description: 'anchor 를 품는(없으면 직전) 사이클 — 하나도 없으면 null' })
  cycle?: GpaCycleDto | null;
  @ApiProperty({ description: '이전 사이클 존재 여부' }) hasPrev!: boolean;
  @ApiProperty({ description: '다음 사이클 존재 여부' }) hasNext!: boolean;
  @ApiProperty({ type: [GpaServiceDto], description: '포인트 규정 — 원문 5종' }) services!: GpaServiceDto[];
  @ApiProperty({ description: '사이클 합계 — 배정' }) totalAlloc!: number;
  @ApiProperty({ description: '사이클 합계 — 승인 사용' }) totalUsed!: number;
  @ApiProperty({ description: '사이클 합계 — 승인 대기' }) totalWait!: number;
  @ApiProperty({ description: '사이클 합계 — 잔여 (배정−사용−대기)' }) totalRemain!: number;
  @ApiProperty({
    description: '§82 머리의 「N회 진행」 — 이 사이클 소비 기록 수. 승인 대기도 센다 '
      + '(기록이 있다는 것은 회차가 있었다는 뜻이고, 그 포인트는 이미 잔여에서 빠져 있다)',
  }) totalUses!: number;
  @ApiProperty({
    type: [GpaStudentDto],
    description: '배정 ∪ 소비 학생 — **잔여 적은 순**(원본 §82 「5명 · 잔여 적은 순」), 같으면 이름 순. '
      + '초과가 맨 앞에 온다 — 먼저 손봐야 할 것이 먼저 보여야 한다.',
  }) students!: GpaStudentDto[];
  @ApiProperty({ type: [GpaUseDto], description: '사이클 내 소비 — 날짜·시간 순 (gpTimeline 입력)' }) uses!: GpaUseDto[];
}

export class GpaUseCreateDto {
  @ApiProperty() @IsInt() @Min(1) cycleId!: number;
  @ApiProperty() @IsInt() @Min(1) studentId!: number;
  @ApiProperty({ description: '서비스 키 — 포인트는 서버가 규정에서 스냅샷' })
  @IsIn(['hw', 'prj', 'quiz', 'test', 'self'], { message: '서비스는 원문 5종 중 하나입니다' })
  svcKey!: string;
  @ApiProperty({ description: 'YYYY-MM-DD — 사이클 창 안이어야 한다' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'onDate는 YYYY-MM-DD 형식입니다' })
  onDate!: string;
  @ApiPropertyOptional({ description: 'KST 분 (0~1439)' })
  @IsOptional() @IsInt() @Min(0) @Max(1439)
  startMin?: number;
  @ApiPropertyOptional({ description: "kind='gpa' 회차 SER id" })
  @IsOptional() @IsInt() @Min(1)
  serId?: number;
  @ApiPropertyOptional({ description: '기록지 URL — 500자 이내' })
  @IsOptional() @IsString() @MaxLength(500)
  noteUrl?: string;
}

export class GpaUseStateDto {
  @ApiProperty({ enum: ['wait', 'ok'], description: 'ok = 승인 · wait = 되돌림' })
  @IsIn(['wait', 'ok'])
  state!: 'wait' | 'ok';
}

export class GpaAllocPutDto {
  @ApiProperty() @IsInt() @Min(1) cycleId!: number;
  @ApiProperty() @IsInt() @Min(1) studentId!: number;
  @ApiProperty({ description: '이 사이클 배정량 — 0 이상 (0 은 배정 회수)' })
  @IsInt() @Min(0) @Max(32000)
  points!: number;
}
