/** @file-guide
 * 목적: students.controller.ts — 관리자 학생 목록·상세 GET(UX-C1)
 * 책임/재사용: 공용 Perm과 HTTP DTO를 사용한다. 신규 쓰기·삭제 권한을 열지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Perm } from '../../common/perm';
import { ApiErrorDto } from '../../common/http.dto';
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

  @Get(':id')
  @ApiOperation({ summary: '학생 현재 정보·보호자 요약·수강 사실·기존 연결 감사 metadata. 전체 변경 이력 아님.' })
  @ApiOkResponse({ type: StudentReadDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STUDENT_NOT_FOUND' })
  detail(@Param() params: StudentReadParamsDto): Promise<StudentReadDto> { return this.service.detail(params); }
}
