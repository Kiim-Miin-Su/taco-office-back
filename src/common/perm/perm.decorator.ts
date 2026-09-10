/** @file-guide
 * 목적: perm.decorator.ts — PERM_KEY, Perm (auth)
 * 책임/재사용: 공용 인증/권한 경계만 소유한다. 토큰·쿠키 원문을 노출하지 않고 만료/익명/권한 회수 경계를 회귀로 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

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
