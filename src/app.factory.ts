/**
 * 앱 조립 — **한 벌뿐이다.**
 *
 * 로컬(`main.ts` · `app.listen`)과 Vercel(`serverless.ts` · 요청마다 호출)이
 * 각자 `NestFactory.create(...)` 를 부르면 파이프·CORS·전역 접두사가 두 벌이 되고,
 * 언젠가 한쪽에만 미들웨어가 붙는다. 「로컬에서는 되는데 배포하면 안 된다」가 그렇게 생긴다.
 */
import 'reflect-metadata';
import { ClassSerializerInterceptor, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { INestApplication } from '@nestjs/common';
import type { Express } from 'express';
import { json, urlencoded } from 'express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { assertCookieConfig } from './auth/cookie';
import { buildOpenApi } from './openapi';

export const API_PREFIX = 'api/v1';
export const API_BODY_MAX_BYTES = 4 * 1024 * 1024;

/** PNG data URL도 로컬·서버리스에서 같은 상한으로 읽는다. Vercel 요청 상한보다 작게 둔다. */
export function configureApiBodyParser(app: INestApplication): void {
  app.use(json({ limit: API_BODY_MAX_BYTES }));
  app.use(urlencoded({ extended: true, limit: API_BODY_MAX_BYTES }));
}

/**
 * @param server 미리 만들어 둔 express 인스턴스. 서버리스에서 핸들러로 재사용한다.
 *               없으면 Nest 가 자기 것을 만든다 (로컬).
 */
export async function createApp(server?: Express): Promise<INestApplication> {
  /**
   * `abortOnError: false` 가 중요하다. 기본값(true)이면 Nest 는 초기화가 실패할 때
   * **오류를 던지는 대신 프로세스를 죽인다.** 서버리스에서는 그 순간 함수가 통째로 사라져
   * 호출한 쪽이 「연결 끊김」만 받는다 — 왜 안 되는지가 아무 데도 안 남는다.
   * 던지게 두면 `serverless.ts` 가 잡아서 503 과 이유를 돌려준다.
   */
  const opts = { abortOnError: false, bodyParser: false };
  const app = server
    ? await NestFactory.create(AppModule, new ExpressAdapter(server), opts)
    : await NestFactory.create(AppModule, opts);

  app.setGlobalPrefix(API_PREFIX);
  configureApiBodyParser(app);
  app.use(cookieParser());

  const origin = process.env.CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({ origin, credentials: true });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // 금액 필드는 403 을 던지지 않고 **응답에서 뺀다** (CONTRACTS.md §10.2).
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  // 쿠키 설정이 틀리면 여기서 죽는다. 배포가 성공하고 사람이 15분 뒤에 알게 되는 것보다 낫다.
  Logger.log(assertCookieConfig(), 'Cookie');

  // 운영에서 문서를 기본으로 열어 두지 않는다 — API 표면 전체를 광고할 이유가 없다.
  // 계약 파일(openapi.json)은 빌드 때 생성해 프런트에 넘기므로 이것과 무관하다.
  if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_DOCS === 'true') {
    buildOpenApi(app);
  }

  return app;
}
