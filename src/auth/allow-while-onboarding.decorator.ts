/** @file-guide
 * 목적: allow-while-onboarding.decorator.ts — ALLOW_WHILE_ONBOARDING, AllowWhileOnboarding (auth)
 * 책임/재사용: 공용 인증/권한 경계만 소유한다. 토큰·쿠키 원문을 노출하지 않고 만료/익명/권한 회수 경계를 회귀로 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { SetMetadata } from '@nestjs/common';

export const ALLOW_WHILE_ONBOARDING = 'taco:allow-while-onboarding';

/**
 * 첫 설정 전 계정에도 열어 두는 **인증된** 경로 (W8 · 대표 지시 2026-09-26 「변경 안 하면 홈 접속 불가」).
 *
 * 기본은 잠겨 있다 — 첫 설정이 필요한 계정은 이 표시가 없는 모든 보호 API 에서 403 을 받는다.
 * 여는 곳은 `GET /auth/me`(화면이 잠김을 알아야 첫 설정으로 보낸다)와 첫 설정 세 경로뿐이다.
 * @Public 과 다르다: 로그인(Access 토큰)은 여전히 필요하다.
 */
export const AllowWhileOnboarding = () => SetMetadata(ALLOW_WHILE_ONBOARDING, true);
