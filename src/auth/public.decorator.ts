import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'taco:public';

/** 인증 없이 열어 두는 엔드포인트 — 로그인 · 토큰 재발급 · 헬스체크뿐이어야 한다. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
