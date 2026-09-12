/** @file-guide
 * 목적: exec.dto.ts — ExecReportDto, ExecStatDto, ExecAreaDto, ExecInboxDto, ExecDto (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DATE_SCHEMA, IsCalendarDate } from '../../common/validation';

/** 대표 보고 집계의 실제 달력 날짜. 저장할 RPT 주기 key와 구분한다. */
export class ExecQueryDto {
  @ApiProperty({ ...DATE_SCHEMA, example: '2026-08-01', description: '집계 시작일(포함). 실제 YYYY-MM-DD 날짜' })
  @IsCalendarDate()
  from!: string;

  @ApiProperty({ ...DATE_SCHEMA, example: '2026-08-31', description: '집계 종료일(포함). 시작일 이후 또는 같은 날짜' })
  @IsCalendarDate()
  to!: string;
}

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

/** §69 6영역 한 칸 — 저장하지 않고 매번 센다 (D-R4 · DEV-SPEC §5.3) */
export class ExecAreaDto {
  @ApiProperty({ description: 'money · mkt · ops · consulting · complaint · lesson (대표 관심순 고정 · D-R25)' }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: '무엇을 살펴볼 것으로 세는지 한 줄' }) review!: string;
  @ApiProperty({ description: '살펴볼 것 건수. 마케팅은 정보성이라 항상 0 이다' }) count!: number;
  @ApiProperty({ description: '줄을 누르면 가는 곳 — 결재 흐름은 이동만 한다 (D-R27)' }) go!: string;
}

/**
 * §73 결재함 한 줄 — **이동만 한다** (N-12 채택 원문 그대로 · D-R27 · 원칙 22).
 * 여기에는 승인·반려가 없다. 각 화면에서 한다.
 */
export class ExecInboxDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: ['day', 'week', 'month'] }) rptType!: string;
  @ApiProperty({ description: 'RPT 키 날짜 (주간=월요일 · 월간=1일 · D-R23)' }) onDate!: string;
  @ApiProperty({ description: '«26년 8월 21일 금요일» · «08-17 ~ 08-23» 처럼 사람이 읽는 기간' }) label!: string;
  @ApiProperty({ enum: ['draft', 'sent', 'ok', 'rej'] }) state!: string;
  @ApiProperty({ description: 'apFlow 와 같은 세 낱말 — waiting · back · done' }) apState!: string;
  @ApiProperty({ description: '6영역 중 메모를 적은 수 (§69 «담당 x/6 기재»)' }) filled!: number;
  @ApiProperty({ description: '이 기간의 살펴볼 것 합계 (§73 줄 배지)' }) reviewCount!: number;
  @ApiPropertyOptional(S) rejectReason?: string | null;
  @ApiProperty({ description: '이 줄이 가리키는 뷰 — day | week | month' }) go!: string;
}

export class ExecDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ type: [ExecStatDto] }) stats!: ExecStatDto[];
  @ApiProperty({ type: [ExecReportDto] }) reports!: ExecReportDto[];
  @ApiProperty({ type: [ExecAreaDto], description: '§69 6영역 — 대표 관심순 고정' }) areas!: ExecAreaDto[];
  @ApiProperty({ description: '살펴볼 것 — 6영역 배지의 합 (§69 머리)' }) reviewCount!: number;
  @ApiProperty({ description: '이 기간 보고의 «담당 x/6 기재» 중 x. 보고가 없으면 0' }) filled!: number;
  @ApiProperty({ type: [ExecInboxDto], description: '§73 결재함 — 이동만 (N-12)' }) inbox!: ExecInboxDto[];
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39)' }) canSeeAmounts!: boolean;
  @ApiProperty({ description: '저장하지 않는다 — 이 시각에 센 값이다 (D-R4)' }) computedAt!: string;
}
