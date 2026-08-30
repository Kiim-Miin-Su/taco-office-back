import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;

/** §69 대표 보고 — 제출된 보고 한 건 */
export class ExecReportDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: ['day', 'week', 'month'] }) rptType!: string;
  @ApiProperty() onDate!: string;
  @ApiProperty({
    enum: ['draft', 'sent', 'ok', 'rej'],
    description: '**RPT(대표 보고)의 낱말**이다. 수업 리포트(REP)의 rep_state_t 와 다르다 — 한동안 그것을 적어 두어 '
      + '실제로 내려가는 sent 가 목록에 없었다',
  })
  state!: string;
  @ApiProperty({ description: 'D-R14 — 한 줄이라도 적어야 제출된다. jsonb 의 note 를 꺼내 문자열로 내린다' }) memo!: string;
  @ApiPropertyOptional(S) sentAt?: string | null;
  @ApiPropertyOptional(S) reviewedAt?: string | null;
  @ApiPropertyOptional({ ...S, description: 'D-R13 — 반려(rej)하면 사유가 반드시 있다' }) rejectReason?: string | null;
}

/** 숫자 한 칸 — 저장하지 않고 매번 센다 (D-R4) */
export class ExecStatDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiPropertyOptional({ ...N, description: '볼 권한이 없으면 null (D-R39)' }) value?: number | null;
  @ApiPropertyOptional(S) unit?: string | null;
  @ApiProperty({ description: '금액이라 권한을 타는 칸인가' }) money!: boolean;
}

export class ExecDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ type: [ExecStatDto] }) stats!: ExecStatDto[];
  @ApiProperty({ type: [ExecReportDto] }) reports!: ExecReportDto[];
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39)' }) canSeeAmounts!: boolean;
  @ApiProperty({ description: '저장하지 않는다 — 이 시각에 센 값이다 (D-R4)' }) computedAt!: string;
}
