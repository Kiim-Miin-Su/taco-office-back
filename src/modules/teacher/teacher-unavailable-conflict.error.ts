/** @file-guide
 * 목적: 강사 불가시간 등록의 실제 배정 수업 409 응답 계약.
 * 책임/재사용: 공용 오류의 최소 노출 원칙을 유지하면서 본인 수업 재선택에 필요한 회차 정보만 직렬화한다.
 * 검증/작업 지침: docs/AGENT.md · docs/CLAUDE.md · docs/contracts/FILE-GUIDE.md
 */

import { ArgumentsHost, Catch, ConflictException, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiErrorDto } from '../../common/http.dto';
import type { TeacherUnavailableLessonConflict } from '../../lib/teacher-unavailable';

export class TeacherUnavailableConflictErrorDto extends ApiErrorDto {
  @ApiProperty() serId!: number;
  @ApiProperty({ description: '규칙상 원래 회차일 YYYY-MM-DD' }) onDate!: string;
  @ApiProperty({ description: '실제 수업일 YYYY-MM-DD' }) actualDate!: string;
  @ApiProperty({ description: '실제 수업 시작 KST 분' }) startMin!: number;
  @ApiProperty({ description: '실제 수업 종료 KST 분' }) endMin!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) title!: string | null;
}

export class TeacherUnavailableConflictException extends ConflictException {
  constructor(conflict: TeacherUnavailableLessonConflict) {
    super({
      code: 'UNAV_LESSON_CONFLICT',
      message: '이미 배정된 수업과 겹칩니다. 수업 일정을 먼저 확인해 주세요.',
      ...conflict,
    } satisfies TeacherUnavailableConflictErrorDto);
  }
}

/**
 * 권고안 채택(2026-10-08): 상세 값은 인증된 강사 본인의 배정 회차를 잠금 뒤 조회한 결과만 노출한다.
 * 공용 ApiErrorFilter의 상세 비노출 범위를 넓히지 않고 이 쓰기 경로에만 명시적으로 허용한다.
 */
@Catch(TeacherUnavailableConflictException)
export class TeacherUnavailableConflictFilter implements ExceptionFilter<TeacherUnavailableConflictException> {
  catch(exception: TeacherUnavailableConflictException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = exception.getResponse() as TeacherUnavailableConflictErrorDto;
    if (response.locals) response.locals.httpDiagnosticCode = body.code;
    response.status(HttpStatus.CONFLICT).json(body);
  }
}
