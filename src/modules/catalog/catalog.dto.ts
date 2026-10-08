/** @file-guide
 * 목적: catalog.dto.ts — REP_FORMS, KindRowsDto, SubRowDto, CatalogDto, KindCreateDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { KIND_GROUPS } from '../../lib/catalog-words';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

/* 묶음 낱말은 `lib/catalog-words` 하나에서 온다 — 서랍(§18)과 이 화면이 같은 표를 쓴다 (D-R18) */
export { KIND_GROUPS, KIND_GROUP_LABEL } from '../../lib/catalog-words';

/** 리포트 서식 — 원문 §18 의 「리포트」 표시가 붙는 프로그램만 고른다 */
export const REP_FORMS = ['dev', 'assess'] as const;

/** 최종 관리자 수정사항 p6의 과목 색 8개. Catalog 응답도 이 배열을 그대로 내려 Front에 사본을 두지 않는다. */
export const SUBJECT_COLORS = [
  '#A85764', '#B57046', '#4A7FB5', '#3E8E5E', '#7C5CB5', '#C08A2E', '#2F8F8A', '#8B6B5A',
] as const;

export class KindRowsDto {
  @ApiProperty({ description: '코드 — 한 번 정하면 바꾸지 않는다. 시간표가 이 낱말로 저장돼 있다' }) key!: string;
  @ApiProperty() name!: string;
  @ApiProperty() color!: string;
  @ApiProperty({ description: '정원' }) cap!: number;
  @ApiProperty({ enum: KIND_GROUPS }) grp!: string;
  @ApiProperty({ description: '묶음 이름 — 코드표는 서버가 소유한다 (D-R18)' }) grpLabel!: string;
  @ApiProperty({ description: '리포트 작성·차감 대상인가 (§18 원문의 「리포트」 표시)' }) rep!: boolean;
  @ApiPropertyOptional({ type: String, nullable: true, enum: REP_FORMS }) repForm?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) sort?: number | null;
  @ApiProperty({ description: '추가 수업인가 — 시간표 「추가」 배지 · §54 「추가」 칸 · 청구서 별도 줄 (C94-d · C-38)' }) extra!: boolean;
  @ApiProperty({ description: '새 과목의 소유 프로그램으로 선택할 수 있는가. GPA 과거 원장은 false' }) subjectAssignable!: boolean;
  @ApiProperty({ description: '이 프로그램으로 돌고 있는 수업 규칙 수 — 0 이 아니면 코드를 바꿀 수 없다' }) serCount!: number;
}

export class SubRowDto {
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty() color!: string;
  @ApiProperty() active!: boolean;
  @ApiPropertyOptional({ type: Number, nullable: true }) sort?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: '과목이 속한 단일 프로그램. 미연결 legacy는 null' }) kindKey?: string | null;
  @ApiProperty({ description: '이 과목으로 돌고 있는 수업 규칙 수' }) serCount!: number;
}

export class CatalogDto {
  @ApiProperty({ type: [KindRowsDto] }) kinds!: KindRowsDto[];
  @ApiProperty({ type: [SubRowDto] }) subs!: SubRowDto[];
  @ApiProperty({ enum: SUBJECT_COLORS, isArray: true, description: '새 과목·색 변경에서 고르는 최종 8색' }) subjectColors!: string[];
}

const KEY = /^[a-z][a-z0-9_]{1,15}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

export class KindCreateDto {
  @ApiProperty({ description: '영문 소문자·숫자·밑줄. 한 번 정하면 바꾸지 않는다' })
  @IsString() @Matches(KEY, { message: '코드는 영문 소문자로 시작하는 2~16자입니다' })
  key!: string;

  @ApiProperty() @IsString() @MaxLength(30) name!: string;
  @ApiProperty({ description: '#RRGGBB' }) @IsString() @Matches(HEX, { message: '색은 #RRGGBB 입니다' }) color!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(100) cap!: number;
  @ApiProperty({ enum: KIND_GROUPS }) @IsIn(KIND_GROUPS as unknown as string[]) grp!: string;
  @ApiPropertyOptional({ description: '리포트 대상인가' }) @IsOptional() @IsBoolean() rep?: boolean;
  @ApiPropertyOptional({ enum: REP_FORMS }) @IsOptional() @IsIn(REP_FORMS as unknown as string[]) repForm?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) sort?: number;
  @ApiPropertyOptional({ description: '추가 수업인가 — 시간표 「추가」 배지 · §54 「추가」 칸 · 청구서 별도 줄 (C-38)' }) @IsOptional() @IsBoolean() extra?: boolean;
}

export class KindPatchDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(HEX) color?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(100) cap?: number;
  @ApiPropertyOptional({ enum: KIND_GROUPS }) @IsOptional() @IsIn(KIND_GROUPS as unknown as string[]) grp?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() rep?: boolean;
  @ApiPropertyOptional({ enum: REP_FORMS, nullable: true }) @IsOptional() @IsIn([...REP_FORMS, null] as unknown as string[]) repForm?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) sort?: number;
  @ApiPropertyOptional({ description: '추가 수업인가 (C-38)' }) @IsOptional() @IsBoolean() extra?: boolean;
}

export class SubCreateDto {
  @ApiProperty()
  @IsString() @Matches(/^[a-z][a-z0-9-]{1,19}$/, { message: '코드는 영문 소문자로 시작하는 2~20자입니다' })
  key!: string;

  @ApiProperty({ minLength: 1, maxLength: 40 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1, { message: '과목 이름을 적어 주세요' }) @MaxLength(40)
  name!: string;
  @ApiProperty({ description: '과목이 속한 단일 프로그램(kind.key)' })
  @IsString() @Matches(KEY, { message: '프로그램 코드 형식이 올바르지 않습니다' })
  kindKey!: string;
  @ApiProperty({ enum: SUBJECT_COLORS, description: '최종 관리자 수정사항 p6의 8색' })
  @IsString() @IsIn(SUBJECT_COLORS as unknown as string[])
  color!: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) sort?: number;
}

export class SubPatchDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 40 })
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1, { message: '과목 이름을 적어 주세요' }) @MaxLength(40)
  name?: string;
  @ApiPropertyOptional({ description: '새 프로그램. 기존 미연결/불일치 기록은 그대로 읽고 자동 병합하지 않는다' })
  @IsOptional() @IsString() @Matches(KEY)
  kindKey?: string;
  @ApiPropertyOptional({ description: '바꿀 때는 최종 8색만 허용. 기존 legacy 색을 그대로 보내는 것은 보존' })
  @IsOptional() @IsString() @Matches(HEX)
  color?: string;
  @ApiPropertyOptional({ description: '끄면 새 수업에서 고를 수 없다. 이미 도는 수업은 건드리지 않는다' })
  @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) sort?: number;
}
