/** @file-guide
 * 목적: auth.module.ts — AuthModule (auth)
 * 책임/재사용: 공용 인증/권한 경계만 소유한다. 토큰·쿠키 원문을 노출하지 않고 만료/익명/권한 회수 경계를 회귀로 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Staff } from '../entities';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetService } from './password-reset.service';

@Module({
  imports: [TypeOrmModule.forFeature([Staff]), PassportModule, JwtModule.register({})],
  // 첫 설정(W8) · 비밀번호 찾기(N-101) — 발송은 전역 NotifyModule 의 SENDER 를 쓴다
  controllers: [AuthController, OnboardingController, PasswordResetController],
  providers: [AuthService, JwtStrategy, OnboardingService, PasswordResetService],
  exports: [AuthService],
})
export class AuthModule {}
