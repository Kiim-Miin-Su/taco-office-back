/** @file-guide
 * 목적: consulting.module.ts — ConsultingModule (module)
 * 책임/재사용: 기존 provider/controller와 의존성 연결만 소유한다. 업무 규칙이나 별도 전역 상태를 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Lead } from '../../entities';
import { ScheduleModule } from '../schedule/schedule.module';
import { ConsultingController } from './consulting.controller';
import { ConsultingSessionService } from './consulting-session.service';
import { ConsultingService } from './consulting.service';

/** 회차 잡기(C95)는 시간표의 **기존 쓰기**를 한 트랜잭션에서 부른다 — ScheduleModule 을 들여온다 */
@Module({
  imports: [TypeOrmModule.forFeature([Lead]), ScheduleModule],
  controllers: [ConsultingController],
  providers: [ConsultingService, ConsultingSessionService],
})
export class ConsultingModule {}
