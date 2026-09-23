/** @file-guide
 * 목적: zoom.dto.ts — ZoomAcctDto, ZoomSlotDto, ZoomRowDto, ZoomBoardDto, ZoomAccountCreateDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { DATE_SCHEMA, ID_SCHEMA, IsCalendarDate, IsSafeHttpUrl, ToHttpInteger } from '../../common/validation';

/**
 * §21 줌 계정 — 서랍은 **칸이 비었는지**만 보여 주고, 고치는 자리는 「줌 계정 관리」다.
 * 그 관리 화면이 원본 61컷에 없어 지금까지 만들지 않았는데, 대표 결정(2026-09-12)으로 **신설한다.**
 */
/* 이름이 `ZoomAccountDto` 가 아닌 이유 — 서랍(§21)이 이미 그 이름을 쓰고 있다.
   OpenAPI 는 클래스 이름으로 스키마를 모으므로 같은 이름이 둘이면 **조용히 하나가 다른 하나를 덮는다.**
   실제로 덮였고, 프런트 타입이 바뀌어 컴파일이 깨져서 알았다. 화면이 보는 모양이 다르니 이름도 다르다. */
export class ZoomAcctDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: '화면에 보이는 짧은 이름 — Boarding · Consulting · TN · Study …' }) label!: string;
  @ApiProperty() loginEmail!: string;
  @ApiProperty() joinUrl!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) meetingId?: string | null;
  @ApiProperty({ description: '지금 쓰는 계정인가 — 끄면 새 배정에서 빠진다' }) active!: boolean;
  @ApiProperty({ description: '이 계정이 붙어 있는 회차 수 (기준일)' }) usedCount!: number;
  /** 비밀은 **내려보내지 않는다.** 보관은 암호화(`login_secret`)이고 열람은 별도 경로다 */
  @ApiProperty({ description: '암호문에 비밀 payload가 있는가. 빈 값은 false이며 복호화 가능성은 보증하지 않는다. 값 자체는 내려보내지 않는다' }) hasSecret!: boolean;
}

/** 한 시간 칸의 점유 — §21 의 격자 한 칸 */
export class ZoomSlotDto {
  @ApiProperty({ description: '시(0~23)' }) hour!: number;
  @ApiProperty({ description: '이 시간에 이 계정을 쓰는 회차 수' }) busy!: number;
}

export class ZoomRowDto {
  @ApiProperty() zaccId!: number;
  @ApiProperty() label!: string;
  @ApiProperty({ type: [ZoomSlotDto] }) slots!: ZoomSlotDto[];
}

export class ZoomBoardDto {
  @ApiProperty({ description: '기준일 YYYY-MM-DD (KST)' }) onDate!: string;
  @ApiProperty({ description: '격자가 보여 주는 첫 시' }) fromHour!: number;
  @ApiProperty({ description: '격자가 보여 주는 끝 시 (포함)' }) toHour!: number;
  @ApiProperty({ type: [ZoomAcctDto] }) accounts!: ZoomAcctDto[];
  @ApiProperty({ type: [ZoomRowDto] }) rows!: ZoomRowDto[];
  /**
   * 「지금」이 뜻을 갖는 것은 **오늘뿐**이다. 다른 날을 보면 null 이고, 화면은 그 칸을 비운다.
   * 예전에는 이 칸이 「하루 내내 한 번도 안 쓰는 계정 수」였다 — 원문 §21 은
   * 다섯 계정 모두 낮에 붉은 칸이 있는데도 「지금 가능 5」라고 적는다. 묻는 것이 다르다.
   */
  @ApiProperty({ type: Number, nullable: true, description: '이 셈이 선 시각(KST 시). 오늘이 아니면 null' })
  nowHour!: number | null;
  @ApiProperty({ description: '지금 이 시각에 비어 있는 계정 수 — §21 머리의 「지금 가능」' }) freeNow!: number;
  /** `freeNow` 와 **같은 배열**에서 낸다. 이름과 수가 갈리지 않는 유일한 방법이다 (D-R37). */
  @ApiProperty({ type: [String], description: '지금 쓸 수 있는 계정 이름 — §21 아래줄' })
  freeLabels!: string[];
  @ApiProperty({ description: '한 칸도 안 남은 시간대 수 — §21 머리의 「만석 시간대」' }) fullHours!: number;
}

export class ZoomAccountCreateDto {
  @ApiProperty({ minLength: 1, maxLength: 20 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(20)
  label!: string;

  @ApiProperty({ minLength: 1, maxLength: 120 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(120)
  loginEmail!: string;

  @ApiProperty({ maxLength: 500, description: '로그인 정보가 없는 절대 HTTP(S) 참가 주소' })
  @IsString() @MaxLength(500)
  @IsSafeHttpUrl({ message: '참가 링크는 로그인 정보가 없는 올바른 HTTP(S) 주소여야 합니다' })
  joinUrl!: string;

  @ApiPropertyOptional({ maxLength: 30 })
  @ValidateIf((_object, value) => value !== undefined) @IsString() @MaxLength(30)
  meetingId?: string;

  @ApiPropertyOptional({ maxLength: 200, description: '줌 로그인 비밀 — 평문으로 두지 않는다. 넣으면 암호화해 저장한다' })
  @ValidateIf((_object, value) => value !== undefined) @IsString() @MaxLength(200)
  loginSecret?: string;

  @ApiPropertyOptional({ maxLength: 50, description: '회의 비밀번호 — 같은 방식으로 저장한다' })
  @ValidateIf((_object, value) => value !== undefined) @IsString() @MaxLength(50)
  meetingPw?: string;
}

export class ZoomAccountPatchDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 20 })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(20) label?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(120) loginEmail?: string;

  @ApiPropertyOptional({ maxLength: 500, description: '로그인 정보가 없는 절대 HTTP(S) 참가 주소' })
  @ValidateIf((_object, value) => value !== undefined) @IsString() @MaxLength(500)
  @IsSafeHttpUrl({ message: '참가 링크는 로그인 정보가 없는 올바른 HTTP(S) 주소여야 합니다' }) joinUrl?: string;

  @ApiPropertyOptional({ maxLength: 30, description: '생략은 유지, 빈 문자열은 회의 ID 삭제. null은 거절' })
  @ValidateIf((_object, value) => value !== undefined) @IsString() @MaxLength(30) meetingId?: string;

  @ApiPropertyOptional({ maxLength: 200, description: '생략·빈 문자열은 기존 비밀 유지. 나머지 문자열은 공백까지 보존' })
  @ValidateIf((_object, value) => value !== undefined) @IsString() @MaxLength(200) loginSecret?: string;

  @ApiPropertyOptional({ maxLength: 50, description: '생략·빈 문자열은 기존 비밀번호 유지. 나머지 문자열은 공백까지 보존' })
  @ValidateIf((_object, value) => value !== undefined) @IsString() @MaxLength(50) meetingPw?: string;
  @ApiPropertyOptional({ description: '끄면 새 배정에서 빠진다. 이미 붙은 회차는 건드리지 않는다' })
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() active?: boolean;
}

export class ZoomAccountParamsDto {
  @ApiProperty(ID_SCHEMA)
  @ToHttpInteger() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  id!: number;
}

/**
 * 배정 — **회차 하나**(`onDate` 를 주면)거나 **규칙 전체**(안 주면)다.
 * 겹침은 마지막에 `ser_occ` 의 EXCLUDE 가 막는다 — 같은 계정이 같은 시간에 두 번 붙지 않는다.
 */
export class ZoomAssignDto {
  @ApiProperty({ description: '어느 수업 규칙인가' })
  @IsInt() @Min(1)
  serId!: number;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD. 주면 그 회차만, 안 주면 규칙 전체' })
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '날짜는 YYYY-MM-DD 입니다' })
  onDate?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '붙일 계정. null 이면 뗀다' })
  @IsOptional() @IsInt() @Min(1)
  zaccId?: number | null;
}

export class ZoomAssignResultDto {
  @ApiProperty() serId!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) onDate?: string | null;
  @ApiProperty({ type: Number, nullable: true }) zaccId!: number | null;
  @ApiProperty({ description: '다시 그린 회차 수' }) projected!: number;
}

export class ZoomBoardQueryDto {
  @ApiPropertyOptional({ ...DATE_SCHEMA, description: '기준일 YYYY-MM-DD (KST). 없으면 오늘' })
  @ValidateIf((_object, value) => value !== undefined) @IsCalendarDate()
  onDate?: string;
}
