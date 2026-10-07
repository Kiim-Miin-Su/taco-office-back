/** @file-guide
 * 목적: openapi.ts — buildOpenApi (config)
 * 책임/재사용: 기존 런타임/빌드/검사 설정을 유지한다. 의존성·배포·비밀값 변경은 별도 근거와 검증 없이는 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiErrorDto } from './common/http.dto';
import { REFRESH_COOKIE } from './auth/cookie';
import {
  MeetingAgendaDto,
  MeetingAgendaImportDto,
  MeetingAgendaImportResultDto,
  MeetingAgendaSummaryDto,
  MeetingAgendaWriteDto,
  MeetingDetailDto,
  MeetingDto,
  MeetingMinutesSummaryDto,
} from './modules/ops/ops.dto';

/**
 * **DTO 가 단일 출처다.** 여기서 만든 openapi.json 을 프론트가 읽어 타입을 생성한다.
 * 프론트가 자기 interface 를 손으로 적으면 형상이 조용히 어긋난다 (CONTRACTS.md §1).
 */
export function buildOpenApi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('TACO ERP API')
    .setDescription('티엔아카데미 학원 운영 백오피스 — 개발 명세서 v2 기준')
    .setVersion('0.1.0')
    .addBearerAuth()
    .addCookieAuth(REFRESH_COOKIE, { type: 'apiKey', in: 'cookie' }, REFRESH_COOKIE)
    .addSecurityRequirements('bearer')
    .addGlobalResponse(...[400, 401, 403, 404, 409, 500].map(status => ({
      status, type: ApiErrorDto, description: '공용 오류 형식. 해당 endpoint의 입력·권한·자원·DB 검증에 따라 반환될 수 있다.',
    })))
    .build();
  /*
   * BO-Q13 DTO 단계: runtime endpoint보다 먼저 생성 계약을 Front에 전달한다.
   * 실제 저장을 흉내 내지 않기 위해 controller path는 Backend 단계에서만 추가하고,
   * 그 전에는 extraModels로 request/response schema만 생성한다.
   */
  const doc = SwaggerModule.createDocument(app, config, {
    extraModels: [
      ApiErrorDto,
      MeetingAgendaSummaryDto,
      MeetingMinutesSummaryDto,
      MeetingAgendaDto,
      MeetingAgendaWriteDto,
      MeetingAgendaImportDto,
      MeetingAgendaImportResultDto,
      MeetingDto,
      MeetingDetailDto,
    ],
  });
  SwaggerModule.setup('api/docs', app, doc);
  return doc;
}
