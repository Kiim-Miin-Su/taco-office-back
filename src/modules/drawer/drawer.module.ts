/** @file-guide
 * 목적: drawer.module.ts — DrawerModule (module)
 * 책임/재사용: 기존 provider/controller와 의존성 연결만 소유한다. 업무 규칙이나 별도 전역 상태를 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Lead } from '../../entities';
import { ScheduleModule } from '../schedule/schedule.module';
import { DrawerController } from './drawer.controller';
import { DrawerService } from './drawer.service';

/**
 * 서랍은 여덟 표를 가로질러 읽는다. 표마다 리포지터리를 주입하면 여덟 줄이 되고
 * 표가 하나 늘 때마다 또 한 줄이 는다 — 읽기 전용 SQL 이므로 커넥션 하나면 된다.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Lead]), ScheduleModule],
  controllers: [DrawerController],
  providers: [DrawerService],
})
export class DrawerModule {}
