import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SerOcc } from '../../entities';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';

@Module({
  imports: [TypeOrmModule.forFeature([SerOcc])],
  controllers: [ScheduleController],
  providers: [ScheduleService],
})
export class ScheduleModule {}
