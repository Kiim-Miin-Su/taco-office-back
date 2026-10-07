/** @file-guide
 * 목적: BOC-09D-03 전용 controller/service를 연결한다. (module)
 * 책임/재사용: 업무 규칙을 복제하지 않고 전역 DataSource를 사용한다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-09-SCENARIOS-2026-10-07.md
 */
import { Module } from '@nestjs/common';
import { PrivateNotesController } from './private-notes.controller';
import { PrivateNotesService } from './private-notes.service';

@Module({ controllers: [PrivateNotesController], providers: [PrivateNotesService] })
export class PrivateNotesModule {}
