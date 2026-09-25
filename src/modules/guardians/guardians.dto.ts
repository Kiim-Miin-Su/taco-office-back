/** @file-guide
 * 목적: guardians.dto.ts — GuardianDto, GuardianListDto, GuardianCreateDto, GuardianPatchDto, GuardianSendDto, GuardianSendResultDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 보호자 — DQ3 대표 답변 (2026-09-25 · N-42): 「복수 보호자 + 선택 발송, 메일과 SENS 만」.
 *
 * **입력 방어의 첫 겹이다.** 메일 모양·휴대폰 모양은 발송 경계(`notify/sender`)의 판정을 그대로 빌린다 —
 * 여기서 따로 정규식을 적으면 「저장은 되는데 보낼 때 거절」이 생긴다. 연락처가 최소 하나인지 · 받는 채널에
 * 그 연락처가 있는지는 고치기(PATCH)가 기존 값과 합친 뒤에야 알 수 있어 서비스가 다시 보고 DB CHECK 가 마지막에 막는다.
 *
 * 연락처(email·phone)는 이 관리 응답에만 싣는다 — 강사가 받는 응답 어디에도 이 DTO 를 쓰지 않는다.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID,
  Max, MaxLength, Min, MinLength, ValidateBy, ValidateIf, type ValidationOptions,
} from 'class-validator';
import { ID_SCHEMA, ToHttpInteger } from '../../common/validation';
import { isEmail, phoneDigits, SEND_CHANNELS, type SendChannel } from '../notify/sender';

const S = { type: String, nullable: true } as const;

/** 앞뒤 공백을 걷는다 — 공백만 적은 이름이 「있는 이름」으로 저장되지 않게 */
const Trim = () => Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));
/** 선택 칸은 비운 글자를 null 로 — 빈 입력란이 「모양이 아닌 주소」로 거절되지 않고 「없음」이 된다 */
const TrimToNull = () => Transform(({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? null : t;
});

/** 메일 모양 — 발송 경계의 `isEmail` 과 같은 판정이다 (두 벌이면 저장과 발송이 다른 답을 한다) */
function IsGuardianEmail(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy({
    name: 'isGuardianEmail',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && value.length <= 254 && isEmail(value),
      defaultMessage: () => '메일 주소 모양이 아닙니다',
    },
  }, options);
}

/** 휴대폰 모양 — 발송 경계의 `phoneDigits` 가 숫자 10~11자리(0으로 시작)로 읽을 수 있어야 한다 */
function IsGuardianPhone(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy({
    name: 'isGuardianPhone',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && value.length <= 20 && phoneDigits(value) !== null,
      defaultMessage: () => '휴대폰 번호 모양이 아닙니다 — 010-1234-5678 처럼 적어 주세요',
    },
  }, options);
}

/* ── 응답 ─────────────────────────────────────────────────────────────── */

export class GuardianDto {
  @ApiProperty(ID_SCHEMA) id!: number;
  @ApiProperty(ID_SCHEMA) studentId!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ ...S, description: '어머니 · 아버지 · 보호자 … 사람이 적은 말' }) relation?: string | null;
  @ApiPropertyOptional({ ...S, description: '관리 화면 전용 — 강사 응답에는 없다' }) email?: string | null;
  @ApiPropertyOptional({ ...S, description: '숫자만 (관리 화면 전용)' }) phone?: string | null;
  @ApiPropertyOptional({ ...S, description: '보이는 모양 010-1234-5678 — 서버가 만든다' }) phoneDisplay?: string | null;
  @ApiProperty() receiveEmail!: boolean;
  @ApiProperty() receiveSms!: boolean;
  @ApiProperty({
    enum: SEND_CHANNELS, isArray: true,
    description: '지금 받는 채널 — 받기를 켰고 연락처가 있는 것만. 발송 창은 채널 이름을 따로 풀지 않고 이 값을 읽는다',
  })
  receives!: SendChannel[];
  @ApiProperty({ description: '대표 보호자 — 학생당 하나. 발송 창에서 미리 체크된다' }) isPrimary!: boolean;
  @ApiProperty({ description: 'false = 사용 중지(지우지 않는다 · 발송 원장이 가리킨다)' }) active!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class GuardianListDto {
  @ApiProperty(ID_SCHEMA) studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiProperty({ type: [GuardianDto], description: '사용 중인 보호자가 먼저(대표 → 이름), 사용 중지는 뒤' })
  guardians!: GuardianDto[];
}

/** 채널 하나가 지금 보낼 수 있는가 — 화면이 칩을 잠그고 까닭을 붙인다 */
export class GuardianChannelDto {
  @ApiProperty({ enum: SEND_CHANNELS }) channel!: SendChannel;
  @ApiProperty({ description: '화면에 보일 이름 — 서버가 준다' }) label!: string;
  @ApiProperty() ready!: boolean;
  @ApiPropertyOptional({ ...S, description: '보낼 수 없는 까닭 — 보낼 수 있으면 null' }) reason?: string | null;
}

export class GuardianChannelsDto {
  @ApiProperty({ type: [GuardianChannelDto] }) channels!: GuardianChannelDto[];
}

/* ── 쓰기 ─────────────────────────────────────────────────────────────── */

export class GuardianCreateDto {
  @ApiProperty({ minLength: 1, maxLength: 40 })
  @Trim() @IsString() @MinLength(1) @MaxLength(40)
  name!: string;

  @ApiPropertyOptional({ ...S, maxLength: 20, description: '어머니 · 아버지 · 보호자 …' })
  @IsOptional() @TrimToNull() @IsString() @MaxLength(20)
  relation?: string | null;

  @ApiPropertyOptional({ ...S, maxLength: 254 })
  @IsOptional() @TrimToNull() @IsGuardianEmail()
  email?: string | null;

  @ApiPropertyOptional({ ...S, maxLength: 20, description: '010-1234-5678 · 01012345678 — 숫자만 저장한다' })
  @IsOptional() @TrimToNull() @IsGuardianPhone()
  phone?: string | null;

  @ApiPropertyOptional({ description: '비우면 메일 주소가 있을 때 받는다' })
  @IsOptional() @IsBoolean()
  receiveEmail?: boolean;

  @ApiPropertyOptional({ description: '비우면 받지 않는다' })
  @IsOptional() @IsBoolean()
  receiveSms?: boolean;

  @ApiPropertyOptional({ description: '대표 보호자로 — 같은 학생의 전 대표는 내려간다' })
  @IsOptional() @IsBoolean()
  isPrimary?: boolean;
}

/**
 * 고치기 — 보낸 칸만 바꾼다. `email: null`·`phone: null`·`relation: null` 은 비운다.
 * `active: true` 는 사용 중지한 보호자를 다시 쓰는 것이다 (중지는 DELETE 가 한다).
 */
export class GuardianPatchDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 40 })
  @IsOptional() @Trim() @IsString() @MinLength(1) @MaxLength(40)
  name?: string;

  @ApiPropertyOptional({ ...S, maxLength: 20 })
  @ValidateIf((_o, v) => v !== undefined && v !== null) @TrimToNull() @IsString() @MaxLength(20)
  relation?: string | null;

  @ApiPropertyOptional({ ...S, maxLength: 254 })
  @ValidateIf((_o, v) => v !== undefined && v !== null) @TrimToNull() @IsGuardianEmail()
  email?: string | null;

  @ApiPropertyOptional({ ...S, maxLength: 20 })
  @ValidateIf((_o, v) => v !== undefined && v !== null) @TrimToNull() @IsGuardianPhone()
  phone?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() receiveEmail?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() receiveSms?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimary?: boolean;

  @ApiPropertyOptional({ enum: [true], description: 'true 만 받는다 — 다시 쓰기. 중지는 DELETE' })
  @IsOptional() @IsIn([true])
  active?: true;
}

export class GuardianParamsDto {
  @ApiProperty(ID_SCHEMA)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  id!: number;
}

/* ── 선택 발송 ────────────────────────────────────────────────────────── */

export class GuardianSendDto {
  @ApiProperty(ID_SCHEMA)
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  studentId!: number;

  @ApiPropertyOptional({ ...ID_SCHEMA, nullable: true, description: '§43 회차 학부모 안내(PNOTI parent)에서 보낼 때 그 줄 — 실제로 나간 것이 하나라도 있으면 sent_at 이 찍힌다' })
  @ValidateIf((_o, v) => v !== undefined && v !== null) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  pnotiId?: number | null;

  @ApiProperty({ type: [Number], minItems: 1, maxItems: 20, description: '받을 보호자 — 서버가 그 학생의 사용 중 보호자인지 다시 본다' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true }) @Max(Number.MAX_SAFE_INTEGER, { each: true })
  guardianIds!: number[];

  @ApiProperty({ enum: SEND_CHANNELS, isArray: true, minItems: 1, description: '보낼 채널 — 보호자가 받지 않는 채널은 그 보호자에게서 건너뛴다' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(SEND_CHANNELS.length) @ArrayUnique() @IsIn(SEND_CHANNELS, { each: true })
  channels!: SendChannel[];

  @ApiPropertyOptional({ ...S, maxLength: 120, description: '메일 제목 — 비우면 서버가 「{학생} 학생 안내」로 적는다. 문자에는 쓰이지 않는다' })
  @ValidateIf((_o, v) => v !== undefined && v !== null) @TrimToNull() @IsString() @MaxLength(120)
  subject?: string | null;

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Trim() @IsString() @MinLength(1) @MaxLength(2000)
  body!: string;

  @ApiProperty({ format: 'uuid', description: '재시도·더블클릭 중복 방지 키 — 같은 키는 앞선 결과를 그대로 돌려준다' })
  @IsUUID()
  requestKey!: string;
}

export class GuardianSendItemDto {
  @ApiProperty(ID_SCHEMA) guardianId!: number;
  @ApiProperty() guardianName!: string;
  @ApiPropertyOptional(S) relation?: string | null;
  @ApiProperty({ enum: SEND_CHANNELS }) channel!: SendChannel;
  @ApiProperty() channelLabel!: string;
  @ApiProperty({ description: '가린 받는 곳 — ab***@example.com · 010-****-1234' }) toMasked!: string;
  @ApiProperty({ enum: ['sent', 'failed', 'not_configured'] }) status!: 'sent' | 'failed' | 'not_configured';
  @ApiProperty({ description: '결과 낱말 — 서버가 준다' }) statusLabel!: string;
  @ApiPropertyOptional({ ...S, description: '실패·미설정 까닭 (받는 곳은 가려져 있다)' }) error?: string | null;
  @ApiProperty({ format: 'date-time' }) sentAt!: string;
}

export class GuardianSendSkipDto {
  @ApiProperty(ID_SCHEMA) guardianId!: number;
  @ApiProperty() guardianName!: string;
  @ApiProperty({ enum: SEND_CHANNELS }) channel!: SendChannel;
  @ApiProperty() channelLabel!: string;
  @ApiProperty() reason!: string;
}

export class GuardianSendCountsDto {
  @ApiProperty() sent!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() notConfigured!: number;
  @ApiProperty({ description: '보호자가 받지 않는 채널이라 건너뛴 수 — 원장에 줄이 없다' }) skipped!: number;
}

export class GuardianSendResultDto {
  @ApiProperty({ format: 'uuid' }) requestKey!: string;
  @ApiProperty(ID_SCHEMA) studentId!: number;
  @ApiPropertyOptional({ type: Number, nullable: true }) pnotiId?: number | null;
  @ApiProperty({ description: '같은 키로 다시 온 요청 — 새로 보내지 않고 앞선 결과를 돌려준다' }) replayed!: boolean;
  @ApiPropertyOptional({ ...S, description: 'PNOTI 발송 기록 시각 — 실제로 나간 것이 없으면 null' }) pnotiSentAt?: string | null;
  @ApiProperty({ description: '한 줄 요약 — 서버가 만든다' }) summary!: string;
  @ApiProperty({ type: GuardianSendCountsDto }) counts!: GuardianSendCountsDto;
  @ApiProperty({ type: [GuardianSendItemDto] }) items!: GuardianSendItemDto[];
  @ApiProperty({ type: [GuardianSendSkipDto], description: '처음 요청에서만 채운다 — 다시 온 요청은 원장만 돌려준다' })
  skipped!: GuardianSendSkipDto[];
}
