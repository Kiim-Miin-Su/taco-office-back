/** @file-guide
 * 목적: HTTP 요청·응답의 값 없는 공통 서버 진단과 요청 ID 경계.
 * 책임/재사용: 로컬·서버리스가 공유하는 app.factory에서 한 번 등록한다. URL/본문/헤더/응답값/예외 원문은 로그에 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const log = new Logger('HttpDiagnostics');
// 수신 헤더나 res.locals의 임의 값 대신 미들웨어가 직접 발급한 ID만 필터에 전달한다.
const issuedRequestIds = new WeakMap<Response, string>();
const SAFE_ROUTE = /^\/[A-Za-z0-9_/:.*-]*$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
// 사용자값을 code에 넣은 새 예외도 로그 원문이 되지 않도록 승인된 고정 코드만 허용한다.
// 새 코드를 추가하지 않아도 HTTP_상태로 안전하게 기록된다. 응답 자체의 code 계약은 바꾸지 않는다.
const LOG_CODES = new Set(`BAD_REQUEST UNAUTHORIZED FORBIDDEN NOT_FOUND CONFLICT INTERNAL
  RESOURCE_CONFLICT DUPLICATE BAD_RANGE PAUSE_OVERLAP REFERENCE_NOT_FOUND INVALID_AMOUNT
  MODE_ROOM_ONLINE STUDENT_NOT_FOUND TEACHER_NOT_FOUND ROOM_NOT_FOUND OCCURRENCE_NOT_FOUND
  SOURCE_NOT_FOUND BAD_STUDENT_REPLACEMENT PASTE_STUDENT_CHANGED MOVE_STUDENT_CHANGED
  STAFF_AUDIT_CURSOR_INVALID`.split(/\s+/));

/** Express가 매칭한 코드 소유 route만 사용한다. 원시 URL·query·동적 segment 값은 절대 보지 않는다. */
function routeTemplate(req: Request): string {
  const route = (req as Request & { route?: { path?: unknown } }).route?.path;
  return typeof route === 'string' && route.length <= 200 && SAFE_ROUTE.test(route) ? route : '[unmatched]';
}

function actorId(req: Request): number | null {
  const id = (req as Request & { user?: { id?: unknown } }).user?.id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function responseCode(res: Response, status: number): string {
  if (status === 0) return 'CLIENT_ABORTED';
  if (status < 400) return 'OK';
  const code = res.locals?.httpDiagnosticCode;
  return typeof code === 'string' && LOG_CODES.has(code) ? code : `HTTP_${status}`;
}

/** 서버가 발급한 요청 ID만 반환한다. 미들웨어 없는 독립 필터 호출은 null이다. */
export function httpRequestId(res: Response): string | null {
  return issuedRequestIds.get(res) ?? null;
}

/** 응답이 끝나야 Express route template와 인증된 actor를 알 수 있으므로 한 번의 완료 경계에서 두 이벤트를 남긴다. */
export function httpDiagnostics(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  const started = process.hrtime.bigint();
  issuedRequestIds.set(res, requestId);
  res.setHeader('X-Request-Id', requestId);
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    const status = res.writableFinished ? res.statusCode : 0;
    const common = {
      requestId, method: METHODS.has(req.method) ? req.method : 'OTHER', route: routeTemplate(req),
      status, code: responseCode(res, status),
      durationMs: Math.max(0, Math.round(Number(process.hrtime.bigint() - started) / 1_000_000)),
      actorId: actorId(req),
    };
    try {
      log.log(JSON.stringify({ event: 'http.request', ...common }));
      log.log(JSON.stringify({ event: 'http.response', ...common }));
    } catch { /* 진단 실패는 업무 요청을 바꾸지 않는다. 원시 오류도 fallback으로 출력하지 않는다. */ }
  };
  res.once('finish', record);
  res.once('close', record);
  next();
}
