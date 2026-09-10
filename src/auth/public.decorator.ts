/** @file-guide
 * 목적: public.decorator.ts — IS_PUBLIC, Public (auth)
 * 책임/재사용: 공용 인증/권한 경계만 소유한다. 토큰·쿠키 원문을 노출하지 않고 만료/익명/권한 회수 경계를 회귀로 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiSecurity } from '@nestjs/swagger';

export const IS_PUBLIC = 'taco:public';

/** Access Bearer 예외를 공유한다. 별도 인증 수단은 문서에 명시하고 해당 handler가 검증한다. */
export const Public = (securityScheme?: string) => applyDecorators(
  SetMetadata(IS_PUBLIC, true), ApiSecurity(securityScheme ? { [securityScheme]: [] } : {}),
);
