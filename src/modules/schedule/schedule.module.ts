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
