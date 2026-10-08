/** @file-guide
 * 목적: 일반 자료요청 controller/service를 애플리케이션에 조립한다.
 * 책임/재사용: provider 연결만 소유하며 업무 규칙은 service에 둔다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-08D2-MATERIAL-REQUEST-PERSISTENCE-2026-10-09.md · docs/AGENT.md
 */

import { Module } from '@nestjs/common';
import { MaterialRequestsController } from './material-requests.controller';
import { MaterialRequestsService } from './material-requests.service';

@Module({ controllers: [MaterialRequestsController], providers: [MaterialRequestsService] })
export class MaterialRequestsModule {}
