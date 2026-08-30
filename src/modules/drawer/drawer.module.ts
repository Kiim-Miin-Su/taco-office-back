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
