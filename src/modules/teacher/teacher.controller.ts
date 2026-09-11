/** @file-guide
 * 목적: teacher.controller.ts — TeacherController (controller)
 * 책임/재사용: HTTP DTO/경로와 인증·Perm 메타데이터를 연결하고 기존 service에 위임한다. SQL/업무 전이를 컨트롤러에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import {
  ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import type { RequestUser } from '../../common/perm';
import {
  TeacherGuidesDto, TeacherGuidesQueryDto, TeacherHistoryDto, TeacherHistoryQueryDto, TeacherHomeDto,
  TeacherSuggestionCreateDto, TeacherSuggestionDto, TeacherSuggestionsDto,
  TeacherUnavBlockDto, TeacherUnavCreateDto, TeacherUnavDto, TeacherUnavQueryDto,
} from './teacher.dto';
import { TeacherService } from './teacher.service';

@ApiTags('teacher')
@Controller('teacher')
export class TeacherController {
  constructor(private readonly svc: TeacherService) {}

  /** 강사 전용 표면 — 시급·정산이 실리므로 역할·본인 고정을 서버가 한다. 관리자 미리보기는 별도 결정 뒤에. */
  private assertTeacher(user: RequestUser): void {
    if (user.role !== 'teacher') throw new ForbiddenException('강사 전용 화면입니다');
  }

  @Get('home')
  @ApiOperation({ summary: '강사 홈 — 오늘·다가오는 수업·주간 요약·오늘 할 일·내 설정 (강사 덱 §7~9)' })
  @ApiOkResponse({ type: TeacherHomeDto })
  @ApiForbiddenResponse({ description: '강사 전용 — 다른 역할은 관리자 화면을 쓴다' })
  async home(@CurrentUser() user: RequestUser): Promise<TeacherHomeDto> {
    this.assertTeacher(user);
    return this.svc.home(user.id);
  }

  @Get('history')
  @ApiOperation({ summary: '수업 히스토리 — 월 기록 + 본인 정산 (강사 덱 §29~31 · D-R7·D-R32·D-15)' })
  @ApiOkResponse({ type: TeacherHistoryDto })
  @ApiForbiddenResponse({ description: '강사 전용 — 다른 강사의 정산은 누구도 여기서 볼 수 없다' })
  async history(@CurrentUser() user: RequestUser, @Query() query: TeacherHistoryQueryDto): Promise<TeacherHistoryDto> {
    this.assertTeacher(user);
    return this.svc.history(user.id, query.month);
  }

  @Get('guides')
  @ApiOperation({ summary: '수업 안내 — 이번 주 담당 학생·교재·진단·수업 설정 (강사 덱 §10~13)' })
  @ApiOkResponse({ type: TeacherGuidesDto })
  @ApiForbiddenResponse({ description: '강사 전용' })
  async guides(@CurrentUser() user: RequestUser, @Query() query: TeacherGuidesQueryDto): Promise<TeacherGuidesDto> {
    this.assertTeacher(user);
    return this.svc.guides(user.id, query.week);
  }

  @Get('suggestions')
  @ApiOperation({ summary: '건의 사항 — 내가 보낸 것 + 이달 쿼터 (덱 §33~34 · D-11·D-12)' })
  @ApiOkResponse({ type: TeacherSuggestionsDto })
  @ApiForbiddenResponse({ description: '강사 전용' })
  async suggestions(@CurrentUser() user: RequestUser): Promise<TeacherSuggestionsDto> {
    this.assertTeacher(user);
    return this.svc.suggestions(user.id);
  }

  @Post('suggestions')
  @ApiOperation({ summary: '건의 등록 — 월 3회는 서버가 센다 (초과: SUGGESTION_QUOTA_EXCEEDED)' })
  @ApiCreatedResponse({ type: TeacherSuggestionDto })
  @ApiConflictResponse({ description: '이달 한도 소진 — code SUGGESTION_QUOTA_EXCEEDED' })
  @ApiForbiddenResponse({ description: '강사 전용' })
  async createSuggestion(
    @CurrentUser() user: RequestUser,
    @Body() dto: TeacherSuggestionCreateDto,
  ): Promise<TeacherSuggestionDto> {
    this.assertTeacher(user);
    return this.svc.createSuggestion(user.id, dto);
  }

  @Get('unavailable')
  @ApiOperation({ summary: '불가 시간 — 2주 격자 메타 + 내 등록 (원본 §15/16 · N-20 날짜별 7일 전 마감)' })
  @ApiOkResponse({ type: TeacherUnavDto })
  @ApiForbiddenResponse({ description: '강사 전용' })
  async unavailable(@CurrentUser() user: RequestUser, @Query() query: TeacherUnavQueryDto): Promise<TeacherUnavDto> {
    this.assertTeacher(user);
    return this.svc.unavailable(user.id, query.anchor);
  }

  @Post('unavailable')
  @ApiOperation({ summary: '불가 시간 등록 — 마감·겹침은 서버가 판정 (UNAV_DEADLINE · UNAV_OVERLAP)' })
  @ApiCreatedResponse({ type: TeacherUnavBlockDto })
  @ApiConflictResponse({ description: 'code UNAV_DEADLINE(7일 전 마감) | UNAV_OVERLAP(본인 겹침) | TIME_RANGE | INVALID_DATE' })
  @ApiForbiddenResponse({ description: '강사 전용' })
  async createUnavailable(
    @CurrentUser() user: RequestUser,
    @Body() dto: TeacherUnavCreateDto,
  ): Promise<TeacherUnavBlockDto> {
    this.assertTeacher(user);
    return this.svc.createUnavailable(user.id, dto);
  }

  @Delete('unavailable/:id')
  @ApiOperation({ summary: '불가 시간 삭제 — 열린 날짜(오늘+7 이후)의 본인 등록만 (UNAV_LOCKED)' })
  @ApiOkResponse({ description: '{ ok: true }' })
  @ApiConflictResponse({ description: 'code UNAV_LOCKED — 마감분·legacy 는 관리자 조정' })
  @ApiForbiddenResponse({ description: '강사 전용' })
  async deleteUnavailable(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ ok: true }> {
    this.assertTeacher(user);
    return this.svc.deleteUnavailable(user.id, id);
  }
}
