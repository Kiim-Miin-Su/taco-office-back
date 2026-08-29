import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;

/** §30 컨설팅 회차 — 5W1H 로 적는다 (누가·무엇을·왜·어떻게) */
export class ConsultingSessionDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: '몇 번째 회차' }) seq!: number;
  @ApiProperty() onDate!: string;
  @ApiPropertyOptional(S) who?: string | null;
  @ApiPropertyOptional(S) what?: string | null;
  @ApiPropertyOptional(S) why?: string | null;
  @ApiPropertyOptional(S) how?: string | null;
  @ApiPropertyOptional({ ...N, description: '연결된 수업이 있으면 그 SER' }) serId?: number | null;
}

/** §29 컨설팅 건 */
export class ConsultingDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: ['admissions', 'essay', 'roadmap'], description: '종류 10종 중 시드에 있는 것' }) consType!: string;
  @ApiProperty({ enum: ['contract', 'running', 'done'], description: '계약 → 진행 → 종료' }) stage!: string;
  @ApiPropertyOptional({ ...N, description: '계약 5단계 — 계약서 → 피드백 → 학부모 전달 → 서명본 → 수납' }) contractStep?: number | null;
  @ApiProperty({ type: [String] }) studentNames!: string[];
  @ApiPropertyOptional(S) ownerName?: string | null;
  @ApiPropertyOptional(N) sessions?: number | null;
  @ApiPropertyOptional(S) endOn?: string | null;
  @ApiProperty() createdAt!: string;

  /** D-R39 — 금액은 대표만 본다. 나머지에게는 서버가 null 로 내린다. */
  @ApiPropertyOptional({ ...N, description: '대표가 아니면 null' }) amount?: number | null;
  /** 공개 범위 — 역할 권한과 **독립된 두 번째 층**이다 (DEV-SPEC §4.4). 배분율이 아니다. */
  @ApiProperty({
    enum: ['all', 'money_only', 'picked', 'private'],
    description: '전체 공개 · 수납만 공개 · 지정 공개 · 전체 비공개',
  })
  share!: string;

  @ApiProperty({ description: '내용(회차 기록)을 열 수 있는가 — csCanFull()' }) canOpen!: boolean;

  @ApiProperty({ type: [ConsultingSessionDto] }) sessionsLog!: ConsultingSessionDto[];
}

export class ConsultingListDto {
  @ApiProperty({ type: [ConsultingDto] }) items!: ConsultingDto[];
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39)' }) canSeeAmounts!: boolean;
}
