/** @file-guide
 * 목적: schedule.module.ts — ScheduleModule (module)
 * 책임/재사용: 기존 provider/controller와 의존성 연결만 소유한다. 업무 규칙이나 별도 전역 상태를 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SerOcc } from '../../entities';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';
import { ScheduleWriteService } from './schedule.write.service';
import { ScheduleAttendanceService } from './schedule.attendance.service';

@Module({
  imports: [TypeOrmModule.forFeature([SerOcc])],
  controllers: [ScheduleController],
  providers: [ScheduleService, ScheduleWriteService, ScheduleAttendanceService],
  // 서랍의 §19 변경 요청이 겹침 설명을 여기서 가져다 쓴다 — 같은 판정이 두 벌이 되지 않게
  exports: [ScheduleService],
})
export class ScheduleModule {}
