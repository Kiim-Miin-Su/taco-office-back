/** @file-guide
 * 목적: teacher.module.ts — TeacherModule (module)
 * 책임/재사용: 모듈 조립만 소유한다. providers/imports 배선 외 업무 규칙을 두지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ser } from '../../entities';
import { TeacherController } from './teacher.controller';
import { TeacherService } from './teacher.service';

@Module({
  imports: [TypeOrmModule.forFeature([Ser])],
  controllers: [TeacherController],
  providers: [TeacherService],
})
export class TeacherModule {}
