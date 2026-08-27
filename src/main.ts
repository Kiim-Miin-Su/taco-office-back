import 'reflect-metadata';
import { ClassSerializerInterceptor, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { buildOpenApi } from './openapi';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(','), credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // 금액 필드는 403 을 던지지 않고 **응답에서 뺀다** (CONTRACTS.md §10.2).
  // 목록 조회가 권한마다 갈라지지 않게 하려는 것이다.
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  buildOpenApi(app);

  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
