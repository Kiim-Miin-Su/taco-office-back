/** @file-guide
 * 목적: exec.module.ts — ExecModule (module)
 * 책임/재사용: 기존 provider/controller와 의존성 연결만 소유한다. 업무 규칙이나 별도 전역 상태를 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Lead } from '../../entities';
import { BoardModule } from '../board/board.module';
import { ExecController } from './exec.controller';
import { ExecService } from './exec.service';

@Module({
  // 수업 영역의 「덜 된 수업」 판정을 현황판에서 그대로 쓴다 (판정 복사 금지)
  imports: [TypeOrmModule.forFeature([Lead]), BoardModule],
  controllers: [ExecController],
  providers: [ExecService],
})
export class ExecModule {}
