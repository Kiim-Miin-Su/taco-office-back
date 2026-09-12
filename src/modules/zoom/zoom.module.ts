/** @file-guide
 * 목적: zoom.module.ts — ZoomModule (module)
 * 책임/재사용: 기존 provider/controller와 의존성 연결만 소유한다. 업무 규칙이나 별도 전역 상태를 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Zacc } from '../../entities';
import { ZoomController } from './zoom.controller';
import { ZoomService } from './zoom.service';

@Module({
  imports: [TypeOrmModule.forFeature([Zacc])],
  controllers: [ZoomController],
  providers: [ZoomService],
  exports: [ZoomService],
})
export class ZoomModule {}
