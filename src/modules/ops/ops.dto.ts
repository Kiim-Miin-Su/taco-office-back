/** @file-guide
 * 목적: ops.dto.ts — LeadDto, ComplaintDto, TodoDto, PlanDto, MeetingDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;
const FQ = { description: 'FQ 클라이언트 검색 대상. 원문을 보존한다.' } as const;

/** §23 상담 단계 보드 · §24 중단 지점 */
export class LeadDto {
  @ApiProperty() id!: number;
  @ApiProperty(FQ) name!: string;
  @ApiPropertyOptional({ ...S, ...FQ }) school?: string | null;
  @ApiProperty({ description: 'first | wait2nd | second | hold | enrolled | failed' }) stage!: string;
  @ApiPropertyOptional(N) ownerId?: number | null;
  @ApiPropertyOptional(N) studentId?: number | null;
  @ApiPropertyOptional({ ...S, ...FQ }) ownerName?: string | null;
  @ApiPropertyOptional({ ...S, description: '실패한 경우 어디서 멈췄나 (§24)' }) stopAt?: string | null;
  @ApiPropertyOptional({ ...S, ...FQ }) reason?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ description: '접수한 지 며칠' }) ageDays!: number;

  /* N-25 채택 (§4-17) — 실패 이력. 판정은 서버 한 곳: fail_from 명시값 → 도달 기록 역순 → 미분류. */
  @ApiPropertyOptional({ ...S, description: '실패 당시 이전 단계 명시값 — 전이 때 서버가 라이브 기록. 레거시 NULL' })
  failFrom?: string | null;
  @ApiPropertyOptional({ ...S, description: '되살릴 단계 판정 결과(failed 건만) — null 이면 미분류(단계 지정 필요)' })
  revivalStage?: string | null;
  @ApiPropertyOptional({ ...S, description: "판정 근거 — 'explicit'(명시값) | 'log'(도달 기록) | null(미분류)" })
  revivalSource?: string | null;
}

const LEAD_ACTIVE_STAGES = ['first', 'wait2nd', 'second', 'hold'] as const;
const LEAD_STOPS = ['before_book', 'before_first', 'after_first', 'after_second'] as const;

export class LeadFailDto {
  @ApiProperty({ enum: [...LEAD_STOPS], description: '중단 지점 분류 (§24 · 기존 4어휘)' })
  @IsIn([...LEAD_STOPS], { message: '중단 지점은 기존 4분류 중 하나입니다' })
  stopAt!: string;
  @ApiPropertyOptional({ description: '사유 — 500자 이내. 생략하면 기존 사유 유지' })
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

export class LeadResumeDto {
  @ApiPropertyOptional({
    enum: [...LEAD_ACTIVE_STAGES],
    description: '되살릴 단계 지정 — 생략하면 서버 판정(명시값 → 도달 기록). 미분류인데 생략하면 409 UNCLASSIFIED',
  })
  @IsOptional()
  @IsIn([...LEAD_ACTIVE_STAGES], { message: '되살릴 단계는 진행 4단계 중 하나입니다' })
  to?: string;
}

/** §67 컴플레인 */
export class ComplaintDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: ['lesson', 'intake', 'book', 'schedule', 'teacher'] }) area!: string;
  @ApiPropertyOptional(S) studentName?: string | null;
  @ApiProperty({ description: 'received | acting | closed' }) stage!: string;
  @ApiProperty() body!: string;
  @ApiPropertyOptional(S) action?: string | null;
  @ApiPropertyOptional(S) result?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() ageDays!: number;
}

/** §64 운영 할 일 */
export class TodoDto {
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiPropertyOptional(S) toName?: string | null;
  @ApiPropertyOptional(S) dueOn?: string | null;
  @ApiProperty() done!: boolean;
  @ApiProperty({ enum: ['meeting', 'complaint', 'consulting', 'plan', 'manual'] }) src!: string;
  @ApiProperty({ description: '기한이 지난 날 수. 0이면 안 지남' }) overdueDays!: number;
}

/** §61 기획 단계 보드 */
export class PlanDto {
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiProperty({ description: 'draft | review | rework | approved | done' }) stage!: string;
  @ApiPropertyOptional(S) goal?: string | null;
  @ApiPropertyOptional(S) ask?: string | null;
  @ApiPropertyOptional(S) dueOn?: string | null;
  @ApiPropertyOptional(S) ownerName?: string | null;
  @ApiProperty() overdueDays!: number;
}

/** §63 회의 목록 */
export class MeetingDto {
  @ApiProperty() id!: number;
  @ApiProperty() mtType!: string;
  @ApiPropertyOptional(S) title?: string | null;
  @ApiPropertyOptional(S) onDate?: string | null;
  @ApiProperty() attendees!: number;
  @ApiProperty() confirmed!: number;
  @ApiProperty({ description: '속기록을 썼는가 — 안 쓰면 회의가 끝난 것이 아니다' }) hasMinutes!: boolean;
}

/** §59 마케팅 트래킹 */
export class MarketingDto {
  @ApiProperty() id!: number;
  @ApiProperty() channel!: string;
  @ApiProperty() item!: string;
  @ApiPropertyOptional(S) url?: string | null;
  @ApiPropertyOptional(N) impressions?: number | null;
  @ApiPropertyOptional(N) clicks?: number | null;
  @ApiPropertyOptional(N) inquiries?: number | null;
  @ApiPropertyOptional(N) enrolled?: number | null;
  @ApiPropertyOptional({ ...N, description: '집행 비용 — 대표만 (D-R39)' }) cost?: number | null;
  @ApiPropertyOptional({ ...N, description: '등록당 비용' }) costPerEnroll?: number | null;
}

/** 건의 사항 */
export class SuggestionDto {
  @ApiProperty() id!: number;
  @ApiProperty() staffName!: string;
  @ApiProperty({ enum: ['lesson', 'pay', 'schedule', 'etc'] }) category!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ enum: ['open', 'reviewing', 'done'] }) state!: string;
  @ApiPropertyOptional(S) reply?: string | null;
  @ApiProperty() createdAt!: string;
}

export class OpsDto {
  @ApiProperty({ type: [LeadDto] }) leads!: LeadDto[];
  @ApiProperty({ type: [ComplaintDto] }) complaints!: ComplaintDto[];
  @ApiProperty({ type: [TodoDto] }) todos!: TodoDto[];
  @ApiProperty({ type: [PlanDto] }) plans!: PlanDto[];
  @ApiProperty({ type: [MeetingDto] }) meetings!: MeetingDto[];
  @ApiProperty({ type: [MarketingDto] }) marketing!: MarketingDto[];
  @ApiProperty({ type: [SuggestionDto] }) suggestions!: SuggestionDto[];
  @ApiProperty({ description: '집행 비용을 볼 수 있는가' }) canSeeAmounts!: boolean;
}
