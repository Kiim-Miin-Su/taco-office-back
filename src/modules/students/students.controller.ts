/** @file-guide
 * 목적: students.controller.ts — 관리자 학생 목록·상세 GET(UX-C1)
 * 책임/재사용: 공용 Perm과 HTTP DTO를 사용한다. 신규 쓰기·삭제 권한을 열지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, type RequestUser } from '../../common/perm';
import { ApiErrorDto } from '../../common/http.dto';
import {
  StudentReactivationCandidateQueryDto,
  StudentReactivationCandidatesDto,
  StudentReactivationDto,
  StudentReactivationPreviewDto,
  StudentReactivationResultDto,
  StudentRegistrationConflictDto,
} from './student-registration.dto';
import { StudentDirectoryDto, StudentListQueryDto, StudentReadDto, StudentReadParamsDto } from './students.dto';
import { StudentsService } from './students.service';

@ApiTags('students')
@Controller('students')
@Perm('canAdminPage', 'canCrudAll')
export class StudentsController {
  constructor(private readonly service: StudentsService) {}

  @Get()
  @ApiOperation({ summary: '학생 DB 최신 생성 순 목록 — 현행 STU만, 기본10명. LEAD 통합/재원상태/국가는 후속.' })
  @ApiOkResponse({ type: StudentDirectoryDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  list(@Query() query: StudentListQueryDto): Promise<StudentDirectoryDto> { return this.service.list(query); }

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

  @Get(':id')
  @ApiOperation({ summary: '학생 현재 정보·보호자 요약·수강 사실·기존 연결 감사 metadata. 전체 변경 이력 아님.' })
  @ApiOkResponse({ type: StudentReadDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STUDENT_NOT_FOUND' })
  detail(@Param() params: StudentReadParamsDto): Promise<StudentReadDto> { return this.service.detail(params); }
}
