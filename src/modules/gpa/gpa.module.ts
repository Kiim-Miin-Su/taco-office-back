/** @file-guide
 * 목적: gpa.module.ts — GpaModule (module)
 * 책임/재사용: 기존 provider/controller와 의존성 연결만 소유한다. 업무 규칙이나 별도 전역 상태를 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GpaCycle } from '../../entities';
import { GpaController } from './gpa.controller';
import { GpaService } from './gpa.service';

@Module({
  imports: [TypeOrmModule.forFeature([GpaCycle])],
  controllers: [GpaController],
  providers: [GpaService],
  exports: [GpaService], // §14 「GPA 회차 요청」 승인이 같은 기록 함수를 부른다 (N-99 · P 영역 한 줄)
})
export class GpaModule {}
