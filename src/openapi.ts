import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * **DTO 가 단일 출처다.** 여기서 만든 openapi.json 을 프론트가 읽어 타입을 생성한다.
 * 프론트가 자기 interface 를 손으로 적으면 형상이 조용히 어긋난다 (CONTRACTS.md §1).
 */
export function buildOpenApi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('TACO ERP API')
    .setDescription('티엔아카데미 학원 운영 백오피스 — 개발 명세서 v2 기준')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const doc = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, doc);
  return doc;
}
