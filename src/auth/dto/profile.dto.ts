/** @file-guide
 * 목적: profile.dto.ts — ProfileDto, ProfileContactCodesDto, ProfileUpdateDto, ProfileContactCodeRequestDto, ProfileContactChangeDto (dto)
 * 책임/재사용: 본인 마이페이지(AUTH-SELF-01) 입력/응답을 Swagger와 validator로 명시한다. 코드 채널 · 나라 목록 · 코드 결과는 첫 설정 DTO를 재사용한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 본인 마이페이지 (AUTH-SELF-01 · 사용자 결정 2026-10-16) — 로그인한 사람이 **자기** 이름 · 영어 이름을 고치고,
 * 이메일 · 휴대폰은 새 수신처로 받은 코드와 지금 비밀번호로 확인한 뒤에만 바꾼다.
 *
 * 경로에 사람 id 가 없다 — 대상은 늘 세션의 본인이다. 전역 ValidationPipe(forbidNonWhitelisted)가 role · id · verified ·
 * email · phone 같은 칸을 PATCH 에 실으면 400 으로 거절한다(연락처는 확인 경로로만 바뀐다).
 * 타인 수정(구성원 관리 · 대표/관리자 보호 규칙)과 섞지 않는다.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { SEND_CHANNELS, type SendChannel } from '../../modules/notify/sender';
import { OnboardingChannelDto, OnboardingCodeRequestDto, PhoneCountryDto } from './onboarding.dto';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** 연락처 변경 코드의 채널 표 · 나라 목록 · 시간 — 첫 설정과 같은 원장 한 곳(auth-code · lib/phone)에서 온다 */
export class ProfileContactCodesDto {
  @ApiProperty({ type: [OnboardingChannelDto], description: '코드를 받을 채널 — 낱말 · 못 보내는 까닭은 서버가 준다' })
  channels!: OnboardingChannelDto[];
  @ApiProperty({ type: [PhoneCountryDto], description: '휴대폰 국가번호 목록 — 첫 줄이 대한민국(기본값)' })
  phoneCountries!: PhoneCountryDto[];
  @ApiProperty({ description: '코드 유효 시간(분)' }) codeTtlMinutes!: number;
  @ApiProperty({ description: '같은 채널로 다시 받기까지 기다릴 초' }) resendAfterSeconds!: number;
}

/** GET /auth/profile — 본인 화면에 필요한 최소 정보. 비밀번호 해시 · 권한 예외 · 세션 시각은 싣지 않는다 */
export class ProfileDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: '로그인 아이디 — 매니저가 정한 그대로(본인 화면에서 바꾸지 않는다)' }) loginId!: string;
  @ApiProperty({ description: '이름 — 셸 · 구성원 목록과 같은 칸(STAFF.name)' }) name!: string;
  @ApiProperty({ type: String, nullable: true, description: '영어 이름 — 비어 있으면 null' }) englishName!: string | null;
  @ApiProperty({ description: '역할의 이름 — 표시용(판정은 MeDto 플래그)' }) roleLabel!: string;
  @ApiProperty({ type: String, nullable: true, description: '직함 — 권한과 무관' }) title!: string | null;
  @ApiProperty({ type: String, nullable: true, description: '본인 이메일(연락 · 인증용 · 아이디가 아니다)' }) email!: string | null;
  @ApiProperty({ description: '이메일 인증 완료 여부' }) emailVerified!: boolean;
  @ApiProperty({ type: String, nullable: true, description: '본인 휴대폰 — 한국은 숫자만 · 해외는 +국가번호…' }) phone!: string | null;
  @ApiProperty({ description: '휴대폰 인증 완료 여부' }) phoneVerified!: boolean;
  @ApiProperty({ type: String, nullable: true, description: '입사일 YYYY-MM-DD — 옛 계정은 null 일 수 있다' }) hiredOn!: string | null;
  @ApiProperty({ type: ProfileContactCodesDto }) contactCodes!: ProfileContactCodesDto;
}

/**
 * PATCH /auth/profile — 이름 · 영어 이름만. **생략 = 그대로 둔다.**
 * name 은 비울 수 없다(null · 빈 글자는 400). 길이 · 앞뒤 공백 규칙은 구성원 만들기(StaffCreateDto.name)와 같다.
 * englishName 은 null 또는 앞뒤 공백을 지운 빈 글자면 **비운다**(NULL 로 저장). 임의 영문 정규식은 두지 않는다.
 */
export class ProfileUpdateDto {
  @ApiPropertyOptional({ maxLength: 40, description: '이름 — 생략하면 그대로 · null/빈 글자는 400' })
  @ValidateIf((o: ProfileUpdateDto) => o.name !== undefined)
  @Transform(trimmed)
  @IsString({ message: '이름을 적어 주세요' }) @MinLength(1, { message: '이름을 적어 주세요' }) @MaxLength(40, { message: '이름은 40자까지입니다' })
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 40, description: '영어 이름 — 생략하면 그대로 · null 또는 빈 글자면 비운다' })
  @IsOptional()
  @Transform(trimmed)
  @IsString({ message: '영어 이름은 글자로 적어 주세요' }) @MaxLength(40, { message: '영어 이름은 40자까지입니다' })
  englishName?: string | null;
}

/** POST /auth/profile/contact-codes — 바꿀 **새** 이메일 또는 휴대폰으로 코드를 보낸다(첫 설정 코드 요청과 같은 모양) */
export class ProfileContactCodeRequestDto extends OnboardingCodeRequestDto {}

const CODE = /^\d{6}$/;

/**
 * POST /auth/profile/contact-change — 새 수신처 · 그 수신처로 받은 코드 · 지금 비밀번호를 한 번에.
 * 코드와 비밀번호가 둘 다 맞기 전에는 지금 값과 인증 상태가 그대로다. 연락처를 비우는 입력은 없다.
 */
export class ProfileContactChangeDto {
  @ApiProperty({ enum: SEND_CHANNELS, description: 'email = 이메일 바꾸기 · sms = 휴대폰 바꾸기' })
  @IsIn(SEND_CHANNELS as unknown as string[], { message: '바꿀 연락처는 이메일 또는 휴대폰입니다' })
  channel!: SendChannel;

  @ApiProperty({ example: 'kim@tnacademy.kr', maxLength: 160, description: '새 이메일 주소 또는 휴대폰 번호 — 코드를 받은 그 수신처' })
  @IsString({ message: '새 이메일 주소나 휴대폰 번호를 적어 주세요' })
  @MaxLength(160, { message: '받을 곳이 너무 깁니다' })
  target!: string;

  @ApiProperty({ example: '123456', pattern: '^\\d{6}$', description: '새 수신처로 받은 코드' })
  @IsString({ message: '인증 코드를 적어 주세요' })
  @Matches(CODE, { message: '인증 코드는 숫자 6자리입니다' })
  code!: string;

  @ApiProperty({ example: '********', maxLength: 200, description: '지금 비밀번호 — 다시 확인한다. 응답 · 기록에는 싣지 않는다' })
  @IsString({ message: '지금 비밀번호를 적어 주세요' })
  @MinLength(1, { message: '지금 비밀번호를 적어 주세요' })
  @MaxLength(200, { message: '비밀번호가 너무 깁니다' })
  currentPassword!: string;
}
