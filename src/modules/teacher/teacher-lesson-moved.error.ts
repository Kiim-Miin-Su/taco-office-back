/** @file-guide
 * 목적: 강사 exact 수업 허브의 stale 실제 날짜 409 응답 계약을 보존한다.
 * 책임/재사용: 공용 오류 응답의 code·message 경계는 유지하면서 이 경로에 필요한 안전한 actualDate만 노출한다.
 * 검증/작업 지침: docs/AGENT.md · docs/CLAUDE.md · docs/contracts/FILE-GUIDE.md
 */

import { ArgumentsHost, Catch, ConflictException, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiErrorDto } from '../../common/http.dto';

export class TeacherLessonMovedErrorDto extends ApiErrorDto {
  @ApiProperty({ example: '2026-10-05', description: '서버가 확인한 최신 실제 수업일' })
  actualDate!: string;
}

export class TeacherLessonMovedException extends ConflictException {
  constructor(actualDate: string) {
    super({
      code: 'TEACHER_LESSON_MOVED',
      message: '수업일이 변경되었습니다. 최신 일정에서 다시 열어 주세요.',
      actualDate,
    } satisfies TeacherLessonMovedErrorDto);
  }
}

/**
 * 권고안 채택(2026-10-08): actualDate는 강사 본인 회차를 exact key로 확인한 뒤에만 나오는
 * 안전한 재동기화 값이다. 공용 ApiErrorFilter의 임의 상세 비노출 정책은 넓히지 않고 이 예외만
 * 명시적으로 직렬화한다. 정책 변경 시 service·controller·OpenAPI·Front 생성 타입과 BOC-05 문서를 함께 갱신한다.
 */
@Catch(TeacherLessonMovedException)
export class TeacherLessonMovedFilter implements ExceptionFilter<TeacherLessonMovedException> {
  catch(exception: TeacherLessonMovedException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = exception.getResponse() as TeacherLessonMovedErrorDto;
    if (response.locals) response.locals.httpDiagnosticCode = body.code;
    response.status(HttpStatus.CONFLICT).json(body);
  }
}
