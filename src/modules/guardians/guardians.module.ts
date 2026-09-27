/** @file-guide
 * 목적: guardians.module.ts — GuardiansModule (module)
 * 책임/재사용: 기존 provider/controller와 의존성 연결만 소유한다. 업무 규칙이나 별도 전역 상태를 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Module } from '@nestjs/common';
import { ConsultingModule } from '../consulting/consulting.module';
import { GuardiansController } from './guardians.controller';
import { GuardiansService } from './guardians.service';

/**
 * 보호자와 선택 발송 (DQ3) — 발송 경계 SENDER 는 전역 NotifyModule 이 준다.
 * 「계약서 전달하기」(N-77)는 컨설팅의 공개 범위 · 첨부 판정을 ConsultingService 에 맡긴다 — ConsultingModule 을 들여온다.
 */
@Module({
  imports: [ConsultingModule],
  controllers: [GuardiansController],
  providers: [GuardiansService],
})
export class GuardiansModule {}
