import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { RequestUser } from '../common/perm';

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestUser =>
    ctx.switchToHttp().getRequest<{ user: RequestUser }>().user,
);
