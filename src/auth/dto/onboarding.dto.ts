/** @file-guide
 * 목적: onboarding.dto.ts — PhoneCountryDto, OnboardingChannelDto, OnboardingInfoDto, OnboardingCodeRequestDto, OnboardingCodeResultDto, OnboardingCompleteDto (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 계정 첫 설정 (W8 · 대표 지시 2026-09-26) — 「첫 로그인 시 아이디 및 비밀번호 강제 변경 · phone · email 인증 필수」.
 *
 * 입력 검사는 **모양만** 여기서 본다(글자 수 · 코드 여섯 자리 · 채널 낱말). 이메일 · 휴대폰 · 비밀번호 규칙은
 * 서비스가 `lib/account-policy` 한 곳으로 판정한다 — 비밀번호 규칙을 여기에도 적으면 문장과 판정이 두 벌이 된다
 * (그래서 비밀번호 거절은 400 BAD_REQUEST 가 아니라 400 PASSWORD_RULE 로 규칙 문장을 그대로 돌려준다).
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import { SEND_CHANNELS, type SendChannel } from '../../modules/notify/sender';

/**
 * 휴대폰 국가번호 고르기의 한 줄 (N-103 · 대표 결정 2026-09-26 「해외 번호도 받기」). 목록은 서버 한 곳(lib/phone)이 준다 —
 * 첫 설정 화면과 구성원 만들기 · 수정 창이 같은 목록을 쓴다. 화면은 `+code 번호` 모양의 글 하나로 보낸다.
 */
export class PhoneCountryDto {
  @ApiProperty({ example: '82', description: '국가번호 — + 없이 숫자만' }) code!: string;
  @ApiProperty({ example: '대한민국', description: '나라 이름' }) label!: string;
}

export class OnboardingChannelDto {
  @ApiProperty({ enum: SEND_CHANNELS }) channel!: SendChannel;
  /* 낱말은 발송기 채널 표(CHANNEL_SPECS)에서 온다 — 화면이 「메일」·「문자」를 다시 적지 않는다 */
  @ApiProperty({ description: '채널 이름 — 「메일」·「문자」' }) label!: string;
  @ApiProperty({ description: '지금 코드를 보낼 수 있는가 — 아니면 화면이 단추를 잠근다' }) ready!: boolean;
  @ApiProperty({ type: String, nullable: true, description: '보낼 수 없는 까닭 — ready=false 일 때만' })
  notReadyReason!: string | null;
}

export class OnboardingInfoDto {
  @ApiProperty({ description: '이 계정이 첫 설정을 해야 하는가 — false 면 화면은 일정으로 보낸다' }) required!: boolean;
  @ApiProperty({ description: '지금 로그인 아이디(이메일)' }) loginId!: string;
  @ApiProperty({ type: String, nullable: true, description: '지금 등록된 휴대폰(가린 모양) — 없으면 null' })
  phoneMasked!: string | null;
  @ApiProperty({ description: '비밀번호 규칙 문장 — 화면은 이 문장을 그대로 적는다' }) passwordRule!: string;
  @ApiProperty({ description: '코드 유효 시간(분)' }) codeTtlMinutes!: number;
  @ApiProperty({ description: '같은 채널로 다시 받기까지 기다릴 초' }) resendAfterSeconds!: number;
  @ApiProperty({ type: [OnboardingChannelDto] }) channels!: OnboardingChannelDto[];
  @ApiProperty({ type: [PhoneCountryDto], description: '휴대폰 국가번호 목록 — 첫 줄이 대한민국(기본값)' })
  phoneCountries!: PhoneCountryDto[];
}

export class OnboardingCodeRequestDto {
  @ApiProperty({ enum: SEND_CHANNELS, description: 'email = 새 아이디(이메일)로 · sms = 휴대폰으로' })
  @IsIn(SEND_CHANNELS as unknown as string[], { message: '코드를 받을 곳은 이메일 또는 휴대폰입니다' })
  channel!: SendChannel;

  @ApiProperty({ example: 'kim@tnacademy.kr', maxLength: 160, description: '받을 이메일 주소 또는 휴대폰 번호' })
  @IsString({ message: '받을 이메일 주소나 휴대폰 번호를 적어 주세요' })
  @MaxLength(160, { message: '받을 곳이 너무 깁니다' })
  target!: string;
}

export class OnboardingCodeResultDto {
  @ApiProperty({ enum: SEND_CHANNELS }) channel!: SendChannel;
  @ApiProperty({ description: '코드를 보낸 곳(가린 모양)' }) targetMasked!: string;
  @ApiProperty({ type: String, format: 'date-time', description: '코드가 만료되는 시각' }) expiresAt!: string;
  @ApiProperty({ description: '같은 채널로 다시 받기까지 기다릴 초' }) resendAfterSeconds!: number;
  @ApiPropertyOptional({
    description: '개발용 — 운영이 아니고 서버의 AUTH_CODE_DEV_ECHO=on 이며 발송 설정이 없을 때만 실린다. 운영 응답에는 절대 없다',
  })
  devCode?: string;
}

const CODE = /^\d{6}$/;

export class OnboardingCompleteDto {
  @ApiProperty({ example: 'kim@tnacademy.kr', maxLength: 160, description: '새 로그인 아이디(이메일) — 코드를 받은 주소' })
  @IsString({ message: '새 아이디(이메일)를 적어 주세요' })
  @MaxLength(160, { message: '이메일이 너무 깁니다' })
  email!: string;

  @ApiProperty({ example: '********', maxLength: 200, description: '새 비밀번호 — 규칙은 GET /auth/onboarding 의 passwordRule' })
  @IsString({ message: '새 비밀번호를 적어 주세요' })
  @MaxLength(200, { message: '비밀번호가 너무 깁니다' })
  password!: string;

  @ApiProperty({
    example: '010-1234-5678', maxLength: 32,
    description: '휴대폰 번호 — 코드를 받은 번호. 해외 번호는 `+국가번호 번호`(N-103 · 나라는 phoneCountries)',
  })
  @IsString({ message: '휴대폰 번호를 적어 주세요' })
  @MaxLength(32, { message: '휴대폰 번호가 너무 깁니다' })
  phone!: string;

  @ApiProperty({ example: '123456', pattern: '^\\d{6}$', description: '이메일로 받은 코드' })
  @IsString({ message: '이메일 인증 코드를 적어 주세요' })
  @Matches(CODE, { message: '이메일 인증 코드는 숫자 6자리입니다' })
  emailCode!: string;

  @ApiProperty({ example: '123456', pattern: '^\\d{6}$', description: '휴대폰으로 받은 코드' })
  @IsString({ message: '휴대폰 인증 코드를 적어 주세요' })
  @Matches(CODE, { message: '휴대폰 인증 코드는 숫자 6자리입니다' })
  phoneCode!: string;
}
