/** @file-guide
 * 목적: 강사 특이사항 write/receipt와 관리자 학생별 reader의 역할별 HTTP 경계를 연결한다. (controller)
 * 책임/재사용: 역할·DTO·상태코드만 소유하고 회차·명단·version 판정은 service에 위임한다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-09-SCENARIOS-2026-10-07.md · docs/contracts/CONTRACTS.md
 */
import { Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse,
  ApiOkResponse, ApiOperation, ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { ApiErrorDto } from '../../common/http.dto';
import { canAdminPage, isRole, Perm, type RequestUser } from '../../common/perm';
import {
  AdminStudentPrivateNoteListDto, TeacherPrivateNoteReceiptDto, TeacherPrivateNoteReceiptListDto,
  TeacherPrivateNoteWriteDto,
} from './private-notes.dto';
import { PrivateNotesService } from './private-notes.service';

@ApiTags('private-notes')
@Controller()
export class PrivateNotesController {
  constructor(private readonly service: PrivateNotesService) {}
  private assertTeacher(user: RequestUser): void {
    if (!isRole(user.role) || canAdminPage(user.role)) throw new ForbiddenException('강사 전용 화면입니다');
  }

  @Post('teacher/private-notes')
  @ApiOperation({ summary: '완료 회차의 학생 특이사항을 관리자 전용 원장에 저장한다' })
  @ApiCreatedResponse({ type: TeacherPrivateNoteReceiptDto, description: '강사에게 본문 없이 전달 영수증 metadata만 반환' })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'TEACHER_PRIVATE_NOTE_EMPTY' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'TEACHER_PRIVATE_NOTE_TARGET_NOT_FOUND' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'VERSION_CONFLICT | REQUEST_KEY_REUSED | REPLAY_STALE | LESSON_NOT_COMPLETED' })
  @ApiForbiddenResponse({ description: '강사 전용' })
  write(@CurrentUser() user: RequestUser, @Body() dto: TeacherPrivateNoteWriteDto): Promise<TeacherPrivateNoteReceiptDto> {
    this.assertTeacher(user);
    return this.service.write(user.id, dto);
  }

  @Get('teacher/private-notes/receipts')
  @ApiOperation({ summary: '내가 관리자에게 전달한 최근 특이사항 영수증 — 본문 제외' })
  @ApiOkResponse({ type: TeacherPrivateNoteReceiptListDto })
  receipts(@CurrentUser() user: RequestUser): Promise<TeacherPrivateNoteReceiptListDto> {
    this.assertTeacher(user);
    return this.service.receipts(user.id);
  }

  @Get('students/:studentId/private-notes')
  @Perm('canAdminPage', 'canCrudAll')
  @ApiOperation({ summary: '관리자 학생별 강사 특이사항 모음 — 본문을 반환하는 유일한 projection' })
  @ApiOkResponse({ type: AdminStudentPrivateNoteListDto })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'STUDENT_NOT_FOUND' })
  @ApiForbiddenResponse({ description: '관리자 페이지·전체 CRUD 권한 필요' })
  studentNotes(@Param('studentId', ParseIntPipe) studentId: number): Promise<AdminStudentPrivateNoteListDto> {
    return this.service.studentNotes(studentId);
  }
}
