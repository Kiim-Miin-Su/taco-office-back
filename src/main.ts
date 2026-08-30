/**
 * 로컬 개발 서버. **조립은 하지 않는다** — `app.factory.ts` 가 한다.
 *
 * Vercel 은 이 파일을 부르지 않는다 (`api/index.js` → `dist/serverless.js`).
 * 그래서 여기 있는 것은 「포트를 연다」 하나뿐이어야 한다.
 */
import { Logger } from '@nestjs/common';
import { createApp } from './app.factory';

async function bootstrap() {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  Logger.log(`http://localhost:${port}/api/v1 (문서 /api/docs)`, 'Bootstrap');
}
void bootstrap();
