/** @file-guide
 * 목적: 일반 자료요청의 강사 생성·확인과 관리자 보드·상태 전이 HTTP 경로를 연결한다.
 * 책임/재사용: 역할·DTO 경계만 소유하고 검증·트랜잭션·파일 ACL은 service에 위임한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-08D2-MATERIAL-REQUEST-PERSISTENCE-2026-10-09.md · docs/contracts/CONTRACTS.md
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse,
  ApiOkResponse, ApiOperation, ApiPayloadTooLargeResponse, ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Perm, type RequestUser } from '../../common/perm';
import {
  MaterialRequestAcknowledgeDto, MaterialRequestCreateDto, MaterialRequestOptionsDto,
  MaterialRequestQueryDto, MaterialRequestsDto, MaterialRequestTransitionDto, MaterialRequestWriteResultDto,
} from './material-requests.dto';
import { MaterialRequestsService } from './material-requests.service';

@ApiTags('material-requests')
@Controller('material-requests')
export class MaterialRequestsController {
  constructor(private readonly svc: MaterialRequestsService) {}

  @Get('options')
  @ApiOperation({ summary: '강사 자료요청 전체 담당 학생 선택지 — 본인 범위' })
  @ApiOkResponse({ type: MaterialRequestOptionsDto })
  @ApiForbiddenResponse({ description: '강사 전용' })
  options(@CurrentUser() user: RequestUser): Promise<MaterialRequestOptionsDto> {
    return this.svc.options(user);
  }

  @Get('mine')
  @ApiOperation({ summary: '강사 본인의 일반 자료요청과 전달 파일·처리 이력' })
  @ApiOkResponse({ type: MaterialRequestsDto })
  @ApiForbiddenResponse({ description: '강사 전용' })
  mine(@CurrentUser() user: RequestUser): Promise<MaterialRequestsDto> {
    return this.svc.mine(user);
  }

  @Post()
  @ApiOperation({
    summary: '강사 일반 자료요청 접수',
    description: 'GPAPACK·교재 변경과 분리된 MATREQ 원장이다. 담당 학생·KST 기한·멱등 키·첨부를 같은 트랜잭션에서 검증한다.',
  })
  @ApiCreatedResponse({ type: MaterialRequestWriteResultDto })
  @ApiBadRequestResponse({ description: 'MATERIAL_REQUEST_DATE_PAST | MATERIAL_REQUEST_FILE_KIND' })
  @ApiConflictResponse({ description: 'MATERIAL_REQUEST_KEY_REUSED' })
  @ApiPayloadTooLargeResponse({ description: 'FILE_TOO_LARGE' })
  create(@CurrentUser() user: RequestUser, @Body() dto: MaterialRequestCreateDto): Promise<MaterialRequestWriteResultDto> {
    return this.svc.create(user, dto);
  }

  @Get()
  @Perm('canAdminPage', 'canGpaPack')
  @ApiOperation({ summary: '관리자 일반 자료요청 보드 — 접수·준비·전달·반려와 이력' })
  @ApiOkResponse({ type: MaterialRequestsDto })
  all(@CurrentUser() user: RequestUser, @Query() query: MaterialRequestQueryDto): Promise<MaterialRequestsDto> {
    return this.svc.all(user, query);
  }

  @Patch(':id')
  @Perm('canAdminPage', 'canGpaPack')
  @ApiOperation({
    summary: '관리자 자료요청 상태 전이',
    description: '접수→준비, 접수/준비→반려, 준비→전달만 허용한다. 전달은 실제 내부 첨부가 필수이며 외부 발송을 성공으로 표시하지 않는다.',
  })
  @ApiOkResponse({ type: MaterialRequestWriteResultDto })
  @ApiConflictResponse({ description: 'MATERIAL_REQUEST_STALE | MATERIAL_REQUEST_INVALID_TRANSITION | MATERIAL_REQUEST_KEY_REUSED' })
  transition(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MaterialRequestTransitionDto,
  ): Promise<MaterialRequestWriteResultDto> {
    return this.svc.transition(user, id, dto);
  }

  @Post(':id/ack')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '강사 전달 파일 수신 확인 — 요청자 본인만' })
  @ApiOkResponse({ type: MaterialRequestWriteResultDto })
  @ApiConflictResponse({ description: 'MATERIAL_REQUEST_STALE | MATERIAL_REQUEST_NOT_DELIVERED | MATERIAL_REQUEST_ALREADY_ACKNOWLEDGED' })
  acknowledge(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MaterialRequestAcknowledgeDto,
  ): Promise<MaterialRequestWriteResultDto> {
    return this.svc.acknowledge(user, id, dto);
  }
}
