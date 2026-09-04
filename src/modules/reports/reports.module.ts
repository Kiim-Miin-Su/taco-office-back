import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Rep } from '../../entities';
import { ReportsController } from './reports.controller';
import { REPORT_FILE_STORE, VercelReportFileStore } from './report-file.store';
import { ReportsService } from './reports.service';

@Module({
  imports: [TypeOrmModule.forFeature([Rep])],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    VercelReportFileStore,
    { provide: REPORT_FILE_STORE, useExisting: VercelReportFileStore },
  ],
})
export class ReportsModule {}
