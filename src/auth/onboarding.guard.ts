/** @file-guide
 * 목적: onboarding.guard.ts — ONBOARDING_REQUIRED_MESSAGE, OnboardingGuard (auth)
 * 책임/재사용: 공용 인증/권한 경계만 소유한다. 토큰·쿠키 원문을 노출하지 않고 만료/익명/권한 회수 경계를 회귀로 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestUser } from '../common/perm';
import { IS_PUBLIC } from './public.decorator';
import { ALLOW_WHILE_ONBOARDING } from './allow-while-onboarding.decorator';

export const ONBOARDING_REQUIRED_MESSAGE = '첫 설정을 먼저 마쳐 주세요 — 휴대폰 · 이메일 확인과 새 비밀번호';

/**
 * 첫 설정 잠금 (W8 · 대표 지시 2026-09-26).
 *
 * 「첫 로그인 시 주요 인증(휴대폰 · 이메일) 및 비밀번호 재설정 — 안 하면 홈 페이지 접속 불가」(W8 · W10).
 * 화면이 돌려보내는 것만으로는 부족하다 — 임시 비밀번호를 아는 사람(만든 매니저 포함)이 API 를 직접 부르면 그만이다.
 * 그래서 **JwtAuthGuard 바로 뒤 · PermGuard 앞**에 둔다: request.user 가 채워진 뒤에 판정하고,
 * 권한 문장(「canCrudAll 권한이 필요합니다」)보다 먼저 「첫 설정」이라는 진짜 까닭을 말한다.
 *
 * 판정 재료 `mustChange` 는 JwtStrategy 가 **매 요청 현재 STAFF 에서** 다시 읽은 값이다(토큰에 싣지 않는다) —
 * 첫 설정을 마치는 순간 같은 계정의 다음 요청부터 풀리고, 관리자가 다시 켜면 다음 요청부터 잠긴다.
 */
@Injectable()
export class OnboardingGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    // 공개 경로(로그인 · 재발급 · 로그아웃 …)와 첫 설정 경로는 판정하지 않는다
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_WHILE_ONBOARDING, targets)) return true;
    const user = ctx.switchToHttp().getRequest<{ user?: RequestUser }>().user;
    if (user?.mustChange === true) {
      throw new ForbiddenException({ code: 'CREDENTIALS_CHANGE_REQUIRED', message: ONBOARDING_REQUIRED_MESSAGE });
    }
    return true;
  }
}
