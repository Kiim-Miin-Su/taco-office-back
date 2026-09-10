/** @file-guide
 * 목적: auth.dto.ts — LoginDto, MeDto, LoginResultDto, RefreshResultDto (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { ROLES, type PermFlags, type Role } from '../../common/perm';

export class LoginDto {
  @ApiProperty({ example: 'kim@tnacademy.kr', format: 'email' })
  @IsEmail({}, { message: '이메일 형식이 아닙니다' })
  email!: string;

  @ApiProperty({ example: '********', minLength: 8 })
  @IsString()
  @MinLength(8, { message: '비밀번호는 8자 이상입니다' })
  password!: string;
}

/**
 * `/auth/me` 응답 — **플래그를 서버가 내려준다.**
 * 프론트가 role 을 보고 다시 파생하면 판정이 두 벌이 된다 (D-R39).
 */
export class MeDto implements PermFlags {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ROLES }) role!: Role;
  @ApiProperty({ type: String, nullable: true, description: '직함 — 권한과 무관' }) title!: string | null;

  @ApiProperty({ description: '관리자 백오피스 진입' }) canAdminPage!: boolean;
  @ApiProperty({ description: '전 항목 CRUD' }) canCrudAll!: boolean;
  @ApiProperty({ description: '지출 · 총수입 — 대표 전용' }) canSeeProfit!: boolean;
  @ApiProperty({ description: '오늘·이전 스케줄 출결 (D-R35)' }) canCrudAttendance!: boolean;
  @ApiProperty() canMoney!: boolean;
  @ApiProperty() canWage!: boolean;
  @ApiProperty() canApprove!: boolean;
  @ApiProperty() canHide!: boolean;
  @ApiProperty() canGpaPack!: boolean;
}

export class LoginResultDto {
  @ApiProperty({ description: 'Access 토큰 (15분). Refresh 는 httpOnly 쿠키로 나갑니다' })
  accessToken!: string;

  @ApiProperty({ type: MeDto })
  user!: MeDto;
}

export class RefreshResultDto {
  @ApiProperty() accessToken!: string;
}
