/** @file-guide
 * 목적: auth.dto.ts — LoginDto, MeDto, LoginResultDto, RefreshResultDto (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { ROLES, type PermFlags, type Role } from '../../common/perm';

/**
 * 로그인 (W10 · 대표 지시 2026-09-26 「아이디 형식은 자유」) — 아이디는 이메일이 아니다. 대소문자를 가리지 않는다.
 *
 * `email` 은 **옛 화면 호환 별칭**이다 — 마이그레이션은 back 배포 전에 돌고 front · back 은 따로 배포되므로, 새 서버가
 * 먼저 떠도 옛 화면(`{ email, password }`)이 로그인할 수 있게 둔다. 옛 계정의 아이디는 이메일이 옮겨 와 있어 뜻이 같다.
 * 새 코드는 `loginId` 만 보낸다. 다음 배포 뒤 지운다(TODO · W10).
 */
export class LoginDto {
  @ApiProperty({ example: 'kim.teacher', maxLength: 120, description: '로그인 아이디 — 형식 자유 · 대소문자 무시' })
  @ValidateIf((o: LoginDto) => o.email === undefined)
  @IsString({ message: '아이디를 적어 주세요' })
  @MinLength(1, { message: '아이디를 적어 주세요' })
  @MaxLength(120, { message: '아이디가 너무 깁니다' })
  loginId?: string;

  @ApiPropertyOptional({ deprecated: true, maxLength: 120, description: '옛 화면 호환 — loginId 와 같은 뜻(W10 이전 화면이 보낸다). 새 코드는 쓰지 않는다' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  email?: string;

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
  /* 낱말은 서버가 만든다 (D-R18). 화면이 제 표를 들고 있으면 서랍 §17 과 머리 배지가 갈린다 */
  @ApiProperty({ description: '역할의 이름 — 「강사」·「매니저」… 판정이 아니라 표시용이다' }) roleLabel!: string;

  @ApiProperty({ description: '관리자 백오피스 진입' }) canAdminPage!: boolean;
  @ApiProperty({ description: '전 항목 CRUD' }) canCrudAll!: boolean;
  @ApiProperty({ description: '지출 · 총수입 — 대표 전용' }) canSeeProfit!: boolean;
  @ApiProperty({ description: '오늘·이전 스케줄 출결 (D-R35)' }) canCrudAttendance!: boolean;
  @ApiProperty() canMoney!: boolean;
  @ApiProperty() canWage!: boolean;
  @ApiProperty() canApprove!: boolean;
  @ApiProperty() canHide!: boolean;
  @ApiProperty() canGpaPack!: boolean;

  /*
   * W8 · 대표 지시 2026-09-26 — 켜져 있으면 화면은 첫 설정(/onboarding) 밖으로 나가지 못하고 서버도 403 이다.
   * 서버는 **늘** 채운다. 계약에서만 선택 칸인 이유: 화면 시험의 Me 대역 수십 벌을 한꺼번에 고치지 않으려고(빠지면 false 로 읽는다).
   */
  @ApiProperty({ required: false, description: '첫 설정(휴대폰 · 이메일 인증 · 새 비밀번호)을 끝내야 하는가 — 서버는 늘 채운다' })
  mustChangeCredentials?: boolean;
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
