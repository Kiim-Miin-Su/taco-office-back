/** @file-guide
 * 목적: api-error.filter.ts — ApiErrorFilter (error)
 * 책임/재사용: 공용 오류 응답 정규화 경계다. 실제 노출 필드만 DTO/OpenAPI로 문서화하고 비밀값/DB 내부 상세를 응답에 싣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { httpRequestId } from '../http-diagnostics';

/**
 * 모든 에러를 **한 형태**로 내보낸다. 프론트 인터셉터가 한 군데에서만 해석하면 되도록.
 *
 *   { code, message } — common/http.dto.ts의 ApiErrorDto와 동일. detail은 현재 노출하지 않는다.
 *
 * DB 제약 위반을 여기서 사람 말로 번역한다 (D-R43) — 서비스마다 try/catch 를 두지 않는다.
 *   23P01 EXCLUDE  겹침       → 409 RESOURCE_CONFLICT (학생 휴원 기간 겹침 `stu_pause_no_overlap` 만 PAUSE_OVERLAP)
 *   23505 UNIQUE   중복       → 409 DUPLICATE
 *   23514 CHECK    범위 벗어남 → 400 INVALID_AMOUNT (일정 시간 CHECK 3개만 BAD_RANGE)
 *   23503 FK       참조 없음   → 400 REFERENCE_NOT_FOUND
 */
const SCHEDULE_TIME_CHECKS = new Set(['ser_time_check', 'exc_time_check', 'ser_occ_time_check']);
/** 제약 이름으로 더 정확한 말을 고르는 자리 — 같은 23P01 이라도 「강사·강의실·줌」과 「휴원 기간」은 다른 문장이다 (C92-c) */
const CONSTRAINT_MAP: Record<string, { status: number; code: string; message: string }> = {
  stu_pause_no_overlap: {
    status: HttpStatus.CONFLICT,
    code: 'PAUSE_OVERLAP',
    message: '이미 잡힌 휴원 기간과 겹칩니다 — 먼저 복귀 처리하거나 기간을 바꿔 주세요',
  },
};
const PG_MAP: Record<string, { status: number; code: string; message: string }> = {
  '23P01': {
    status: HttpStatus.CONFLICT,
    code: 'RESOURCE_CONFLICT',
    message: '같은 시간에 강사·강의실·줌이 이미 잡혀 있습니다',
  },
  '23505': {
    status: HttpStatus.CONFLICT,
    code: 'DUPLICATE',
    message: '이미 있는 항목입니다',
  },
  '23514': {
    status: HttpStatus.BAD_REQUEST,
    code: 'INVALID_AMOUNT',
    message: '값이 허용 범위를 벗어났습니다',
  },
  '23503': {
    status: HttpStatus.BAD_REQUEST,
    code: 'REFERENCE_NOT_FOUND',
    message: '연결하려는 대상이 없습니다',
  },
};

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('ApiError');

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    const pgCode = (err as { code?: string })?.code;
    if (pgCode && Object.prototype.hasOwnProperty.call(PG_MAP, pgCode)) {
      const constraint = (err as { constraint?: string }).constraint ?? '';
      const m = (Object.prototype.hasOwnProperty.call(CONSTRAINT_MAP, constraint) ? CONSTRAINT_MAP[constraint] : null)
        ?? (pgCode === '23514' && SCHEDULE_TIME_CHECKS.has(constraint)
          ? { status: HttpStatus.BAD_REQUEST, code: 'BAD_RANGE', message: '수업 시각은 같은 날 안의 정수 분이며 길이는 10~480분이어야 합니다' }
          : PG_MAP[pgCode]!);
      // 알려진 코드 소유 제약만 남긴다. 예외 객체의 원시 constraint 문자열은 비밀값일 수 있다.
      const knownConstraint = Object.prototype.hasOwnProperty.call(CONSTRAINT_MAP, constraint)
        || SCHEDULE_TIME_CHECKS.has(constraint) ? constraint : 'other';
      this.log.warn(`${pgCode} ${knownConstraint}`);
      if (res.locals) res.locals.httpDiagnosticCode = m.code;
      res.status(m.status).json({ code: m.code, message: m.message });
      return;
    }

    if (err instanceof HttpException) {
      const body = err.getResponse();
      const message =
        typeof body === 'string' ? body : ((body as { message?: unknown }).message ?? err.message);
      const code = (body as { code?: string })?.code ?? httpCode(err.getStatus());
      if (res.locals) res.locals.httpDiagnosticCode = code;
      res.status(err.getStatus()).json({
        code,
        message: Array.isArray(message) ? message.join('\n') : message,
      });
      return;
    }

    // 원시 stack/message에는 SQL 입력·주민번호·토큰이 섞일 수 있다. HTTP 진단의 requestId/code로 좁혀 추적한다.
    this.log.error(`INTERNAL unexpected error requestId=${httpRequestId(res) ?? 'unavailable'}`);
    if (res.locals) res.locals.httpDiagnosticCode = 'INTERNAL';
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ code: 'INTERNAL', message: '처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요' });
  }
}

function httpCode(status: number): string {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  return 'ERROR';
}
