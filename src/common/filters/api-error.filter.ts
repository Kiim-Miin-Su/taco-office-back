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

/**
 * 모든 에러를 **한 형태**로 내보낸다. 프론트 인터셉터가 한 군데에서만 해석하면 되도록.
 *
 *   { code, message } — common/http.dto.ts의 ApiErrorDto와 동일. detail은 현재 노출하지 않는다.
 *
 * DB 제약 위반을 여기서 사람 말로 번역한다 (D-R43) — 서비스마다 try/catch 를 두지 않는다.
 *   23P01 EXCLUDE  겹침       → 409 RESOURCE_CONFLICT
 *   23505 UNIQUE   중복       → 409 DUPLICATE
 *   23514 CHECK    범위 벗어남 → 400 INVALID_AMOUNT (일정 시간 CHECK 3개만 BAD_RANGE)
 *   23503 FK       참조 없음   → 400 REFERENCE_NOT_FOUND
 */
const SCHEDULE_TIME_CHECKS = new Set(['ser_time_check', 'exc_time_check', 'ser_occ_time_check']);
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
    if (pgCode && PG_MAP[pgCode]) {
      const m = pgCode === '23514' && SCHEDULE_TIME_CHECKS.has((err as { constraint?: string }).constraint ?? '')
        ? { status: HttpStatus.BAD_REQUEST, code: 'BAD_RANGE', message: '수업 시각은 같은 날 안의 정수 분이며 길이는 10~480분이어야 합니다' }
        : PG_MAP[pgCode]!;
      // 어느 제약이 걸렸는지 남긴다 — "충돌났다" 만으로는 운영에서 못 고친다
      this.log.warn(`${pgCode} ${(err as { constraint?: string }).constraint ?? ''}`);
      res.status(m.status).json({ code: m.code, message: m.message });
      return;
    }

    if (err instanceof HttpException) {
      const body = err.getResponse();
      const message =
        typeof body === 'string' ? body : ((body as { message?: unknown }).message ?? err.message);
      res.status(err.getStatus()).json({
        code: (body as { code?: string })?.code ?? httpCode(err.getStatus()),
        message: Array.isArray(message) ? message.join('\n') : message,
      });
      return;
    }

    this.log.error(err instanceof Error ? err.stack : String(err));
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
