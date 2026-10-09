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
import {
  StudentCreateDto,
  StudentCreatePreviewDto,
  StudentCreateResultDto,
  StudentRegistrationContactDto,
  StudentRegistrationCountryOptionDto,
  StudentRegistrationGradePeriodDto,
  StudentRegistrationGuardianDto,
  StudentRegistrationOptionsDto,
  StudentRegistrationPeriodDto,
  StudentRegistrationResidencePeriodDto,
  StudentRegistrationSchoolPeriodDto,
  StudentRegistrationSummaryDto,
  StudentRegistrationTextPeriodDto,
  StudentRegistrationTimezoneOptionDto,
  StudentRegistrationWordDto,
  StudentReactivationCandidateDto,
  StudentReactivationCandidateQueryDto,
  StudentReactivationCandidatesDto,
  StudentReactivationConsultationDto,
  StudentReactivationDto,
  StudentReactivationEffectsDto,
  StudentReactivationPreviewDto,
  StudentReactivationResultDto,
  StudentRegistrationConflictDto,
  StudentSchoolCreateDto,
  StudentSchoolOptionDto,
  StudentSchoolSearchQueryDto,
} from './modules/students/student-registration.dto';
import {
  BookSaleCancelDto,
  BookSaleCreateDto,
  BookSaleDto,
  BookSaleFeePolicySnapshotDto,
  BookSaleLedgerDto,
  BookSaleMethodSummaryDto,
  BookSaleWriteResultDto,
} from './modules/accounting/accounting.dto';

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
      /*
       * BOC-03D-01 권고안 채택(2026-10-07): 15절 DTO를 LeadEnrollDto와 분리하고
       * runtime path 전에 생성 schema만 공개한다. POST /students와 preview/options/schools는
       * 공용 writer·권한·transaction이 연결되는 Backend 단계에서 함께 연다.
       */
      StudentRegistrationPeriodDto,
      StudentRegistrationSchoolPeriodDto,
      StudentRegistrationGradePeriodDto,
      StudentRegistrationResidencePeriodDto,
      StudentRegistrationTextPeriodDto,
      StudentRegistrationContactDto,
      StudentRegistrationGuardianDto,
      StudentCreateDto,
      StudentRegistrationTimezoneOptionDto,
      StudentRegistrationCountryOptionDto,
      StudentRegistrationWordDto,
      StudentRegistrationOptionsDto,
      StudentSchoolOptionDto,
      StudentSchoolSearchQueryDto,
      StudentSchoolCreateDto,
      StudentRegistrationSummaryDto,
      StudentCreatePreviewDto,
      StudentCreateResultDto,
      /*
       * BOC-03D-02 권고안 채택(2026-10-07): 재활성화는 기존 STU identity를 대상으로 한
       * 별도 versioned command다. 공용 오류의 code/message 형상과 후보·preview/result
       * schema만 생성하고, 권위 상태 owner와 transaction이 생기기 전 runtime path는 열지 않는다.
       */
      StudentReactivationCandidateQueryDto,
      StudentReactivationCandidateDto,
      StudentReactivationCandidatesDto,
      StudentReactivationConsultationDto,
      StudentReactivationDto,
      StudentReactivationEffectsDto,
      StudentReactivationPreviewDto,
      StudentReactivationResultDto,
      StudentRegistrationConflictDto,
      /*
       * BOC-11F Front → DTO 단계: 실제 판매·PAY transaction이 연결되기 전에
       * request/response schema를 생성 타입으로 고정한다. runtime path는 Backend 단계에서만 열고,
       * 그전 Front는 저장 성공을 표시하지 않는다.
       */
      BookSaleFeePolicySnapshotDto,
      BookSaleDto,
      BookSaleMethodSummaryDto,
      BookSaleLedgerDto,
      BookSaleCreateDto,
      BookSaleCancelDto,
      BookSaleWriteResultDto,
    ],
  });
  SwaggerModule.setup('api/docs', app, doc);
  return doc;
}
