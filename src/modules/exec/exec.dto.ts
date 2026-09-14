/** @file-guide
 * 목적: exec.dto.ts — ExecQueryDto, ExecReportDto, ExecStatDto, ExecAreaDto, ExecInboxDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { DATE_SCHEMA, ID_SCHEMA, IsCalendarDate, ToHttpInteger } from '../../common/validation';
import { EXEC_AREA_KEYS } from '../../lib/exec-areas';

/** 원본 §69 의 메모 칸 하나 — 「숫자만으로는 모를 것」. 한 줄이라 길이를 막아 둔다. */
export const EXEC_MEMO_MAX = 500;

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

  /* ── §69 의 「숫자만으로는 모를 것」과 서명줄 (C85-a) ───────────────── */

  @ApiProperty({
    type: () => [ExecAreaMemoDto],
    description: '6영역 메모 — **대표 관심순 여섯 칸이 언제나 다 온다**(안 적은 칸은 빈 문자열). 화면이 칸을 만들지 않는다',
  })
  memos!: ExecAreaMemoDto[];

  @ApiProperty({ description: '6영역 중 적힌 칸 수 — 「담당 x/6 기재」의 x' }) filled!: number;

  @ApiPropertyOptional({ ...S, description: '원본 §69 서명줄 「올린 사람」. 옛 보고는 누가 올렸는지 기록이 없어 null 이다' })
  sentByName?: string | null;

  @ApiPropertyOptional({ ...S, description: '원본 §69 서명줄 「대표 승인」' })
  reviewedByName?: string | null;
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

/**
 * §71 월간 「어디서 놓쳤나」 한 줄 — 낱말은 `lib/intake-words` 한 곳에서 온다 (D-R18).
 * 분류되지 않은 실패는 `key: 'none'` 으로 **따로 선다** — 이 줄을 빼면 머리의 「등록 실패 N건」과
 * 줄들의 합이 갈린다 (N-19 · N-25 는 추정 이관을 금지하므로 미분류는 사라지지 않는다).
 */
export class ExecLostRowDto {
  @ApiProperty({ description: 'before_book | before_first | after_first | after_second | none' }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() count!: number;
}

/**
 * §71 **월간에만** 서는 판 — 일간·주간 컷에는 없다.
 *
 * 기간이 **달력 한 달 전체**일 때만 내려간다. 주기 종류를 따로 받지 않는 이유는, 그것이 곧
 * 기간이 말해 주는 사실이기 때문이다 — 주는 달을 채울 수 없고 하루도 그렇다. 입력이 둘이면
 * 둘이 어긋날 수 있다.
 *
 * **묶는 기준은 「들어온 달」이지 「실패한 날」이 아니다.** 실패한 시각은 라이브 전이에만
 * 남아 있어(`LEAD_STAGE_LOG`) 그 전에 만들어진 건에는 없다 — 실패한 날로 묶으면 옛 건이
 * 통째로 사라지고 머리가 거짓이 된다. 「이번 달 들어온 문의 중 어디서 놓쳤나」로 읽는다.
 */
export class ExecMonthlyDto {
  @ApiProperty({ description: '이 달에 들어온 문의 수 — 「등록 실패 N건」의 모집단' }) leads!: number;
  @ApiProperty({ description: '그중 지금 등록 실패인 건 수 — 아래 줄들의 합과 같다 (N-19)' }) lost!: number;
  @ApiProperty({ type: [ExecLostRowDto], description: '중단 지점별 — 0 인 갈래는 서지 않는다' })
  lostRows!: ExecLostRowDto[];
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
  @ApiPropertyOptional({ type: ExecMonthlyDto, nullable: true, description: '§71 월간 전용 — 기간이 달력 한 달 전체가 아니면 null' })
  monthly?: ExecMonthlyDto | null;
  @ApiProperty({ description: '저장하지 않는다 — 이 시각에 센 값이다 (D-R4)' }) computedAt!: string;
}

/* ── §69 쓰기 — 「숫자만으로는 모를 것」과 서명 ─────────────────────── */

/**
 * 영역 하나의 메모. 낱말(key)은 `lib/exec-areas` 한 곳에서 온다 — 화면이 제 표를 들면
 * 「담당 x/6 기재」의 x 와 실제로 적힌 칸이 갈린다 (D-R18).
 */
export class ExecAreaMemoDto {
  @ApiProperty({ enum: EXEC_AREA_KEYS })
  @IsIn([...EXEC_AREA_KEYS])
  key!: string;

  @ApiProperty({ maxLength: EXEC_MEMO_MAX, description: '빈 문자열이면 그 칸을 비운다' })
  @IsString() @MaxLength(EXEC_MEMO_MAX)
  memo!: string;
}

/** PATCH /exec/report — 작성 중 저장. 주기+날짜로 한 건을 찾거나 만든다 (D-R23 정규화는 서버가). */
export class ExecMemoWriteDto {
  @ApiProperty({ enum: ['day', 'week', 'month'] })
  @IsIn(['day', 'week', 'month'])
  rptType!: string;

  @ApiProperty({ ...DATE_SCHEMA, description: '기간 안 아무 날짜. 서버가 주기 key 로 정규화한다 (D-R23)' })
  @IsCalendarDate()
  onDate!: string;

  @ApiProperty({ type: [ExecAreaMemoDto], maxItems: 6 })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6)
  @ValidateNested({ each: true }) @Type(() => ExecAreaMemoDto)
  memos!: ExecAreaMemoDto[];
}

/** POST /exec/report/submit — 「대표께 올리기」 */
export class ExecSubmitDto {
  @ApiProperty({ enum: ['day', 'week', 'month'] })
  @IsIn(['day', 'week', 'month'])
  rptType!: string;

  @ApiProperty(DATE_SCHEMA)
  @IsCalendarDate()
  onDate!: string;
}

/** POST /exec/report/:id/review — §73 결재. 반려는 사유가 있어야 한다 (D-R13). */
export class ExecReviewDto {
  @ApiProperty({ enum: ['ok', 'rej'] })
  @IsIn(['ok', 'rej'])
  action!: string;

  @ApiPropertyOptional({ maxLength: EXEC_MEMO_MAX, description: 'rej 면 반드시 있어야 한다 (D-R13)' })
  @IsOptional() @IsString() @MaxLength(EXEC_MEMO_MAX)
  reason?: string;
}

/** 쓰기 응답 — 화면이 상태·기재 수를 다시 세지 않는다 (D-R37). */
export class ExecReportWriteResultDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: ['draft', 'sent', 'ok', 'rej'] }) state!: string;
  @ApiProperty({ description: 'RPT 키 날짜 — 서버가 정규화한 값 (D-R23)' }) onDate!: string;
  @ApiProperty({ description: '6영역 중 적힌 칸 수 — 「담당 x/6 기재」의 x' }) filled!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) sentByName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) reviewedByName?: string | null;
}

/** URL 의 RPT 식별자 — 다른 경로와 같은 안전 정수 범위다. */
export class ExecReportParamsDto {
  @ApiProperty(ID_SCHEMA)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  id!: number;
}
