/**
 * Vercel 서버리스 진입점의 알맹이.
 *
 * 함수는 요청마다 **다시 불릴 수 있지만**, 같은 인스턴스가 재사용되기도 한다(웜 스타트).
 * 그래서 부팅을 약속(Promise) 하나에 담아 두고 두 번째 요청부터는 그것을 기다리기만 한다 —
 * 매 요청마다 Nest 를 새로 조립하면 DB 커넥션이 요청 수만큼 열린다.
 *
 * `app.listen()` 은 부르지 않는다. 포트를 여는 것은 플랫폼이고, 우리는 핸들러만 준다.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import { createApp } from './app.factory';

const server = express();
let booting: Promise<void> | null = null;

async function boot(): Promise<void> {
  const app = await createApp(server);
  await app.init();
}

/**
 * ⚠️ `res` 는 **express 의 Response 가 아니다.** 플랫폼이 넘겨주는 것은 노드의 날 것이라
 * `res.status(...)`·`res.json(...)` 이 없을 수 있다. 실제로 그렇게 적었다가
 * **부팅 실패를 알리려던 코드가 스스로 터져 프로세스를 죽였다** — 503 대신 연결 끊김이 났다.
 * 그래서 여기서는 노드 API 만 쓴다. express 로 넘긴 **뒤에야** 그 편의 메서드가 생긴다.
 */
function fail(res: ServerResponse, code: string, message: string, status = 503): void {
  if (res.headersSent) { res.end(); return; }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ code, message }));
}

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  booting ??= boot();
  booting
    .then(() => server(req as never, res as never))
    .catch((e: unknown) => {
      // 부팅이 실패하면 **다음 요청에서 다시 시도한다** — 한 번 실패한 약속을 계속 붙들면
      // 인스턴스가 살아 있는 동안 영원히 503 이 된다 (DB 가 잠깐 늦게 뜬 경우가 그렇다).
      booting = null;
      console.error('[boot] 실패:', e);
      fail(res, 'BOOTING', '서버가 준비되지 않았습니다. 잠시 뒤 다시 시도해 주세요.');
    });
}
