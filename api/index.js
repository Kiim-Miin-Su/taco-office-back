/**
 * Vercel 서버리스 함수 — 이 파일이 API 전체의 문이다 (`vercel.json` 이 모든 경로를 여기로 보낸다).
 *
 * **왜 `.js` 이고, 왜 `dist/` 를 읽는가.**
 * Vercel 의 함수 번들러는 자기 esbuild 설정으로 TypeScript 를 컴파일하는데
 * `emitDecoratorMetadata` 를 켜지 않는다. NestJS 는 그 메타데이터로 의존성을 주입하므로
 * 여기서 `src/` 를 직접 import 하면 **주입이 통째로 깨진다.**
 *
 * 그래서 `nest build`(= tsc, 데코레이터 메타데이터 켜짐)가 만든 `dist/` 를 읽는다.
 * 이 파일 자체에는 데코레이터가 없어 번들러가 건드려도 안전하다.
 */

let handler;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  handler = require('../dist/serverless').default;
} catch (e) {
  /**
   * 여기로 오는 경우는 하나뿐이다 — **빌드 산출물이 없다.**
   *
   * 그냥 두면 MODULE_NOT_FOUND 가 그대로 올라가 Vercel 이 속을 알 수 없는 500 을 준다.
   * 실제로 `nest build` 가 **빈 dist 를 만들고 exit 0** 으로 끝난 적이 있다
   * (증분 캐시가 dist 밖에 있어서 tsc 가 아무것도 안 내보냈다).
   * 그때 화면에는 아무 단서도 안 남았다. 그래서 여기서 **무엇이 없는지** 말해 준다.
   */
  const why = e && e.code === 'MODULE_NOT_FOUND'
    ? 'dist/serverless.js 가 없습니다 — 빌드가 산출물을 안 냈습니다.\n'
      + '  Vercel > Deployments > 그 배포 > Build Logs 에서 `nest build` 가 무엇을 냈는지 보세요.\n'
      + '  캐시 문제면 Redeploy 할 때 "Use existing Build Cache" 를 끄고 돌리세요.'
    : String((e && e.message) || e);

  handler = (req, res) => {
    // eslint-disable-next-line no-console
    console.error('[api/index] 앱을 못 불러왔습니다:', e);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ code: 'BUILD_MISSING', message: why }));
  };
}

module.exports = handler;
