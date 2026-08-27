import { SetMetadata } from '@nestjs/common';
import type { PermName } from './perm';

export const PERM_KEY = 'taco:perm';

/**
 * 이 엔드포인트에 필요한 권한.
 *
 *   @Perm('canCrudAll')
 *   @Patch('/attendance/:id')
 *   update() { … }
 *
 * 컨트롤러가 role 을 직접 보지 않게 하는 것이 목적이다 (D-R39).
 */
export const Perm = (...names: PermName[]) => SetMetadata(PERM_KEY, names);
