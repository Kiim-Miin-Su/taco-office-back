/** @file-guide
 * 목적: files.module.ts — FilesModule (module)
 * 책임/재사용: 기존 provider/controller와 의존성 연결만 소유한다. 업무 규칙이나 별도 전역 상태를 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileRow } from '../../entities';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  imports: [TypeOrmModule.forFeature([FileRow])],
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
