/** @file-guide
 * 목적: current-user.decorator.ts — CurrentUser (auth)
 * 책임/재사용: 공용 인증/권한 경계만 소유한다. 토큰·쿠키 원문을 노출하지 않고 만료/익명/권한 회수 경계를 회귀로 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { RequestUser } from '../common/perm';

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestUser =>
    ctx.switchToHttp().getRequest<{ user: RequestUser }>().user,
);
