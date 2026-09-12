/** @file-guide
 * 목적: reports.module.ts — ReportsModule (module)
 * 책임/재사용: 기존 provider/controller와 의존성 연결만 소유한다. 업무 규칙이나 별도 전역 상태를 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Rep } from '../../entities';
import { ReportsController } from './reports.controller';
import { FilesModule } from '../files/files.module';
import { NeonReportFileStore, REPORT_FILE_STORE, VercelReportFileStore } from './report-file.store';
import { ReportsService } from './reports.service';

@Module({
  imports: [TypeOrmModule.forFeature([Rep]), FilesModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    VercelReportFileStore,
    NeonReportFileStore,
    // 새 파일은 Neon 으로 간다. Vercel 은 예전 주소를 지울 때만 불린다 (대표 결정 2026-09-12)
    { provide: REPORT_FILE_STORE, useExisting: NeonReportFileStore },
  ],
})
export class ReportsModule {}
