import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Rep } from '../../entities';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [TypeOrmModule.forFeature([Rep])],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
