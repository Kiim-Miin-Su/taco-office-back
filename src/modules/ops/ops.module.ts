/** @file-guide
 * 목적: ops.module.ts — OpsModule (module)
 * 책임/재사용: 기존 provider/controller와 의존성 연결만 소유한다. 업무 규칙이나 별도 전역 상태를 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Lead } from '../../entities';
import { AccountingModule } from '../accounting/accounting.module';
import { BooksModule } from '../books/books.module';
import { GuidesModule } from '../guides/guides.module';
import { ScheduleModule } from '../schedule/schedule.module';
import { LeadEnrollService } from './enroll.service';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';
import { TeacherChangeService } from './teacher-change.service';

/** 등록 확정(C91)·강사 교체(C93)는 시간표·청구서·교재·안내의 **기존 쓰기**를 한 트랜잭션에서 부른다 — 네 모듈을 들여온다 */
@Module({
  imports: [TypeOrmModule.forFeature([Lead]), ScheduleModule, AccountingModule, BooksModule, GuidesModule],
  controllers: [OpsController],
  providers: [OpsService, LeadEnrollService, TeacherChangeService],
})
export class OpsModule {}
