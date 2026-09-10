/** @file-guide
 * 목적: consulting.dto.ts — ConsultingSessionDto, ConsultingDto, ConsultingListDto (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CONS_SHARES, type ConsShare } from '../../lib/rules';
import { CONSULTING_STAGES, CONTRACT_STEP_MAX, CONSULTING_SESSION_MAX, type ConsultingStage } from './consulting.rules';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;

/** §31 컨설팅 회차 — 5W1H 로 적는다 (누가·무엇을·왜·어떻게) */
export class ConsultingSessionDto {
  @ApiProperty() id!: number;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: CONSULTING_SESSION_MAX, description: '건별 고유 회차 순번' }) seq!: number;
  @ApiProperty({ ...S, format: 'date', description: '미정이면 null' }) onDate!: string | null;
  @ApiPropertyOptional(S) who?: string | null;
  @ApiPropertyOptional(S) what?: string | null;
  @ApiPropertyOptional(S) why?: string | null;
  @ApiPropertyOptional(S) how?: string | null;
  @ApiPropertyOptional({ ...N, description: '연결된 수업이 있으면 그 SER' }) serId?: number | null;
}

/** §26·§27 컨설팅 건 조회. §29 생성 input은 별도 청크. */
export class ConsultingDto {
  @ApiProperty() id!: number;
  @ApiProperty({ maxLength: 20, description: '종류 코드. 원본 §29에 종류 10개가 있으며 저장 코드와의 대응은 생성 계약에서 정리한다. 조회는 기존 코드를 보존하고 시드 3종으로 제한하지 않는다.' }) consType!: string;
  @ApiProperty({ type: String, enum: CONSULTING_STAGES, description: '계약 → 진행 → 종료' }) stage!: ConsultingStage;
  @ApiPropertyOptional({ type: 'integer', nullable: true, minimum: 1, maximum: CONTRACT_STEP_MAX, description: '계약 5단계. 계약 중 미정은 null, 진행/종료는 5.' }) contractStep?: number | null;
  @ApiProperty({ type: [String] }) studentNames!: string[];
  @ApiPropertyOptional(S) ownerName?: string | null;
  @ApiPropertyOptional({ type: 'integer', nullable: true, minimum: 1, maximum: CONSULTING_SESSION_MAX }) sessions?: number | null;
  @ApiPropertyOptional(S) endOn?: string | null;
  @ApiProperty() createdAt!: string;

  /** D-R39 — 금액은 대표만 본다. 나머지에게는 서버가 null 로 내린다. */
  @ApiPropertyOptional({ ...N, description: '대표가 아니면 null' }) amount?: number | null;
  /** 공개 범위 — 역할 권한과 **독립된 두 번째 층**이다 (DEV-SPEC §4.4). 배분율이 아니다. */
  @ApiProperty({
    type: String, enum: CONS_SHARES,
    description: '전체 공개 · 수납만 공개 · 지정 공개 · 전체 비공개',
  })
  share!: ConsShare;

  @ApiProperty({ description: '내용(회차 기록)을 열 수 있는가 — csCanFull()' }) canOpen!: boolean;

  @ApiProperty({ type: [ConsultingSessionDto] }) sessionsLog!: ConsultingSessionDto[];
}

export class ConsultingListDto {
  @ApiProperty({ type: [ConsultingDto] }) items!: ConsultingDto[];
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39)' }) canSeeAmounts!: boolean;
}
