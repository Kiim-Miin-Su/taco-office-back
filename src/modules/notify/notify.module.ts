/** @file-guide
 * 목적: notify.module.ts — NotifyModule (module)
 * 책임/재사용: 기존 provider/controller와 의존성 연결만 소유한다. 업무 규칙이나 별도 전역 상태를 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Global, Module } from '@nestjs/common';
import { LiveSender } from './live.sender';
import { SENDER } from './sender';

/**
 * 발송 경계를 전역으로 둔다 — 리포트 전달·수업 안내·계약서 전달이 모두 같은 것을 쓴다.
 * 구현을 바꿀 때 한 곳만 바꾸면 된다.
 */
@Global()
@Module({
  providers: [LiveSender, { provide: SENDER, useExisting: LiveSender }],
  exports: [SENDER],
})
export class NotifyModule {}
