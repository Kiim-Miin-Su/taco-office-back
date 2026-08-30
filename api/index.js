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
module.exports = require('../dist/serverless').default;
