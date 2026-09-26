/** @file-guide
 * 목적: password-reset.dto.ts — PasswordResetInfoDto, PasswordResetCodeRequestDto, PasswordResetCodeResultDto, PasswordResetCompleteDto (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 비밀번호 찾기 (N-101 · 대표 결정 2026-09-26 「로그인 화면의 비밀번호 찾기 — 등록된 이메일과 휴대폰 코드를 둘 다 확인해야
 * 새 비밀번호를 정한다 · 옛 세션은 끊는다 · 모든 역할」).
 *
 * 로그인 전 화면이 부른다(@Public). 그래서 **계정이 있는지 알려 주지 않는다** — 코드 받기는 계정이 없거나 · 확인되지 않았거나 ·
 * 한도에 걸렸거나 · 보내지 못했어도 같은 모양으로 답하고, 마치기는 코드 · 계정 문제를 한 문장으로 답한다(로그인 실패와 같은 원칙).
 * 모양 검사만 여기서 본다 — 비밀번호 규칙은 서비스가 `lib/account-policy` 한 곳으로 판정한다(첫 설정과 같다).
 *
 * 아이디는 형식이 자유다(W10) — `loginId` 로 받는다. `email` 은 옛 화면 호환 별칭(로그인과 같다 · 다음 배포 뒤 지운다).
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { SEND_CHANNELS, type SendChannel } from '../../modules/notify/sender';
import { OnboardingChannelDto } from './onboarding.dto';

export class PasswordResetInfoDto {
  @ApiProperty({ description: '비밀번호 규칙 문장 — 화면은 이 문장을 그대로 적는다(첫 설정과 같은 문장)' }) passwordRule!: string;
  @ApiProperty({ description: '코드 유효 시간(분)' }) codeTtlMinutes!: number;
  @ApiProperty({ description: '같은 채널로 다시 받기까지 기다릴 초' }) resendAfterSeconds!: number;
  @ApiProperty({ type: [OnboardingChannelDto], description: '코드 채널 — 낱말 · 못 보내는 까닭은 서버가 준다(첫 설정과 같은 표)' })
  channels!: OnboardingChannelDto[];
}

export class PasswordResetCodeRequestDto {
  @ApiProperty({ example: 'kim.teacher', maxLength: 120, description: '로그인 아이디(형식 자유 · 대소문자 무시) — 코드는 이 계정에 **등록 · 확인된** 이메일 · 휴대폰으로만 간다' })
  @ValidateIf((o: PasswordResetCodeRequestDto) => o.email === undefined)
  @IsString({ message: '아이디를 적어 주세요' })
  @MinLength(1, { message: '아이디를 적어 주세요' })
  @MaxLength(120, { message: '아이디가 너무 깁니다' })
  loginId?: string;

  @ApiPropertyOptional({ deprecated: true, maxLength: 160, description: '옛 화면 호환 — loginId 와 같은 뜻(W10 이전 화면이 보낸다)' })
  @IsOptional() @IsString() @MaxLength(160)
  email?: string;

  @ApiProperty({ enum: SEND_CHANNELS, description: 'email = 등록된 이메일로 · sms = 등록된 휴대폰으로' })
  @IsIn(SEND_CHANNELS as unknown as string[], { message: '코드를 받을 곳은 이메일 또는 휴대폰입니다' })
  channel!: SendChannel;
}

export class PasswordResetCodeResultDto {
  @ApiProperty({ enum: SEND_CHANNELS }) channel!: SendChannel;
  @ApiProperty({
    description: '안내 문장 — 계정이 있든 없든 같다(보낸 곳 · 계정 여부를 싣지 않는다). 화면은 이 문장을 그대로 적는다',
  })
  message!: string;
  @ApiProperty({ type: String, format: 'date-time', description: '보냈다면 코드가 만료되는 시각' }) expiresAt!: string;
  @ApiProperty({ description: '같은 채널로 다시 받기까지 기다릴 초' }) resendAfterSeconds!: number;
  @ApiPropertyOptional({
    description: '개발용 — 운영이 아니고 서버의 AUTH_CODE_DEV_ECHO=on 이며 발송 설정이 없고 코드를 실제로 만들었을 때만 실린다. 운영 응답에는 절대 없다',
  })
  devCode?: string;
}

const CODE = /^\d{6}$/;

export class PasswordResetCompleteDto {
  @ApiProperty({ example: 'kim.teacher', maxLength: 120, description: '로그인 아이디 — 코드를 받은 계정' })
  @ValidateIf((o: PasswordResetCompleteDto) => o.email === undefined)
  @IsString({ message: '아이디를 적어 주세요' })
  @MinLength(1, { message: '아이디를 적어 주세요' })
  @MaxLength(120, { message: '아이디가 너무 깁니다' })
  loginId?: string;

  @ApiPropertyOptional({ deprecated: true, maxLength: 160, description: '옛 화면 호환 — loginId 와 같은 뜻(W10 이전 화면이 보낸다)' })
  @IsOptional() @IsString() @MaxLength(160)
  email?: string;

  @ApiProperty({ example: '123456', pattern: '^\\d{6}$', description: '등록된 이메일로 받은 코드' })
  @IsString({ message: '이메일 인증 코드를 적어 주세요' })
  @Matches(CODE, { message: '이메일 인증 코드는 숫자 6자리입니다' })
  emailCode!: string;

  @ApiProperty({ example: '123456', pattern: '^\\d{6}$', description: '등록된 휴대폰으로 받은 코드' })
  @IsString({ message: '휴대폰 인증 코드를 적어 주세요' })
  @Matches(CODE, { message: '휴대폰 인증 코드는 숫자 6자리입니다' })
  phoneCode!: string;

  @ApiProperty({ example: '********', maxLength: 200, description: '새 비밀번호 — 규칙은 GET /auth/password-reset 의 passwordRule' })
  @IsString({ message: '새 비밀번호를 적어 주세요' })
  @MaxLength(200, { message: '비밀번호가 너무 깁니다' })
  password!: string;
}
