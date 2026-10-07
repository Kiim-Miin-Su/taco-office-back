/** @file-guide
 * 목적: 관리자 학생 조회와 BOC-03 신규 등록·재활성화 HTTP 경계를 연결한다.
 * 책임/재사용: 공용 Perm·생성 DTO를 사용하며 선택지·상태·transaction 판정은 StudentsService에 위임한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { hasPerm, isRole, Perm, type RequestUser } from '../../common/perm';
import { ApiErrorDto } from '../../common/http.dto';
import {
  StudentReactivationCandidateQueryDto,
  StudentReactivationCandidatesDto,
  StudentReactivationDto,
  StudentReactivationPreviewDto,
  StudentReactivationResultDto,
  StudentRegistrationConflictDto,
  StudentCreateDto,
  StudentCreatePreviewDto,
  StudentCreateResultDto,
  StudentRegistrationOptionsDto,
  StudentSchoolCreateDto,
  StudentSchoolOptionDto,
  StudentSchoolSearchQueryDto,
} from './student-registration.dto';
import { StudentDirectoryDto, StudentHubDto, StudentHubQueryDto, StudentListQueryDto, StudentReadDto, StudentReadParamsDto } from './students.dto';
import { StudentsService } from './students.service';
import {
  StudentKinderMarkerConflictDto, StudentKinderMarkerCreateDto, StudentKinderMarkerDto, StudentKinderMarkerHistoryDto,
} from './student-kinder.dto';
import { StudentKinderService } from './student-kinder.service';

@ApiTags('students')
@Controller('students')
@Perm('canAdminPage', 'canCrudAll')
export class StudentsController {
  constructor(private readonly service: StudentsService, private readonly kinder: StudentKinderService) {}

  @Get()
  @ApiOperation({ summary: '학생 DB 최신 생성 순 목록 — 현행 STU만, 기본10명. LEAD 통합/재원상태/국가는 후속.' })
  @ApiOkResponse({ type: StudentDirectoryDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  list(@Query() query: StudentListQueryDto): Promise<StudentDirectoryDto> { return this.service.list(query); }

  @Get('options')
  @ApiOperation({ summary: '신규 학생 등록 국가·시간대·영속 학년 code 선택지' })
  @ApiOkResponse({ type: StudentRegistrationOptionsDto })
  registrationOptions(): Promise<StudentRegistrationOptionsDto> { return this.service.registrationOptions(); }

  @Get('schools')
  @ApiOperation({ summary: '활성 학교 이름 검색 — 최대 20개' })
  @ApiOkResponse({ type: [StudentSchoolOptionDto] })
  searchSchools(@Query() query: StudentSchoolSearchQueryDto): Promise<StudentSchoolOptionDto[]> {
    return this.service.searchSchools(query);
  }

  @Post('schools')
  @ApiOperation({ summary: '학교 추가 또는 정규화 identity가 같은 활성 학교 반환' })
  @ApiCreatedResponse({ type: StudentSchoolOptionDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiConflictResponse({ type: StudentRegistrationConflictDto })
  createSchool(@CurrentUser() user: RequestUser, @Body() dto: StudentSchoolCreateDto): Promise<StudentSchoolOptionDto> {
    return this.service.createSchool(user.id, dto);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '신규 학생 15절 등록 미리보기 — 실제 writer와 지연 제약을 실행한 뒤 쓰기 0',
    description: 'BOC-03D-04b 권고안: preview는 requestKey를 소비하지 않으며 이미 저장된 key는 409로 재조회를 요구한다.',
  })
  @ApiOkResponse({ type: StudentCreatePreviewDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STUDENT_REGISTRATION_REFERENCE_NOT_FOUND' })
  @ApiConflictResponse({ type: StudentRegistrationConflictDto })
  previewCreate(
    @CurrentUser() user: RequestUser,
    @Body() dto: StudentCreateDto,
  ): Promise<StudentCreatePreviewDto> {
    return this.service.previewCreate(user.id, dto);
  }

  @Post()
  @ApiOperation({
    summary: '신규 학생 15절 저장 — 기간·연락·보호자·담당·형제·상태·감사 단일 transaction',
    description: '같은 actor/requestKey/body 재시도는 기존 결과를 반환한다. 연락처·현금영수증 원문은 LOG와 응답에 싣지 않는다.',
  })
  @ApiCreatedResponse({ type: StudentCreateResultDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STUDENT_REGISTRATION_REFERENCE_NOT_FOUND' })
  @ApiConflictResponse({ type: StudentRegistrationConflictDto })
  create(
    @CurrentUser() user: RequestUser,
    @Body() dto: StudentCreateDto,
  ): Promise<StudentCreateResultDto> {
    return this.service.create(user.id, dto);
  }

  @Get('reactivation-candidates')
  @ApiOperation({
    summary: '기존 학생 재활성화 후보 — 명시 상태·현재 profile version',
    description: 'BOC-03D-03b 권고안: 휴원·수강 종료·현재 명단으로 상태를 추정하지 않는다. event가 없는 기존 학생은 unknown으로 반환한다.',
  })
  @ApiOkResponse({ type: StudentReactivationCandidatesDto })
  reactivationCandidates(@Query() query: StudentReactivationCandidateQueryDto): Promise<StudentReactivationCandidatesDto> {
    return this.service.reactivationCandidates(query);
  }

  @Post(':id/reactivate/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '기존 학생 재활성화 미리보기 — 쓰기 0, requestKey 미소모' })
  @ApiOkResponse({ type: StudentReactivationPreviewDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'STUDENT_ID_MISMATCH | STUDENT_REACTIVATION_LEAD_INVALID' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STUDENT_NOT_FOUND' })
  @ApiConflictResponse({ type: StudentRegistrationConflictDto })
  previewReactivation(
    @CurrentUser() user: RequestUser,
    @Param() params: StudentReadParamsDto,
    @Body() dto: StudentReactivationDto,
  ): Promise<StudentReactivationPreviewDto> {
    return this.service.previewReactivation(user.id, params.id, dto);
  }

  @Post(':id/reactivate')
  @ApiOperation({
    summary: '기존 학생 재활성화 — 같은 STU·새 상담·상태/감사 한 transaction',
    description: '신규 STU·수강·수업·청구·교재·안내·첫 수업 task를 만들지 않는다. 같은 actor/requestKey/body 재시도는 기존 결과를 반환한다.',
  })
  @ApiCreatedResponse({ type: StudentReactivationResultDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'STUDENT_ID_MISMATCH | STUDENT_REACTIVATION_LEAD_INVALID' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STUDENT_NOT_FOUND' })
  @ApiConflictResponse({ type: StudentRegistrationConflictDto })
  reactivate(
    @CurrentUser() user: RequestUser,
    @Param() params: StudentReadParamsDto,
    @Body() dto: StudentReactivationDto,
  ): Promise<StudentReactivationResultDto> {
    return this.service.reactivate(user.id, params.id, dto);
  }

  @Get(':id/hub')
  @ApiOperation({
    summary: '학생 10탭 aggregate — 이어서 할 일·리포트·코멘트·청구 exact student projection',
    description: 'BOC-04D-01 권고안: 세 목록은 독립 keyset cursor를 쓰며 금액은 canMoney, 컨설팅 건수는 공용 공개 범위를 통과한 것만 반환한다. 강사는 이 관리자 경계에서 403이다.',
  })
  @ApiOkResponse({ type: StudentHubDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'STUDENT_HUB_CURSOR_INVALID' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STUDENT_NOT_FOUND' })
  hub(
    @CurrentUser() user: RequestUser,
    @Param() params: StudentReadParamsDto,
    @Query() query: StudentHubQueryDto,
  ): Promise<StudentHubDto> {
    const role = isRole(user.role) ? user.role : null;
    return this.service.hub(
      params,
      query,
      user.id,
      role !== null && hasPerm(role, 'canMoney', user.perms),
      role !== null && hasPerm(role, 'canHide', user.perms),
    );
  }

  @Get(':id/kinder-marker')
  @ApiOperation({ summary: '학생 Kinder 명시 표식 append-only 이력 — 학년·나이 파생 없음' })
  @ApiOkResponse({ type: StudentKinderMarkerHistoryDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STUDENT_NOT_FOUND' })
  kinderHistory(@Param() params: StudentReadParamsDto): Promise<StudentKinderMarkerHistoryDto> {
    return this.kinder.history(params.id);
  }

  @Post(':id/kinder-marker')
  @ApiOperation({
    summary: '학생 Kinder 표식 예약 — 미래 효력·version·일반 class 1대1 강제',
    description: '충돌 시 학생을 자동 제거하거나 수업을 분리하지 않고 원래 회차일·실제 수업일·충돌기간을 409로 반환합니다.',
  })
  @ApiCreatedResponse({ type: StudentKinderMarkerDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STUDENT_NOT_FOUND' })
  @ApiConflictResponse({ type: StudentKinderMarkerConflictDto })
  createKinderMarker(
    @CurrentUser() user: RequestUser,
    @Param() params: StudentReadParamsDto,
    @Body() dto: StudentKinderMarkerCreateDto,
  ): Promise<StudentKinderMarkerDto> {
    return this.kinder.create(user.id, params.id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '학생 현재 정보·보호자 요약·수강 사실·기존 연결 감사 metadata. 전체 변경 이력 아님.' })
  @ApiOkResponse({ type: StudentReadDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STUDENT_NOT_FOUND' })
  detail(@Param() params: StudentReadParamsDto): Promise<StudentReadDto> { return this.service.detail(params); }
}
