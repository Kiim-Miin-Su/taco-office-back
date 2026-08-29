import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;

/** §23 상담 단계 보드 · §24 중단 지점 */
export class LeadDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional(S) school?: string | null;
  @ApiProperty({ description: 'first | wait2nd | second | hold | enrolled | failed' }) stage!: string;
  @ApiPropertyOptional(S) ownerName?: string | null;
  @ApiPropertyOptional({ ...S, description: '실패한 경우 어디서 멈췄나 (§24)' }) stopAt?: string | null;
  @ApiPropertyOptional(S) reason?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ description: '접수한 지 며칠' }) ageDays!: number;
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
